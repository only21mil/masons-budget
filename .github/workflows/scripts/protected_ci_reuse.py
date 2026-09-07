#!/usr/bin/env python3
"""Capture premerge execution inputs and verify them at the actual landing.

No platform work runs after landing. Provider evidence remains attached to its
original source SHA, run and attempt. Canonical relay readback, review and release
approval are separate delivery gates.
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
import sys

REPO = "only21mil/masons-budget"
PREFIX = f"/repos/{REPO}"
JOBS = {
    "shared-domain": ("clients.yml", "Shared domain contract"),
    "convex-wire-golden": ("clients.yml", "Production wire golden decoders"),
    "convex-functions": ("clients.yml", "Convex functions"),
    "linux-client": ("clients.yml", "Linux client"),
    "android-client": ("clients.yml", "Android client"),
    "swift": ("swift.yml", "Build and test the Apple client"),
    "swift-routing": ("swift.yml", "Detect Apple changes"),
    "workflow-lint": ("workflow-lint.yml", "actionlint + secret inventory"),
}

CHECK_SCOPE = {
    "shared-domain": ["Typecheck", "Parity tests against the Swift contract"],
    "convex-wire-golden": ["Fixture synthetic-content guard", "Fixture provenance and Linux values", "Linux wire decoder"],
    "convex-functions": ["Typecheck deployable Convex functions", "Typecheck Convex tests", "Read/mutation auth and todo LWW tests"],
    "linux-client": ["Typecheck renderer", "Typecheck electron main/preload", "Lint", "Preload boundary guard", "Render matrix (20 routes x profiles x states)"],
    "android-client": ["Domain parity tests (shared fixture, no Android SDK)", "Lint Android app", "App unit tests"],
    "swift": ["macOS build"],
    "swift-routing": ["Recognize a base-unchanged PR edit", "Match Apple-owned paths"],
    "workflow-lint": ["actionlint", "Secret inventory cross-check"],
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
    for job in ("linux-client", "android-client", "credential-tooling"):
        tree = "tooling" if job == "credential-tooling" else job.split("-")[0]
        pattern = re.search(r"\[" + tree + r"\]='([^']+)'", clients)
        need(pattern is not None, "source client path map is unrecognized")
        if not wide and not any(re.search(pattern[1], name) for name in paths):
            result.add("Credential mint tooling" if job == "credential-tooling" else JOBS[job][1])
    spec = importlib.util.spec_from_file_location("apple_paths", Path(__file__).with_name("apple_changed_tree.py"))
    apple = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(apple)
    if not apple.requires_apple(paths):
        result.update((JOBS["swift"][1], "Verify committed Xcode project"))
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
    """Retain the original execution inputs after ordinary premerge setup.

    Tree identity pins scripts, workflows, actions and lockfiles. Dependency
    bytes and tool versions describe the source execution; the landing verifier
    does not set up a second platform environment or claim a new execution.
    """
    env = {name: os.environ.get(name, "") for name in (
        "RUNNER_OS", "RUNNER_ARCH", "LANG", "LC_ALL", "TZ", "BUDGET_CI_REUSE_EPOCH")}
    need(env["RUNNER_OS"] and env["RUNNER_ARCH"], "runner identity missing")
    versions = {"python": command(["python3", "--version"])}
    if job in ("swift-routing", "workflow-lint"):
        env.update({name: os.environ.get(name, "") for name in ("ImageOS", "ImageVersion")})
        need(env["ImageOS"] and env["ImageVersion"], "runner image identity missing")
        return {"environment": env, "versions": versions}
    if job == "swift":
        # Retain compile inputs. The provider's successful job separately proves
        # that its iOS tests ran; no claim about later simulator state is made.
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
            "context": current_context, "authority": authority(api),
            "qualification_version": 2,
            "policy_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "epoch": os.environ.get("BUDGET_CI_REUSE_EPOCH", ""),
            "event_action": event.get("action"), "base_changed": "base" in event.get("changes", {})}


WORKFLOW_CHECKS = {
    "clients.yml": ["Detect changed trees", "Credential mint tooling", "Shared domain contract",
                    "Production wire golden decoders", "Convex functions", "Linux client", "Android client"],
    "swift.yml": ["Detect Apple changes", "Verify committed Xcode project", "Build and test the Apple client"],
    "workflow-lint.yml": ["actionlint + secret inventory"],
}


def fresh(timestamp):
    age = (dt.datetime.now(dt.timezone.utc) -
           dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))).total_seconds()
    need(0 <= age <= MAX_AGE, "source execution expired")


def latest_job(api, run, name):
    jobs = api.pages(PREFIX + f"/actions/runs/{run['id']}/jobs?filter=all", "jobs")
    matches = [job for job in jobs if job["name"] == name]
    need(matches and all(type(job.get("run_attempt")) is int and job["run_attempt"] > 0
                         for job in matches), "source job attempt missing")
    attempt = max(job["run_attempt"] for job in matches)
    matches = [job for job in matches if job["run_attempt"] == attempt]
    need(len(matches) == 1 and attempt <= run["run_attempt"], "ambiguous source job attempt")
    job = matches[0]
    need(job["status"] == "completed", "source job is pending")
    fresh(job["completed_at"])
    return job


def source_artifact(api, run, job, attempt):
    artifacts = api.pages(PREFIX + f"/actions/runs/{run['id']}/artifacts", "artifacts")
    matches = [item for item in artifacts if item["name"] == f"ci-reuse-{attempt}-{job}" and not item["expired"]]
    need(len(matches) == 1, "source input proof missing or ambiguous")
    artifact = matches[0]
    archive = api.raw(PREFIX + f"/actions/artifacts/{artifact['id']}/zip")
    need(artifact.get("digest") == "sha256:" + hashlib.sha256(archive).hexdigest(), "source artifact digest mismatch")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        need(bundle.namelist() == ["protected-ci-reuse.json"], "unexpected source artifact contents")
        need(bundle.getinfo("protected-ci-reuse.json").file_size <= LIMIT, "source proof exceeds size limit")
        proof = json.loads(bundle.read("protected-ci-reuse.json"))
    return artifact, proof


def unchanged_apple_edit(api, run):
    """Only the trusted title/body edit guard can supersede no Apple work.

    Keep its provider record separately. A skipped build by itself is never
    evidence of a no-op event and never supplies a successful execution.
    """
    if run["path"] != ".github/workflows/swift.yml" or run["conclusion"] != "success":
        return False
    jobs = api.pages(PREFIX + f"/actions/runs/{run['id']}/jobs?filter=all", "jobs")
    latest = [job for job in jobs if job.get("run_attempt") == run["run_attempt"]]
    detectors = [job for job in latest if job["name"] == "Detect Apple changes"]
    return (len(detectors) == 1 and detectors[0]["conclusion"] == "success"
            and any(step["name"] == "Recognize a base-unchanged PR edit" and step["conclusion"] == "success"
                    for step in detectors[0].get("steps", []))
            and all(any(job["name"] == name and job["conclusion"] == "skipped" for job in latest)
                    for name in WORKFLOW_CHECKS["swift.yml"][1:]))


def qualification_runs(api, head):
    selected, ignored = {}, []
    for filename in WORKFLOW_CHECKS:
        rows = api.pages(PREFIX + f"/actions/workflows/{filename}/runs?head_sha={head}&event=pull_request", "runs")
        for row in sorted(rows, key=lambda item: item["id"], reverse=True):
            run = api.one(PREFIX + f"/actions/runs/{row['id']}")
            need(run["head_sha"] == head and run["event"] == "pull_request"
                 and run["path"] == ".github/workflows/" + filename
                 and run["head_repository"]["full_name"] == REPO, "untrusted source workflow")
            need(run["status"] == "completed" and run["conclusion"] == "success", "latest source workflow did not succeed")
            fresh(run["updated_at"])
            if unchanged_apple_edit(api, run):
                ignored.append(run)
                continue
            selected[filename] = run
            break
        need(filename in selected, "source qualification workflow missing")
    return selected, ignored


def validate_qualification(source, *, job, run, execution, source_head, pr, landed, protection):
    need(source.get("schema_version") == 1 and source.get("mode") == "source"
         and source.get("qualification_version") == 2, "run predates complete premerge qualification")
    need(source["repository"] == REPO and source["job"] == job
         and source["head_sha"] == source_head and source["pull_request"] == pr["number"], "source proof identity differs")
    need(source["run_id"] == run["id"] and source["run_attempt"] == execution["run_attempt"], "source proof job attempt differs")
    need(source["check_scope"] == CHECK_SCOPE[job], "source command scope changed")
    need(source["tree_sha"] == landed["tree"]["sha"], "landed tree differs from source proof")
    need(source["workflow_sha256"] == hashlib.sha256(Path(workflow(job)).read_bytes()).hexdigest(), "source workflow changed")
    need(source["policy_sha256"] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "source verifier policy changed")
    need(source["authority"] == protection, "protected authority changed")
    need(source["epoch"] == os.environ.get("BUDGET_CI_REUSE_EPOCH", ""), "execution policy epoch changed")
    need(source.get("context", {}).get("environment") and source["context"].get("versions"), "source execution inputs missing")


def verify_qualification(api, head, *, candidate_only=False):
    """Verify completed source qualification; do not claim a new execution.

    The immutable source environment is retained, not compared to this Ubuntu
    verifier host. No platform command is running here. An epoch change revokes
    qualification when toolchain/dependency policy requires new execution.
    """
    need(re.fullmatch(r"[0-9a-f]{40}", head) is not None, "landed SHA must be exact")
    need(command(["git", "rev-parse", "HEAD"]) == head, "checkout is not the exact target commit")
    current_main = api.one(PREFIX + "/git/ref/heads/main")["object"]["sha"]
    need(candidate_only or current_main == head, "main authority moved")
    landed = api.one(PREFIX + f"/git/commits/{head}")
    need(landed["sha"] == head, "landed commit authority differs")
    prs = api.pages(PREFIX + f"/commits/{head}/pulls", "array")
    candidates = [pr for pr in prs if (pr["head"]["sha"] == head or
                  (pr.get("merged_at") and pr.get("merge_commit_sha") == head))
                  and pr["base"]["ref"] == "main" and pr["head"]["repo"]["full_name"] == REPO]
    need(len(candidates) == 1, "source PR authority is ambiguous")
    pr = api.one(PREFIX + f"/pulls/{candidates[0]['number']}")
    need(not pr["draft"] and pr["head"]["repo"]["full_name"] == REPO
         and pr["base"]["repo"]["full_name"] == REPO and pr["base"]["ref"] == "main", "source PR authority differs")
    source_head = pr["head"]["sha"]
    if head != source_head:
        need(pr.get("merged") and pr.get("merge_commit_sha") == head and (pr.get("merged_by") or {}).get("id"),
             "merge commit lacks provider PR authority")
    candidate = api.one(PREFIX + f"/git/commits/{source_head}")
    need(candidate["sha"] == source_head and candidate["tree"]["sha"] == landed["tree"]["sha"], "candidate/landing trees differ")
    protection = authority(api)
    runs, ignored = qualification_runs(api, source_head)
    checks = api.pages(PREFIX + f"/commits/{source_head}/check-runs?filter=all", "checks")
    # The always-executed shared contract proof pins the source base used by
    # every applicability decision. Other job proofs must name this same base.
    shared_run = runs["clients.yml"]
    shared_job = latest_job(api, shared_run, JOBS["shared-domain"][1])
    _, anchor = source_artifact(api, shared_run, "shared-domain", shared_job["run_attempt"])
    validate_qualification(anchor, job="shared-domain", run=shared_run, execution=shared_job,
                           source_head=source_head, pr=pr, landed=landed, protection=protection)
    base = anchor["base_sha"]
    if candidate_only:
        need(head == source_head and current_main == base, "candidate no longer targets its tested main base")
    if head == source_head:
        comparison = api.one(PREFIX + f"/compare/{base}...{source_head}?per_page=1")
        need(comparison["status"] == "ahead" and comparison["merge_base_commit"]["sha"] == base,
             "source is not a fast-forward from its tested base")
    else:
        need([parent["sha"] for parent in landed["parents"]] == [base, source_head], "landed ordered parents changed")
    inapplicable = inapplicable_source_checks(anchor)
    requirements = {item["name"]: item["integration_id"] for item in protection["required_checks"]}
    supported = {name for names in WORKFLOW_CHECKS.values() for name in names}
    need(set(requirements) <= supported, "required check has no qualified workflow binding")
    qualified_checks, executions, proofs = [], [], {}
    for filename, names in WORKFLOW_CHECKS.items():
        run = runs[filename]
        suite_checks = [check for check in checks if (check.get("check_suite") or {}).get("id") == run["check_suite_id"]]
        selected = select_checks(suite_checks, [{"name": name, "integration_id": requirements.get(name, 15368)}
                                                for name in names], source_head, inapplicable)
        for selected_check in selected:
            name = selected_check["name"]
            execution = latest_job(api, run, name)
            provider_check = selected_check["provider_result"]
            need(execution["conclusion"] == provider_check["conclusion"], "job/check conclusion differs")
            need(execution.get("check_run_url") == f"https://api.github.com{PREFIX}/check-runs/{provider_check['id']}",
                 "job does not own the selected provider check")
            executions.append({"run_id": run["id"], "job": execution})
            qualified_checks.append(selected_check)
        for job, (job_workflow, name) in JOBS.items():
            if job_workflow != filename or name in inapplicable:
                continue
            execution = next(item["job"] for item in executions if item["run_id"] == run["id"] and item["job"]["name"] == name)
            need(execution["conclusion"] == "success", "source job supplies no successful execution")
            artifact, source = source_artifact(api, run, job, execution["run_attempt"])
            validate_qualification(source, job=job, run=run, execution=execution,
                                   source_head=source_head, pr=pr, landed=landed, protection=protection)
            need(source["base_sha"] == base, "source jobs tested different bases")
            tested = api.one(PREFIX + f"/git/commits/{source['tested_sha']}")
            need(tested["sha"] == source["tested_sha"] and tested["tree"]["sha"] == landed["tree"]["sha"], "provider tested tree differs")
            if tested["sha"] != source_head:
                need([parent["sha"] for parent in tested["parents"]] == [base, source_head], "tested ordered parents changed")
            proofs[job] = {"artifact": artifact, "source_proof": source, "tested_commit": tested}
    # Even ignored no-op events must have tested the same candidate/workflow
    # tree. The detector captures its own provider-attached source proof.
    ignored_proofs = []
    for ignored_run in ignored:
        execution = latest_job(api, ignored_run, "Detect Apple changes")
        artifact, source = source_artifact(api, ignored_run, "swift-routing", execution["run_attempt"])
        validate_qualification(source, job="swift-routing", run=ignored_run, execution=execution,
                               source_head=source_head, pr=pr, landed=landed, protection=protection)
        need(source["base_sha"] == base and source.get("event_action") == "edited"
             and source.get("base_changed") is False, "ignored Apple event changed qualification inputs")
        tested = api.one(PREFIX + f"/git/commits/{source['tested_sha']}")
        need(tested["sha"] == source["tested_sha"] and tested["tree"]["sha"] == landed["tree"]["sha"], "ignored event tested a different tree")
        if tested["sha"] != source_head:
            need([parent["sha"] for parent in tested["parents"]] == [base, source_head], "ignored event tested different parents")
        ignored_proofs.append({"run": ignored_run, "job": execution, "artifact": artifact,
                               "source_proof": source, "tested_commit": tested})
    need(authority(api) == protection, "protection moved during verification")
    need(qualification_runs(api, source_head) == (runs, ignored), "source workflows changed during verification")
    final_checks = api.pages(PREFIX + f"/commits/{source_head}/check-runs?filter=all", "checks")
    for filename, names in WORKFLOW_CHECKS.items():
        suite = runs[filename]["check_suite_id"]
        final_selected = select_checks([check for check in final_checks if (check.get("check_suite") or {}).get("id") == suite],
            [{"name": name, "integration_id": requirements.get(name, 15368)} for name in names], source_head, inapplicable)
        need(final_selected == [check for check in qualified_checks if check["name"] in names], "source checks changed during verification")
    need(api.one(PREFIX + f"/pulls/{pr['number']}") == pr, "source PR changed during verification")
    need(api.one(PREFIX + "/git/ref/heads/main")["object"]["sha"] == current_main, "main moved during verification")
    return {"schema_version": 2, "mode": "qualified-candidate" if candidate_only else "qualified-source-at-landing", "repository": REPO,
            **({} if candidate_only else {"landed_commit": landed}), "candidate_commit": candidate, "tested_base": base,
            "pull_request": pr, "source_workflows": runs, "ignored_unchanged_edit_runs": ignored, "ignored_event_proofs": ignored_proofs,
            "source_checks": qualified_checks, "source_executions": executions, "source_proofs": proofs,
            "inapplicable_checks": sorted(inapplicable), "authority": protection,
            "fresh_checks": ["provider authority and source identity" + ("" if candidate_only else " and landing equivalence")],
            "reused_checks": [check["name"] for check in qualified_checks if check["provider_result"]["conclusion"] == "success"],
            "canonical_authority": "Required separate delivery evidence: fresh relay main, reviewed PR/parents and subsequent complete no-op mirror equality",
            "execution_context": "Original source execution retained; no new platform execution claimed. Release builds/signing have independent fresh contexts."}


def verify_landing(api, head):
    return verify_qualification(api, head)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--job", choices=JOBS)
    mode.add_argument("--verify-landing", metavar="SHA")
    mode.add_argument("--verify-candidate", metavar="SHA")
    args = parser.parse_args()
    api = API()
    try:
        command(["git", "diff", "--quiet", "HEAD", "--"])
        if args.verify_landing or args.verify_candidate:
            need(os.environ.get("GITHUB_REPOSITORY") == REPO, "repository is not eligible")
            head = args.verify_landing or args.verify_candidate
            proof = verify_qualification(api, head, candidate_only=bool(args.verify_candidate))
            proof["api_evidence"] = api.evidence
            phase = "candidate" if args.verify_candidate else "landing"
            Path(f"protected-ci-{phase}.json").write_text(json.dumps(proof, indent=2) + "\n")
            print(f"Verified premerge qualification for {phase} {head}; no platform CI repeated.")
            return 0
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        pr = event.get("pull_request") or {}
        eligible = (os.environ.get("GITHUB_REPOSITORY") == REPO
                    and os.environ.get("GITHUB_EVENT_NAME") == "pull_request"
                    and (pr.get("head", {}).get("repo") or {}).get("full_name") == REPO
                    and (pr.get("base", {}).get("repo") or {}).get("full_name") == REPO
                    and pr.get("base", {}).get("ref") == "main" and not pr.get("draft", True))
        if eligible:
            proof = capture(api, args.job, event, context(args.job))
        else:
            proof = {"schema_version": 1, "mode": "fresh", "job": args.job,
                     "reason": "This event is not an eligible internal non-draft main PR source"}
        proof["api_evidence"] = api.evidence
        Path("protected-ci-reuse.json").write_text(json.dumps(proof, indent=2) + "\n")
        print(f"Captured {JOBS[args.job][1]} inputs; this job executes its normal checks once.")
        return 0
    except (Refusal, OSError, ValueError, KeyError, TypeError, AttributeError,
            subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        # No response bodies, credentials or subprocess output in diagnostics.
        reason = str(exc) if isinstance(exc, Refusal) else "source evidence unavailable or malformed"
        print(f"CI qualification refused: {reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
