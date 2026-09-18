#!/usr/bin/env python3

from __future__ import annotations

import argparse
import itertools
import re
from collections import Counter
from pathlib import Path


# Read the source contract, never the recorded output or historical screenshots.
# Paths are relative to this script so direct CI invocation and unittest discovery
# both work regardless of the caller's working directory.
REPO_ROOT = Path(__file__).resolve().parents[3]
KOTLIN_ROOT = Path("android/app/src")
CAPTURE_SOURCE = KOTLIN_ROOT / "test/kotlin/com/sats21m/vogelvault/DesignPacketTest.kt"
DESTINATION_SOURCE = KOTLIN_ROOT / "main/kotlin/com/sats21m/vogelvault/ui/VaultApp.kt"
UNIT_SOURCE = Path("android/domain/src/main/kotlin/com/sats21m/vogelvault/domain/Money.kt")


# This is a deliberately bounded Kotlin reader, not a Kotlin evaluator. Accept
# ordinary catalog/capture spelling changes; refuse new control flow rather
# than deriving a plausible but incomplete manifest.
TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|[^\s]', re.S)
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")


def source_text(path: Path) -> str:
    source = path.read_text()
    result: list[str] = []
    i = 0
    while i < len(source):
        if source[i] == '"':
            match = TOKEN.match(source, i)
            if match is None or not match.group().endswith('"') or len(match.group()) < 2:
                raise ValueError("unterminated Kotlin string")
            result.append(match.group())
            i = match.end()
        elif source.startswith("//", i):
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
            result.append(" ")
        elif source.startswith("/*", i):
            depth = 1
            i += 2
            while depth and i < len(source):
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError("unterminated Kotlin comment")
            result.append(" ")
        else:
            result.append(source[i])
            i += 1
    return "".join(result)


def closing(tokens: list[str], start: int) -> int:
    pairs = {"(": ")", "{": "}", "[": "]"}
    stack = [pairs[tokens[start]]]
    for i in range(start + 1, len(tokens)):
        token = tokens[i]
        if token in pairs:
            stack.append(pairs[token])
        elif token in pairs.values():
            if token != stack.pop():
                break
            if not stack:
                return i
    raise ValueError("unsupported Android capture contract: unbalanced delimiters")


def arguments(tokens: list[str]) -> list[list[str]]:
    result: list[list[str]] = []
    start = i = 0
    while i < len(tokens):
        if tokens[i] in ("(", "{", "["):
            i = closing(tokens, i)
        elif tokens[i] == ",":
            result.append(tokens[start:i])
            start = i + 1
        i += 1
    if start < len(tokens):
        result.append(tokens[start:])
    return result


def literal(tokens: list[str]) -> str:
    if len(tokens) != 1 or not tokens[0].startswith('"'):
        raise ValueError("unsupported capture filename or catalog string")
    # Kotlin escaping and raw strings need an explicit reader update.
    if "\\" in tokens[0]:
        raise ValueError("unsupported escaped capture filename or catalog string")
    return tokens[0][1:-1]


def catalog(path: Path, enum: str, *, storage_keys: bool = False) -> list[str]:
    tokens = TOKEN.findall(source_text(path))
    try:
        start = next(i + 3 for i in range(len(tokens) - 2)
                     if tokens[i:i + 3] == ["enum", "class", enum])
    except StopIteration as error:
        raise ValueError(f"unsupported Android capture contract: enum {enum}") from error
    if tokens[start] == "(":
        start = closing(tokens, start) + 1
    if tokens[start] != "{":
        raise ValueError(f"unsupported Android capture contract: enum {enum}")
    body = tokens[start + 1:closing(tokens, start)]
    # Stop at a top-level semicolon, never one inside a label.
    i = 0
    values: list[str] = []
    while i < len(body) and body[i] != ";":
        name = body[i]
        if not IDENTIFIER.fullmatch(name) or body[i + 1:i + 2] != ["("]:
            raise ValueError(f"unsupported Android capture contract: {enum} entry")
        end = closing(body, i + 1)
        args = arguments(body[i + 2:end])
        if storage_keys:
            named = [arg[2:] for arg in args if arg[:2] == ["storageKey", "="]]
            values.append(literal(named[0] if named else args[0]))
        else:
            values.append(name.lower())
        i = end + 1
        if body[i:i + 1] == [","]:
            i += 1
        elif body[i:i + 1] not in ([";"], []):
            raise ValueError(f"unsupported Android capture contract: {enum} entry suffix")
    if not values or len(values) != len(set(values)):
        raise ValueError(f"empty or duplicate Android capture catalog: {enum}")
    return values


