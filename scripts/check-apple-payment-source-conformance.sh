#!/usr/bin/env bash
#
# Payment-source conformance gate (Apple client).
#
# Verifies the Swift TransactionSourceCatalog in
# MasonsBudget/MasonsBudget/Models/TransactionSource.swift matches the closed
# wire contract in shared/domain/fixtures/payment-source-cases.json wire for
# wire, label for label, in canonical picker order. The companion Swift test
# (MasonsBudgetTests/PaymentSourceConformanceTests.swift) pins the catalogue
# against hardcoded contract values; this gate diffs against the live fixture
# JSON so drift in either direction is caught.
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec python3 "$ROOT/scripts/apple_payment_source_conformance.py" --root "$ROOT" "$@"
