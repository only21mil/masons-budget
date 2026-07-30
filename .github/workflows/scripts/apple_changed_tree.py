#!/usr/bin/env python3
"""Decide whether a changed-file list can affect the Apple client."""

from __future__ import annotations

import re
import sys
from collections.abc import Iterable


APPLE_PATH = re.compile(
    r"^(?:"
    r"MasonsBudget/|"
    r"Package\.swift$|"
    r"Tests/|"
    r"shared/domain/convex-wire-golden-provenance\.json$|"
    r"shared/domain/fixtures/visibility-cases\.json$|"
    r"shared/domain/fixtures/convex-wire-golden/|"
    r"scripts/regenerate-xcode-project\.sh$|"
    r"\.github/workflows/swift\.yml$"
    r")"
)


def requires_apple(changed_paths: Iterable[str]) -> bool:
    return any(APPLE_PATH.match(path.strip()) for path in changed_paths if path.strip())


def main() -> int:
    return 0 if requires_apple(sys.stdin) else 1


if __name__ == "__main__":
    raise SystemExit(main())
