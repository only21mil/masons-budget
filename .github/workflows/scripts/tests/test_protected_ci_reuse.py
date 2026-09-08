#!/usr/bin/env python3
"""Exercise source qualification, actual landing and refusal paths without GitHub."""
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("reuse", Path(__file__).parents[1] / "protected_ci_reuse.py")
reuse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reuse)
BASE, SOURCE, LANDED, TREE = (letter * 40 for letter in "abcd")


def ago(minutes):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)).isoformat()


class InputAndAuthorityTests(unittest.TestCase):
    def test_read_only_authority_does_not_require_hidden_bypass_actors(self):
        rule = {"ruleset_id": 7, "ruleset_source_type": "Repository", "ruleset_source": reuse.REPO,
                "type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": True,
                "required_status_checks": [{"context": "Shared domain contract", "integration_id": 15368}]}}
        metadata = {"id": 7, "source_type": "Repository", "source": reuse.REPO, "enforcement": "active",
                    "target": "branch", "updated_at": "2026-09-07T00:00:00Z", "conditions": {}, "rules": [rule]}
        class ReadOnlyAPI:
            def one(self, endpoint):
                if endpoint == reuse.PREFIX:
                    return {"id": 1, "full_name": reuse.REPO, "default_branch": "main"}
                if endpoint == reuse.PREFIX + "/rulesets/7":
                    return metadata
                if endpoint == reuse.PREFIX + "/branches/main":
                    return {"name": "main", "protected": True, "protection": {}}
                raise AssertionError(endpoint)
            def pages(self, endpoint, kind):
                return [rule]
        original = reuse.authority(ReadOnlyAPI())
        self.assertNotIn("bypass_actors", original["rulesets"][0])
        metadata["updated_at"] = "2026-09-07T00:01:00Z"
        self.assertNotEqual(original, reuse.authority(ReadOnlyAPI()))
        metadata["enforcement"] = "disabled"
        with self.assertRaises(reuse.Refusal):
            reuse.authority(ReadOnlyAPI())

    def test_legacy_public_branch_inventory_is_supported_without_rulesets(self):
        protection = {"enabled": True, "required_status_checks": {
            "contexts": ["Shared domain contract"], "checks": [{"context": "Shared domain contract", "app_id": 15368}],
            "enforcement_level": "non_admins"}}
        class LegacyAPI:
            def one(self, endpoint):
                if endpoint == reuse.PREFIX:
                    return {"full_name": reuse.REPO, "default_branch": "main", "id": 42}
                return {"name": "main", "protected": True, "protection": protection}
            def pages(self, endpoint, kind):
                return []
        result = reuse.authority(LegacyAPI())
        self.assertEqual(result["required_checks"], [{"name": "Shared domain contract", "integration_id": 15368}])
        self.assertEqual(result["rulesets"], [])
        protection["required_status_checks"]["checks"][0]["app_id"] = None
        with self.assertRaises(reuse.Refusal):
            reuse.authority(LegacyAPI())

    def test_read_only_ruleset_authority_preserves_non_strict_policy(self):
        rule = {"type": "required_status_checks", "ruleset_id": 7, "ruleset_source_type": "Repository",
                "ruleset_source": reuse.REPO, "parameters": {"strict_required_status_checks_policy": False,
                    "required_status_checks": [{"context": "Shared domain contract", "integration_id": 15368}]}}
        metadata = {"id": 7, "source_type": "Repository", "source": reuse.REPO, "enforcement": "active",
                    "target": "branch", "conditions": {}, "rules": [rule], "updated_at": "2026-09-07T00:00:00Z"}
        class PublicAPI:
            def one(self, endpoint):
                if endpoint == reuse.PREFIX:
                    return {"full_name": reuse.REPO, "default_branch": "main", "id": 42}
                if endpoint.endswith("/branches/main"):
                    return {"name": "main", "protected": True, "protection": {}}
                return metadata
            def pages(self, endpoint, kind):
                return [rule]
        result = reuse.authority(PublicAPI())
        self.assertEqual(result["strict_policies"], [False])
        self.assertNotIn("bypass_actors", result["rulesets"][0])
        metadata["enforcement"] = "disabled"
        with self.assertRaises(reuse.Refusal):
            reuse.authority(PublicAPI())

    def test_compare_api_allows_only_exact_bounded_commit_range(self):
        api = reuse.API()
        self.addCleanup(api.config.cleanup)
        with patch.object(reuse.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"{}", b"")):
            api.raw(reuse.PREFIX + f"/compare/{BASE}...{SOURCE}?per_page=1")
            with self.assertRaises(reuse.Refusal):
                api.raw(reuse.PREFIX + "/compare/../../untrusted")

    def test_installed_bytes_and_workspace_links_are_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packages = root / "node_modules"
            packages.mkdir()
            target = root / "workspace"
            target.mkdir()
            (target / "index.js").write_text("first")
            (packages / "workspace").symlink_to(target, target_is_directory=True)
            with patch.object(reuse.Path, "cwd", return_value=root):
                original = reuse.files_digest(packages)
                (target / "index.js").write_text("changed")
                self.assertNotEqual(original, reuse.files_digest(packages))
                (packages / "outside").symlink_to("/etc/hosts")
                with self.assertRaisesRegex(reuse.Refusal, "escapes checkout"):
                    reuse.files_digest(packages)


