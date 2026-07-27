// Suite for convex/writeback.ts — the validating write path.
//
// MC2 is gone, so nothing upstream of Convex checks anything. These tests are
// the proof that the last remaining gate actually rejects: every case below is
// a value that would silently corrupt the family's only copy of their finances
// if it were coerced instead of refused.
//
// Three of the guards are MIRRORS of code that lives outside convex/ (the sync
// token, the family contract, the money and date parsers). Those are not
// trusted on inspection — each has a parity test that drives the mirror and the
// real thing and asserts they agree, so an un-mirrored change breaks the suite
// rather than production.
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import schema from "./schema";
import {
  freshSecret,
  setDeploymentEnv,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import {
  AUDIT_FILE,
  FAMILY_MEMBERS,
  isRealIsoDate,
  MAX_AUDIT_BYTES,
  MAX_AUDIT_ENTRIES,
  minorUnitsToDecimalString,
  readAuditLog,
  spendSignFor,
  storedAmountToMinorUnits,
  TODO_LANES,
  transactionsFileFor,
  trimAuditLog,
} from "./writeback";

// The real domain contract, imported only in the test. The deployed function
// cannot import across the convex/ boundary; a test can, which is exactly what
// makes the mirrors checkable.
import {
  FAMILY_MEMBERS as DOMAIN_FAMILY_MEMBERS,
  mc2TransactionsFileName,
} from "../shared/domain/src/family";
import { parseCents } from "../shared/domain/src/money";
import { isIsoDate as domainIsIsoDate, TODO_LANES as DOMAIN_TODO_LANES } from "../shared/domain/src/todo";

useIsolatedDeploymentEnv();

// ── Harness ──
// A local instance rather than harness.test-utils.testConvex, whose module map
// predates this file and is owned by another change in flight.

const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./dataFiles.ts": () => import("./dataFiles"),
  "./todoNormalize.ts": () => import("./todoNormalize"),
  "./writeback.ts": () => import("./writeback"),
};

function harness() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof harness>;
type Row = Record<string, unknown>;

type CreateTransactionArgs = {
  id: string;
  owner: string;
  date: string;
  merchant: string;
  amountMinor: number;
  kind?: "spend" | "credit";
  category: string;
  card?: string | null;
  note?: string | null;
  actor: string;
  token?: string;
};

type EditTransactionArgs = {
  id: string;
  owner: string;
  date?: string;
  merchant?: string;
  amountMinor?: number;
  kind?: "spend" | "credit";
  category?: string;
  card?: string | null;
  note?: string | null;
  actor: string;
  token?: string;
};

type CreateTodoArgs = {
  id: string;
  title: string;
  category: string;
  owner: string;
  assignee?: string;
  project?: string;
  area?: string;
  notes?: string;
  dueDate?: string | null;
  priority?: number;
  flag?: boolean;
  done?: boolean;
  actor: string;
  token?: string;
};

type EditTodoArgs = {
  id: string;
  title?: string;
  category?: string;
  owner?: string;
  assignee?: string;
  project?: string;
  area?: string;
  notes?: string;
  dueDate?: string | null;
  priority?: number;
  flag?: boolean;
  done?: boolean;
  actor: string;
  token?: string;
};

interface WriteResult {
  ok: true;
  file: string;
  id: string;
  version: number;
  created?: boolean;
  changed?: boolean;
  idempotent: boolean;
  auditSeq: number | null;
}

const api = {
  createTransaction: "writeback:createTransaction" as unknown as FunctionReference<
    "mutation",
    "public",
    CreateTransactionArgs,
    WriteResult
  >,
  editTransaction: "writeback:editTransaction" as unknown as FunctionReference<
    "mutation",
    "public",
    EditTransactionArgs,
    WriteResult
  >,
  createTodo: "writeback:createTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    CreateTodoArgs,
    WriteResult
  >,
  editTodo: "writeback:editTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    EditTodoArgs,
    WriteResult
  >,
  dataFilesSync: "dataFiles:sync" as unknown as FunctionReference<
    "mutation",
    "public",
    { name: string; data: unknown; token?: string },
    { name: string; version: number }
  >,
  dataFilesGet: "dataFiles:get" as unknown as FunctionReference<
    "query",
    "public",
    { name: string; token?: string },
    unknown
  >,
};