def expected_pngs(repo_root: Path = REPO_ROOT) -> frozenset[str]:
    destinations = catalog(repo_root / DESTINATION_SOURCE, "Destination")
    units = catalog(repo_root / UNIT_SOURCE, "DisplayUnit", storage_keys=True)
    unit_names = catalog(repo_root / UNIT_SOURCE, "DisplayUnit")
    tokens = TOKEN.findall(source_text(repo_root / CAPTURE_SOURCE))
    helpers = {"capture", "captureStatusAndUnavailableTokens"}
    defaults: dict[str, str] = {}
    names: list[str] = []

    # Keep fields of one enum entry bound together when a filename uses both.
    def expand(template: str, dimensions: dict[str, list[dict[str, str]]]) -> None:
        for entries in itertools.product(*dimensions.values()):
            name = template
            for variable, entry in zip(dimensions, entries):
                for expression, value in entry.items():
                    name = name.replace("${" + variable + "." + expression + "}", value)
            if "$" in name:
                raise ValueError(f"unsupported capture filename template: {template}")
            if not name or any(c in name for c in "/\\\n\r\0") or name in (".", ".."):
                raise ValueError(f"capture filename must be a basename: {template}")
            names.append(name + ".png")

    def walk(body: list[str], dimensions: dict[str, list[dict[str, str]]],
             lists: dict[str, list[str]]) -> None:
        lists = dict(lists)
        i = 0
        while i < len(body):
            token = body[i]
            if token == "fun" and body[i + 1:i + 2] and body[i + 1] in helpers:
                helper = body[i + 1]
                end = closing(body, i + 2)
                for arg in arguments(body[i + 3:end]):
                    if arg[:4] == ["name", ":", "String", "="]:
                        defaults[helper] = literal(arg[4:])
                if body[end + 1:end + 2] != ["{"]:
                    raise ValueError("unsupported capture helper definition")
                stop = closing(body, end + 1)
                implementation = body[end + 2:stop]
                image_calls = [j for j, value in enumerate(implementation)
                               if value == "captureRoboImage"]
                if len(image_calls) != 1:
                    raise ValueError("unsupported capture helper output count")
                call = image_calls[0]
                output_end = closing(implementation, call + 1)
                if implementation[call + 2:output_end] != ['"build/outputs/roborazzi/$name.png"']:
                    raise ValueError("unsupported capture helper output path")
                if any(value in ("if", "when", "for", "while", "do", "forEach", "repeat")
                       for value in implementation):
                    raise ValueError("unsupported capture helper control flow")
                i = stop + 1
                continue
            if token == "val" and body[i + 1:i + 2] and body[i + 1] in ("sampled", "states"):
                variable = body[i + 1]
                if body[i + 2:i + 5] != ["=", "listOf", "("]:
                    raise ValueError("unsupported Android capture contract: capture list")
                end = closing(body, i + 4)
                if body[end + 1:end + 2] == ["."]:
                    raise ValueError("unsupported Android capture contract: filtered list")
                values = []
                enum = "Destination" if variable == "sampled" else "Freshness"
                for arg in arguments(body[i + 5:end]):
                    if len(arg) != 3 or arg[:2] != [enum, "."] or not IDENTIFIER.fullmatch(arg[2]):
                        raise ValueError("unsupported Android capture contract: capture list entry")
                    values.append(arg[2].lower())
                if not values or len(values) != len(set(values)):
                    raise ValueError("empty or duplicate Android capture list")
                if variable == "sampled" and not set(values) <= set(destinations):
                    raise ValueError("sampled destination missing from Destination catalog")
                lists[variable] = values
                i = end + 1
                continue
            if token == "for":
                end = closing(body, i + 1)
                header = body[i + 2:end]
                catalogs = {
                    ("Destination", ".", "entries"): [
                        {"name.lowercase()": value} for value in destinations
                    ],
                    ("DisplayUnit", ".", "entries"): [
                        {"name.lowercase()": name, "storageKey": key}
                        for name, key in zip(unit_names, units)
                    ],
                    **{(key,): [{"name.lowercase()": value} for value in values]
                       for key, values in lists.items()},
                }
                if len(header) < 3 or header[1] != "in" or tuple(header[2:]) not in catalogs:
                    raise ValueError("unsupported Android capture contract: iteration")
                if body[end + 1:end + 2] != ["{"]:
                    raise ValueError("unsupported Android capture contract: loop body")
                stop = closing(body, end + 1)
                walk(body[end + 2:stop], {**dimensions, header[0]: catalogs[tuple(header[2:])]}, lists)
                i = stop + 1
                continue
            if token in ("if", "when", "while", "do", "forEach", "repeat"):
                raise ValueError(f"unsupported Android capture contract: control flow {token}")
            if token in helpers and body[i + 1:i + 2] == ["("]:
                end = closing(body, i + 1)
                args = arguments(body[i + 2:end])
                named = [arg[2:] for arg in args if arg[:2] == ["name", "="]]
                if named:
                    template = literal(named[0])
                elif args and args[0][1:2] != ["="]:
                    template = literal(args[0])
                elif token in defaults:
                    template = defaults[token]
                else:
                    raise ValueError("unsupported capture filename: missing name")
                expand(template, dimensions)
                i = end + 1
                continue
            if token == "captureRoboImage" and body[i + 1:i + 2] == ["("]:
                raise ValueError("unsupported Android capture contract: direct image capture")
            if token == "{":
                end = closing(body, i)
                walk(body[i + 1:end], dimensions, lists)
                i = end + 1
                continue
            i += 1

    walk(tokens, {}, {})
    if not names or len(names) != len(set(names)):
        raise ValueError("empty or duplicate Android capture filenames")
    return frozenset(names)


