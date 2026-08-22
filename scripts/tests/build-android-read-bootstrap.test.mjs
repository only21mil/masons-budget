import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
  GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE,
  buildAndroidReadBootstrap,
  readPrivatePairingFile,
  validatePrivateOutputPath,
} from "../build-android-read-bootstrap.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
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

test("Gradle locks combined intent to guarded bootstrap builds", async () => {
  const source = await readFile(
    path.join(repoRoot, "android/app/build.gradle.kts"),
    "utf8",
  );
  const field = "CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE";
  assert.equal(source.match(new RegExp(field, "g"))?.length, 2);
  assert.match(
    source,
    new RegExp(
      `buildConfigField\\("boolean", "${field}", "false"\\)`,
    ),
  );
  assert.match(
    source,
    new RegExp(`"boolean",\\s*"${field}",\\s*"true"`),
  );
});

test("manual workflow retains branch signer cleanup and retention gates", async () => {
  const source = await readFile(
    path.join(repoRoot, ".github/workflows/android-read-bootstrap.yml"),
    "utf8",
  );
  for (const invariant of [
    "workflow_dispatch:",
    "github.event.repository.default_branch",
    "ANDROID_DEBUG_KEYSTORE_BASE64",
    "PAIRING: ${{ inputs.mode == 'bootstrap-pair' && secrets.ANDROID_READ_BOOTSTRAP_PAIR || '' }}",
    "VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE: android-read-bootstrap-apk-v1",
    "retention-days: 1",
    "if: always()",
    "find \"$private_root\" -xdev -type f -exec shred -u -- {} +",
  ]) {
    assert.equal(source.includes(invariant), true, invariant);
  }
});

test("approved manual CI builds bootstrap then scrubbed clean APK with exact uncached assembly", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-invoke-");
  const input = await pairingFile(directory);
  const intermediates = path.join(directory, "intermediates");
  const fakeGeneratedApk = path.join(intermediates, "generated.apk");
  const fakeBuildConfig = path.join(intermediates, "BuildConfig.java");
  const stableDebugKeystore = path.join(directory, "stable-debug.keystore");
  const output = path.join(directory, "vogel-vault-read-bootstrap.apk");
  const cleanOutput = path.join(directory, "vogel-vault-clean.apk");
  await writeFile(stableDebugKeystore, "test-keystore", { mode: 0o600 });
  await chmod(stableDebugKeystore, 0o600);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (String(command).endsWith("gradlew")) {
      const combined = Boolean(
        options.env.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE,
      );
      mkdirSync(intermediates, { recursive: true });
      writeFileSync(fakeGeneratedApk, "test-apk-bytes");
      writeFileSync(
        fakeBuildConfig,
        [
          'public static final String CONVEX_READ_TOKEN = "";',
          `public static final String CONVEX_READ_BOOTSTRAP_PAIR = "${
            combined ? validPairingCode() : ""
          }";`,
          `public static final boolean CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE = ${combined};`,
        ].join("\n"),
      );
    }
    return { status: 0, error: undefined };
  };

  const result = buildAndroidReadBootstrap({
    pairingFile: input,
    output,
    cleanOutput,
    processEnv: {
      ...process.env,
      HOME: os.homedir(),
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE:
        GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE,
      CONVEX_READ_TOKEN: "must-not-reach-gradle",
      CONVEX_SYNC_TOKEN: "must-not-reach-gradle",
      VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
    },
    spawn,
    generatedApkPath: fakeGeneratedApk,
    generatedBuildConfigPath: fakeBuildConfig,
    intermediatesPath: intermediates,
  });

  assert.deepEqual(result, { output, cleanOutput });
  assert.equal(calls.length, 4);
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
  assert.equal(calls[1].command, "find");
  assert.deepEqual(calls[2].args, [
    ":app:assembleDebug",
    "--no-build-cache",
    "--no-configuration-cache",
    "--no-daemon",
    "--rerun-tasks",
  ]);
  assert.equal(calls[2].options.env.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE, "");
  assert.equal(
    calls[2].options.env.VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE,
    "",
  );
  assert.equal(calls[2].options.env.CONVEX_READ_TOKEN, "");
  assert.equal(calls[2].options.env.CONVEX_SYNC_TOKEN, "");
  assert.equal(calls[2].options.env.VOGEL_DEBUG_KEYSTORE, stableDebugKeystore);
  assert.equal(calls[3].command, "find");
  assert.equal(await readFile(output, "utf8"), "test-apk-bytes");
  assert.equal(await readFile(cleanOutput, "utf8"), "test-apk-bytes");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal((await stat(cleanOutput)).mode & 0o777, 0o600);
});