async function readFile(t: T, name: string) {
  return await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    return doc ?? null;
  });
}

async function readRows(t: T, name: string): Promise<Row[]> {
  const doc = await readFile(t, name);
  const data = doc?.data;
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object" && Array.isArray(data.todos)) {
    return data.todos as Row[];
  }
  return [];
}

interface AuditEntry {
  seq: number;
  op: string;
  entity: string;
  file: string;
  id: string;
  actor: string;
  before: Row | null;
  after: Row;
}

async function readAudit(t: T) {
  const doc = await readFile(t, AUDIT_FILE);
  const data = (doc?.data ?? {}) as {
    entries?: AuditEntry[];
    dropped?: number;
    nextSeq?: number;
    droppedThroughSeq?: number | null;
  };
  return {
    entries: data.entries ?? [],
    dropped: data.dropped ?? 0,
    nextSeq: data.nextSeq ?? 1,
    droppedThroughSeq: data.droppedThroughSeq ?? null,
  };
}

/** Authenticate and return the token every test writes with. */
function authed(): string {
  const token = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: token });
  return token;
}

/** The structured rejection payload, or a failure if the call succeeded. */
async function rejection(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof ConvexError) {
      return error.data as { code: string; field: string | null; message: string };
    }
    throw error;
  }
  throw new Error("expected the mutation to reject, but it resolved");
}

const BASE_TXN = {
  owner: "victor",
  date: "2026-07-20",
  merchant: "Costco",
  category: "Groceries",
  actor: "victor@linux",
};

