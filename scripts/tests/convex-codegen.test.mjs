import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { checkGenerated, repoRoot } from "../convex-codegen.mjs";
import { prepareRemote } from "../convex-codegen-remote.mjs";

// These are invented fixtures. No real CLI, credentials, or network is used.
const target = "https://test-fixture-123.convex.cloud";
const secret = "fixture-secret-never-forward-to-logs";
const args = ["--target-url", target, "--acknowledge-remote-preparation"];
const pair = { CONVEX_SELF_HOSTED_URL: target, CONVEX_SELF_HOSTED_ADMIN_KEY: secret };

function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  const writes = [];
  const reads = [];
  const schema = Buffer.from("export default fixtureSchema;\n");
  const io = {
    existsSync: () => false,
    readFileSync(file) {
      reads.push(file);
      if (file.endsWith("package.json")) return '{"version":"1.42.3"}';
      if (file.endsWith("schema.ts")) return schema;
      throw new Error("Unexpected read");
    },
    writeFileSync: (...values) => writes.push(values),
  };
  const options = {
    root: "/fixture",
    args,
    env: pair,
    io,
    log: (message) => logs.push(message),
    run: (...values) => {
      calls.push(values);
      return { status: 0, stdout: secret, stderr: secret };
    },
    ...overrides,
  };
  return { calls, logs, writes, reads, schema, options, execute: () => prepareRemote(options) };
}

