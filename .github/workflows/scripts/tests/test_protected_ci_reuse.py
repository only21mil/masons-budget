#!/usr/bin/env python3
"""Exercise real reuse acquisition and workflow skip boundaries without GitHub."""
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


class FakeAPI:
    def __init__(self, source, run, pr, landed, check):
        self.source, self.run, self.pr, self.landed, self.check = source, run, pr, landed, check
        self.main = LANDED
        self.source_commit = {"sha": SOURCE, "tree": {"sha": TREE}, "parents": [{"sha": BASE}]}
        self.tested_commit = {"sha": "e" * 40, "tree": {"sha": TREE}, "parents": [{"sha": BASE}, {"sha": SOURCE}]}
        self.job_conclusion = "success"
        self.artifacts = True
        self.corrupt_digest = False
        self.archive_extra = False
        self.evidence = []
        self.additional_checks = []

    def one(self, endpoint):
        suffix = endpoint.removeprefix(reuse.PREFIX)
        if suffix == "/git/ref/heads/main":
            return {"object": {"sha": self.main}}
        if suffix == f"/git/commits/{self.main}":
            return self.landed
        if suffix == f"/git/commits/{SOURCE}":
            return self.source_commit
        if suffix == f"/git/commits/{'e' * 40}":
            return self.tested_commit
        if suffix == f"/compare/{BASE}...{SOURCE}?per_page=1":
            return {"status": "ahead", "merge_base_commit": {"sha": BASE}}
        if suffix == "/pulls/42":
            return self.pr
        if suffix == "/actions/runs/100":
            return self.run
        raise AssertionError(endpoint)

    def archive(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as bundle:
            bundle.writestr("protected-ci-reuse.json", json.dumps(self.source))
            if self.archive_extra:
                bundle.writestr("surprise", "untrusted")
        return output.getvalue()

    def raw(self, endpoint):
        if endpoint == reuse.PREFIX + "/actions/artifacts/500/zip":
            return self.archive()
        raise AssertionError(endpoint)

    def pages(self, endpoint, kind):
        suffix = endpoint.removeprefix(reuse.PREFIX)
        if suffix == f"/commits/{self.main}/pulls":
            return [self.pr]
        if suffix == f"/actions/workflows/clients.yml/runs?head_sha={SOURCE}&event=pull_request":
            return [self.run]
        if suffix == f"/actions/runs?head_sha={SOURCE}&event=pull_request":
            return [self.run]
        if suffix == "/actions/runs/100/artifacts":
            return [{"id": 500, "name": "ci-reuse-1-shared-domain", "expired": False,
                     "digest": "sha256:" + ("0" * 64 if self.corrupt_digest else hashlib.sha256(self.archive()).hexdigest())}] if self.artifacts else []
        if suffix == f"/commits/{SOURCE}/check-runs?filter=all":
            return [self.check, *self.additional_checks]
        if suffix == "/actions/runs/100/attempts/1/jobs":
            return [{"id": 80, "name": "Shared domain contract", "status": "completed", "conclusion": self.job_conclusion}]
        raise AssertionError(endpoint)


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.context = {"environment": {"ImageVersion": "20260906.1"}, "versions": {"node": "24.0.0", "os_packages": "node=24"}}
        self.authority = {"required_checks": [{"name": "Shared domain contract", "integration_id": 15368}], "strict_policies": [False]}
        self.run = {"id": 100, "run_attempt": 1, "status": "completed", "conclusion": "success", "event": "pull_request",
                    "path": reuse.workflow("shared-domain"), "head_repository": {"full_name": reuse.REPO}, "head_sha": SOURCE,
                    "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "check_suite_id": 300, "workflow_id": 10}
        self.pr = {"number": 42, "merged": True, "merged_at": "2026-09-07T00:00:00Z", "state": "closed", "draft": False,
                   "merged_by": {"id": 7}, "head": {"sha": SOURCE, "repo": {"full_name": reuse.REPO}},
                   "base": {"ref": "main", "repo": {"full_name": reuse.REPO}}, "merge_commit_sha": LANDED}
        self.landed = {"sha": LANDED, "tree": {"sha": TREE}, "parents": [{"sha": BASE}, {"sha": SOURCE}]}
        self.source = {"schema_version": 1, "mode": "source", "repository": reuse.REPO, "job": "shared-domain",
                       "check_scope": reuse.CHECK_SCOPE["shared-domain"], "run_id": 100, "run_attempt": 1, "head_sha": SOURCE, "base_sha": BASE, "tested_sha": "e" * 40,
                       "tree_sha": TREE, "pull_request": 42, "workflow_sha256": hashlib.sha256(Path(reuse.workflow("shared-domain")).read_bytes()).hexdigest(),
                       "context": copy.deepcopy(self.context), "authority": copy.deepcopy(self.authority)}
        self.check = {"id": 800, "name": "Shared domain contract", "head_sha": SOURCE, "status": "completed", "conclusion": "success",
                      "app": {"id": 15368, "slug": "github-actions"}, "check_suite": {"id": 300},
                      "started_at": "2026-09-07T00:00:00Z", "completed_at": "2026-09-07T01:00:00Z",
                      "html_url": "https://github.com/only21mil/masons-budget/actions/runs/100/job/80",
                      "details_url": "https://github.com/only21mil/masons-budget/actions/runs/100/job/80"}
        self.api = FakeAPI(self.source, self.run, self.pr, self.landed, self.check)

    def acquire(self):
        with patch.object(reuse, "authority", return_value=self.authority), patch.object(reuse, "command", return_value=self.api.main):
            return reuse.acquire_reuse(self.api, "shared-domain", self.api.main, self.context, BASE)

    def refuse(self):
        with self.assertRaises((reuse.Refusal,)):
            self.acquire()

    def test_distinct_candidate_synthetic_and_landed_sha_reuses_identical_tree(self):
        result = self.acquire()
        self.assertEqual(result["mode"], "reused")
        self.assertEqual(result["head_sha"], LANDED)
        self.assertEqual(result["source_proof"]["head_sha"], SOURCE)
        self.assertEqual(result["source_proof"]["mode"], "source")
        self.assertEqual(result["protected_checks"][0]["check_run_id"], 800)

    def test_changed_tree(self):
        self.landed["tree"]["sha"] = "f" * 40
        self.refuse()

    def test_digest_valid_artifact_cannot_relabel_provider_source_tree(self):
        self.api.source_commit["tree"]["sha"] = "f" * 40
        self.refuse()

    def test_digest_valid_artifact_cannot_relabel_provider_tested_tree(self):
        self.api.tested_commit["tree"]["sha"] = "f" * 40
        self.refuse()

    def test_tested_merge_wrong_ordered_parents(self):
        self.api.tested_commit["parents"].reverse()
        self.refuse()

    def test_tested_candidate_sha_itself_is_allowed(self):
        self.source["tested_sha"] = SOURCE
        self.assertEqual(self.acquire()["mode"], "reused")

    def test_reversed_or_added_parent(self):
        self.landed["parents"].reverse()
        self.refuse()

    def test_workflow_change(self):
        self.source["workflow_sha256"] = "0" * 64
        self.refuse()

    def test_runner_context_change(self):
        self.context["environment"]["ImageVersion"] = "new-image"
        self.refuse()

    def test_resolved_dependency_change(self):
        self.context["versions"]["os_packages"] = "xorriso=2"
        self.refuse()

    def test_protection_change(self):
        self.authority["strict_policies"] = [True]
        self.refuse()

    def test_wrong_repo_or_event(self):
        for field, bad in [("event", "workflow_dispatch"), ("path", ".github/workflows/untrusted.yml")]:
            with self.subTest(field=field):
                old = self.run[field]
                self.run[field] = bad
                self.refuse()
                self.run[field] = old

    def test_unmerged_or_wrong_pr_authority(self):
        for field, value in [("merged", False), ("merge_commit_sha", SOURCE), ("merged_by", None)]:
            with self.subTest(field=field):
                old = self.pr[field]
                self.pr[field] = value
                self.refuse()
                self.pr[field] = old

    def test_fork_refused(self):
        self.pr["head"]["repo"]["full_name"] = "attacker/buzz"
        self.refuse()

    def test_failed_or_pending_or_cancelled_source(self):
        for status, conclusion in [("completed", "failure"), ("in_progress", None), ("completed", "cancelled")]:
            self.run.update(status=status, conclusion=conclusion)
            self.refuse()

    def test_failed_job_despite_successful_run(self):
        self.api.job_conclusion = "failure"
        self.refuse()

    def test_failed_required_check_despite_successful_run(self):
        self.check["conclusion"] = "failure"
        self.refuse()

    def test_required_check_wrong_app_or_suite(self):
        self.check["app"]["id"] = 1
        self.refuse()
        self.check["app"]["id"] = 15368
        self.check["check_suite"]["id"] = 99
        self.refuse()

    def test_changed_run_attempt_cannot_reuse_old_artifact(self):
        self.source["run_attempt"] = 2
        self.refuse()

    def test_old_run_expired(self):
        self.run["updated_at"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).isoformat()
        self.refuse()

    def test_main_moved(self):
        self.api.main = "f" * 40
        self.refuse()

    def test_source_artifact_is_required_not_legacy_receipt_relabel(self):
        self.api.artifacts = False
        self.refuse()

    def test_reused_proof_cannot_become_source(self):
        self.source["mode"] = "reused"
        self.refuse()

    def test_corrupt_digest_and_extra_archive_file(self):
        self.api.corrupt_digest = True
        self.refuse()
        self.api.corrupt_digest = False
        self.api.archive_extra = True
        self.refuse()

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


    def test_fast_forward_exact_candidate_keeps_source_provenance(self):
        self.api.main = SOURCE
        self.landed.update(sha=SOURCE, parents=[{"sha": BASE}])
        self.pr["merge_commit_sha"] = SOURCE
        result = self.acquire()
        self.assertEqual(result["head_sha"], SOURCE)
        self.assertEqual(result["source_proof"]["run_id"], 100)
        with patch.object(reuse, "authority", return_value=self.authority), patch.object(reuse, "command", return_value=SOURCE):
            with self.assertRaisesRegex(reuse.Refusal, "push base"):
                reuse.acquire_reuse(self.api, "shared-domain", SOURCE, self.context, "f" * 40)

    def test_new_main_suite_does_not_relabel_or_hide_pr_source_result(self):
        self.api.additional_checks = [{**self.check, "id": 999, "status": "in_progress", "conclusion": None,
                                       "check_suite": {"id": 901}}]
        result = self.acquire()
        self.assertEqual(result["protected_checks"][0]["check_run_id"], 800)
        self.assertEqual(result["source_run"]["id"], 100)

    def test_reused_command_scope_cannot_be_broadened(self):
        self.source["check_scope"] = ["all job work"]
        self.refuse()

    def test_unrelated_skips_require_exact_changed_path_proof(self):
        with patch.object(reuse, "command", return_value="linux/src/example.ts\0"):
            skipped = reuse.inapplicable_source_checks(self.source)
        self.assertEqual(skipped, {"Android client", "Build and test the Apple client"})
        check = {**self.check, "name": "Build and test the Apple client", "conclusion": "skipped"}
        required = [{"name": check["name"], "integration_id": 15368}]
        self.assertEqual(reuse.select_checks([check], required, SOURCE, skipped)[0]["provider_result"]["conclusion"], "skipped")
        with patch.object(reuse, "command", return_value="MasonsBudget/MasonsBudget/App/Example.swift\0"):
            affected = reuse.inapplicable_source_checks(self.source)
        with self.assertRaises(reuse.Refusal):
            reuse.select_checks([check], required, SOURCE, affected)
        self.check["conclusion"] = "skipped"
        self.refuse()

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
        self.assertEqual(result["required_checks"], self.authority["required_checks"])
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

    def test_tested_commit_tree_and_parents_are_independently_bound(self):
        self.api.tested_commit["tree"]["sha"] = "f" * 40
        self.refuse()
        self.api.tested_commit["tree"]["sha"] = TREE
        self.api.tested_commit["parents"].reverse()
        self.refuse()

    def test_latest_app_check_failure_never_falls_back_to_old_success(self):
        rows = [self.check, {**self.check, "id": 801, "conclusion": "failure"}]
        with self.assertRaises(reuse.Refusal):
            reuse.select_checks(rows, self.authority["required_checks"], SOURCE)

    def test_workflows_reuse_only_named_checks_and_keep_artifacts_fresh(self):
        for file, expected in [("clients.yml", ["shared-domain", "convex-wire-golden", "convex-functions", "linux-client", "android-client"]), ("swift.yml", ["swift"])]:
            workflow = Path(".github/workflows", file).read_text()
            blocks = dict(re.findall(r"(?ms)^  ([a-z0-9-]+):\n(.*?)(?=^  [a-z0-9-]+:\n|\Z)", workflow))
            for job in expected:
                block = blocks[job]
                self.assertIn("id: reuse", block)
                for permission in ("checks: read", "actions: read", "pull-requests: read"):
                    self.assertIn(permission, block)
                self.assertIn("steps.reuse.outputs.reused != 'true'", block)
                self.assertIn("Retain protected result provenance", block)
            for job in set(blocks) - set(expected):
                self.assertNotIn("id: reuse", blocks[job])
            for step in ["Build", "Capture design packet", "Design-packet tests", "Assemble stable-signed debug APK", "Verify Android builds cannot embed a read credential", "iOS unit tests", "Boot the simulator"]:
                match = re.search(r"(?ms)^      - name: " + re.escape(step) + r"\n(.*?)(?=^      - |\Z)", workflow)
                if match:
                    self.assertNotIn("steps.reuse", match[1])
        self.assertNotIn("id: reuse", Path(".github/workflows/workflow-lint.yml").read_text())
        for name in ("buzz-ios-release.yml", "buzz-macos-release.yml"):
            self.assertNotIn("protected_ci_reuse", Path(".github/workflows", name).read_text())


if __name__ == "__main__":
    unittest.main()
