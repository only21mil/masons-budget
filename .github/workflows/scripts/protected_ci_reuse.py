#!/usr/bin/env python3
"""Reuse selected tree-scoped CI work, retaining a separate exact-main proof.

This is a CI optimization, not merge/review/deployment authorization. A refusal
runs the ordinary job. Never change a source receipt's commit or conclusion.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile
import shutil

REPO = "only21mil/masons-budget"
PREFIX = f"/repos/{REPO}"
JOBS = {
    "shared-domain": ("clients.yml", "Shared domain contract"),
    "convex-wire-golden": ("clients.yml", "Production wire golden decoders"),
    "convex-functions": ("clients.yml", "Convex functions"),
    "linux-client": ("clients.yml", "Linux client"),
    "android-client": ("clients.yml", "Android client"),
    "swift": ("swift.yml", "Build and test the Apple client"),
}

CHECK_SCOPE = {
    "shared-domain": ["Typecheck", "Parity tests against the Swift contract"],
    "convex-wire-golden": ["Fixture synthetic-content guard", "Fixture provenance and Linux values", "Linux wire decoder"],
    "convex-functions": ["Typecheck deployable Convex functions", "Typecheck Convex tests", "Read/mutation auth and todo LWW tests"],
    "linux-client": ["Typecheck renderer", "Typecheck electron main/preload", "Lint", "Preload boundary guard", "Render matrix (20 routes x profiles x states)"],
    "android-client": ["Domain parity tests (shared fixture, no Android SDK)", "Lint Android app", "App unit tests"],
    "swift": ["macOS build"],
}


def workflow(job):
    return ".github/workflows/" + JOBS[job][0]


MAX_AGE = 86400
LIMIT = 4 * 1024 * 1024


class Refusal(Exception):
    pass


def need(condition, message):
    if not condition:
        raise Refusal(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60, check=False)
    need(result.returncode == 0, f"context command unavailable: {args[0]}")
    return (result.stdout or result.stderr).strip()


class API:
    """Read only, fixed-host API client. Never retain or print credentials."""
    def __init__(self):
        self.evidence = []
        self.config = tempfile.TemporaryDirectory(prefix="budget-ci-reuse-gh-")

    def raw(self, endpoint):
        need(endpoint.startswith((PREFIX + "/", "/orgs/only21mil/", "/enterprises/only21mil/"))
             or endpoint == PREFIX, "API origin/repository mismatch")
        comparison = re.fullmatch(re.escape(PREFIX) + r"/compare/[0-9a-f]{40}\.\.\.[0-9a-f]{40}\?per_page=1", endpoint)
        need((".." not in endpoint or comparison) and "#" not in endpoint, "invalid API path")
        env = {key: value for key, value in os.environ.items()
               if key in ("PATH", "HOME", "GH_TOKEN", "SSL_CERT_FILE", "SSL_CERT_DIR")}
        env.update(GH_HOST="github.com", GH_PROMPT_DISABLED="1", GH_CONFIG_DIR=self.config.name)
        result = subprocess.run([shutil.which("gh") or "/usr/bin/gh", "api", "--hostname", "github.com", "--method", "GET",
                                 "-H", "X-GitHub-Api-Version: 2022-11-28", endpoint],
                                env=env, capture_output=True, timeout=60, check=False)
        need(result.returncode == 0, "GitHub evidence unavailable")
        need(len(result.stdout) <= LIMIT, "GitHub evidence exceeds size limit")
        return result.stdout

    def one(self, endpoint):
        body = json.loads(self.raw(endpoint))
        self.evidence.append({"endpoint": endpoint, "body": body, "sha256": digest(body)})
        return body

    def pages(self, endpoint, kind):
        key = {"checks": "check_runs", "runs": "workflow_runs", "jobs": "jobs", "artifacts": "artifacts"}.get(kind)
        values = []
        for page in range(1, 21):
            body = self.one(endpoint + ("&" if "?" in endpoint else "?") + f"per_page=100&page={page}")
            rows = body[key] if key else body
            need(isinstance(rows, list), "invalid GitHub page")
            values.extend(rows)
            if len(rows) < 100:
                return values
        raise Refusal("GitHub pagination limit exceeded")


def authority(api):
    """Bind public active protection; hidden bypass/review policy stays a delivery gate."""
    repository = api.one(PREFIX)
    need(repository["full_name"] == REPO and repository["default_branch"] == "main", "repository authority changed")
    rules = api.pages(PREFIX + "/rules/branches/main", "array")
    required, sources, policies = {}, set(), []
    for rule in rules:
        sources.add((rule["ruleset_id"], rule["ruleset_source_type"], rule["ruleset_source"]))
        if rule["type"] != "required_status_checks":
            continue
        params = rule["parameters"]
        need(isinstance(params["strict_required_status_checks_policy"], bool), "invalid strict policy")
        policies.append(params["strict_required_status_checks_policy"])
        for check in params["required_status_checks"]:
            name, app = check["context"], check["integration_id"]
            need(isinstance(name, str) and name and isinstance(app, int) and app > 0, "required check is not app-bound")
            need(name not in required or required[name] == app, "ambiguous required check app")
            required[name] = app
    branch = api.one(PREFIX + "/branches/main")
    need(branch["name"] == "main" and branch["protected"] is True, "main branch is not protected")
    legacy = branch.get("protection", {})
    legacy_checks = legacy.get("required_status_checks", {}).get("checks", [])
    for check in legacy_checks:
        name, app = check["context"], check["app_id"]
        need(isinstance(name, str) and name and isinstance(app, int) and app > 0, "legacy check is not app-bound")
        need(name not in required or required[name] == app, "ambiguous legacy required check app")
        required[name] = app
    need(required, "no app-bound required checks")
    metadata = []
    for identity, kind, origin in sorted(sources):
        prefix = {"Repository": "/repos/", "Organization": "/orgs/", "Enterprise": "/enterprises/"}.get(kind)
        need(prefix is not None and isinstance(identity, int) and identity > 0, "unsupported ruleset authority")
        body = api.one(f"{prefix}{origin}/rulesets/{identity}")
        need(body["id"] == identity and body["source_type"] == kind and body["source"] == origin
             and body["enforcement"] == "active" and body["target"] == "branch", "inactive or changed ruleset authority")
        metadata.append({key: body[key] for key in (
            "id", "source_type", "source", "enforcement", "target", "conditions", "rules", "updated_at")})
    return {"repository_id": repository["id"], "rules": rules, "rulesets": metadata,
            "required_checks": [{"name": key, "integration_id": required[key]} for key in sorted(required)],
            "strict_policies": policies, "legacy_protection": legacy}


def select_checks(rows, requirements, head, allowed_skips=()):
    """Select latest exact-head checks from the configured Apps, never a stale success."""
    result = []
    for required in requirements:
        matches = [row for row in rows if row.get("name") == required["name"]
                   and (row.get("app") or {}).get("id") == required["integration_id"]]
        need(matches and all(isinstance(row.get("id"), int) for row in matches), "required app-bound check missing")
        latest = max(matches, key=lambda row: row["id"])
        need(latest["head_sha"] == head and latest["status"] == "completed"
             and (latest["conclusion"] == "success" or
                  latest["conclusion"] == "skipped" and required["name"] in allowed_skips),
             "required exact-head check did not succeed or prove inapplicable")
        result.append({"name": required["name"], "check_suite_id": latest["check_suite"]["id"],
                       "check_run_id": latest["id"], "provider_result": latest,
                       "superseded": [row for row in matches if row["id"] != latest["id"]]})
    return result


def inapplicable_source_checks(source):
    """Replay only the existing internal-PR path rules at the exact source/base.

    A skip never proves a reusable job succeeded. It can only explain an
    unrelated required context; source job success is checked independently.
    """
    paths = [name for name in command(["git", "diff", "--name-only", "-z",
                                      source["base_sha"], source["head_sha"], "--"]).split("\0") if name]
    clients = Path(".github/workflows/clients.yml").read_text()
    match = re.search(r"grep -qE '([^']+)' && wide=true", clients)
    need(match is not None, "source client path policy is unrecognized")
    wide = any(re.search(match[1], name) for name in paths)
    result = set()
    for job in ("linux-client", "android-client"):
        tree = job.split("-")[0]
        pattern = re.search(r"\[" + tree + r"\]='([^']+)'", clients)
        need(pattern is not None, "source client path map is unrecognized")
        if not wide and not any(re.search(pattern[1], name) for name in paths):
            result.add(JOBS[job][1])
    spec = importlib.util.spec_from_file_location("apple_paths", Path(__file__).with_name("apple_changed_tree.py"))
    apple = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(apple)
    if not apple.requires_apple(paths):
        result.add(JOBS["swift"][1])
    return result


def files_digest(directory, seen=()):
    """Hash installed dependency bytes and executable bits, not cache-hit labels."""
    directory = Path(directory)
    need(directory.is_dir(), "resolved dependency directory missing")
    need(directory.resolve() not in seen, "cyclic dependency directory")
    seen = (*seen, directory.resolve())
    entries = []
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if path.is_symlink():
            target = path.resolve()
            need(target.is_relative_to(Path.cwd().resolve()), "dependency link escapes checkout")
            content = files_digest(target, seen) if target.is_dir() else hashlib.sha256(target.read_bytes()).hexdigest()
            entries.append((relative, "link", os.readlink(path), content))
        elif path.is_file():
            entries.append((relative, path.stat().st_mode & 0o111, hashlib.sha256(path.read_bytes()).hexdigest()))
    need(entries, "resolved dependency directory empty")
    return digest(entries)


def context(job):
    """Measure inputs of the explicitly reused commands after ordinary setup.

    Main-only artifacts, credential checks and mutable simulator tests always run.
    Whole-tree identity pins scripts, workflows, action pins and lockfiles. Actual
    installed Node bytes or resolved Gradle artifacts also bind mutable setup.
    """
    env = {name: os.environ.get(name, "") for name in (
        "RUNNER_OS", "RUNNER_ARCH", "LANG", "LC_ALL", "TZ", "BUDGET_CI_REUSE_EPOCH")}
    need(env["RUNNER_OS"] and env["RUNNER_ARCH"], "runner identity missing")
    versions = {"python": command(["python3", "--version"])}
    if job == "swift":
        # Only the unsigned macOS compile is reused. iOS tests and simulator
        # preparation remain fresh because persistent device data is not proof.
        need(env["RUNNER_OS"] == "macOS" and os.environ.get("XCODE_VERSION") == "26.6", "unqualified Apple context")
        versions.update({"os": command(["sw_vers"]), "xcode": command(["xcodebuild", "-version"]),
                         "swift": command(["swift", "--version"]),
                         "sdk": command(["xcrun", "--sdk", "macosx", "--show-sdk-build-version"]),
                         "developer": command(["xcode-select", "-p"])})
        command(["codesign", "--verify", "--deep", "--strict", "/Applications/Xcode.app"])
        project = Path("MasonsBudget/MasonsBudget.xcodeproj/project.pbxproj").read_text()
        need("XCRemoteSwiftPackageReference" not in project and "XCLocalSwiftPackageReference" not in project,
             "external Apple package context is unproven")
        versions["compiler_sha256"] = hashlib.sha256(Path(command(["xcrun", "--find", "swiftc"])).read_bytes()).hexdigest()
    else:
        env.update({name: os.environ.get(name, "") for name in ("ImageOS", "ImageVersion")})
        need(env["ImageOS"] and env["ImageVersion"], "runner image identity missing")
        versions["os_packages"] = command(["dpkg-query", "-W", "-f=${Package}=${Version}\n"])
        if job == "android-client":
            need(os.environ.get("BUDGET_GRADLE_CONTEXT_STATUS") == "success", "Gradle context resolution did not succeed")
            manifest = Path(os.environ["RUNNER_TEMP"]) / "budget-gradle-context.json"
            dependencies = json.loads(manifest.read_text())
            need(dependencies.get("schema") == 1 and dependencies.get("artifacts")
                 and dependencies.get("configurations") and dependencies.get("pluginCache")
                 and dependencies.get("sdkPackages") and dependencies.get("gradle"), "resolved Gradle context missing")
            versions["gradle"] = dependencies
            versions["java"] = command(["java", "-XshowSettings:properties", "-version"])
            # Prefetched runtimes are independently checksum-verified by the
            # unchanged setup. Hash the exact files passed to offline tests.
            versions["robolectric"] = files_digest(Path(os.environ["RUNNER_TEMP"]) / "robolectric-dependencies")
        else:
            versions.update({name: command([name, "--version"]) for name in ("node", "npm")})
            versions["node_modules"] = {str(path): files_digest(path) for path in (
                Path("node_modules"), Path("linux/node_modules"), Path("shared/domain/node_modules")) if path.is_dir()}
            need("node_modules" in versions["node_modules"], "resolved Node dependencies missing")
    return {"environment": env, "versions": versions}


def capture(api, job, event, current_context):
    pr = event["pull_request"]
    need(pr["head"]["repo"]["full_name"] == REPO and pr["base"]["repo"]["full_name"] == REPO,
         "fork source is not eligible")
    need(pr["base"]["ref"] == "main" and not pr["draft"], "source is not an internal main candidate")
    head, base = pr["head"]["sha"], pr["base"]["sha"]
    need(api.one(PREFIX + "/git/ref/heads/main")["object"]["sha"] == base, "source base moved")
    tested = command(["git", "rev-parse", "HEAD"])
    tree = command(["git", "rev-parse", "HEAD^{tree}"])
    need(api.one(PREFIX + f"/git/commits/{head}")["tree"]["sha"] == tree, "tested merge tree differs from candidate")
    # Strict current-base testing permits synthetic PR merge SHA != head SHA.
    return {"schema_version": 1, "mode": "source", "repository": REPO, "job": job,
            "check_scope": CHECK_SCOPE[job], "run_id": int(os.environ["GITHUB_RUN_ID"]), "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
            "pull_request": pr["number"], "head_sha": head, "base_sha": base,
            "tested_sha": tested, "tree_sha": tree, "workflow_sha256": hashlib.sha256(Path(workflow(job)).read_bytes()).hexdigest(),
            "context": current_context, "authority": authority(api)}


def validate_source(source, *, job, run, pr, landed, before, current_authority, current_context, workflow_hash):
    """Pure decision boundary, also used by the focused refusal tests."""
    need(source.get("schema_version") == 1 and source.get("mode") == "source", "source proof is missing or relabeled")
    need(source["repository"] == REPO and source["job"] == job, "source repository/job mismatch")
    need(source["check_scope"] == CHECK_SCOPE[job], "source reused command scope differs")
    need(source["run_id"] == run["id"] and source["run_attempt"] == run["run_attempt"], "source attempt mismatch")
    need(run["status"] == "completed" and run["conclusion"] == "success" and run["event"] == "pull_request",
         "source protected workflow did not succeed")
    need(run["path"] == workflow(job) and run["head_repository"]["full_name"] == REPO, "untrusted source workflow")
    need(pr["merged"] is True and pr["state"] == "closed" and not pr["draft"] and (pr.get("merged_by") or {}).get("id"),
         "source has no merged pull-request authority")
    need(pr["head"]["repo"]["full_name"] == REPO and pr["base"]["repo"]["full_name"] == REPO
         and pr["base"]["ref"] == "main", "source PR authority mismatch")
    need(source["pull_request"] == pr["number"] and source["head_sha"] == pr["head"]["sha"] == run["head_sha"],
         "source candidate mismatch")
    need(pr["merge_commit_sha"] == landed["sha"], "source PR is not the landed merge")
    if landed["sha"] == source["head_sha"]:
        need(before == source["base_sha"], "fast-forward push base differs from tested base")
    else:
        need([parent["sha"] for parent in landed["parents"]] == [source["base_sha"], source["head_sha"]],
             "landed ordered parents differ from tested base/candidate")
    need(source["tree_sha"] == landed["tree"]["sha"], "landed tree changed")
    need(source["workflow_sha256"] == workflow_hash, "workflow changed")
    need(source["context"] == current_context, "relevant execution context changed")
    need(source["authority"] == current_authority, "protected authority changed")
    return True


def acquire_reuse(api, job, head, current_context, before=None):
    need(re.fullmatch(r"[0-9a-f]{40}", head) is not None, "landed SHA must be exact")
    need(api.one(PREFIX + "/git/ref/heads/main")["object"]["sha"] == head, "main authority moved")
    landed = api.one(PREFIX + f"/git/commits/{head}")
    need(command(["git", "rev-parse", "HEAD"]) == head, "checkout is not landed commit")
    candidates = api.pages(PREFIX + f"/commits/{head}/pulls", "array")
    candidates = [pr for pr in candidates if pr.get("merge_commit_sha") == head and pr.get("merged_at")]
    need(len(candidates) == 1, "landed PR authority is ambiguous")
    pr = api.one(PREFIX + f"/pulls/{candidates[0]['number']}")
    source_head = pr["head"]["sha"]
    runs = api.pages(PREFIX + f"/actions/workflows/{JOBS[job][0]}/runs?head_sha={source_head}&event=pull_request", "runs")
    need(bool(runs), "no source CI workflow")
    run = max(runs, key=lambda item: item["id"])
    # Never fall back past a failed, cancelled, pending or rerun source attempt.
    run = api.one(PREFIX + f"/actions/runs/{run['id']}")
    completed = dt.datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
    age = (dt.datetime.now(dt.timezone.utc) - completed).total_seconds()
    need(0 <= age <= MAX_AGE, "source protected result expired")
    artifact_name = f"ci-reuse-{run['run_attempt']}-{job}"
    artifacts = api.pages(PREFIX + f"/actions/runs/{run['id']}/artifacts", "artifacts")
    artifacts = [item for item in artifacts if item["name"] == artifact_name and not item["expired"]]
    need(len(artifacts) == 1, "source dependency/context proof missing or ambiguous")
    artifact = artifacts[0]
    archive = api.raw(PREFIX + f"/actions/artifacts/{artifact['id']}/zip")
    need(artifact.get("digest") == "sha256:" + hashlib.sha256(archive).hexdigest(), "source artifact digest mismatch")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        need(bundle.namelist() == ["protected-ci-reuse.json"], "unexpected source artifact contents")
        need(bundle.getinfo("protected-ci-reuse.json").file_size <= LIMIT, "source proof exceeds size limit")
        source = json.loads(bundle.read("protected-ci-reuse.json"))
    current_authority = authority(api)
    candidate = api.one(PREFIX + f"/git/commits/{source_head}")
    tested = api.one(PREFIX + f"/git/commits/{source['tested_sha']}")
    need(candidate["sha"] == source_head and tested["sha"] == source["tested_sha"]
         and candidate["tree"]["sha"] == tested["tree"]["sha"] == source["tree_sha"],
         "candidate/tested tree authority differs")
    if tested["sha"] != source_head:
        need([parent["sha"] for parent in tested["parents"]] == [source["base_sha"], source_head],
             "synthetic tested commit has wrong ordered parents")
    if head == source_head:
        comparison = api.one(PREFIX + f"/compare/{source['base_sha']}...{source_head}?per_page=1")
        need(comparison["status"] == "ahead" and comparison["merge_base_commit"]["sha"] == source["base_sha"],
             "fast-forward source ancestry unproven")
    validate_source(source, job=job, run=run, pr=pr, landed=landed, before=before,
                    current_authority=current_authority, current_context=current_context,
                    workflow_hash=hashlib.sha256(Path(workflow(job)).read_bytes()).hexdigest())
    # Fast-forward landing keeps the source SHA. Its new main checks may
    # already be pending, so select PR workflow suites explicitly rather than
    # confusing that fresh run with the original protected source result.
    source_runs = api.pages(PREFIX + f"/actions/runs?head_sha={source_head}&event=pull_request", "runs")
    latest_by_workflow = {}
    for item in source_runs:
        previous = latest_by_workflow.get(item["workflow_id"])
        if previous is None or item["id"] > previous["id"]:
            latest_by_workflow[item["workflow_id"]] = item
    qualified_runs = [api.one(PREFIX + f"/actions/runs/{item['id']}") for item in latest_by_workflow.values()]
    need(qualified_runs and all(item["head_sha"] == source_head and item["event"] == "pull_request"
         and item["head_repository"]["full_name"] == REPO and item["status"] == "completed"
         and item["conclusion"] == "success" for item in qualified_runs), "source PR workflows did not succeed")
    suites = {item["check_suite_id"] for item in qualified_runs}
    allowed_skips = inapplicable_source_checks(source) - {JOBS[job][1]}
    checks = select_checks([check for check in api.pages(PREFIX + f"/commits/{source_head}/check-runs?filter=all", "checks")
                            if (check.get("check_suite") or {}).get("id") in suites],
                           current_authority["required_checks"], source_head, allowed_skips)
    jobs = api.pages(PREFIX + f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs")
    jobs = [item for item in jobs if item["name"] == JOBS[job][1]]
    need(len(jobs) == 1 and jobs[0]["status"] == "completed" and jobs[0]["conclusion"] == "success",
         "source job did not succeed in the bound attempt")
    # The workflow result and check suite must describe this same source run.
    protected_name = JOBS[job][1]
    own_checks = [check for check in checks if check["name"] == protected_name]
    need(bool(own_checks), "source job has no protected check coverage")
    need(all(check["check_suite_id"] == run["check_suite_id"] for check in own_checks), "source required check belongs to another run")
    need(authority(api) == current_authority, "protection moved during reuse verification")
    need(api.one(PREFIX + f"/actions/runs/{run['id']}") == run, "source run changed during reuse verification")
    need(all(api.one(PREFIX + f"/actions/runs/{item['id']}") == item for item in qualified_runs),
         "source protected workflows changed during reuse verification")
    need(api.one(PREFIX + "/git/ref/heads/main")["object"]["sha"] == head, "main moved during reuse verification")
    return {"schema_version": 1, "mode": "reused", "repository": REPO, "job": job, "head_sha": head,
            "landed": landed, "pull_request": pr, "source_run": run, "source_job": jobs[0],
            "reused_steps": CHECK_SCOPE[job], "other_steps": "Fresh under their unchanged workflow conditions; no old build or design artifact is republished",
            "source_artifact": artifact, "source_proof": source, "protected_checks": checks,
            "source_workflows": qualified_runs, "inapplicable_source_checks": sorted(allowed_skips), "candidate_commit": candidate, "tested_commit": tested, "push_before": before,
            "authority": current_authority, "context": current_context,
            "canonical_refs": "GitHub main verified; Buzz relay readback remains a delivery gate",
            "review_and_approval": "Independent delivery gates remain required for the exact candidate"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", choices=JOBS, required=True)
    args = parser.parse_args()
    api = API()
    proof = {"schema_version": 1, "mode": "fresh", "job": args.job}
    try:
        need(os.environ.get("GITHUB_REPOSITORY") == REPO, "repository is not eligible")
        command(["git", "diff", "--quiet", "HEAD", "--"])
        current_context = context(args.job)
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
            proof = capture(api, args.job, event, current_context)
        elif os.environ.get("GITHUB_EVENT_NAME") == "push" and os.environ.get("GITHUB_REF") == "refs/heads/main":
            proof = acquire_reuse(api, args.job, os.environ["GITHUB_SHA"], current_context, event.get("before"))
        else:
            raise Refusal("event requires fresh execution")
    except (Refusal, OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        # Never expose API response bodies or subprocess output in refusals.
        proof = {"schema_version": 1, "mode": "fresh", "job": args.job,
                 "reason": str(exc) if isinstance(exc, (Refusal,)) else "source evidence unavailable or malformed"}
    proof["api_evidence"] = api.evidence
    Path("protected-ci-reuse.json").write_text(json.dumps(proof, indent=2) + "\n")
    reused = proof["mode"] == "reused"
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"reused={'true' if reused else 'false'}\n")
    summary = (f"Verified protected-result reuse for {JOBS[args.job][1]} from run {proof['source_run']['id']} "
               f"attempt {proof['source_run']['run_attempt']} at {proof['source_proof']['head_sha']}. "
               f"Exact landed commit: {proof['head_sha']}. Reused commands: {', '.join(CHECK_SCOPE[args.job])}. "
               "Other steps keep their ordinary fresh execution and artifact provenance. Full proof is in this job's ci-reuse artifact."
               if reused else f"Fresh {JOBS[args.job][1]} execution. {proof.get('reason', 'Capturing source proof for a later identical-tree merge.')} ")
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary + "\n")


if __name__ == "__main__":
    main()
