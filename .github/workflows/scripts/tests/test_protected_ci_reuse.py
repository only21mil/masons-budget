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
        self.pr = {"number": 42, "merged": True, "merged_at": "2026-09-07T00:00:00Z", "draft": False,
                   "merged_by": {"id": 7}, "head": {"sha": SOURCE, "repo": {"full_name": reuse.REPO}},
                   "base": {"ref": "main", "repo": {"full_name": reuse.REPO}}, "merge_commit_sha": LANDED}
        self.protection = {"required_checks": [{"name": name, "integration_id": 15368}
                           for names in reuse.WORKFLOW_CHECKS.values() for name in names]}
        self.runs, self.jobs, self.checks, self.sources = {}, {}, [], {}
        for index, (filename, names) in enumerate(reuse.WORKFLOW_CHECKS.items(), 1):
            self.runs[index] = {"id": index, "run_attempt": 1, "status": "completed", "conclusion": "success",
                               "event": "pull_request", "path": ".github/workflows/" + filename,
                               "head_sha": SOURCE, "head_repository": {"full_name": reuse.REPO},
                               "check_suite_id": index * 100, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            self.jobs[index] = []
            for count, name in enumerate(names, 1):
                check_id = index * 1000 + count
                self.jobs[index].append({"id": check_id + 10000, "name": name, "run_attempt": 1,
                    "status": "completed", "conclusion": "success", "completed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
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
            return self.pr
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
        self.api.extra_runs[99] = {**self.api.runs[1], "id": 99, "conclusion": "failure"}
        self.refuse()

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
        run = self.api.extra_runs[99] = {**self.api.runs[2], "id": 99, "check_suite_id": 9900}
        self.api.jobs[99] = copy.deepcopy(self.api.jobs[2])
        self.api.jobs[99][0]["steps"] = [{"name": "Recognize a base-unchanged PR edit", "conclusion": "success"}]
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        self.api.sources["swift-routing-noop"] = {**self.api.sources["swift-routing"],
            "run_id": 99, "event_action": "edited", "base_changed": False}
        result = self.verify()
        self.assertEqual(result["source_workflows"]["swift.yml"]["id"], 2)
        self.assertEqual(result["ignored_unchanged_edit_runs"], [run])

    def test_skipped_apple_without_noop_guard_cannot_reuse_older_run(self):
        self.api.extra_runs[99] = {**self.api.runs[2], "id": 99, "check_suite_id": 9900}
        self.api.jobs[99] = copy.deepcopy(self.api.jobs[2])
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        self.refuse()

    def test_partial_rerun_keeps_original_attempt_and_its_age(self):
        self.api.runs[1]["run_attempt"] = 2
        result = self.verify()
        self.assertEqual(result["source_proofs"]["shared-domain"]["source_proof"]["run_attempt"], 1)
        self.api.jobs[1][2]["completed_at"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).isoformat()
        self.refuse()

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
        self.api.extra_runs[99] = {**self.api.runs[2], "id": 99, "check_suite_id": 9900}
        self.api.jobs[99] = copy.deepcopy(self.api.jobs[2])
        self.api.jobs[99][0]["steps"] = [{"name": "Recognize a base-unchanged PR edit", "conclusion": "success"}]
        for job in self.api.jobs[99][1:]:
            job["conclusion"] = "skipped"
        self.refuse()
        self.api.sources["swift-routing-noop"] = {**self.api.sources["swift-routing"],
            "run_id": 99, "event_action": "edited", "base_changed": True}
        self.refuse()

    def test_no_broad_workflow_has_a_main_push_trigger_or_step_reuse(self):
        for filename in reuse.WORKFLOW_CHECKS:
            text = Path(".github/workflows", filename).read_text()
            trigger = text.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
            self.assertNotRegex(trigger, r"(?m)^  push:")
            self.assertNotIn("steps.reuse.outputs", text)
        self.assertNotIn("main-push-policy: verify-all", Path(".github/workflows/clients.yml").read_text())


if __name__ == "__main__":
    unittest.main()
