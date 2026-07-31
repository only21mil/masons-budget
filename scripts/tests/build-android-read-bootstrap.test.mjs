import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  buildAndroidReadBootstrap,
  readPrivatePairingFile,
  validatePrivateOutputPath,
} from "../build-android-read-bootstrap.mjs";

const testRoots = [];

async function privateDirectory(prefix = "vv-android-bootstrap-build-") {
  const workRoot = path.join(os.homedir(), "work");
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(path.join(workRoot, prefix));
  testRoots.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(testRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function validPairingCode() {
  return `android-read-${Buffer.alloc(18, 7).toString("base64url")}.${Buffer.alloc(32, 9).toString("base64url")}`;
}

async function pairingFile(directory, value = validPairingCode(), mode = 0o600) {
  const file = path.join(directory, "pairing.txt");
  await writeFile(file, value, { mode });
  await chmod(file, mode);
  return file;
}

test("private pairing validation accepts only canonical owned 0600 files under HOME work", async () => {
  const directory = await privateDirectory();
  const file = await pairingFile(directory);
  const result = readPrivatePairingFile(file, os.homedir());
  assert.equal(result.file, file);
  assert.equal(result.pairingCode, validPairingCode());

  await chmod(file, 0o640);
  assert.throws(() => readPrivatePairingFile(file, os.homedir()), /0600/);
  await chmod(file, 0o600);
  assert.throws(
    () => readPrivatePairingFile(file, os.homedir(), (process.getuid?.() ?? 0) + 1),
    /owned/,
  );
});

test("private pairing validation rejects symlink multiline malformed oversized and noncanonical proof", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-invalid-");
  const target = await pairingFile(directory);
  const link = path.join(directory, "pairing-link.txt");
  await symlink(target, link);
  assert.throws(() => readPrivatePairingFile(link, os.homedir()), /symlink/);

  for (const [name, value, error] of [
    ["multiline", `${validPairingCode()}\n`, /format/],
    ["malformed", "android-read-short.bad", /format/],
    ["oversized", "x".repeat(161), /oversized/],
  ]) {
    const invalidDirectory = await privateDirectory(`vv-android-bootstrap-${name}-`);
    const file = await pairingFile(invalidDirectory, value);
    assert.throws(() => readPrivatePairingFile(file, os.homedir()), error);
  }

  const canonical = validPairingCode();
  // The canonical final `k` has zero pad bits; `l` decodes to the same bytes
  // but sets a discarded pad bit, so a permissive decoder alone is insufficient.
  const noncanonical = `${canonical.slice(0, -1)}l`;
  const noncanonicalDirectory = await privateDirectory("vv-android-bootstrap-noncanonical-");
  const noncanonicalFile = await pairingFile(noncanonicalDirectory, noncanonical);
  assert.throws(
    () => readPrivatePairingFile(noncanonicalFile, os.homedir()),
    /canonically/,
  );
});

test("output must be new and beneath HOME work", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-output-");
  const output = path.join(directory, "bootstrap.apk");
  assert.equal(validatePrivateOutputPath(output, os.homedir()), output);
  await writeFile(output, "existing");
  assert.throws(
    () => validatePrivateOutputPath(output, os.homedir()),
    /overwrite/,
  );
});

test("build invokes only uncached local debug assembly, copies exclusively, and cleans intermediates", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-invoke-");
  const input = await pairingFile(directory);
  const fakeGeneratedApk = path.join(directory, "generated.apk");
  const stableDebugKeystore = path.join(directory, "stable-debug.keystore");
  const output = path.join(directory, "bootstrap.apk");
  await writeFile(fakeGeneratedApk, "test-apk-bytes");
  await writeFile(stableDebugKeystore, "test-keystore", { mode: 0o600 });
  await chmod(stableDebugKeystore, 0o600);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, error: undefined };
  };

  const result = buildAndroidReadBootstrap({
    pairingFile: input,
    output,
    processEnv: {
      ...process.env,
      HOME: os.homedir(),
      CI: "",
      CONVEX_READ_TOKEN: "must-not-reach-gradle",
      CONVEX_SYNC_TOKEN: "must-not-reach-gradle",
      VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
    },
    spawn,
    generatedApkPath: fakeGeneratedApk,
  });

  assert.deepEqual(result, { output });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    ":app:assembleDebug",
    "--no-build-cache",
    "--no-configuration-cache",
    "--no-daemon",
    "--rerun-tasks",
  ]);
  assert.equal(calls[0].options.env.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE, input);
  assert.equal(calls[0].options.env.CONVEX_READ_TOKEN, "");
  assert.equal(calls[0].options.env.CONVEX_SYNC_TOKEN, "");
  assert.equal(calls[0].options.env.VOGEL_DEBUG_KEYSTORE, stableDebugKeystore);
  assert.equal(calls[0].args.join(" ").includes(validPairingCode()), false);
  assert.deepEqual(calls[1].args, [
    ":app:clean",
    "--no-build-cache",
    "--no-configuration-cache",
    "--no-daemon",
  ]);
  assert.equal(calls[1].options.env.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE, "");
  assert.equal(calls[1].options.env.CONVEX_READ_TOKEN, "");
  assert.equal(calls[1].options.env.CONVEX_SYNC_TOKEN, "");
  assert.equal(await readFile(output, "utf8"), "test-apk-bytes");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("build refuses CI before invoking Gradle", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-ci-");
  const input = await pairingFile(directory);
  let calls = 0;
  assert.throws(
    () =>
      buildAndroidReadBootstrap({
        pairingFile: input,
        output: path.join(directory, "bootstrap.apk"),
        processEnv: { ...process.env, HOME: os.homedir(), CI: "true" },
        spawn: () => {
          calls += 1;
          return { status: 0 };
        },
      }),
    /forbidden in CI/,
  );
  assert.equal(calls, 0);
});

test("build refuses to create an uninstall-only APK without the stable signing key", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-signing-");
  const input = await pairingFile(directory);
  assert.throws(
    () =>
      buildAndroidReadBootstrap({
        pairingFile: input,
        output: path.join(directory, "bootstrap.apk"),
        processEnv: { ...process.env, HOME: os.homedir(), CI: "", VOGEL_DEBUG_KEYSTORE: "" },
        spawn: () => ({ status: 0 }),
      }),
    /stable debug keystore/,
  );
});