class LandingAPI:
    def __init__(self):
        self.evidence = []
        self.main = LANDED
        self.landed = {"sha": LANDED, "tree": {"sha": TREE}, "parents": [{"sha": BASE}, {"sha": SOURCE}]}
        self.candidate = {"sha": SOURCE, "tree": {"sha": TREE}, "parents": [{"sha": BASE}]}
        self.pr = {"number": 42, "state": "closed", "merged": True, "merged_at": "2026-09-07T00:00:00Z", "draft": False,
                   "updated_at": "2026-09-08T15:59:07Z", "merged_by": {"id": 7}, "labels": [],
                   "head": {"sha": SOURCE, "ref": "feature", "repo": {"full_name": reuse.REPO, "updated_at": "2026-09-08T15:59:07Z"}},
                   "base": {"sha": BASE, "ref": "main", "repo": {"full_name": reuse.REPO, "updated_at": "2026-09-08T15:59:07Z"}},
                   "merge_commit_sha": LANDED}
        # Snapshot returned by every read after the first, when set: the final
        # readback sees a PR object that drifted during verification.
        self.final_pr = None
        self.pr_reads = 0
        self.protection = {"required_checks": [{"name": name, "integration_id": 15368}
                           for names in reuse.WORKFLOW_CHECKS.values() for name in names]}
        self.runs, self.jobs, self.checks, self.sources = {}, {}, [], {}
        for index, (filename, names) in enumerate(reuse.WORKFLOW_CHECKS.items(), 1):
            self.runs[index] = {"id": index, "run_attempt": 1, "status": "completed", "conclusion": "success",
                               "event": "pull_request", "path": ".github/workflows/" + filename,
                               "head_sha": SOURCE, "head_repository": {"full_name": reuse.REPO},
                               "check_suite_id": index * 100, "created_at": ago(20),
                               "run_started_at": ago(20), "updated_at": ago(19)}
            self.jobs[index] = []
            for count, name in enumerate(names, 1):
                check_id = index * 1000 + count
                self.jobs[index].append({"id": check_id + 10000, "name": name, "run_attempt": 1,
                    "status": "completed", "conclusion": "success", "completed_at": ago(19),
                    "check_run_url": f"https://api.github.com{reuse.PREFIX}/check-runs/{check_id}"})
                self.checks.append({"id": check_id, "name": name, "head_sha": SOURCE, "app": {"id": 15368},
                    "status": "completed", "conclusion": "success", "check_suite": {"id": index * 100}})
            for job, (job_filename, _) in reuse.JOBS.items():
                if filename == job_filename:
                    self.sources[job] = {"schema_version": 1, "qualification_version": 2, "mode": "source",
                        "repository": reuse.REPO, "job": job, "run_id": index, "run_attempt": 1,
                        "head_sha": SOURCE, "base_sha": BASE, "tree_sha": TREE, "tested_sha": SOURCE,
                        "pull_request": 42, "check_scope": reuse.CHECK_SCOPE[job],
                        "workflow_sha256": hashlib.sha256(Path(reuse.workflow(job)).read_bytes()).hexdigest(),
                        "policy_sha256": hashlib.sha256(Path(reuse.__file__).read_bytes()).hexdigest(),
                        "epoch": "", "authority": copy.deepcopy(self.protection),
                        "context": {"environment": {"RUNNER_OS": "Linux"}, "versions": {"dependency_hash": "abc"}}}
        # Finish the required-check inventory before copying it into proofs.
        for source in self.sources.values():
            source["authority"] = copy.deepcopy(self.protection)
        self.corrupt_digest = False
        self.moves_at_end = False
        self.main_reads = 0
        self.extra_runs = {}

    def add_run(self, identity, original=1, *, started=10, attempt=1):
        """Another provider execution, with its own suite, jobs and artifacts."""
        run = self.extra_runs[identity] = {**self.runs[original], "id": identity, "run_attempt": attempt,
            "check_suite_id": identity * 100, "run_started_at": ago(started), "updated_at": ago(started - 1)}
        self.jobs[identity] = []
        for job in self.jobs[original]:
            check = next(check for check in self.checks
                         if job["check_run_url"].endswith("/" + str(check["id"])))
            check_id = identity * 1000 + check["id"] % 1000
            self.checks.append({**copy.deepcopy(check), "id": check_id, "check_suite": {"id": identity * 100}})
            self.jobs[identity].append({**copy.deepcopy(job), "id": check_id + 10000, "run_attempt": attempt,
                "completed_at": ago(started - 1),
                "check_run_url": f"https://api.github.com{reuse.PREFIX}/check-runs/{check_id}"})
        for key, source in list(self.sources.items()):
            if source["run_id"] == original:
                self.sources[f"{key}-{identity}"] = {**copy.deepcopy(source), "run_id": identity, "run_attempt": attempt}
        return run

    def one(self, endpoint):
        suffix = endpoint.removeprefix(reuse.PREFIX)
        if suffix == "/git/ref/heads/main":
            self.main_reads += 1
            return {"object": {"sha": "f" * 40 if self.moves_at_end and self.main_reads > 1 else self.main}}
        if suffix == f"/git/commits/{self.main}":
            return self.landed
        if suffix == f"/git/commits/{SOURCE}":
            return self.candidate
        if suffix == "/pulls/42":
            self.pr_reads += 1
            snapshot = self.final_pr if self.final_pr and self.pr_reads > 1 else self.pr
            # The real API retains every response body; the receipt keeps both.
            self.evidence.append({"endpoint": endpoint, "body": json.dumps(snapshot)})
            return snapshot
        if suffix == f"/compare/{BASE}...{SOURCE}?per_page=1":
            return {"status": "ahead", "merge_base_commit": {"sha": BASE}}
        if suffix.startswith("/actions/runs/"):
            identity = int(suffix.split("/")[-1])
            return self.runs.get(identity, self.extra_runs.get(identity))
        raise AssertionError(endpoint)

    def archive(self, job):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as bundle:
            bundle.writestr("protected-ci-reuse.json", json.dumps(self.sources[job]))
        return buffer.getvalue()

    def raw(self, endpoint):
        return self.archive(endpoint.split("/")[-2])

    def pages(self, endpoint, kind):
        suffix = endpoint.removeprefix(reuse.PREFIX)
        if suffix in (f"/commits/{self.main}/pulls", f"/commits/{SOURCE}/pulls"):
            return [self.pr]
        if suffix == f"/commits/{SOURCE}/check-runs?filter=all":
            return self.checks
        if suffix.startswith("/actions/workflows/"):
            filename = suffix.split("/")[3]
            return [run for run in [*self.runs.values(), *self.extra_runs.values()]
                    if run["path"] == ".github/workflows/" + filename]
        match = re.fullmatch(r"/actions/runs/(\d+)/(.*)", suffix)
        if match:
            identity, target = int(match[1]), match[2]
            if target == "jobs?filter=all":
                return self.jobs[identity]
            if target == "artifacts":
                return [{"id": job, "name": f"ci-reuse-{source['run_attempt']}-{source['job']}", "expired": False,
                         "digest": "sha256:" + ("0" * 64 if self.corrupt_digest else hashlib.sha256(self.archive(job)).hexdigest())}
                        for job, source in self.sources.items() if source["run_id"] == identity]
        raise AssertionError(endpoint)


