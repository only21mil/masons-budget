#!/usr/bin/env python3
"""Ensure CoreSimulator has one named iPhone for the newest iOS runtime."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import uuid
from typing import Any


class SimulatorSetupError(RuntimeError):
    """A concrete simulator could not be selected or created."""


def version_tuple(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in value.split("."))
    except ValueError as error:
        raise SimulatorSetupError(f"invalid simulator runtime version {value!r}") from error


def encoded_version(value: str) -> int:
    parts = version_tuple(value)
    major, minor, patch = (parts + (0, 0, 0))[:3]
    return (major << 16) | (minor << 8) | patch


def select_runtime(runtimes: list[dict[str, Any]]) -> dict[str, Any]:
    available = [
        runtime
        for runtime in runtimes
        if runtime.get("isAvailable")
        and str(runtime.get("identifier", "")).startswith(
            "com.apple.CoreSimulator.SimRuntime.iOS-"
        )
        and runtime.get("version")
    ]
    if not available:
        raise SimulatorSetupError(
            "no available iOS simulator runtime is installed; "
            "an SDK alone cannot host a simulator device"
        )
    return max(available, key=lambda runtime: version_tuple(runtime["version"]))


def select_device_type(
    device_types: list[dict[str, Any]], runtime: dict[str, Any]
) -> dict[str, Any]:
    runtime_version = encoded_version(runtime["version"])
    compatible = [
        device_type
        for device_type in device_types
        if device_type.get("productFamily") == "iPhone"
        and device_type.get("identifier")
        and int(device_type.get("minRuntimeVersion", 0)) <= runtime_version
        <= int(device_type.get("maxRuntimeVersion", 0))
    ]
    if not compatible:
        raise SimulatorSetupError(
            "no compatible iPhone simulator device type is installed for "
            f"{runtime['name']} ({runtime['identifier']})"
        )

    # Prefer the newest device family compatible with the selected runtime.
    return max(
        compatible,
        key=lambda device_type: (
            int(device_type.get("minRuntimeVersion", 0)),
            str(device_type["name"]),
        ),
    )


def find_named_device(
    devices: dict[str, list[dict[str, Any]]], runtime_id: str, name: str
) -> str | None:
    candidates = [
        device
        for device in devices.get(runtime_id, [])
        if device.get("name") == name and device.get("isAvailable")
    ]
    if not candidates:
        return None
    return sorted(str(device["udid"]) for device in candidates)[0]


def simctl_json(*arguments: str) -> dict[str, Any]:
    completed = subprocess.run(
        ["xcrun", "simctl", *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SimulatorSetupError(
            f"simctl {' '.join(arguments)} returned invalid JSON"
        ) from error


def create_device(name: str, device_type_id: str, runtime_id: str) -> str:
    completed = subprocess.run(
        ["xcrun", "simctl", "create", name, device_type_id, runtime_id],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise SimulatorSetupError(
            "simctl could not create the required iPhone device "
            f"{name!r} with type {device_type_id} on runtime {runtime_id} "
            f"(exit {completed.returncode})"
        )
    udid = completed.stdout.strip()
    try:
        uuid.UUID(udid)
    except ValueError as error:
        raise SimulatorSetupError(
            f"simctl create returned an invalid device identifier: {udid!r}"
        ) from error
    return udid


def ensure_simulator(name: str) -> str:
    runtime = select_runtime(simctl_json("list", "-j", "runtimes")["runtimes"])
    device_type = select_device_type(
        simctl_json("list", "-j", "devicetypes")["devicetypes"], runtime
    )
    devices = simctl_json("list", "-j", "devices")["devices"]

    print(
        f"Selected {runtime['name']} ({runtime['identifier']}) with "
        f"{device_type['name']} ({device_type['identifier']}).",
        file=sys.stderr,
    )
    udid = find_named_device(devices, runtime["identifier"], name)
    if udid:
        print(f"Reusing {name} ({udid}).", file=sys.stderr)
        return udid

    udid = create_device(name, device_type["identifier"], runtime["identifier"])
    print(f"Created {name} ({udid}).", file=sys.stderr)
    return udid


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="Vogel Vault CI iPhone")
    arguments = parser.parse_args()

    try:
        print(ensure_simulator(arguments.name))
    except (KeyError, OSError, subprocess.SubprocessError, SimulatorSetupError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
