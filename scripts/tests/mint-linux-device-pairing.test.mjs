import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPROVED_CONVEX_ORIGIN,
  LINUX_DEVICE_CAPABILITIES,
  RESPONSE_LIMIT_BYTES,
  approvedConvexOrigin,
  mintLinuxDevicePairing,
} from "../mint-linux-device-pairing.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(repoRoot, "scripts/mint-linux-device-pairing.mjs");

async function destination(prefix = "vv-linux-pair-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(directory, "pairing.json");
}

function successResponseFor(request) {
  const body = JSON.parse(request.body);
  return new Response(
    JSON.stringify({
      status: "success",
      value: {
        pairId: body.args.pairId,
        expiresAt: body.args.expiresAt,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

test("dry-run generates no secret, writes no file, and needs no token", async () => {
  const output = await destination("vv-linux-pair-dry-");
  const result = spawnSync(
    process.execPath,
    [script, "--dry-run", "--profile", "victor", "--out", output],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: path.dirname(output),
        CONVEX_SYNC_TOKEN: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no request, file write, or secret generation/);
  await assert.rejects(readFile(output), /ENOENT/);
});

test("accepts only the exact approved HTTPS household origin", () => {
  assert.equal(
    approvedConvexOrigin(APPROVED_CONVEX_ORIGIN),
    APPROVED_CONVEX_ORIGIN,
  );
  assert.equal(
    approvedConvexOrigin(`${APPROVED_CONVEX_ORIGIN}/`),
    APPROVED_CONVEX_ORIGIN,
  );
  for (const unsafe of [
    "http://keen-elephant-452.convex.cloud",
    "https://user@keen-elephant-452.convex.cloud",
    "https://keen-elephant-452.convex.cloud:443",
    "https://keen-elephant-452.convex.cloud:444",
    "https://keen-elephant-452.convex.cloud/not-the-origin",
    "https://keen-elephant-452.convex.cloud?next=evil",
    "https://keen-elephant-452.convex.cloud#fragment",
    "https://keen-elephant-452.convex.cloud.evil.example",
    "https://evilkeen-elephant-452.convex.cloud",
  ]) {
    assert.throws(() => approvedConvexOrigin(unsafe), /exactly|approved/);
  }
});

test("trusted mint sends all four grants and writes one raw unprinted pairing code 0600", async () => {
  const output = await destination();
  const token = "test-only-random-sync-token";
  const requests = [];
  const result = await mintLinuxDevicePairing({
    convexUrl: APPROVED_CONVEX_ORIGIN,
    syncToken: token,
    name: "Test Linux",
    profile: "victor",
    hours: 24,
    output,
    now: 1_000,
    randomBytes: (size) => Buffer.alloc(size, size),
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request });
      return successResponseFor(request);
    },
  });

  assert.deepEqual(result, { output });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${APPROVED_CONVEX_ORIGIN}/api/mutation`);
  assert.equal(requests[0].redirect, "error");
  assert.ok(requests[0].signal instanceof AbortSignal);
  const requestBody = JSON.parse(requests[0].body);
  assert.equal(requestBody.path, "dataFiles:createMobilePairing");
  assert.equal(requestBody.args.token, token);
  assert.deepEqual(requestBody.args.capabilities, LINUX_DEVICE_CAPABILITIES);
  assert.equal(requestBody.args.profile, "victor");

  const artifactText = await readFile(output, "utf8");
  const artifact = JSON.parse(artifactText);
  assert.match(artifact.pairingCode, /^linux-[^.]+\.[A-Za-z0-9_-]+$/);
  assert.equal(artifactText.includes(token), false);
  assert.equal(artifact.convexUrl, undefined);
  assert.equal(artifact.pairId, undefined);
  assert.equal(artifact.profile, "victor");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("a redirect is rejected without issuing a second request", async () => {
  const output = await destination("vv-linux-pair-redirect-");
  let requests = 0;
  await assert.rejects(
    mintLinuxDevicePairing({
      convexUrl: APPROVED_CONVEX_ORIGIN,
      syncToken: "test-token",
      name: "Test Linux",
      profile: "victor",
      hours: 24,
      output,
      fetchImpl: async (_url, request) => {
        requests += 1;
        assert.equal(request.redirect, "error");
        return new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example/steal" },
        });
      },
    }),
    /failed \(307\)/,
  );
  assert.equal(requests, 1);
  await assert.rejects(readFile(output), /ENOENT/);
});

test("oversized, malformed, and wrong-schema responses write no artifact", async () => {
  const cases = [
    {
      name: "oversized",
      response: new Response("x".repeat(RESPONSE_LIMIT_BYTES + 1), {
        status: 200,
      }),
      error: /size limit/,
    },
    {
      name: "malformed",
      response: new Response("{definitely-not-json", { status: 200 }),
      error: /valid JSON/,
    },
    {
      name: "wrong-schema",
      response: new Response(JSON.stringify({ status: "success", value: {} }), {
        status: 200,
      }),
      error: /expected schema/,
    },
  ];

  for (const fixture of cases) {
    const output = await destination(`vv-linux-pair-${fixture.name}-`);
    await assert.rejects(
      mintLinuxDevicePairing({
        convexUrl: APPROVED_CONVEX_ORIGIN,
        syncToken: "test-token",
        name: "Test Linux",
        profile: "victor",
        hours: 24,
        output,
        fetchImpl: async () => fixture.response,
      }),
      fixture.error,
    );
    await assert.rejects(readFile(output), /ENOENT/);
  }
});
