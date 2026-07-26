// SAT-READ-AUTH regression suite.
//
// Until 2026-07-26 every query in dataFiles.ts was unauthenticated, so the
// deployment URL — committed at scripts/convex-codegen.mjs and baked into every
// shipped client — was the only thing standing between a stranger and the
// household's full financial history. These tests exist so that can never
// silently come back: each of the four read entry points is asserted closed.
import { beforeEach, describe, expect, it } from "vitest";

import {
  api,
  freshSecret,
  seedDataFile,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

/** Every query that can return stored data, with a call that exercises it. */
const READ_ENTRY_POINTS = [
  {
    name: "get",
    call: (t: ReturnType<typeof testConvex>, token?: string) =>
      t.query(api.get, { name: "budget", token }),
  },
  {
    name: "getVersions",
    call: (t: ReturnType<typeof testConvex>, token?: string) =>
      t.query(api.getVersions, { token }),
  },
  {
    name: "list",
    call: (t: ReturnType<typeof testConvex>, token?: string) =>
      t.query(api.list, { token }),
  },
  {
    name: "listTodoTombstones",
    call: (t: ReturnType<typeof testConvex>, token?: string) =>
      t.query(api.listTodoTombstones, { token }),
  },
] as const;

let t: ReturnType<typeof testConvex>;

beforeEach(async () => {
  t = testConvex();
  // Synthetic payload — nothing here resembles real household data.
  await seedDataFile(t, "budget", { month: "2026-07", categories: [] });
  await t.run(async (ctx) => {
    await ctx.db.insert("todoTombstones", { id: "t-1", deletedAt: 1 });
  });
});

describe("read auth: no token configured, no hatch (the deployed default)", () => {
  for (const entry of READ_ENTRY_POINTS) {
    it(`${entry.name} fails closed`, async () => {
      await expect(entry.call(t)).rejects.toThrow(
        /CONVEX_READ_TOKEN is not configured/,
      );
    });

    it(`${entry.name} fails closed even when a token is supplied`, async () => {
      // A caller guessing a token must not be able to talk the deployment into
      // an open state; with nothing configured there is nothing to match.
      await expect(entry.call(t, freshSecret())).rejects.toThrow(
        /CONVEX_READ_TOKEN is not configured/,
      );
    });
  }
});

describe("read auth: CONVEX_READ_TOKEN configured", () => {
  let readToken: string;

  beforeEach(() => {
    readToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
  });

  for (const entry of READ_ENTRY_POINTS) {
    it(`${entry.name} rejects a missing token`, async () => {
      await expect(entry.call(t)).rejects.toThrow(/invalid read token/);
    });

    it(`${entry.name} rejects an incorrect token`, async () => {
      await expect(entry.call(t, freshSecret())).rejects.toThrow(
        /invalid read token/,
      );
    });

    it(`${entry.name} rejects an empty-string token`, async () => {
      await expect(entry.call(t, "")).rejects.toThrow(/invalid read token/);
    });

    it(`${entry.name} accepts the correct token`, async () => {
      await expect(entry.call(t, readToken)).resolves.toBeDefined();
    });
  }

  it("get returns the stored payload only to an authenticated caller", async () => {
    await expect(t.query(api.get, { name: "budget", token: readToken })).resolves.toEqual({
      month: "2026-07",
      categories: [],
    });
  });

  it("get returns null for an unknown file rather than leaking its absence differently", async () => {
    await expect(
      t.query(api.get, { name: "does-not-exist", token: readToken }),
    ).resolves.toBeNull();
  });
});

describe("read auth: ALLOW_TOKENLESS_READ cutover hatch", () => {
  it("permits unauthenticated reads while the hatch is on", async () => {
    setDeploymentEnv({ ALLOW_TOKENLESS_READ: "true" });
    for (const entry of READ_ENTRY_POINTS) {
      await expect(entry.call(t)).resolves.toBeDefined();
    }
  });

  it("only the exact string \"true\" opens the hatch", async () => {
    for (const value of ["TRUE", "True", "1", "yes", "false", " true"]) {
      setDeploymentEnv({ ALLOW_TOKENLESS_READ: value });
      await expect(t.query(api.list, {})).rejects.toThrow(
        /CONVEX_READ_TOKEN is not configured/,
      );
    }
  });

  // ⚠️ CUTOVER HAZARD — documented, not a behaviour change.
  //
  // The comment above validateReadToken prescribes: (2) set CONVEX_READ_TOKEN
  // and ship clients that send it, (3) confirm, THEN remove the hatch. But the
  // hatch is only consulted when CONVEX_READ_TOKEN is UNSET, so step (2) starts
  // enforcing immediately and every client that does not yet send the token —
  // including the TestFlight build already on Victor's phone — breaks at that
  // moment, not at step (3). This test pins the real precedence so the runbook
  // gets written against the code rather than against the comment.
  it("the hatch is ignored once CONVEX_READ_TOKEN is set", async () => {
    setDeploymentEnv({
      CONVEX_READ_TOKEN: freshSecret(),
      ALLOW_TOKENLESS_READ: "true",
    });
    await expect(t.query(api.list, {})).rejects.toThrow(/invalid read token/);
  });
});
