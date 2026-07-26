// SAT-READ-AUTH regression suite.
//
// Until 2026-07-26 every query in dataFiles.ts was unauthenticated, so the
// deployment URL — committed at scripts/convex-codegen.mjs and baked into every
// shipped client — was the only thing standing between a stranger and the
// household's full financial history. These tests exist so that can never
// silently come back: each of the four read entry points is asserted closed.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  // The hatch outranks the token, and that is the whole design.
  //
  // These assertions used to be inverted — they pinned the hatch being ignored
  // once CONVEX_READ_TOKEN was set, which made the documented cutover order
  // ("set the token, then ship clients") start enforcing at the wrong step and
  // lock out every client that did not yet send one. Enforcement now flips when
  // the hatch is REMOVED, so the sequence in docs/convex-read-auth-cutover.md is
  // the sequence the code actually implements.
  describe("the hatch outranks a configured CONVEX_READ_TOKEN", () => {
    beforeEach(() => {
      setDeploymentEnv({
        CONVEX_READ_TOKEN: freshSecret(),
        ALLOW_TOKENLESS_READ: "true",
      });
    });

    for (const entry of READ_ENTRY_POINTS) {
      it(`${entry.name} admits a tokenless caller`, async () => {
        await expect(entry.call(t)).resolves.toBeDefined();
      });

      it(`${entry.name} admits a caller sending the wrong token`, async () => {
        // Permissive means permissive: while the hatch is on the server cannot
        // tell a correctly-configured client from a broken one, which is why
        // step 4 of the runbook is client-side inspection rather than a probe.
        await expect(entry.call(t, freshSecret())).resolves.toBeDefined();
      });
    }
  });

  it("setting CONVEX_READ_TOKEN is inert until the hatch comes off", async () => {
    const readToken = freshSecret();
    setDeploymentEnv({
      CONVEX_READ_TOKEN: readToken,
      ALLOW_TOKENLESS_READ: "true",
    });
    await expect(t.query(api.list, {})).resolves.toBeDefined();

    // Removing the hatch is the enforcement flip — one variable, and the only
    // thing that changes posture.
    delete process.env.ALLOW_TOKENLESS_READ;
    await expect(t.query(api.list, {})).rejects.toThrow(/invalid read token/);
    await expect(t.query(api.list, { token: readToken })).resolves.toBeDefined();
  });

  it("re-setting the hatch is a complete rollback from enforcement", async () => {
    setDeploymentEnv({ CONVEX_READ_TOKEN: freshSecret() });
    await expect(t.query(api.list, {})).rejects.toThrow(/invalid read token/);

    setDeploymentEnv({ ALLOW_TOKENLESS_READ: "true" });
    await expect(t.query(api.list, {})).resolves.toBeDefined();
  });

  // ⚠️ THE HAZARD THIS DESIGN BUYS. A set CONVEX_READ_TOKEN is not evidence of
  // enforcement, so the server says so on every permissive admission. That log
  // line and scripts/verify-read-auth.sh reporting OPEN are the two signals
  // that catch a deployment everyone believes is closed but is not.
  it("logs loudly that a set token is being ignored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setDeploymentEnv({
        CONVEX_READ_TOKEN: freshSecret(),
        ALLOW_TOKENLESS_READ: "true",
      });
      await t.query(api.list, {});

      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toMatch(/PERMISSIVE/);
      expect(logged).toMatch(/CONVEX_READ_TOKEN is set but IGNORED/);
      expect(logged).toMatch(/NOT enforcing auth/);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a permissive admission when no token is configured either", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setDeploymentEnv({ ALLOW_TOKENLESS_READ: "true" });
      await t.query(api.list, {});

      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toMatch(/PERMISSIVE/);
      expect(logged).toMatch(/not configured/);
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when the gate is actually enforcing", async () => {
    const readToken = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: readToken });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await t.query(api.list, { token: readToken });
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).not.toMatch(/PERMISSIVE/);
    } finally {
      warn.mockRestore();
    }
  });
});