class LandingTests(unittest.TestCase):
    def setUp(self):
        self.api = LandingAPI()

    def verify(self, inapplicable=(), candidate_only=False):
        def command(args):
            return (SOURCE if candidate_only else self.api.main) if args[:2] == ["git", "rev-parse"] else "MasonsBudget/example.swift\0shared/domain/example.ts\0"
        with patch.object(reuse, "authority", return_value=self.api.protection), patch.object(reuse, "command", side_effect=command), \
             patch.object(reuse, "inapplicable_source_checks", return_value=set(inapplicable)), patch.dict(reuse.os.environ, {"BUDGET_CI_REUSE_EPOCH": ""}):
            return reuse.verify_qualification(self.api, SOURCE if candidate_only else self.api.main, candidate_only=candidate_only)

    def refuse(self):
        with self.assertRaises(reuse.Refusal):
            self.verify()

    def test_complete_premerge_source_preserves_provider_identity_at_merge(self):
        result = self.verify()
        self.assertEqual(result["landed_commit"]["sha"], LANDED)
        self.assertEqual(result["candidate_commit"]["sha"], SOURCE)
        self.assertEqual(len(result["source_checks"]), 11)
        self.assertEqual(result["source_proofs"]["swift"]["source_proof"]["head_sha"], SOURCE)
        self.assertNotIn("platform CI", str(result["fresh_checks"]))

    def test_premerge_qualification_binds_current_base_without_inventing_a_landing(self):
        self.api.main = BASE
        self.api.pr.update(merged=False, merged_at=None, merge_commit_sha=None)
        result = self.verify(candidate_only=True)
        self.assertEqual(result["mode"], "qualified-candidate")
        self.assertNotIn("landed_commit", result)
        self.assertEqual(result["candidate_commit"]["sha"], SOURCE)
        self.api.main = "f" * 40
        with self.assertRaises(reuse.Refusal):
            self.verify(candidate_only=True)

    def test_canonical_fast_forward_can_precede_mirror_pr_closure(self):
        self.api.main = SOURCE
        self.api.landed = self.api.candidate
        self.api.pr.update(merged=False, merged_at=None, merge_commit_sha=None)
        self.assertEqual(self.verify()["landed_commit"]["sha"], SOURCE)

    def test_later_unrelated_skipped_check_suite_does_not_shadow_source(self):
        self.api.checks.extend([{**check, "id": check["id"] + 90000, "conclusion": "skipped",
                                 "check_suite": {"id": 999}} for check in list(self.api.checks)])
        self.assertEqual(len(self.verify()["reused_checks"]), 11)

    def test_newer_failed_source_workflow_never_falls_back(self):
        self.api.add_run(99)["conclusion"] = "failure"
        self.refuse()

    def test_later_rerun_of_older_run_blocks_candidate_and_landing(self):
        for candidate_only in (False, True):
            for status, conclusion in (("completed", "failure"), ("completed", "cancelled"),
                                       ("in_progress", None), ("queued", None), ("waiting", None)):
                with self.subTest(candidate_only=candidate_only, status=status, conclusion=conclusion):
                    self.api = LandingAPI()
                    self.api.add_run(10)
                    self.api.runs[1].update(run_attempt=2, run_started_at=ago(5),
                                            updated_at=ago(4), status=status, conclusion=conclusion)
                    if candidate_only:
                        self.api.main = BASE
                        self.api.pr.update(merged=False, merged_at=None, merge_commit_sha=None)
                    with self.assertRaisesRegex(reuse.Refusal, "source workflow (is pending|did not succeed)"):
                        self.verify(candidate_only=candidate_only)

    def test_successful_older_run_rerun_supersedes_later_created_failure(self):
        self.api.add_run(10)["conclusion"] = "failure"
        self.api.runs[1].update(run_attempt=2, run_started_at=ago(5), updated_at=ago(4))
        for job in self.api.jobs[1]:
            job.update(run_attempt=2, completed_at=ago(4))
        for source in self.api.sources.values():
            if source["run_id"] == 1:
                source["run_attempt"] = 2
        result = self.verify()
        self.assertEqual(result["source_workflows"]["clients.yml"]["id"], 1)
        self.assertEqual(result["source_proofs"]["shared-domain"]["source_proof"]["run_attempt"], 2)

    def test_metadata_update_does_not_refresh_or_reorder_execution(self):
        self.api.add_run(10)
        self.api.runs[1].update(conclusion="failure", updated_at=ago(1))
        result = self.verify()
        self.assertEqual(result["source_workflows"]["clients.yml"]["id"], 10)
        self.api.extra_runs[10].update(run_started_at=ago(60 * 49), updated_at=ago(0))
        self.api.runs[1]["run_started_at"] = ago(60 * 50)
        for identity, minutes in ((1, 60 * 50 - 1), (10, 60 * 49 - 1)):
            for job in self.api.jobs[identity]:
                job["completed_at"] = ago(minutes)
        with self.assertRaisesRegex(reuse.Refusal, "source execution expired"):
            self.verify()

    def test_pending_rerun_with_previous_start_is_not_hidden(self):
        self.api.add_run(10)
        self.api.runs[1].update(status="queued", conclusion=None, run_attempt=2)
        with self.assertRaisesRegex(reuse.Refusal, "source workflow is pending"):
            self.verify()

    def test_missing_tied_and_invalid_execution_order_refuse(self):
        self.api.add_run(10)
        for value in (None, "invalid", "2026-09-07T00:00:00", ago(-5),
                      self.api.extra_runs[10]["run_started_at"]):
            with self.subTest(timestamp=value):
                self.api.runs[1]["run_started_at"] = value
                self.refuse()

    def test_overlapping_older_attempt_cannot_hide_its_later_outcome(self):
        self.api.add_run(10)
        for conclusion in ("failure", "cancelled", "success"):
            with self.subTest(conclusion=conclusion):
                self.api.runs[1]["conclusion"] = conclusion
                self.api.jobs[1][0].update(conclusion=conclusion, completed_at=ago(5))
                with self.assertRaisesRegex(reuse.Refusal, "execution order is ambiguous"):
                    self.verify()

    def test_missing_latest_attempt_jobs_and_incomplete_chronology_refuse(self):
        self.api.add_run(10)
        self.api.runs[1]["run_attempt"] = 2
        with self.assertRaisesRegex(reuse.Refusal, "latest source attempt has missing or pending jobs"):
            self.verify()
        self.api.runs[1]["run_attempt"] = 1
        self.api.jobs[1][0]["completed_at"] = None
        self.refuse()

    def test_final_readback_catches_a_new_rerun_of_an_older_run(self):
        self.api.add_run(10)
        pages = self.api.pages
        reads = 0
        def reread(endpoint, kind):
            nonlocal reads
            if "/actions/workflows/clients.yml/runs?" in endpoint:
                reads += 1
                if reads == 2:
                    self.api.runs[1].update(run_attempt=2, run_started_at=ago(5), conclusion="failure")
            return pages(endpoint, kind)
        with patch.object(self.api, "pages", side_effect=reread):
            with self.assertRaisesRegex(reuse.Refusal, "latest source workflow did not succeed"):
                self.verify()
        self.assertEqual(reads, 2)

    def test_failed_pending_cancelled_and_skipped_source_jobs_refuse(self):
        for conclusion in ("failure", "cancelled", "skipped", None):
            with self.subTest(conclusion=conclusion):
                self.api.jobs[1][2]["conclusion"] = conclusion
                self.refuse()

    def test_skipped_context_requires_applicability_and_stays_skipped(self):
        name = "Linux client"
        next(job for job in self.api.jobs[1] if job["name"] == name)["conclusion"] = "skipped"
        next(check for check in self.api.checks if check["name"] == name)["conclusion"] = "skipped"
        self.refuse()
        result = self.verify({name})
        self.assertNotIn(name, result["reused_checks"])
        self.assertNotIn("linux-client", result["source_proofs"])

    def test_noop_apple_edit_uses_original_successful_suite(self):
        run = self.api.add_run(99, original=2)
        self.api.jobs[99][0]["steps"] = [{"name": "Recognize a base-unchanged PR edit", "conclusion": "success"}]
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        self.api.sources["swift-routing-99"].update(event_action="edited", base_changed=False)
        result = self.verify()
        self.assertEqual(result["source_workflows"]["swift.yml"]["id"], 2)
        self.assertEqual(result["ignored_unchanged_edit_runs"], [run])

    def overlapping_apple_edit(self, *, started=10):
        run = self.api.add_run(99, original=2, started=started)
        self.api.jobs[99][0]["steps"] = [{"name": "Recognize a base-unchanged PR edit", "conclusion": "success"}]
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        for identity, completed in ((2, 5), (99, 9)):
            for job in self.api.jobs[identity]:
                job["completed_at"] = ago(completed)
        self.api.sources["swift-routing-99"].update(event_action="edited", base_changed=False)
        return run

    def test_proved_noop_overlap_in_either_direction_preserves_real_apple_execution(self):
        for candidate_only in (False, True):
            for started in (10, 25):
                with self.subTest(candidate_only=candidate_only, noop_started=started):
                    self.api = LandingAPI()
                    run = self.overlapping_apple_edit(started=started)
                    if candidate_only:
                        self.api.main = BASE
                        self.api.pr.update(merged=False, merged_at=None, merge_commit_sha=None)
                    result = self.verify(candidate_only=candidate_only)
                    self.assertEqual(result["source_workflows"]["swift.yml"]["id"], 2)
                    self.assertEqual(result["ignored_unchanged_edit_runs"], [run])
                    proof = result["ignored_event_proofs"][0]
                    self.assertEqual(proof["run"]["id"], 99)
                    self.assertEqual(proof["source_proof"]["job"], "swift-routing")
                    self.assertEqual(proof["source_proof"]["base_sha"], BASE)
                    self.assertEqual(proof["tested_commit"]["tree"]["sha"], TREE)
                    apple = [item for item in result["source_executions"] if item["run_id"] == 2]
                    self.assertEqual(len(apple), 3)
                    self.assertTrue(all(item["job"]["conclusion"] == "success" for item in apple))
                    self.assertFalse(any(item["run_id"] == 99 for item in result["source_executions"]))

    def test_overlapping_noop_requires_complete_unchanged_source_proof(self):
        invalid = [("qualification_version", None), ("event_action", "synchronize"), ("base_changed", True),
                   ("head_sha", LANDED), ("run_attempt", 2), ("base_sha", "f" * 40),
                   ("tree_sha", "f" * 40), ("workflow_sha256", "0" * 64),
                   ("policy_sha256", "0" * 64), ("authority", {}), ("context", {})]
        for started in (10, 25):
            for field, value in [(None, None), *invalid]:
                with self.subTest(noop_started=started, field=field):
                    self.api = LandingAPI()
                    self.overlapping_apple_edit(started=started)
                    if field is None:
                        del self.api.sources["swift-routing-99"]
                    else:
                        self.api.sources["swift-routing-99"][field] = value
                    self.refuse()

    def test_pending_failed_and_unproved_overlapping_edits_refuse(self):
        for started in (10, 25):
            for status, conclusion in (("completed", "failure"), ("completed", "cancelled"),
                                       ("in_progress", None), ("queued", None)):
                with self.subTest(noop_started=started, status=status, conclusion=conclusion):
                    self.api = LandingAPI()
                    self.overlapping_apple_edit(started=started).update(status=status, conclusion=conclusion)
                    self.refuse()
            for defect in ("guard", "detector", "downstream", "pending_job", "missing_jobs"):
                with self.subTest(noop_started=started, defect=defect):
                    self.api = LandingAPI()
                    self.overlapping_apple_edit(started=started)
                    if defect == "guard":
                        self.api.jobs[99][0]["steps"][0]["conclusion"] = "skipped"
                    elif defect == "detector":
                        self.api.jobs[99][0]["conclusion"] = "failure"
                    elif defect == "downstream":
                        self.api.jobs[99][1]["conclusion"] = "success"
                    elif defect == "pending_job":
                        self.api.jobs[99][0]["status"] = "in_progress"
                    else:
                        self.api.jobs[99] = []
                    self.refuse()

    def test_proved_noop_does_not_hide_overlapping_real_apple_runs(self):
        for conclusion in ("success", "failure", "cancelled"):
            with self.subTest(conclusion=conclusion):
                self.api = LandingAPI()
                self.overlapping_apple_edit()
                self.api.add_run(88, original=2, started=7)
                self.api.runs[2]["conclusion"] = conclusion
                with self.assertRaisesRegex(reuse.Refusal, "execution order is ambiguous"):
                    self.verify()

    def test_completed_historical_noop_does_not_need_new_source_proof(self):
        self.overlapping_apple_edit(started=60 * 50)
        for job in self.api.jobs[99]:
            job["completed_at"] = ago(60 * 50 - 1)
        del self.api.sources["swift-routing-99"]
        result = self.verify()
        self.assertEqual(result["source_workflows"]["swift.yml"]["id"], 2)
        self.assertEqual(result["ignored_unchanged_edit_runs"], [])

    def test_older_run_noop_rerun_preserves_the_later_created_successful_suite(self):
        self.api.add_run(99, original=2)
        self.api.runs[2].update(run_attempt=2, run_started_at=ago(5), updated_at=ago(4))
        for index, original in enumerate(list(self.api.jobs[2])):
            job = {**original, "id": original["id"] + 90000, "run_attempt": 2, "completed_at": ago(4),
                   "conclusion": "success" if index == 0 else "skipped"}
            if index == 0:
                job["steps"] = [{"name": "Recognize a base-unchanged PR edit", "conclusion": "success"}]
            self.api.jobs[2].append(job)
        self.api.sources["swift-routing"].update(run_attempt=2, event_action="edited", base_changed=False)
        result = self.verify()
        self.assertEqual(result["source_workflows"]["swift.yml"]["id"], 99)
        self.assertEqual(result["ignored_unchanged_edit_runs"], [self.api.runs[2]])
        self.assertEqual(result["ignored_event_proofs"][0]["source_proof"]["run_attempt"], 2)
        self.api.sources["swift-routing"]["base_changed"] = True
        self.refuse()

    def test_skipped_apple_without_noop_guard_cannot_reuse_older_run(self):
        self.api.add_run(99, original=2)
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        self.refuse()

    def test_partial_rerun_keeps_original_attempt_and_its_age(self):
        # Run 10 was created later, but run 1's partial rerun executed last.
        self.api.add_run(10)
        self.api.runs[1].update(run_attempt=2, run_started_at=ago(5), updated_at=ago(4))
        previous = next(job for job in self.api.jobs[1] if job["name"] == "Linux client")
        check_id = 99001
        self.api.jobs[1].append({**previous, "id": check_id + 10000, "run_attempt": 2, "completed_at": ago(4),
            "check_run_url": f"https://api.github.com{reuse.PREFIX}/check-runs/{check_id}"})
        check = next(check for check in self.api.checks if check["name"] == "Linux client")
        self.api.checks.append({**check, "id": check_id})
        self.api.sources["linux-client"]["run_attempt"] = 2
        result = self.verify()
        self.assertEqual(result["source_workflows"]["clients.yml"]["id"], 1)
        self.assertEqual(result["source_proofs"]["shared-domain"]["source_proof"]["run_attempt"], 1)
        self.assertEqual(result["source_proofs"]["linux-client"]["source_proof"]["run_attempt"], 2)
        self.api.jobs[1][2]["completed_at"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).isoformat()
        with self.assertRaisesRegex(reuse.Refusal, "source execution expired"):
            self.verify()

    def test_newer_failed_job_cannot_use_older_success(self):
        self.api.runs[1]["run_attempt"] = 2
        self.api.jobs[1].append({**self.api.jobs[1][2], "run_attempt": 2, "conclusion": "failure"})
        self.refuse()

    def test_proof_digest_and_job_check_ownership_are_required(self):
        self.api.corrupt_digest = True
        self.refuse()
        self.api.corrupt_digest = False
        self.api.jobs[1][2]["check_run_url"] = "https://api.github.com/repos/attacker/check-runs/1003"
        self.refuse()

    def test_missing_legacy_or_relabeled_proof_refuses(self):
        for field, value in [("qualification_version", None), ("mode", "reused"), ("head_sha", LANDED),
                             ("run_attempt", 2), ("policy_sha256", "0" * 64), ("epoch", "revoked"),
                             ("context", {}), ("workflow_sha256", "0" * 64), ("base_sha", "f" * 40)]:
            with self.subTest(field=field):
                original = self.api.sources["swift"][field]
                self.api.sources["swift"][field] = value
                self.refuse()
                self.api.sources["swift"][field] = original

    def test_landed_tree_parents_ref_and_required_app_changes_refuse(self):
        self.api.landed["parents"].reverse()
        self.refuse()
        self.api.landed["parents"].reverse()
        self.api.landed["tree"]["sha"] = "f" * 40
        self.refuse()
        self.api.landed["tree"]["sha"] = TREE
        self.api.moves_at_end = True
        self.refuse()
        self.api.moves_at_end = False
        self.api.protection["required_checks"][0]["integration_id"] = 999
        self.refuse()

    def test_source_path_rules_prove_only_unaffected_contexts_inapplicable(self):
        with patch.object(reuse, "command", return_value="linux/src/example.ts\0"):
            skipped = reuse.inapplicable_source_checks(self.api.sources["shared-domain"])
        self.assertEqual(skipped, {"Android client", "Credential mint tooling", "Verify committed Xcode project",
                                   "Build and test the Apple client"})
        with patch.object(reuse, "command", return_value="MasonsBudget/MasonsBudget/App/Example.swift\0"):
            self.assertNotIn("Build and test the Apple client", reuse.inapplicable_source_checks(self.api.sources["shared-domain"]))

    def test_fork_draft_missing_wrong_app_and_later_failed_check_refuse(self):
        self.api.pr["head"]["repo"]["full_name"] = "attacker/budget"
        self.refuse()
        self.api.pr["head"]["repo"]["full_name"] = reuse.REPO
        self.api.pr["draft"] = True
        self.refuse()
        self.api.pr["draft"] = False
        self.api.checks[0]["app"]["id"] = 999
        self.refuse()
        self.api.checks[0]["app"]["id"] = 15368
        self.api.checks.append({**self.api.checks[0], "id": 99001, "conclusion": "failure"})
        self.refuse()

    def test_noop_apple_event_requires_its_own_complete_unchanged_proof(self):
        self.api.add_run(99, original=2)
        self.api.jobs[99][0]["steps"] = [{"name": "Recognize a base-unchanged PR edit", "conclusion": "success"}]
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        proof = self.api.sources.pop("swift-routing-99")
        self.refuse()
        self.api.sources["swift-routing-99"] = {**proof, "event_action": "edited", "base_changed": True}
        self.refuse()

    def drifted_pr(self, **changes):
        """Copy of the source PR snapshot with dotted-path fields replaced."""
        final = copy.deepcopy(self.api.pr)
        for path, value in changes.items():
            target = final
            keys = path.split(".")
            for key in keys[:-1]:
                target = target.setdefault(key, {})
            target[keys[-1]] = value
        return final

    def test_nested_repository_metadata_drift_does_not_refuse(self):
        # Budget PR316 landed verification at 1f9d3b5e5656590601898469563839d50b52b025:
        # only base.repo.updated_at and head.repo.updated_at moved from
        # 2026-09-08T15:59:07Z to 2026-09-08T16:33:22Z during verification.
        later = "2026-09-08T16:33:22Z"
        self.api.final_pr = self.drifted_pr(**{"base.repo.updated_at": later, "head.repo.updated_at": later,
                                               "updated_at": later, "base.repo.pushed_at": later,
                                               "head.repo.open_issues_count": 3, "comments": 4, "mergeable_state": "unknown"})
        proof = self.verify()
        self.assertEqual(proof["pull_request"], self.api.pr)
        self.assertEqual(proof["pull_request"]["base"]["repo"]["updated_at"], "2026-09-08T15:59:07Z")
        snapshots = [json.loads(item["body"]) for item in self.api.evidence if item["endpoint"].endswith("/pulls/42")]
        self.assertEqual([snapshot["base"]["repo"]["updated_at"] for snapshot in snapshots],
                         ["2026-09-08T15:59:07Z", later])

    def test_pull_request_authority_drift_refuses(self):
        cases = {"head.sha": "e" * 40, "head.ref": "other", "head.repo.full_name": "other/fork", "head.repo.id": 99,
                 "base.sha": "e" * 40, "base.ref": "release", "base.repo.full_name": "other/fork", "base.repo.id": 99,
                 "state": "open", "draft": True, "merged": False, "merged_at": None, "merge_commit_sha": "e" * 40,
                 "merged_by.id": 8, "number": 43, "user.id": 5, "author_association": "NONE",
                 "maintainer_can_modify": True, "locked": True, "labels": [{"name": "skip-ci"}]}
        for path, value in cases.items():
            with self.subTest(field=path):
                self.api.pr_reads = 0
                self.api.evidence.clear()
                self.api.final_pr = self.drifted_pr(**{path: value})
                with self.assertRaisesRegex(reuse.Refusal, "source PR changed during verification"):
                    self.verify()

    def test_no_broad_workflow_has_a_main_push_trigger_or_step_reuse(self):
        for filename in reuse.WORKFLOW_CHECKS:
            text = Path(".github/workflows", filename).read_text()
            trigger = text.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
            self.assertNotRegex(trigger, r"(?m)^  push:")
            self.assertNotIn("steps.reuse.outputs", text)
        self.assertNotIn("main-push-policy: verify-all", Path(".github/workflows/clients.yml").read_text())


if __name__ == "__main__":
    unittest.main()
