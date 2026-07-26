#!/usr/bin/env python3
"""Cross-check every secret reference in the workflows against secrets-inventory.json.

Why this exists on top of actionlint: the `secrets` context is an open map, so
actionlint happily type-checks `secrets.APPSTORE_USERNAME` even when no such
secret has ever existed on the repository. That exact reference sat in deploy.yml
for months and no gate noticed, because a missing secret expands to the empty
string at runtime rather than failing. The only way to catch it statically is to
maintain a declared inventory and diff against it, which is what this does.

Checks, all fatal:
  1. Every `secrets.NAME` referenced by a workflow is declared in the inventory.
  2. The referencing workflow is listed in that secret's `used_by`.
  3. Every `used_by` entry names a workflow that really does reference the secret
     (so a declaration cannot outlive its use).
  4. No dynamic `secrets[...]` access and no `toJSON(secrets)` — the first defeats
     static checking, the second would print every value into the log.
  5. Every `${{ secrets.X }}` interpolation sits alone on a `key: ${{ secrets.X }}`
     line, i.e. bound to an env/with key. Splicing a secret into a `run:` body
     substitutes the value into the shell source itself.

Reads nothing but workflow source. Never touches a secret value.

Deliberately stdlib-only and YAML-parser-free: this must run on a bare runner
before any dependency is installed, and a line-oriented check is the one that can
state rule 5 at all.

Known limit of being line-oriented: a whole-line comment is skipped, and without
parsing YAML there is no way to tell a comment describing a workflow from a `#`
line inside a `run:` block. Neither executes, so the blind spot is a commented-out
reference — which cannot fail a release, which is the thing this guards.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

WORKFLOW_DIR = Path(__file__).resolve().parent.parent
INVENTORY = WORKFLOW_DIR / "secrets-inventory.json"

# Provided by Actions itself, never declared as a repository secret.
BUILTIN_SECRETS = {"GITHUB_TOKEN"}

SECRET_REF = re.compile(r"\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)")
DYNAMIC_REF = re.compile(r"\bsecrets\s*\[")
DUMP_REF = re.compile(r"\btoJSON\s*\(\s*secrets\s*\)", re.IGNORECASE)
INTERPOLATION = re.compile(r"\$\{\{[^}]*\bsecrets\.")
# The only shape that binds a secret to a variable instead of pasting it into code.
SAFE_BINDING = re.compile(r"^\s*[A-Za-z_][A-Za-z0-9_-]*:\s*\$\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}\s*$")

REQUIRED_FIELDS = {"name", "purpose", "encoding", "required_for_release", "used_by"}


def workflow_files() -> list[Path]:
    # Top level only: GitHub does not treat subdirectories of .github/workflows
    # as workflows, which is why this script and the inventory can live under it.
    return sorted(
        p for p in WORKFLOW_DIR.iterdir()
        if p.is_file() and p.suffix in {".yml", ".yaml"}
    )


def load_inventory(errors: list[str]) -> dict[str, dict]:
    try:
        raw = json.loads(INVENTORY.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{INVENTORY.name}: cannot be read as JSON: {exc}")
        return {}

    declared: dict[str, dict] = {}
    for entry in raw.get("secrets", []):
        missing = REQUIRED_FIELDS - entry.keys()
        if missing:
            errors.append(
                f"{INVENTORY.name}: entry {entry.get('name', '<unnamed>')!r} is missing "
                f"{', '.join(sorted(missing))}"
            )
            continue
        name = entry["name"]
        if name in declared:
            errors.append(f"{INVENTORY.name}: {name} is declared twice")
        if name in BUILTIN_SECRETS:
            errors.append(f"{INVENTORY.name}: {name} is provided by Actions and must not be declared")
        declared[name] = entry
    if not declared and not errors:
        errors.append(f"{INVENTORY.name}: declares no secrets")
    return declared


def scan(path: Path, errors: list[str]) -> set[str]:
    referenced: set[str] = set()
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if line.lstrip().startswith("#"):
            continue
        where = f"{path.name}:{lineno}"
        if DUMP_REF.search(line):
            errors.append(f"{where}: toJSON(secrets) would write every secret value to the log")
        if DYNAMIC_REF.search(line):
            errors.append(f"{where}: dynamic secrets[...] access cannot be checked against the inventory")
        if INTERPOLATION.search(line) and not SAFE_BINDING.match(line):
            errors.append(
                f"{where}: bind the secret to its own env/with key "
                "(KEY: ${{ secrets.NAME }}); interpolating it anywhere else pastes "
                "the value into the script or condition"
            )
        referenced.update(SECRET_REF.findall(line))
    return referenced


def main() -> int:
    errors: list[str] = []
    declared = load_inventory(errors)

    files = workflow_files()
    if not files:
        errors.append("no workflow files found")

    refs_by_file: dict[str, set[str]] = {}
    for path in files:
        refs_by_file[path.name] = scan(path, errors)

    for filename, names in sorted(refs_by_file.items()):
        for name in sorted(names):
            if name in BUILTIN_SECRETS:
                continue
            entry = declared.get(name)
            if entry is None:
                errors.append(
                    f"{filename}: references secrets.{name}, which is not declared in "
                    f"{INVENTORY.name}. Either the name is wrong or the inventory is stale — "
                    "a secret that does not exist expands to an empty string and fails silently."
                )
                continue
            if filename not in entry["used_by"]:
                errors.append(
                    f"{filename}: references secrets.{name} but is not listed in that "
                    f"secret's used_by ({', '.join(entry['used_by'])})"
                )

    known_files = set(refs_by_file)
    for name, entry in sorted(declared.items()):
        for filename in entry["used_by"]:
            if filename not in known_files:
                errors.append(f"{INVENTORY.name}: {name}.used_by names {filename}, which does not exist")
            elif name not in refs_by_file[filename]:
                errors.append(
                    f"{INVENTORY.name}: {name}.used_by claims {filename}, but that workflow "
                    "never references it"
                )

    if errors:
        for message in errors:
            print(f"::error::{message}")
        print(f"\n{len(errors)} secret-inventory problem(s).", file=sys.stderr)
        return 1

    total_refs = sum(len(v - BUILTIN_SECRETS) for v in refs_by_file.values())
    print(
        f"OK: {total_refs} secret reference(s) across {len(files)} workflow(s), "
        f"all declared in {INVENTORY.name}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
