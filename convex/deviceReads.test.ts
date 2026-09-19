// H2 regression: paired device credentials gain read scope, and the
// client-asserted viewer is validated against the credential's server-stored
// profile. The shared read token stays functional for the migration window and
// its envelopes carry an explicit deprecation marker.
import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  seedDataFile,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

const query = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"query", "public", Args, Result>;

type Rows<T> = { rows: T[]; complete: boolean; readAuth?: unknown };

const api = {
  listTransactions: query<
    {
      viewer: string;
      deviceId?: string;
      deviceToken?: string;
      token?: string;
    },
    Rows<{ owner: string; txId: string }>
  >("tables:listTransactions"),
  get: query<
    {
      name: string;
      deviceId?: string;
      deviceToken?: string;
      token?: string;
    },
    unknown
  >("dataFiles:get"),
  getVersions: query<
    { deviceId?: string; deviceToken?: string; token?: string },
    Record<string, number>
  >("dataFiles:getVersions"),
  list: query<
    { deviceId?: string; deviceToken?: string; token?: string },
    { name: string; version: number; updatedAt: number }[]
  >("dataFiles:list"),
  listTodoTombstones: query<
    { deviceId?: string; deviceToken?: string; token?: string },
    { id: string; deletedAt: number }[]
  >("dataFiles:listTodoTombstones"),
};

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

let t: T;
let readToken: string;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  readToken = freshSecret();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_READ_TOKEN: readToken, CONVEX_SYNC_TOKEN: syncToken });
});

async function seedLedger() {
  await t.run(async (ctx) => {
    await ctx.db.insert("transactions", {
      txId: "adult-tx",
      owner: "victor",
      date: "2026-08-01",
      month: "2026-08",
      merchant: "Household",
      amountCents: -2_500n,
      category: "Groceries",
      sourceFile: "transactions",
      updatedAtMs: 1,
    });
    await ctx.db.insert("transactions", {
      txId: "mason-tx",
      owner: "mason",
      date: "2026-08-01",
      month: "2026-08",
      merchant: "School shop",
      amountCents: -300n,
      category: "School",
      sourceFile: "mason-transactions",
      updatedAtMs: 1,
    });
  });
}

