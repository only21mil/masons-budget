import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

const checkReadCredential =
  "readCanary:check" as unknown as FunctionReference<
    "query",
    "public",
    { token?: string },
    { ok: true }
  >;

let t: ReturnType<typeof testConvex>;

beforeEach(() => {
  t = testConvex();
});

describe("read canary", () => {
  it("returns only a fixed success marker for the configured read credential", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });

    const result = await t.query(checkReadCredential, { token });

    expect(result).toEqual({ ok: true });
    expect(Object.keys(result)).toEqual(["ok"]);
  });

  it("uses one redacted rejection for missing config and missing, blank, or wrong credentials", async () => {
    const token = freshSecret();
    const rejected = /Unauthorized read credential/;

    await expect(t.query(checkReadCredential, {})).rejects.toThrow(rejected);
    await expect(
      t.query(checkReadCredential, { token }),
    ).rejects.toThrow(rejected);

    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    for (const supplied of [undefined, "", freshSecret()] as const) {
      await expect(
        t.query(checkReadCredential, { token: supplied }),
      ).rejects.toThrow(rejected);
    }
  });

  it("stays fail-closed under tokenless read and sync hatches", async () => {
    setDeploymentEnv({
      ALLOW_TOKENLESS_READ: "true",
      ALLOW_TOKENLESS_SYNC: "true",
    });

    await expect(t.query(checkReadCredential, {})).rejects.toThrow(
      /Unauthorized read credential/,
    );

    const token = freshSecret();
    setDeploymentEnv({
      CONVEX_READ_TOKEN: token,
      ALLOW_TOKENLESS_READ: "true",
      ALLOW_TOKENLESS_SYNC: "true",
    });
    await expect(t.query(checkReadCredential, {})).rejects.toThrow(
      /Unauthorized read credential/,
    );
    await expect(
      t.query(checkReadCredential, { token: freshSecret() }),
    ).rejects.toThrow(/Unauthorized read credential/);
    await expect(t.query(checkReadCredential, { token })).resolves.toEqual({
      ok: true,
    });
  });

  it("returns the same fixed marker when household tables contain rows", async () => {
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    await t.run(async (ctx) => {
      await ctx.db.insert("dataFiles", {
        name: "budget",
        data: { private: "synthetic fixture" },
        updatedAt: 1,
        version: 1,
      });
      await ctx.db.insert("todoTombstones", {
        id: "private-synthetic-id",
        deletedAt: 1,
      });
    });

    await expect(t.query(checkReadCredential, { token })).resolves.toEqual({
      ok: true,
    });
  });
});