test("clean-only build needs no pairing file and performs one clean assembly", async () => {
  const directory = await privateDirectory("vv-android-clean-only-");
  const intermediates = path.join(directory, "intermediates");
  const fakeGeneratedApk = path.join(intermediates, "generated.apk");
  const fakeBuildConfig = path.join(intermediates, "BuildConfig.java");
  const stableDebugKeystore = path.join(directory, "stable-debug.keystore");
  const output = path.join(directory, "vogel-vault-clean.apk");
  await writeFile(stableDebugKeystore, "test-keystore", { mode: 0o600 });
  await chmod(stableDebugKeystore, 0o600);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (String(command).endsWith("gradlew")) {
      mkdirSync(intermediates, { recursive: true });
      writeFileSync(fakeGeneratedApk, "test-apk-bytes");
      writeFileSync(
        fakeBuildConfig,
        [
          'public static final String CONVEX_READ_TOKEN = "";',
          'public static final String CONVEX_READ_BOOTSTRAP_PAIR = "";',
          "public static final boolean CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE = false;",
        ].join("\n"),
      );
    }
    return { status: 0, error: undefined };
  };

  const result = buildAndroidReadBootstrap({
    output,
    cleanOnly: true,
    processEnv: {
      ...process.env,
      HOME: os.homedir(),
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE:
        GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE,
      CONVEX_READ_TOKEN: "must-not-reach-gradle",
      CONVEX_SYNC_TOKEN: "must-not-reach-gradle",
      VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
    },
    spawn,
    generatedApkPath: fakeGeneratedApk,
    generatedBuildConfigPath: fakeBuildConfig,
    intermediatesPath: intermediates,
  });

  assert.deepEqual(result, { output, cleanOutput: undefined });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE, "");
  assert.equal(calls[0].options.env.CONVEX_READ_TOKEN, "");
  assert.equal(calls[0].options.env.CONVEX_SYNC_TOKEN, "");
  assert.equal(calls[0].options.env.VOGEL_DEBUG_KEYSTORE, stableDebugKeystore);
  assert.equal(calls[1].command, "find");
  assert.equal(await readFile(output, "utf8"), "test-apk-bytes");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("clean replacement fails closed if generated todo-write intent remains true", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-clean-guard-");
  const input = await pairingFile(directory);
  const intermediates = path.join(directory, "intermediates");
  const fakeGeneratedApk = path.join(intermediates, "generated.apk");
  const fakeBuildConfig = path.join(intermediates, "BuildConfig.java");
  const stableDebugKeystore = path.join(directory, "stable-debug.keystore");
  await writeFile(stableDebugKeystore, "test-keystore", { mode: 0o600 });
  await chmod(stableDebugKeystore, 0o600);
  let assemblies = 0;
  const spawn = (command) => {
    if (String(command).endsWith("gradlew")) {
      assemblies += 1;
      mkdirSync(intermediates, { recursive: true });
      writeFileSync(fakeGeneratedApk, "test-apk-bytes");
      writeFileSync(
        fakeBuildConfig,
        [
          'public static final String CONVEX_READ_TOKEN = "";',
          `public static final String CONVEX_READ_BOOTSTRAP_PAIR = "${
            assemblies === 1 ? validPairingCode() : ""
          }";`,
          "public static final boolean CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE = true;",
        ].join("\n"),
      );
    }
    return { status: 0, error: undefined };
  };

  assert.throws(
    () =>
      buildAndroidReadBootstrap({
        pairingFile: input,
        output: path.join(directory, "bootstrap.apk"),
        cleanOutput: path.join(directory, "clean.apk"),
        processEnv: {
          ...process.env,
          HOME: os.homedir(),
          CI: "true",
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE:
            GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE,
          VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
        },
        spawn,
        generatedApkPath: fakeGeneratedApk,
        generatedBuildConfigPath: fakeBuildConfig,
        intermediatesPath: intermediates,
      }),
    /retained read-bootstrap material/,
  );
  assert.equal(assemblies, 2);
  await assert.rejects(stat(path.join(directory, "clean.apk")), /ENOENT/);
  await assert.rejects(stat(intermediates), /ENOENT/);
});

test("bootstrap copy fails closed when generated todo-write intent is false", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-intent-guard-");
  const input = await pairingFile(directory);
  const intermediates = path.join(directory, "intermediates");
  const fakeGeneratedApk = path.join(intermediates, "generated.apk");
  const fakeBuildConfig = path.join(intermediates, "BuildConfig.java");
  const stableDebugKeystore = path.join(directory, "stable-debug.keystore");
  const output = path.join(directory, "bootstrap.apk");
  await writeFile(stableDebugKeystore, "test-keystore", { mode: 0o600 });
  await chmod(stableDebugKeystore, 0o600);

  assert.throws(
    () =>
      buildAndroidReadBootstrap({
        pairingFile: input,
        output,
        processEnv: {
          ...process.env,
          HOME: os.homedir(),
          CI: "",
          VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
        },
        spawn: (command) => {
          if (String(command).endsWith("gradlew")) {
            mkdirSync(intermediates, { recursive: true });
            writeFileSync(fakeGeneratedApk, "test-apk-bytes");
            writeFileSync(
              fakeBuildConfig,
              [
                'public static final String CONVEX_READ_TOKEN = "";',
                `public static final String CONVEX_READ_BOOTSTRAP_PAIR = "${validPairingCode()}";`,
                "public static final boolean CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE = false;",
              ].join("\n"),
            );
          }
          return { status: 0, error: undefined };
        },
        generatedApkPath: fakeGeneratedApk,
        generatedBuildConfigPath: fakeBuildConfig,
        intermediatesPath: intermediates,
      }),
    /combined enrollment intent/,
  );
  await assert.rejects(stat(output), /ENOENT/);
  await assert.rejects(stat(intermediates), /ENOENT/);
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

test("CI allowance rejects every near miss of the exact manual GitHub Actions shape", async () => {
  const directory = await privateDirectory("vv-android-bootstrap-ci-shape-");
  const input = await pairingFile(directory);
  const approved = {
    ...process.env,
    HOME: os.homedir(),
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE:
      GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE,
  };

  for (const [name, value] of [
    ["CI", "1"],
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_EVENT_NAME", "push"],
    ["VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE", "android-read-bootstrap"],
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        buildAndroidReadBootstrap({
          pairingFile: input,
          output: path.join(directory, `${name}.apk`),
          processEnv: { ...approved, [name]: value },
          spawn: () => {
            calls += 1;
            return { status: 0 };
          },
        }),
      /forbidden in CI/,
    );
    assert.equal(calls, 0);
  }
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