describe("device-credential reads", () => {
  it("derives the authoritative viewer from the credential profile", async () => {
    await seedLedger();
    const mason = await pairMobileDevice(t, syncToken, "read-mason-device", undefined, "mason");

    const response = await t.query(api.listTransactions, {
      viewer: "mason",
      deviceId: mason.deviceId,
      deviceToken: mason.deviceToken,
    });
    expect(response.readAuth).toBeUndefined();
    expect(response.rows.map((row) => row.owner)).toEqual(["mason"]);
  });

  it("rejects a viewer assertion that disagrees with the credential", async () => {
    await seedLedger();
    const mason = await pairMobileDevice(t, syncToken, "read-mason-spoof", undefined, "mason");

    await expect(
      t.query(api.listTransactions, {
        viewer: "victor",
        deviceId: mason.deviceId,
        deviceToken: mason.deviceToken,
      }),
    ).rejects.toThrow(/viewer does not match the credential profile/);
  });

  it("rejects revoked, unknown, and malformed device credentials", async () => {
    const device = await pairMobileDevice(t, syncToken, "read-revoke-device");
    await t.mutation(
      "dataFiles:revokeMobileDevice" as unknown as FunctionReference<
        "mutation",
        "public",
        { deviceId: string; deviceToken: string },
        unknown
      >,
      { deviceId: device.deviceId, deviceToken: device.deviceToken },
    );

    await expect(
      t.query(api.listTransactions, {
        viewer: "victor",
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.query(api.listTransactions, {
        viewer: "victor",
        deviceId: device.deviceId,
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.query(api.listTransactions, {
        viewer: "victor",
        deviceId: device.deviceId,
      }),
    ).rejects.toThrow(/malformed device credential/);
  });

  it("keeps the shared-token path working and marks it deprecated", async () => {
    await seedLedger();
    const response = await t.query(api.listTransactions, {
      viewer: "mason",
      token: readToken,
    });
    expect(response.readAuth).toEqual({
      mode: "shared-token",
      deprecated: true,
    });
    // The shared token authorizes no one in particular: the client-asserted
    // viewer still decides scope on this legacy path.
    expect(response.rows.map((row) => row.owner)).toEqual(["mason"]);

    const adult = await t.query(api.listTransactions, {
      viewer: "victor",
      token: readToken,
    });
    expect(adult.rows.map((row) => row.owner).sort()).toEqual([
      "mason",
      "victor",
    ]);
  });

  it("scopes blob reads through the credential profile", async () => {
    await seedDataFile(t, "finances", { household: true });
    await seedDataFile(t, "mason-transactions", [{ id: "m-1" }]);
    await seedDataFile(t, "writeback-audit", { entries: [] });
    const mason = await pairMobileDevice(t, syncToken, "blob-mason-device", undefined, "mason");
    const victor = await pairMobileDevice(t, syncToken, "blob-victor-device", undefined, "victor");

    await expect(
      t.query(api.get, {
        name: "finances",
        deviceId: mason.deviceId,
        deviceToken: mason.deviceToken,
      }),
    ).rejects.toThrow(/outside the credential's profile scope/);
    await expect(
      t.query(api.get, {
        name: "some-unclassified-file",
        deviceId: mason.deviceId,
        deviceToken: mason.deviceToken,
      }),
    ).rejects.toThrow(/outside the credential's profile scope/);
    await expect(
      t.query(api.get, {
        name: "mason-transactions",
        deviceId: mason.deviceId,
        deviceToken: mason.deviceToken,
      }),
    ).resolves.toEqual([{ id: "m-1" }]);
    await expect(
      t.query(api.get, {
        name: "finances",
        deviceId: victor.deviceId,
        deviceToken: victor.deviceToken,
      }),
    ).resolves.toEqual({ household: true });
    await expect(
      t.query(api.get, {
        name: "finances",
        deviceId: victor.deviceId,
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });

  it("lists sync metadata without loading legacy blob payloads", async () => {
    const metadata = { name: "finances", version: 7, updatedAt: 1234 };
    await t.run(async (ctx) => {
      await ctx.db.insert("syncVersions", metadata);
      await ctx.db.insert("dataFiles", {
        name: "legacy-only",
        data: { ignored: true },
        version: 1,
        updatedAt: 1,
      });
    });

    await expect(t.query(api.list, { token: readToken })).resolves.toEqual([
      metadata,
    ]);
    await expect(t.query(api.list, {})).rejects.toThrow();
    await expect(t.query(api.list, { token: freshSecret() })).rejects.toThrow();
  });

  it("filters household-wide metadata lists for child credentials", async () => {
    await seedDataFile(t, "finances", { household: true });
    await seedDataFile(t, "mason-transactions", [{ id: "m-1" }]);
    const mason = await pairMobileDevice(t, syncToken, "meta-mason-device", undefined, "mason");
    const victor = await pairMobileDevice(t, syncToken, "meta-victor-device", undefined, "victor");

    const childVersions = await t.query(api.getVersions, {
      deviceId: mason.deviceId,
      deviceToken: mason.deviceToken,
    });
    expect(Object.keys(childVersions).sort()).toEqual(["mason-transactions"]);
    const childList = await t.query(api.list, {
      deviceId: mason.deviceId,
      deviceToken: mason.deviceToken,
    });
    expect(childList.map((entry) => entry.name).sort()).toEqual([
      "mason-transactions",
    ]);

    const adultVersions = await t.query(api.getVersions, {
      deviceId: victor.deviceId,
      deviceToken: victor.deviceToken,
    });
    expect(Object.keys(adultVersions).sort()).toEqual([
      "finances",
      "mason-transactions",
    ]);
    const adultList = await t.query(api.list, {
      deviceId: victor.deviceId,
      deviceToken: victor.deviceToken,
    });
    expect(adultList.map((entry) => entry.name).sort()).toEqual([
      "finances",
      "mason-transactions",
    ]);
  });

  it("authenticates the tombstone list for paired credentials", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("todoTombstones", { id: "tomb-1", deletedAt: 1 });
    });
    const device = await pairMobileDevice(t, syncToken, "tomb-device", undefined, "mason");
    await expect(
      t.query(api.listTodoTombstones, {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
      }),
    ).resolves.toEqual([{ id: "tomb-1", deletedAt: 1 }]);
    await expect(
      t.query(api.listTodoTombstones, {
        deviceId: device.deviceId,
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.query(api.listTodoTombstones, {
        deviceId: device.deviceId,
        deviceToken: freshSecret(),
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
  });
});