EXPECTED_PNGS = expected_pngs()
EXPECTED_COUNT = len(EXPECTED_PNGS)


def verify(packet_dir: Path) -> list[str]:
    if not packet_dir.is_dir():
        return [f"packet directory does not exist: {packet_dir}"]

    names = [path.name for path in packet_dir.rglob("*.png") if path.is_file()]
    counts = Counter(names)
    actual = set(names)
    errors: list[str] = []

    missing = sorted(EXPECTED_PNGS - actual)
    unexpected = sorted(actual - EXPECTED_PNGS)
    duplicates = sorted(name for name, count in counts.items() if count > 1)

    if missing:
        errors.append(f"missing PNGs ({len(missing)}): {', '.join(missing)}")
    if unexpected:
        errors.append(f"unexpected PNGs ({len(unexpected)}): {', '.join(unexpected)}")
    if duplicates:
        errors.append(f"duplicate PNG basenames ({len(duplicates)}): {', '.join(duplicates)}")
    if len(names) != EXPECTED_COUNT and not errors:
        errors.append(f"found {len(names)} PNG files; expected {EXPECTED_COUNT}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the exact Android design-packet PNG contract."
    )
    parser.add_argument("packet_dir", type=Path)
    args = parser.parse_args()

    errors = verify(args.packet_dir)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print(f"OK: Android design packet contains exactly {EXPECTED_COUNT} expected PNGs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