function assertRefused(h) {
  assert.equal(h.execute(), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
  assert.ok(!h.logs.join("\n").includes(secret));
}

test("default wrapper can only invoke the credential-free local checker", () => {
  const calls = [];
  const result = checkGenerated({ args: [], root: "/fixture", env: {
    ...pair, CONVEX_DEPLOY_KEY: secret, NODE_OPTIONS: secret, BASH_ENV: secret,
  }, log: () => {}, run: (...values) => { calls.push(values); return { status: 0 }; } });
  assert.equal(result, 0);
  assert.deepEqual(calls, [["/bin/bash", ["/fixture/scripts/check-convex-generated-change.sh", "HEAD"], {
    cwd: "/fixture", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "inherit",
  }]]);
});

test("ordinary npm codegen executes only the mock local checker, even with deployment credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vv-codegen-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { codegen: manifest.scripts.codegen } }));
  fs.copyFileSync(path.join(repoRoot, "scripts/convex-codegen.mjs"), path.join(root, "scripts/convex-codegen.mjs"));
  fs.writeFileSync(path.join(root, "scripts/check-convex-generated-change.sh"),
    '#!/bin/bash\n[[ "$1" == HEAD ]] || exit 11\n[[ -z "${CONVEX_DEPLOY_KEY+x}${CONVEX_SELF_HOSTED_ADMIN_KEY+x}" ]] || exit 12\nprintf "mock-local-check-only\\n"\n');
  // No Convex CLI or dependencies exist in this fixture. Network boundaries
  // are replaced by the mock checker; no actual generation is executed.
  const result = spawnSync("npm", ["run", "codegen"], {
    cwd: root, encoding: "utf8", env: {
      PATH: process.env.PATH, ...pair, CONVEX_DEPLOY_KEY: secret,
      npm_config_cache: path.join(root, "npm-cache"), npm_config_update_notifier: "false",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mock-local-check-only/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test("local checks reject remote, dry-run, and secret-bearing passthrough without invoking a process", () => {
  for (const attempt of [args, ["--dry-run"], ["--admin-key", secret]]) {
    const logs = [];
    assert.equal(checkGenerated({ args: attempt, log: (m) => logs.push(m), run: () => assert.fail("spawned") }), 1);
    assert.ok(!logs.join("\n").includes(secret));
  }
});

test("help is local and explains persistent effects and independent approval", () => {
  const h = harness({ args: ["--help"] });
  assert.equal(h.execute(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 0);
  assert.match(h.logs.join("\n"), /does not grant or verify approval/);
  assert.match(h.logs.join("\n"), /may persist/);
});

test("remote path requires exact target and acknowledgement without passthrough", () => {
  for (const attempt of [[], args.slice(0, 2), [...args, "--dry-run"], [...args, "--env-file", secret], ["--admin-key", secret], [...args, "--url", target]]) {
    assertRefused(harness({ args: attempt }));
  }
});

test("rejects nonexact, local, credential-bearing, query and redirected URL forms", () => {
  for (const url of ["http://test-fixture-123.convex.cloud", `${target}/`, `${target}?key=${secret}`, `${target}:443`, `https://${secret}@test-fixture-123.convex.cloud`, "https://convex.cloud.evil.example", "http://127.0.0.1:3210"]) {
    assertRefused(harness({ args: ["--target-url", url, args[2]], env: { ...pair, CONVEX_SELF_HOSTED_URL: url } }));
  }
});

test("rejects missing or mismatched injected pair", () => {
  for (const env of [{}, { CONVEX_SELF_HOSTED_URL: target }, { ...pair, CONVEX_SELF_HOSTED_URL: "https://different-123.convex.cloud" }, { ...pair, CONVEX_SELF_HOSTED_ADMIN_KEY: " " }]) {
    assertRefused(harness({ env }));
  }
});

test("competing selectors and aliases fail before even reading their values", () => {
  for (const name of ["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_URL", "CONVEX_PROVISION_HOST", "CONVEX_OVERRIDE_ACCESS_TOKEN", "CONVEX_FUTURE_OVERRIDE", "EXPECTED_CONVEX_URL", "ALLOW_CONVEX_TARGET_MISMATCH", "NODE_OPTIONS", "NODE_PATH"]) {
    const env = { ...pair };
    Object.defineProperty(env, name, { enumerable: true, get() { assert.fail("override value read"); } });
    assertRefused(harness({ env }));
  }
});

test("local env files are refused without reading them", () => {
  for (const file of [".env", ".env.local"]) {
    const h = harness();
    h.options.io.existsSync = (candidate) => candidate === `/fixture/${file}`;
    h.options.io.readFileSync = () => assert.fail("file read");
    assertRefused(h);
  }
});

test("other CLI versions fail closed", () => {
  const h = harness();
  h.options.io.readFileSync = () => '{"version":"1.43.0"}';
  assertRefused(h);
});

test("explicit path forwards only exact direct target pair and fixed CLI args, never credentials in argv or output", () => {
  const h = harness({ env: { ...pair, GH_TOKEN: secret, BASH_ENV: secret, HTTP_PROXY: secret } });
  assert.equal(h.execute(), 0);
  assert.deepEqual(h.calls, [[process.execPath, ["/fixture/node_modules/convex/bin/main.js", "codegen", "--typecheck", "disable"], {
    cwd: "/fixture", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", CI: "1", ...pair }, stdio: "ignore",
  }]]);
  assert.ok(!JSON.stringify(h.calls[0].slice(0, 2)).includes(secret));
  assert.ok(!h.logs.join("\n").includes(secret));
  assert.deepEqual(h.writes, [["/fixture/convex/schema.sha256", `${createHash("sha256").update(h.schema).digest("hex")}  convex/schema.ts\n`]]);
});

test("process failures and thrown errors never log returned secrets or attest success", () => {
  for (const fail of [() => ({ status: 1, stdout: secret, stderr: secret }), () => ({ status: null, error: new Error(secret) }), () => { throw new Error(secret); }]) {
    const h = harness({ run: fail });
    assert.equal(h.execute(), 1);
    assert.equal(h.writes.length, 0);
    assert.ok(!h.logs.join("\n").includes(secret));
    assert.match(h.logs.join("\n"), /effects/);
  }
});

test("schema edits during remote preparation cannot acquire a successful attestation", () => {
  const h = harness();
  let schemaReads = 0;
  h.options.io.readFileSync = (file) => file.endsWith("package.json") ? '{"version":"1.42.3"}' : Buffer.from(`schema-${schemaReads++}`);
  assert.equal(h.execute(), 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes.length, 0);
  assert.match(h.logs.join("\n"), /schema.ts changed/);
});
