#!/usr/bin/env python3
"""Download only the two reviewed immutable original build artifacts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import zipfile

REPO = "only21mil/masons-budget"
SOURCE = "d9abae67a7d9dfab3d693e968477561456694898"
HEAD = "dca2a86e4a874ab0421d1067b57bca4b4279ca51"
RUN = 34223564212
ARTIFACTS = {
    "aarch64": (10055090759, 101325478, "0dbb493a0cab29a197f882766a79ced20cd5f49229a4590a5d571d749d74f600", 102052157718),
    "x86_64": (10055390672, 82559073, "9d87738f5e9ea553cb51f1fa9b685ad17edd0b2a9f2deced38fe1a28b223c612", 102052157973),
}


def require(ok):
    if not ok:
        raise ValueError("recovery binding or archive validation failed")


def api(route, output=None):
    # gh handles authenticated API redirects. Raw stderr is never rendered.
    argv = ["gh", "api", f"repos/{REPO}/{route}"]
    result = subprocess.run(argv, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE,
                            env={k: os.environ[k] for k in ("HOME", "PATH", "GH_TOKEN") if k in os.environ})
    require(result.returncode == 0)
    return None if output else json.loads(result.stdout)


def validate_authority(run, jobs, artifact, arch):
    artifact_id, size, digest, job_id = ARTIFACTS[arch]
    require(run["id"] == RUN and run["run_attempt"] == 1 and run["head_sha"] == HEAD)
    require(run["repository"]["full_name"] == REPO and run["event"] == "workflow_dispatch")
    require(run["status"] == "completed" and run["conclusion"] == "failure")
    require(run["path"] == ".github/workflows/buzz-macos-release.yml")
    found = [j for j in jobs["jobs"] if j["id"] == job_id]
    require(len(found) == 1 and found[0]["name"] == f"build ({arch})" and found[0]["conclusion"] == "success")
    require(artifact["id"] == artifact_id and artifact["name"] == f"buzz-macos-unsigned-{arch}-{SOURCE}")
    require(artifact["size_in_bytes"] == size and artifact["digest"] == "sha256:" + digest and artifact["expired"] is False)
    require(artifact["workflow_run"]["id"] == RUN and artifact["workflow_run"]["head_sha"] == HEAD)
    require(artifact["workflow_run"]["repository_id"] == 1226024594)


def extract_checked(archive, arch, destination):
    _, size, digest, _ = ARTIFACTS[arch]
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size == size)
    with archive.open("rb") as source:
        digest_state = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest_state.update(block)
        actual = digest_state.hexdigest()
    require(actual == digest and not destination.exists())
    expected = {f"unsigned-{arch}.app.tar.gz", f"build-{arch}.json"}
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        require(len(members) == 2 and {m.filename for m in members} == expected)
        require(all(not m.is_dir() and not stat.S_ISLNK(m.external_attr >> 16) and 0 < m.file_size < 512 * 1024**2 for m in members))
        require(next(m for m in members if m.filename.endswith(".json")).file_size < 65536)
        destination.mkdir(mode=0o700)
        for member in members:
            with z.open(member) as src, (destination/member.filename).open("xb") as out:
                shutil.copyfileobj(src, out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", required=True, choices=ARTIFACTS)
    args = parser.parse_args()
    os.umask(0o077)
    require(os.environ.get("GITHUB_REPOSITORY") == REPO)
    require(os.environ.get("GITHUB_RUN_ID", "").isdigit() and os.environ.get("GITHUB_RUN_ATTEMPT") == "1")
    require(os.environ["GITHUB_RUN_ID"] != str(RUN))
    staging = Path("recovery-download")
    require(not staging.exists() and not staging.is_symlink())
    staging.mkdir(mode=0o700)
    artifact_id = ARTIFACTS[args.arch][0]
    run = api(f"actions/runs/{RUN}/attempts/1")
    jobs = api(f"actions/runs/{RUN}/attempts/1/jobs?per_page=100")
    artifact = api(f"actions/artifacts/{artifact_id}")
    validate_authority(run, jobs, artifact, args.arch)
    archive = staging/"artifact.zip"
    with archive.open("xb") as out:
        api(f"actions/artifacts/{artifact_id}/zip", output=out)
    extract_checked(archive, args.arch, Path("unsigned"))
    receipt = {"schema": "buzz-macos-recovery-download-v1", "repository": REPO,
               "build_run_id": RUN, "build_run_attempt": 1, "build_workflow_sha": HEAD,
               "arch": args.arch, "source": SOURCE, "artifact_id": artifact_id,
               "artifact_sha256": ARTIFACTS[args.arch][2], "build_job_id": ARTIFACTS[args.arch][3],
               "sign_run_id": os.environ["GITHUB_RUN_ID"], "sign_run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
               "sign_workflow_sha": os.environ["GITHUB_SHA"]}
    Path(f"recovery-download-{args.arch}.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("::error::Pinned unsigned artifact recovery failed; no confidential output retained", file=sys.stderr)
        sys.exit(1)
