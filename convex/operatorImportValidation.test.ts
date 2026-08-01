import { describe, expect, it } from "vitest";

import {
  OPERATOR_IMPORT_SCHEMA,
  OperatorImportValidationError,
  canonicalOperatorImportJson,
  canonicalizeOperatorImportEnvelope,
  parseOperatorImportEnvelope,
  semanticFingerprintForOperatorImportOp,
  sha256Hex,
} from "./operatorImportValidation";

const transaction = (overrides: Record<string, unknown> = {}) => ({
  kind: "transaction",
  op_id: "op-1",
  record_id: "tx-1",
  source_locator: "receipt/1",
  owner: "victor",
  source_file: "transactions",
  date: "2026-07-31",
  merchant: "Costco",
  amount_cents: "12345",
  transaction_kind: "spend",
  category: "Groceries",
  ...overrides,
});

const batch = (ops: unknown[], duplicate_attestations: unknown[] = []) => ({
  schema: OPERATOR_IMPORT_SCHEMA,
  batch_id: "batch-1",
  ops,
  duplicate_attestations,
});

describe("operatorImportValidation", () => {
  it("normalizes decimal strings and emits stable canonical JSON and digest", async () => {
    const parsed = parseOperatorImportEnvelope(batch([transaction()]));
    expect(parsed.ops[0]?.kind === "transaction" && parsed.ops[0].amount_cents).toBe(12345n);
    const first = await canonicalizeOperatorImportEnvelope(batch([transaction()]));
    const second = await canonicalizeOperatorImportEnvelope(batch([transaction()]));
    expect(first.manifest_digest).toBe(second.manifest_digest);
    expect(first.manifest_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.counts).toEqual({ transaction: 1, income: 0, btc_buy: 0, btc_bill_pay: 0 });
    expect(canonicalOperatorImportJson(parsed)).toContain('"amount_cents":"12345"');
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("defaults bill pays to the budget-excluded contract", () => {
    const parsed = parseOperatorImportEnvelope(batch([{
      kind: "btc_bill_pay", op_id: "bp-op", record_id: "bp-1",
      source_locator: "river/1", owner: "victor",
      source_file: "bitcoin-bill-pays", date: "2026-07-31",
      merchant: "Aven", category: "Credit Card Payment",
      amount_usd_cents: "12000", btc_spent_sats: "180000",
      btc_price_cents: "6666667", fee_usd_cents: "0",
    }]));
    expect(parsed.ops[0]?.kind === "btc_bill_pay" && parsed.ops[0].budget_effect)
      .toBe("excluded_from_transactions");
  });

  it("rejects inconsistent BTC and USD tuples", () => {
    expect(() => parseOperatorImportEnvelope(batch([{
      kind: "btc_buy", op_id: "buy-op", record_id: "buy-1",
      source_locator: "river/buy-1", owner: "victor",
      source_file: "bitcoin-buys", date: "2026-07-31",
      source: "River", sats: "1", price_usd_cents: "1",
      usd_cents: "999",
    }]))).toThrowError(OperatorImportValidationError);

    expect(() => parseOperatorImportEnvelope(batch([{
      kind: "btc_bill_pay", op_id: "bp-op", record_id: "bp-1",
      source_locator: "river/bp-1", owner: "victor",
      source_file: "bitcoin-bill-pays", date: "2026-07-31",
      merchant: "Aven", category: "Credit Card Payment",
      amount_usd_cents: "12000", btc_spent_sats: "1",
      btc_price_cents: "1", fee_usd_cents: "0",
    }]))).toThrowError(OperatorImportValidationError);
  });

  it("binds an optional preserve-only budget advance into canonical JSON", async () => {
    const input = {
      ...batch([transaction()]),
      budget_advance: {
        source_file: "budget",
        expected_month: "June 2026",
        target_month: "August 2026",
        expected_updated_at_ms: "0",
        history_mode: "preserve_existing",
      },
    };
    const parsed = parseOperatorImportEnvelope(input);
    expect(parsed.budget_advance).toEqual({
      source_file: "budget",
      expected_month: "June 2026",
      target_month: "August 2026",
      expected_updated_at_ms: 0,
      history_mode: "preserve_existing",
    });
    const canonical = canonicalOperatorImportJson(parsed);
    expect(canonical.endsWith("\n")).toBe(true);
    const result = await canonicalizeOperatorImportEnvelope(input);
    expect(result.manifest_digest).toBe(await sha256Hex(canonical));
  });

  it.each([
    [transaction({ amount_cents: 12_345 }), "INVALID_INTEGER"],
    [transaction({ amount_cents: "0" }), "INVALID_SIGN"],
    [transaction({ amount_cents: "-1" }), "INVALID_SIGN"],
    [transaction({ date: "2026-02-29" }), "INVALID_DATE"],
    [transaction({ owner: "mason" }), "OWNER_SOURCE_MISMATCH"],
    [transaction({ category: "Income", transaction_kind: "credit", amount_cents: "-1" }), "INVALID_CATEGORY"],
    [transaction({ surprise: true }), "UNKNOWN_FIELD"],
  ])("fails closed without echoing row contents", (op, code) => {
    try {
      parseOperatorImportEnvelope(batch([op]));
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorImportValidationError);
      expect((error as OperatorImportValidationError).code).toBe(code);
      expect(String(error)).not.toContain("Costco");
    }
  });

  it("rejects duplicate identities and requires an exact semantic attestation", async () => {
    const duplicate = transaction({ op_id: "op-2", record_id: "tx-2", source_locator: "receipt/2" });
    await expect(canonicalizeOperatorImportEnvelope(batch([transaction(), duplicate])))
      .rejects.toMatchObject({ code: "SEMANTIC_DUPLICATE" });

    const parsed = parseOperatorImportEnvelope(batch([transaction()]));
    const fingerprint = await semanticFingerprintForOperatorImportOp(parsed.ops[0]!);
    await expect(canonicalizeOperatorImportEnvelope(batch(
      [transaction(), duplicate],
      [{
        type: "semantic_duplicate",
        op_ids: ["op-1", "op-2"],
        semantic_fingerprint: fingerprint,
        assertion: "distinct_real_world_records",
      }],
    ))).resolves.toMatchObject({ counts: { transaction: 2 } });

    await expect(canonicalizeOperatorImportEnvelope(batch([
      transaction(), transaction({ op_id: "op-2", source_locator: "receipt/2" }),
    ]))).rejects.toMatchObject({ code: "DUPLICATE_RECORD_ID" });
  });

  it("enforces the 100-op bound", () => {
    expect(() => parseOperatorImportEnvelope(batch(
      Array.from({ length: 101 }, (_, index) => transaction({
        op_id: `op-${index}`,
        record_id: `tx-${index}`,
        source_locator: `receipt/${index}`,
      })),
    ))).toThrowError(OperatorImportValidationError);
  });
});