// ─────────────────────────────────────────────────────────────────────────────
describe("auth", () => {
  // The gate is a hand-mirrored copy of the private one in dataFiles.ts, so it
  // is checked against the original rather than read. Both are driven through
  // the same matrix; if they ever disagree, the mirror has drifted and this
  // file's claim about production behaviour has stopped being true.
  const MATRIX: {
    label: string;
    tokenConfigured: boolean;
    hatch: boolean;
    sends: "correct" | "wrong" | "none";
    admits: boolean;
  }[] = [
    { label: "nothing configured, nothing sent", tokenConfigured: false, hatch: false, sends: "none", admits: false },
    { label: "nothing configured, a token sent", tokenConfigured: false, hatch: false, sends: "wrong", admits: false },
    { label: "token configured, correct token", tokenConfigured: true, hatch: false, sends: "correct", admits: true },
    { label: "token configured, wrong token", tokenConfigured: true, hatch: false, sends: "wrong", admits: false },
    { label: "token configured, none sent", tokenConfigured: true, hatch: false, sends: "none", admits: false },
    { label: "hatch on, nothing configured", tokenConfigured: false, hatch: true, sends: "none", admits: true },
    // The precedence that matters: a SET token is not evidence of enforcement.
    { label: "hatch on outranks a configured token", tokenConfigured: true, hatch: true, sends: "wrong", admits: true },
  ];

  for (const cell of MATRIX) {
    it(`matches dataFiles: ${cell.label}`, async () => {
      const t = harness();
      const secret = freshSecret();
      if (cell.tokenConfigured) setDeploymentEnv({ CONVEX_SYNC_TOKEN: secret });
      if (cell.hatch) setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });

      const token =
        cell.sends === "correct"
          ? secret
          : cell.sends === "wrong"
            ? freshSecret()
            : undefined;

      const canonicalAdmitted = await t
        .mutation(api.dataFilesSync, { name: "budget", data: [], token })
        .then(() => true)
        .catch(() => false);

      const mirrorAdmitted = await t
        .mutation(api.createTransaction, {
          ...BASE_TXN,
          id: "txn-auth",
          amountMinor: -1234,
          token,
        })
        .then(() => true)
        // A ConvexError is a VALIDATION rejection, which means the gate let the
        // call through — the only thing this matrix measures. A plain Error is
        // the gate itself refusing.
        .catch((error: unknown) => error instanceof ConvexError);

      expect(mirrorAdmitted).toBe(canonicalAdmitted);
      expect(mirrorAdmitted).toBe(cell.admits);
    });
  }

  it("gates every writeback mutation, not just the first one", async () => {
    const t = harness();
    // No token configured and no hatch: fail-closed on all four doors.
    await expect(
      t.mutation(api.createTransaction, { ...BASE_TXN, id: "a", amountMinor: -1 }),
    ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
    await expect(
      t.mutation(api.editTransaction, { id: "a", owner: "victor", actor: "x" }),
    ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
    await expect(
      t.mutation(api.createTodo, {
        id: "a",
        title: "x",
        category: "sats",
        owner: "victor",
        actor: "x",
      }),
    ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
    await expect(
      t.mutation(api.editTodo, { id: "a", title: "x", actor: "x" }),
    ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
  });

  it("writes nothing when the token is refused", async () => {
    const t = harness();
    setDeploymentEnv({ CONVEX_SYNC_TOKEN: freshSecret() });
    await expect(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "a",
        amountMinor: -1,
        token: freshSecret(),
      }),
    ).rejects.toThrow(/invalid sync token/);
    expect(await readRows(t, "transactions")).toEqual([]);
    expect((await readAudit(t)).entries).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mirror parity with the shared domain contract", () => {
  it("knows exactly the four family members", () => {
    expect([...FAMILY_MEMBERS]).toEqual([...DOMAIN_FAMILY_MEMBERS]);
  });

  it("routes each owner to the file the domain routes them to", () => {
    for (const member of DOMAIN_FAMILY_MEMBERS) {
      expect(transactionsFileFor(member)).toBe(
        mc2TransactionsFileName(member),
      );
    }
  });

  it("keeps Victor and Rachel in one household file", () => {
    // The v0.3 regression: a strict owner check emptied Rachel's screens.
    expect(transactionsFileFor("rachel")).toBe(
      transactionsFileFor("victor"),
    );
  });

  it("uses the same three todo lanes", () => {
    expect([...TODO_LANES]).toEqual([...DOMAIN_TODO_LANES]);
  });

  it("agrees with the domain date validator, 2026-02-30 included", () => {
    const cases = [
      "2026-07-26",
      "2026-02-28",
      "2024-02-29",
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-07-32",
      "2026-7-4",
      "26-07-04",
      "2026-07-26T00:00:00Z",
      "",
      "not a date",
    ];
    for (const value of cases) {
      expect([value, isRealIsoDate(value)]).toEqual([
        value,
        domainIsIsoDate(value),
      ]);
    }
  });

  it("parses a stored amount exactly the way the clients do", () => {
    const samples = [0, 1, -1, 99, 100, 1234, -1234, 505, 999_99, -100_000_00, 100_000_000];
    for (const minor of samples) {
      const stored = Number(minorUnitsToDecimalString(minor));
      expect([minor, storedAmountToMinorUnits(stored)]).toEqual([
        minor,
        parseCents(stored),
      ]);
      expect(parseCents(stored)).toBe(BigInt(minor));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("money", () => {
  it("rejects a float outright instead of rounding it", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-float",
        // Dollars typed into a cents field. Rounding this to -12 cents, or
        // multiplying it by 100, are both a number nobody entered.
        amountMinor: -12.34,
        token,
      }),
    );
    expect(error.code).toBe("invalid_amount");
    expect(error.field).toBe("amountMinor");
    expect(error.message).toContain("integer number of cents");
    expect(await readRows(t, "transactions")).toEqual([]);
  });

  it("rejects a value that has lost precision before it arrived", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-huge",
        amountMinor: -(2 ** 53),
        token,
      }),
    );
    expect(["invalid_amount", "amount_out_of_range"]).toContain(error.code);
  });

  it("rejects a seven-figure line item as the typo it almost certainly is", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-typo",
        amountMinor: -1_000_000_01,
        token,
      }),
    );
    expect(error.code).toBe("amount_out_of_range");
  });

  it("stores the decimal every client already decodes", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -1234,
      token,
    });
    const [row] = await readRows(t, "transactions");
    expect(row.amount).toBe(-12.34);
    // And the read path recovers the exact integer, which is the only property
    // that actually matters.
    expect(parseCents(row.amount)).toBe(-1234n);
  });

  it("round-trips every cent value in a swept range", () => {
    for (let minor = -5_000; minor <= 5_000; minor += 1) {
      const stored = Number(minorUnitsToDecimalString(minor));
      expect(parseCents(stored)).toBe(BigInt(minor));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("owner", () => {
  it("rejects an owner outside the four members", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        owner: "grandma",
        id: "txn-1",
        amountMinor: -100,
        token,
      }),
    );
    expect(error.code).toBe("invalid_owner");
    expect(error.field).toBe("owner");
  });

  it("files Rachel's row in the shared adult file, tagged rachel", async () => {
    const t = harness();
    const token = authed();
    const result = await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      owner: "rachel",
      id: "txn-r",
      amountMinor: -500,
      token,
    });
    expect(result.file).toBe("transactions");
    const [row] = await readRows(t, "transactions");
    expect(row.owner).toBe("rachel");
  });

  it("files a child's row in that child's own file", async () => {
    const t = harness();
    const token = authed();
    const result = await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      owner: "mason",
      id: "txn-m",
      // Child files store spend as a positive magnitude.
      amountMinor: 6000,
      category: "Games",
      token,
    });
    expect(result.file).toBe("mason-transactions");
    expect(await readRows(t, "transactions")).toEqual([]);
    expect(await readRows(t, "mason-transactions")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sign convention", () => {
  it("requires an adult spend to be negative", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-1",
        amountMinor: 1234,
        token,
      }),
    );
    expect(error.code).toBe("sign_mismatch");
    expect(error.message).toContain("not corrected here on purpose");
  });

  it("requires a child spend to be positive", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        owner: "mason",
        id: "txn-1",
        amountMinor: -1234,
        category: "Games",
        token,
      }),
    );
    expect(error.code).toBe("sign_mismatch");
  });

  it("accepts an adult credit as positive", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-pay",
      category: "Income",
      kind: "credit",
      amountMinor: 250_000,
      token,
    });
    const [row] = await readRows(t, "transactions");
    expect(row.amount).toBe(2500);
  });

  it("refuses an Income row declared as spend", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-pay",
        category: "Income",
        amountMinor: -250_000,
        token,
      }),
    );
    expect(error.code).toBe("sign_mismatch");
    expect(error.field).toBe("kind");
  });

  it("refuses a zero-value transaction", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-0",
        amountMinor: 0,
        token,
      }),
    );
    expect(error.code).toBe("invalid_amount");
  });

  it("matches the domain's own view of which files sign spend which way", () => {
    expect(spendSignFor("victor")).toBe(-1);
    expect(spendSignFor("rachel")).toBe(-1);
    expect(spendSignFor("mason")).toBe(1);
    expect(spendSignFor("maddox")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("date", () => {
  const bad: [string, string][] = [
    ["2026-02-30", "invalid_date"],
    ["2026-7-4", "invalid_date"],
    ["2026-07-26T12:00:00Z", "invalid_date"],
    [" 2026-07-26", "invalid_date"],
    ["1999-12-31", "date_out_of_range"],
  ];

  for (const [value, code] of bad) {
    it(`rejects ${JSON.stringify(value)}`, async () => {
      const t = harness();
      const token = authed();
      const error = await rejection(
        t.mutation(api.createTransaction, {
          ...BASE_TXN,
          date: value,
          id: "txn-1",
          amountMinor: -100,
          token,
        }),
      );
      expect(error.code).toBe(code);
      expect(error.field).toBe("date");
    });
  }

  it("rejects a date far in the future", async () => {
    const t = harness();
    const token = authed();
    const year = new Date().getUTCFullYear() + 2;
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        date: `${year}-01-01`,
        id: "txn-1",
        amountMinor: -100,
        token,
      }),
    );
    expect(error.code).toBe("date_out_of_range");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("category", () => {
  it("rejects an empty category", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        category: "",
        id: "txn-1",
        amountMinor: -100,
        token,
      }),
    );
    expect(error.field).toBe("category");
  });

  it("rejects a case-only variant of a category already in the file", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-2",
        category: "groceries",
        amountMinor: -200,
        token,
      }),
    );
    expect(error.code).toBe("category_near_miss");
    expect(error.message).toContain('"Groceries"');
  });

  it("lets a genuinely new category through", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-2",
      category: "Hardware",
      amountMinor: -200,
      token,
    });
    expect(await readRows(t, "transactions")).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("idempotency", () => {
  it("does not double-enter a transaction when the client retries", async () => {
    const t = harness();
    const token = authed();
    const args = { ...BASE_TXN, id: "txn-retry", amountMinor: -4599, token };

    const first = await t.mutation(api.createTransaction, args);
    const second = await t.mutation(api.createTransaction, args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(await readRows(t, "transactions")).toHaveLength(1);
    // The version does not move, so no polling client re-fetches an unchanged
    // file, and the retry leaves no second audit entry for an event that
    // happened once.
    expect(second.version).toBe(first.version);
    expect((await readAudit(t)).entries).toHaveLength(1);
  });

  it("refuses to overwrite a different row that happens to share an id", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-1",
        merchant: "Somewhere Else",
        amountMinor: -900,
        token,
      }),
    );
    expect(error.code).toBe("id_conflict");
    const [row] = await readRows(t, "transactions");
    expect(row.merchant).toBe("Costco");
    expect(row.amount).toBe(-1);
  });

  it("does not double-enter a todo when the client retries", async () => {
    const t = harness();
    const token = authed();
    const args = {
      id: "vv-todo-1",
      title: "Pay the water bill",
      category: "personal",
      owner: "victor",
      actor: "victor@linux",
      token,
    };
    const first = await t.mutation(api.createTodo, args);
    const second = await t.mutation(api.createTodo, args);

    expect(first.created).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(await readRows(t, "todos")).toHaveLength(1);
  });

  it("treats a retry as a retry even though the server re-stamps it", async () => {
    // The stamps differ by construction between the original call and its
    // retry; if the comparison included them, every retry would look like a
    // conflicting write and idempotency would be a lie.
    const t = harness();
    const token = authed();
    const args = {
      id: "vv-todo-2",
      title: "Renew the passport",
      category: "personal",
      owner: "victor",
      actor: "victor@linux",
      token,
    };
    await t.mutation(api.createTodo, args);
    const rowsBefore = await readRows(t, "todos");
    await t.mutation(api.createTodo, args);
    expect(await readRows(t, "todos")).toEqual(rowsBefore);
  });

  it("replaying an edit that already landed changes nothing", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const first = await t.mutation(api.editTransaction, {
      id: "txn-1",
      owner: "victor",
      merchant: "Costco Wholesale",
      actor: "victor@linux",
      token,
    });
    const replay = await t.mutation(api.editTransaction, {
      id: "txn-1",
      owner: "victor",
      merchant: "Costco Wholesale",
      actor: "victor@linux",
      token,
    });
    expect(first.changed).toBe(true);
    expect(replay.changed).toBe(false);
    expect(replay.version).toBe(first.version);
    expect((await readAudit(t)).entries).toHaveLength(2); // create + one edit
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("edit", () => {
  it("refuses to create a row from a mistyped id", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.editTransaction, {
        id: "txn-nope",
        owner: "victor",
        merchant: "x",
        actor: "victor@linux",
        token,
      }),
    );
    expect(error.code).toBe("not_found");
    expect(await readRows(t, "transactions")).toEqual([]);
  });

  it("refuses an edit aimed at the wrong owner's copy of an id", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      owner: "rachel",
      id: "shared-id",
      amountMinor: -100,
      token,
    });
    const error = await rejection(
      t.mutation(api.editTransaction, {
        id: "shared-id",
        owner: "victor",
        merchant: "x",
        actor: "victor@linux",
        token,
      }),
    );
    expect(error.code).toBe("owner_mismatch");
  });

  it("treats an MC2 row with no owner key as victor's", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.dataFilesSync, {
      name: "transactions",
      data: [
        {
          id: "mc2-1",
          date: "2026-06-01",
          merchant: "Legacy",
          amount: -20,
          category: "Groceries",
          card: null,
          note: null,
        },
      ],
      token,
    });
    const result = await t.mutation(api.editTransaction, {
      id: "mc2-1",
      owner: "victor",
      amountMinor: -2500,
      actor: "victor@linux",
      token,
    });
    expect(result.changed).toBe(true);
    const [row] = await readRows(t, "transactions");
    expect(row.amount).toBe(-25);
  });

  it("preserves MC2 keys this module does not model", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.dataFilesSync, {
      name: "transactions",
      data: [
        {
          id: "mc2-2",
          date: "2026-06-01",
          merchant: "Legacy",
          amount: -20,
          category: "Groceries",
          mc2_only_field: "keep me",
        },
      ],
      token,
    });
    await t.mutation(api.editTransaction, {
      id: "mc2-2",
      owner: "victor",
      merchant: "Legacy Renamed",
      actor: "victor@linux",
      token,
    });
    const [row] = await readRows(t, "transactions");
    expect(row.mc2_only_field).toBe("keep me");
    expect(row.merchant).toBe("Legacy Renamed");
  });

  it("checks the sign against the category the row ends up with", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const error = await rejection(
      t.mutation(api.editTransaction, {
        id: "txn-1",
        owner: "victor",
        category: "Income",
        amountMinor: -100,
        actor: "victor@linux",
        token,
      }),
    );
    expect(error.code).toBe("sign_mismatch");
  });

  it("refuses to re-categorise a spend as Income without restating it", async () => {
    // The gap this closes: sign and category are one invariant, and a
    // category-only edit used to skip the check entirely, leaving a negative
    // adult row categorised "Income" — which the read model then scores as
    // zero spend while the transactions screen still shows a purchase.
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const error = await rejection(
      t.mutation(api.editTransaction, {
        id: "txn-1",
        owner: "victor",
        category: "Income",
        actor: "victor@linux",
        token,
      }),
    );
    expect(error.code).toBe("sign_mismatch");
    expect((await readRows(t, "transactions"))[0].category).toBe("Groceries");
  });

  it("allows an unrelated edit on a row whose sign predates this module", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.dataFilesSync, {
      name: "transactions",
      // Positive and not Income: an imported row that does not follow the
      // adult convention. Renaming the merchant must not be blocked by it.
      data: [{ id: "legacy", date: "2026-06-01", merchant: "Odd", amount: 20, category: "Groceries" }],
      token,
    });
    const result = await t.mutation(api.editTransaction, {
      id: "legacy",
      owner: "victor",
      merchant: "Odd Renamed",
      actor: "victor@linux",
      token,
    });
    expect(result.changed).toBe(true);
  });

  it("refuses kind without an amount", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const error = await rejection(
      t.mutation(api.editTransaction, {
        id: "txn-1",
        owner: "victor",
        kind: "credit",
        actor: "victor@linux",
        token,
      }),
    );
    expect(error.code).toBe("invalid_argument");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("todos", () => {
  const NEW_TODO = {
    id: "vv-1",
    title: "Reconcile the July statement",
    category: "sats",
    owner: "victor",
    actor: "victor@linux",
  };

  it("refuses a category that is not one of the three lanes", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTodo, { ...NEW_TODO, category: "Groceries", token }),
    );
    // normalizeTodoLane would have filed this under "sats" without a word.
    expect(error.code).toBe("invalid_category");
    expect(error.message).toContain("sats");
    expect(await readRows(t, "todos")).toEqual([]);
  });

  it("refuses an unknown owner", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTodo, { ...NEW_TODO, owner: "nanny", token }),
    );
    expect(error.code).toBe("invalid_owner");
  });

  it("refuses an impossible due date", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTodo, { ...NEW_TODO, dueDate: "2026-02-30", token }),
    );
    expect(error.code).toBe("invalid_date");
    expect(error.field).toBe("dueDate");
  });

  it("refuses a priority outside the MC2 scale", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTodo, { ...NEW_TODO, priority: 1.5, token }),
    );
    expect(error.code).toBe("invalid_priority");
  });

  it("writes the canonical dual-field superset", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTodo, {
      ...NEW_TODO,
      dueDate: "2026-08-01",
      notes: "statement pdf is in Drive",
      token,
    });
    const [row] = await readRows(t, "todos");
    expect(row.id).toBe("vv-1");
    expect(row.dueDate).toBe("2026-08-01");
    expect(row.due_date).toBe("2026-08-01");
    expect(row.category).toBe("sats");
    expect(row.done).toBe(false);
    expect(row.status).toBe("pending");
    expect(row.notes).toBe("statement pdf is in Drive");
    expect(row.sync_source).toBe("vogel-vault");
  });

  it("a one-field edit does not erase the rest of the todo", async () => {
    // The SAT-1508 data-loss shape: a phone toggling `done` wiped notes,
    // project and due date. This path merges rather than replaces.
    const t = harness();
    const token = authed();
    await t.mutation(api.createTodo, {
      ...NEW_TODO,
      dueDate: "2026-08-01",
      notes: "statement pdf is in Drive",
      project: "Finances",
      token,
    });
    await t.mutation(api.editTodo, {
      id: "vv-1",
      done: true,
      actor: "victor@ios",
      token,
    });
    const [row] = await readRows(t, "todos");
    expect(row.done).toBe(true);
    expect(row.status).toBe("completed");
    expect(row.notes).toBe("statement pdf is in Drive");
    expect(row.project).toBe("Finances");
    expect(row.dueDate).toBe("2026-08-01");
  });

  it("clears a due date on an explicit null and preserves it on absence", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTodo, { ...NEW_TODO, dueDate: "2026-08-01", token });
    await t.mutation(api.editTodo, { id: "vv-1", title: "Renamed", actor: "x", token });
    expect((await readRows(t, "todos"))[0].dueDate).toBe("2026-08-01");
    await t.mutation(api.editTodo, { id: "vv-1", dueDate: null, actor: "x", token });
    expect((await readRows(t, "todos"))[0].dueDate).toBe("");
  });

  it("refuses an edit with nothing to change", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTodo, { ...NEW_TODO, token });
    const error = await rejection(
      t.mutation(api.editTodo, { id: "vv-1", actor: "x", token }),
    );
    expect(error.code).toBe("invalid_argument");
  });

  it("refuses to create a todo from a mistyped id", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.editTodo, { id: "vv-nope", title: "x", actor: "x", token }),
    );
    expect(error.code).toBe("not_found");
  });

  it("keeps the { todos: [...] } wrapper when the file has one", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.dataFilesSync, {
      name: "todos",
      data: { todos: [], generatedAt: "2026-07-01" },
      token,
    });
    await t.mutation(api.createTodo, { ...NEW_TODO, token });
    const doc = await readFile(t, "todos");
    expect(Array.isArray(doc?.data)).toBe(false);
    expect((doc?.data as { generatedAt: string }).generatedAt).toBe("2026-07-01");
    expect(await readRows(t, "todos")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("audit log", () => {
  it("records the exact record an edit replaced", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -1234,
      token,
    });
    await t.mutation(api.editTransaction, {
      id: "txn-1",
      owner: "victor",
      amountMinor: -5678,
      actor: "rachel@ios",
      token,
    });

    const { entries } = await readAudit(t);
    expect(entries).toHaveLength(2);

    const [created, edited] = entries;
    expect(created.op).toBe("create");
    expect(created.before).toBeNull();
    expect(created.after.amount).toBe(-12.34);

    expect(edited.op).toBe("edit");
    expect(edited.actor).toBe("rachel@ios");
    // This is the answer to "whole-file replace gave no history": the prior
    // value is recoverable, byte for byte, from the same deployment.
    expect(edited.before).toEqual(created.after);
    expect(edited.after.amount).toBe(-56.78);
    expect(edited.seq).toBe(created.seq + 1);
  });

  it("commits with the record, so a rejected write leaves no entry", async () => {
    const t = harness();
    const token = authed();
    await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        id: "txn-1",
        amountMinor: -12.5,
        token,
      }),
    );
    expect((await readAudit(t)).entries).toEqual([]);
    expect(await readRows(t, "transactions")).toEqual([]);
  });

  it("is readable through the existing read-token gate, with no new query", async () => {
    const t = harness();
    const syncToken = authed();
    const readToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });

    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token: syncToken,
    });

    await expect(
      t.query(api.dataFilesGet, { name: AUDIT_FILE }),
    ).rejects.toThrow(/Unauthorized/);

    const log = (await t.query(api.dataFilesGet, {
      name: AUDIT_FILE,
      token: readToken,
    })) as { entries: AuditEntry[] };
    expect(log.entries).toHaveLength(1);
  });

  it("tracks its own file version like any other data file", async () => {
    const t = harness();
    const token = authed();
    await t.mutation(api.createTransaction, {
      ...BASE_TXN,
      id: "txn-1",
      amountMinor: -100,
      token,
    });
    const versions = await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("syncVersions")
        .withIndex("by_name", (q) => q.eq("name", AUDIT_FILE))
        .first();
      return doc?.version ?? null;
    });
    expect(versions).toBe(1);
  });

  it("evicts its oldest entries rather than growing until it throws", () => {
    // An unbounded log shares the ledger's mutation, so once it passed Convex's
    // 1 MiB document limit it would start failing the WRITE, not just the log.
    // Forgetting the oldest entry is the lesser failure, and it is counted.
    const log = readAuditLog({});
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 5; i += 1) {
      log.entries.push({
        seq: log.nextSeq,
        at: 0,
        atIso: "1970-01-01T00:00:00.000Z",
        op: "create",
        entity: "transaction",
        file: "transactions",
        id: `txn-${i}`,
        actor: "victor@linux",
        before: null,
        after: { id: `txn-${i}` },
      });
      log.nextSeq += 1;
    }
    const trimmed = trimAuditLog(log);
    expect(trimmed.entries).toHaveLength(MAX_AUDIT_ENTRIES);
    expect(trimmed.dropped).toBe(5);
    expect(trimmed.droppedThroughSeq).toBe(5);
    expect(trimmed.entries[0].id).toBe("txn-5");
  });

  it("evicts on byte budget too, not just entry count", () => {
    const log = readAuditLog({});
    const fat = "x".repeat(100_000);
    for (let i = 0; i < 12; i += 1) {
      log.entries.push({
        seq: log.nextSeq,
        at: 0,
        atIso: "1970-01-01T00:00:00.000Z",
        op: "edit",
        entity: "transaction",
        file: "transactions",
        id: `txn-${i}`,
        actor: "victor@linux",
        before: { note: fat },
        after: { note: fat },
      });
      log.nextSeq += 1;
    }
    const trimmed = trimAuditLog(log);
    expect(JSON.stringify(trimmed.entries).length).toBeLessThanOrEqual(MAX_AUDIT_BYTES);
    expect(trimmed.dropped).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("text hygiene", () => {
  it("rejects an untrimmed merchant rather than trimming it", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        merchant: " Costco",
        id: "txn-1",
        amountMinor: -100,
        token,
      }),
    );
    expect(error.code).toBe("invalid_text");
    expect(error.field).toBe("merchant");
  });

  it("rejects control characters in free text", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        note: `line one${String.fromCharCode(0)}line two`,
        id: "txn-1",
        amountMinor: -100,
        token,
      }),
    );
    expect(error.code).toBe("invalid_text");
  });

  it("requires an actor so every change is attributable", async () => {
    const t = harness();
    const token = authed();
    const error = await rejection(
      t.mutation(api.createTransaction, {
        ...BASE_TXN,
        actor: "",
        id: "txn-1",
        amountMinor: -100,
        token,
      }),
    );
    expect(error.field).toBe("actor");
  });
});
