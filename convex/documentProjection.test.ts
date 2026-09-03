import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertSharesDecimal,
  canonicalizeSharesDecimal,
  parseLexicalJson,
  parseMinorUnits,
  projectBtcBalanceDocument,
  projectBudgetDocument,
  projectDocumentFile,
  projectFinanceDocument,
  SHARES_DECIMAL_MAX_INTEGER_DIGITS,
  SHARES_DECIMAL_MAX_LENGTH,
  SHARES_DECIMAL_MAX_PRECISION,
  SHARES_DECIMAL_MAX_SCALE,
} from "./documentProjection";

const sharesContract = JSON.parse(
  readFileSync(
    new URL("../shared/domain/fixtures/finance-market-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  sharesDecimalContract: {
    maxLength: number;
    signedMaxLength: number;
    maxPrecision: number;
    maxScale: number;
    maxIntegerDigits: number;
    valid: string[];
    lotOnly: string[];
    invalid: string[];
  };
};

describe("document projections preserve money lexically", () => {
  it("rounds raw JSON decimal tokens without passing through a number", () => {
    const budget = projectBudgetDocument(
      `{
        "month": "2026-07",
        "coinbase_one_balance": 1.005,
        "categories": [
          {"name": "Exact", "budget": 2.675, "spent": 999999.99}
        ],
        "income": {
          "weekly_gross": 3.335,
          "weekly_strike": 4.005,
          "weekly_river": 5.015,
          "monthly_gross": 6.025,
          "mtd_income": 7.035,
          "ytd_income": 8.045,
          "paychecks": [
            {"date": "2026-07-01", "amount": 9.055, "net": 10.065}
          ]
        },
        "mtd_income": 11.075,
        "ytd_income": 12.085,
        "monthly_history": [
          {
            "month": "2026-06",
            "income": 13.095,
            "expenses": 14.105,
            "savings_pct": 33.335
          }
        ]
      }`,
      "budget",
      123,
    );

    expect(budget.coinbaseOneBalanceCents).toBe(101n);
    expect(budget.categories).toEqual([
      { name: "Exact", icon: undefined, budgetCents: 268n },
    ]);
    expect(budget.categories[0]).not.toHaveProperty("spent");
    expect(budget.income).toMatchObject({
      weeklyGrossCents: 334n,
      weeklyStrikeCents: 401n,
      weeklyRiverCents: 502n,
      monthlyGrossCents: 603n,
      mtdIncomeCents: 704n,
      ytdIncomeCents: 805n,
    });
    expect(budget.income?.paychecks[0]).toMatchObject({
      amountCents: 906n,
      netCents: 1007n,
    });
    expect(budget.mtdIncomeCents).toBe(1108n);
    expect(budget.ytdIncomeCents).toBe(1209n);
    expect(budget.monthlyHistory[0]).toEqual({
      month: "2026-06",
      incomeCents: 1310n,
      expensesCents: 1411n,
      savingsBps: 3334n,
    });
  });

  it("supports exponent notation and half-away-from-zero exactly", () => {
    expect(parseMinorUnits("1e-8", 8)).toBe(1n);
    expect(parseMinorUnits("5e-9", 8)).toBe(1n);
    expect(parseMinorUnits("-5e-3", 2)).toBe(-1n);
    expect(parseMinorUnits("-1.005", 2)).toBe(-101n);
  });

  it("requires raw JSON text instead of accepting an already-decoded object", () => {
    expect(() => parseLexicalJson({ amount: 1.005 } as unknown as string)).toThrow(
      /requires raw JSON text/,
    );
    expect(() =>
      projectBudgetDocument(
        { month: "2026-07" } as unknown as string,
        "budget",
        0,
      ),
    ).toThrow(/requires raw JSON text/);
  });
});

describe("document projections keep source ownership closed", () => {
  it("uses structural owners and refuses unknown or mismatched owner strings", () => {
    expect(
      projectBudgetDocument(
        `{"month":"2026-07","owner":"mason","categories":[]}`,
        "mason-budget",
        0,
      ).owner,
    ).toBe("mason");

    expect(() =>
      projectBudgetDocument(
        `{"month":"2026-07","owner":"Mason ","categories":[]}`,
        "mason-budget",
        0,
      ),
    ).toThrow(/must be one of victor, rachel, mason, maddox/);

    expect(() =>
      projectBudgetDocument(
        `{"month":"2026-07","owner":"mason","categories":[]}`,
        "budget",
        0,
      ),
    ).toThrow(/must be victor/);
  });

  it("always projects son-balances as Mason and never as an adult", () => {
    const son = projectBtcBalanceDocument(
      `{
        "strike": 0.004,
        "river": 0.002,
        "coldcard": 0.01,
        "total": 0.016,
        "lastUpdated": "2026-07-18T12:00:00Z"
      }`,
      "son-balances",
      10,
    );

    expect(son.owner).toBe("mason");
    expect(son.accounts.map((account) => account.sats)).toEqual([
      400000n,
      200000n,
      1000000n,
    ]);
    expect(son.totals).toEqual({
      sats: 1600000n,
      fiatCents: 0n,
      exchangeSats: 600000n,
      selfCustodySats: 1000000n,
    });
  });
});

describe("all five source documents have typed projections", () => {
  it("projects adult BTC accounts, totals, and fiat as integer minor units", () => {
    const snapshot = projectBtcBalanceDocument(
      `{
        "schemaVersion": 2,
        "asOf": "2026-07-18T12:00:00Z",
        "accounts": {
          "strike": {
            "btc": 0.000000015,
            "fiat": 1.005,
            "label": "Strike",
            "custody": "exchange"
          },
          "coldcard": {
            "btc": 0.25,
            "fiat": 100.115,
            "label": "Coldcard",
            "custody": "self_custody"
          }
        },
        "totals": {}
      }`,
      "btc-balance-snapshot",
      20,
    );

    expect(snapshot.accounts[0]).toMatchObject({
      sats: 2n,
      fiatCents: 101n,
    });
    expect(snapshot.accounts[1]).toMatchObject({
      sats: 25000000n,
      fiatCents: 10012n,
    });
    expect(snapshot.totals).toEqual({
      sats: 25000002n,
      fiatCents: 10113n,
      exchangeSats: 2n,
      selfCustodySats: 25000000n,
    });
  });

  it("projects finances with exact money and closed nested owners", () => {
    const finances = projectFinanceDocument(
      `{
        "retirement": {
          "total": 1050.015,
          "accounts": {
            "adult_401k": {
              "owner": "victor",
              "provider": "Provider",
              "total": 1000.005,
              "weeklyContribution": 25.115,
              "holdings": [{
                "name": "Fund",
                "category": "Equity",
                "value": 1000.005,
                "costBasis": 900.115,
                "gainPct": 11.115,
                "shares": 3.14159265,
                "avgCost": 286.005,
                "currentPricePerShare": 318.315,
                "lots": [{
                  "date": "2026-01-01",
                  "type": "buy",
                  "pricePerShare": 300.005,
                  "shares": 1.125,
                  "amountInvested": 337.505
                }]
              }]
            }
          }
        },
        "mason_401k": {
          "owner": "mason",
          "total": 50.005,
          "weeklyContribution": 5.005,
          "holdings": []
        },
        "last_updated": "2026-07-18T12:00:00Z"
      }`,
      30,
    );

    expect(finances.accounts.map((account) => account.owner)).toEqual([
      "victor",
      "mason",
    ]);
    expect(finances.retirementTotalCents).toBe(105002n);
    expect(finances.accounts[0]).toMatchObject({
      totalValueCents: 100001n,
      weeklyContributionCents: 2512n,
    });
    expect(finances.accounts[0].holdings[0]).toMatchObject({
      valueCents: 100001n,
      costBasisCents: 90012n,
      gainBps: 1112n,
      sharesDecimal: "3.14159265",
      avgCostCents: 28601n,
      currentPricePerShareCents: 31832n,
    });
    expect(finances.accounts[0].holdings[0].lots[0]).toMatchObject({
      pricePerShareCents: 30001n,
      sharesDecimal: "1.125",
      amountInvestedCents: 33751n,
    });
    expect(finances.accounts[1]).toMatchObject({
      owner: "mason",
      totalValueCents: 5001n,
      weeklyContributionCents: 501n,
    });
  });

  it("enforces the shared shares contract before finance storage projection", () => {
    const contract = sharesContract.sharesDecimalContract;
    expect({
      maxLength: SHARES_DECIMAL_MAX_LENGTH,
      signedMaxLength: SHARES_DECIMAL_MAX_LENGTH + 1,
      maxPrecision: SHARES_DECIMAL_MAX_PRECISION,
      maxScale: SHARES_DECIMAL_MAX_SCALE,
      maxIntegerDigits: SHARES_DECIMAL_MAX_INTEGER_DIGITS,
    }).toEqual({
      maxLength: contract.maxLength,
      signedMaxLength: contract.signedMaxLength,
      maxPrecision: contract.maxPrecision,
      maxScale: contract.maxScale,
      maxIntegerDigits: contract.maxIntegerDigits,
    });

    const rawFinance = (shares: string, lotShares = shares) => JSON.stringify({
      retirement: {
        accounts: {
          adult_401k: {
            holdings: [{
              name: "Fund",
              shares,
              lots: [{ shares: lotShares }],
            }],
          },
        },
      },
    });

    const holdingOf = (shares: string, lotShares = shares) =>
      projectFinanceDocument(rawFinance(shares, lotShares), 0).accounts[0]!.holdings[0]!;

    // The fixture's `invalid` column is the *assert* contract every reading
    // client enforces. The projection is the one layer allowed to repair a
    // value instead of refusing it, so a few entries land on a canonical form
    // here. `holding` is absent where the repair is lot-only: minus zero is a
    // second spelling of a legitimate lot quantity, while any negative position
    // size is corruption.
    const repairedAtProjection: Record<string, { holding?: string; lot: string }> = {
      "1.1234567890123": { holding: "1.123456789012", lot: "1.123456789012" },
      "999999999999.9999999999990": {
        holding: "999999999999.999999999999",
        lot: "999999999999.999999999999",
      },
      "-0": { lot: "0" },
      "-0.0": { lot: "0" },
    };

    for (const value of contract.valid) {
      const holding = holdingOf(value);
      expect(holding.sharesDecimal, value).toBe(value);
      expect(holding.lots[0]!.sharesDecimal, value).toBe(value);
    }
    // Signed quantities are lot-only: a reconciliation lot removes shares, a
    // position size never goes negative.
    for (const value of contract.lotOnly) {
      expect(() => holdingOf(value), value).toThrow(/share quantity/);
      expect(holdingOf("1", value).lots[0]!.sharesDecimal, value).toBe(value);
    }
    for (const value of contract.invalid) {
      const repaired = repairedAtProjection[value];
      if (repaired?.holding !== undefined) {
        expect(holdingOf(value).sharesDecimal, value).toBe(repaired.holding);
      } else {
        expect(() => holdingOf(value), value).toThrow(/share quantity/);
      }
      if (repaired !== undefined) {
        expect(holdingOf("1", value).lots[0]!.sharesDecimal, value).toBe(repaired.lot);
      } else {
        expect(() => holdingOf("1", value), value).toThrow(/share quantity/);
      }
    }
  });

  it("projects the legacy stored shapes: float noise and negative reconciliation lots", () => {
    // Boundary-equivalent to legacy pre-contract stored text: lot quantities
    // written from IEEE-754 doubles (15-16 fractional digits), and
    // statement_reconciliation lots that remove shares and are therefore
    // negative. Identifiers and amounts are synthetic; only the shapes matter.
    // Written out as JSON text, not JSON.stringify of JS numbers: the source
    // tokens are the point, and JSON.stringify would re-encode a small negative
    // as an exponent the contract rightly refuses.
    const raw = `{
      "retirement": {
        "accounts": {
          "alpha": {
            "holdings": [{
              "name": "Synthetic Index Fund",
              "ticker": "SYNX",
              "shares": 12.0000000000004,
              "lots": [
                {"date": "2026-03-02", "type": "buy", "shares": 1.7999999999999998},
                {"date": "2026-04-01", "type": "buy", "shares": 0.5000000000005}
              ]
            }]
          },
          "omega": {
            "provider": "Synthetic Retirement Provider",
            "holdings": [{
              "name": "Synthetic Index Fund",
              "ticker": "SYNX",
              "shares": 3.3000000000000003,
              "lots": [
                {"date": "2026-05-01", "type": "statement_reconciliation", "shares": -0.0000000000004},
                {"date": "2026-05-02", "type": "statement_reconciliation", "shares": -1.2345678901239}
              ]
            }]
          }
        }
      }
    }`;

    const accounts = projectFinanceDocument(raw, 0).accounts;
    const alpha = accounts.find((account) => account.key === "alpha")!;
    const omega = accounts.find((account) => account.key === "omega")!;

    expect(alpha.holdings[0]!.sharesDecimal).toBe("12");
    expect(alpha.holdings[0]!.lots.map((lot) => lot.sharesDecimal))
      .toEqual(["1.8", "0.500000000001"]);
    expect(omega.holdings[0]!.sharesDecimal).toBe("3.3");
    // Minus zero has no canonical spelling of its own; a negative that rounds
    // away to nothing becomes plain zero rather than "-0".
    expect(omega.holdings[0]!.lots.map((lot) => lot.sharesDecimal))
      .toEqual(["0", "-1.234567890124"]);
  });

  // A bigint is the obvious wrong guess for "an exact quantity". Rendering one
  // into an error message with JSON.stringify throws a TypeError and replaces
  // the RangeError this contract promises, so a caller catching RangeError sees
  // nothing and crashes instead. These messages are positional by design and
  // must stay that way — a stored quantity in a thrown message reaches the
  // Convex function log.
  it("raises RangeError for non-string quantities and never quotes the value", () => {
    const nonStrings: unknown[] = [
      1n,
      -1n,
      1.5,
      true,
      null,
      undefined,
      { sharesDecimal: "1.5" },
      Symbol("shares"),
    ];
    for (const value of nonStrings) {
      for (const call of [
        () => assertSharesDecimal(value, "holding sharesDecimal"),
        () => assertSharesDecimal(value, "lot sharesDecimal", { signed: true }),
        () => canonicalizeSharesDecimal(value, "holding sharesDecimal"),
        () =>
          canonicalizeSharesDecimal(value, "lot sharesDecimal", {
            signed: true,
          }),
      ]) {
        expect(call, String(typeof value)).toThrow(RangeError);
        expect(call, String(typeof value)).toThrow(
          /^(holding|lot) sharesDecimal is not a canonical share quantity$/,
        );
      }
    }
  });

  it("rejects present non-array finance holdings and lots without rejecting omission", () => {
    const account = (fields: string) => `{
      "retirement": {"accounts": {"adult_401k": {${fields}}}}
    }`;

    expect(projectFinanceDocument(account(""), 0).accounts[0]!.holdings)
      .toEqual([]);
    for (const value of ["{}", "null", '"not-an-array"']) {
      expect(
        () => projectFinanceDocument(account(`"holdings": ${value}`), 0),
        value,
      ).toThrow(/finances\.adult_401k\.holdings must be a JSON array/);
    }

    const holding = (lots: string) => account(`
      "holdings": [{"name": "VOO", "shares": 0${lots}}]
    `);
    expect(projectFinanceDocument(holding(""), 0).accounts[0]!.holdings[0]!.lots)
      .toEqual([]);
    for (const value of ["{}", "null", '"not-an-array"']) {
      expect(
        () => projectFinanceDocument(holding(`, "lots": ${value}`), 0),
        value,
      ).toThrow(/finances\.adult_401k\.holdings\[0\]\.lots must be a JSON array/);
    }
  });

  it("accepts the live direct retirement shape without treating its total as an account", () => {
    const finances = projectFinanceDocument(
      `{
        "lastUpdated": "2026-04-29",
        "retirement": {
          "401k": {
            "provider": "Provider",
            "total": 773307.46,
            "weeklyContribution": 291.6,
            "weeklyContributionDay": "Friday",
            "holdings": []
          },
          "total": 773307.46
        }
      }`,
      31,
    );

    expect(finances.retirementTotalCents).toBe(77330746n);
    expect(finances.accounts).toEqual([
      expect.objectContaining({
        key: "401k",
        owner: "victor",
        totalValueCents: 77330746n,
        weeklyContributionCents: 29160n,
        weeklyContributionDay: "Friday",
      }),
    ]);
  });

  it("dispatches each of the five closed source names to its typed table", () => {
    expect(
      projectDocumentFile(
        "budget",
        `{"month":"2026-07","categories":[]}`,
        0,
      ).table,
    ).toBe("budgetDocuments");
    expect(
      projectDocumentFile(
        "mason-budget",
        `{"month":"2026-07","categories":[]}`,
        0,
      ).table,
    ).toBe("budgetDocuments");
    expect(
      projectDocumentFile(
        "btc-balance-snapshot",
        `{"accounts":{},"totals":{}}`,
        0,
      ).table,
    ).toBe("btcBalanceDocuments");
    expect(
      projectDocumentFile(
        "son-balances",
        `{"strike":0,"river":0,"coldcard":0,"total":0}`,
        0,
      ).table,
    ).toBe("btcBalanceDocuments");
    expect(
      projectDocumentFile(
        "finances",
        `{"retirement":{"accounts":{}}}`,
        0,
      ).table,
    ).toBe("financeDocuments");
    expect(() =>
      projectDocumentFile(
        "maddox-budget" as never,
        `{"month":"2026-07","categories":[]}`,
        0,
      ),
    ).toThrow(/Unknown document source file/);
  });

  it("refuses an unknown owner nested in finances rather than coercing it", () => {
    expect(() =>
      projectFinanceDocument(
        `{
          "retirement": {
            "accounts": {
              "bad": {"owner": "Mason ", "holdings": []}
            }
          }
        }`,
        0,
      ),
    ).toThrow(/must be one of victor, rachel, mason, maddox/);
  });
});

describe("the money copy is the shared domain implementation", () => {
  // The Convex copy was deleted; these pin the context-preserving adapters
  // against the domain implementation they re-export.
  it("agrees with the domain implementation on every contract case", async () => {
    const domain = await import("@vogel-vault/domain/money");
    for (const value of [
      "0",
      "2.5000",
      "12",
      "0.000000000001",
      "123456789012.123456789012",
    ]) {
      expect(canonicalizeSharesDecimal(value, "case")).toBe(
        domain.canonicalizeSharesDecimal(value),
      );
      expect(assertSharesDecimal(value, "case")).toBe(
        domain.assertSharesDecimal(value),
      );
    }
    for (const bad of ["1e5", "01", "+1", "1234567890123", " 1"]) {
      expect(() => canonicalizeSharesDecimal(bad, "case")).toThrow(
        RangeError,
      );
      expect(() => domain.canonicalizeSharesDecimal(bad)).toThrow();
    }
  });

  it("labels rejections with the caller's context, never the value", () => {
    try {
      canonicalizeSharesDecimal("1e5", "finances.holdings[2].shares");
      expect.unreachable();
    } catch (error) {
      expect((error as RangeError).message).toBe(
        "finances.holdings[2].shares is not a canonical share quantity",
      );
    }
  });
});
