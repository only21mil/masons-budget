import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  APPROVED_CONVEX_ORIGIN,
  DEFAULT_TTL_MINUTES,
  MAX_TTL_MINUTES,
  PAIRING_CODE_PATTERN,
  RESPONSE_LIMIT_BYTES,
  mintAndroidReadBootstrap,
  validateOutputPath,
} from "../mint-android-read-bootstrap.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(repoRoot, "scripts/mint-android-read-bootstrap.mjs");
const testRoots = [];

async function destination(prefix = "vv-android-bootstrap-") {
  const workRoot = path.join(os.homedir(), "work");
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(path.join(workRoot, prefix));
  testRoots.push(directory);
  return path.join(directory, "pairing.txt");
}

after(async () => {
  await Promise.all(testRoots.map((root) => rm(root, { recursive: true, force: true })));
});

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
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("dry-run needs no token and creates no pairing material", async () => {
  const output = await destination("vv-android-bootstrap-dry-");
  const result = spawnSync(
    process.execPath,
    [script, "--dry-run", "--out", output],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: os.homedir(),
        CI: "",
        CONVEX_SYNC_TOKEN: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no request, file write, or secret generation/);
  await assert.rejects(readFile(output), /ENOENT/);
});

test("mint sends the exact locked wire shape and writes only pairId dot canonical proof", async () => {
  const output = await destination();
  const syncToken = "test-only-sync-token-never-write";
  const requests = [];
  const result = await mintAndroidReadBootstrap({
    syncToken,
    output,
    homeDirectory: os.homedir(),
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
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(body.args).sort(), [
    "expiresAt",
    "pairId",
    "proofHash",
    "token",
  ]);
  assert.equal(body.path, "dataFiles:createAndroidReadBootstrap");
  assert.equal(body.args.token, syncToken);
  assert.match(body.args.pairId, /^android-read-[A-Za-z0-9_-]{16,64}$/);
  assert.match(body.args.proofHash, /^[0-9a-f]{64}$/);
  assert.equal(body.args.expiresAt, 1_000 + DEFAULT_TTL_MINUTES * 60 * 1000);

  const pairingCode = await readFile(output, "ascii");
  assert.match(pairingCode, PAIRING_CODE_PATTERN);
  assert.equal(pairingCode.includes("\n"), false);
  assert.equal(pairingCode.includes(syncToken), false);
  const [pairId, proof] = pairingCode.split(".");
  assert.equal(pairId, body.args.pairId);
  assert.equal(Buffer.from(proof, "base64url").length, 32);
  assert.equal(Buffer.from(proof, "base64url").toString("base64url"), proof);
  assert.equal(
    crypto.createHash("sha256").update(proof, "ascii").digest("hex"),
    body.args.proofHash,
  );
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("TTL is bounded to one through thirty integer minutes", async () => {
  for (const invalid of [0, -1, 1.5, MAX_TTL_MINUTES + 1, Number.NaN]) {
    const output = await destination(`vv-android-bootstrap-ttl-${String(invalid).replace(".", "-")}-`);
    await assert.rejects(
      mintAndroidReadBootstrap({
        syncToken: "test-token",
        minutes: invalid,
        output,
        homeDirectory: os.homedir(),
      }),
      /minutes/,
    );
  }
});

test("output must be a new resolved path beneath HOME work", async () => {
  const output = await destination("vv-android-bootstrap-path-");
  await writeFile(output, "existing", { mode: 0o600 });
  assert.throws(
    () => validateOutputPath(output, os.homedir()),
    /overwrite/,
  );

  const outside = path.join(path.dirname(os.homedir()), "outside-pairing.txt");
  assert.throws(
    () => validateOutputPath(outside, os.homedir()),
    /HOME\/work|beneath/,
  );

  const linkRoot = await destination("vv-android-bootstrap-link-");
  const link = path.join(path.dirname(linkRoot), "linked-parent");
  await symlink(path.dirname(os.homedir()), link);
  assert.throws(
    () => validateOutputPath(path.join(link, "pairing.txt"), os.homedir()),
    /HOME\/work|beneath/,
  );
});

test("redirect and malformed or oversized responses leave no file", async () => {
  const fixtures = [
    new Response(null, {
      status: 307,
      headers: { Location: "https://attacker.example/steal" },
    }),
    new Response("not-json", { status: 200 }),
    new Response("x".repeat(RESPONSE_LIMIT_BYTES + 1), { status: 200 }),
    new Response(JSON.stringify({ status: "success", value: {} }), { status: 200 }),
  ];
  for (let index = 0; index < fixtures.length; index += 1) {
    const output = await destination(`vv-android-bootstrap-response-${index}-`);
    await assert.rejects(
      mintAndroidReadBootstrap({
        syncToken: "test-token",
        output,
        homeDirectory: os.homedir(),
        fetchImpl: async (_url, request) => {
          assert.equal(request.redirect, "error");
          return fixtures[index];
        },
      }),
      /failed|JSON|size limit|schema/,
    );
    await assert.rejects(readFile(output), /ENOENT/);
  }
});
