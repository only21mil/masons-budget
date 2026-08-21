#!/usr/bin/env python3
"""Require immutable commit pins for external GitHub Actions.

Git tags and branches are mutable. A workflow that references ``owner/repo@v4``
therefore executes code that can change without a repository review. This check
is intentionally stdlib-only so Workflow lint can run it before installing any
project dependencies.

Local reusable workflows and Docker image references are not GitHub Action
repository refs, so they are outside this check.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


WORKFLOW_DIR = Path(__file__).resolve().parent.parent
FULL_COMMIT_SHA = re.compile(r"[0-9a-f]{40}")
USES_LINE = re.compile(r"^\s*(?:-\s*)?uses:\s*(?P<value>[^#]+?)\s*(?:#.*)?$")


def workflow_files(workflow_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in workflow_dir.iterdir()
        if path.is_file() and path.suffix in {".yml", ".yaml"}
    )


def scan(path: Path) -> list[str]:
    errors: list[str] = []
    for lineno, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if line.lstrip().startswith("#"):
            continue
        match = USES_LINE.match(line)
        if match is None:
            continue

        target = match.group("value").strip().strip("'\"")
        if target.startswith("./") or target.startswith("docker://"):
            continue

        action, separator, revision = target.rpartition("@")
        if not separator or "/" not in action:
            errors.append(
                f"{path.name}:{lineno}: external action reference {target!r} "
                "does not have an owner/repository@revision shape"
            )
            continue
        if FULL_COMMIT_SHA.fullmatch(revision) is None:
            errors.append(
                f"{path.name}:{lineno}: {target!r} is mutable; pin the action "
                "to its reviewed full 40-character commit SHA"
            )
    return errors


def check(workflow_dir: Path = WORKFLOW_DIR) -> list[str]:
    files = workflow_files(workflow_dir)
    if not files:
        return [f"{workflow_dir}: no workflow files found"]
    return [
        error
        for path in files
        for error in scan(path)
    ]


def main() -> int:
    errors = check()
    if errors:
        for message in errors:
            print(f"::error::{message}")
        print(f"\n{len(errors)} immutable-action pin problem(s).", file=sys.stderr)
        return 1

    print(
        f"OK: external actions in {len(workflow_files(WORKFLOW_DIR))} workflow(s) "
        "are pinned to full commit SHAs."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
