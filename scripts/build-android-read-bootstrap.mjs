#!/usr/bin/env node

// Build one local-only bootstrap APK. The pairing value is read by Gradle from
// a validated private file path in VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE; it is
// never accepted in argv or printed by this helper.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PAIRING_CODE_PATTERN } from "./mint-android-read-bootstrap.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const androidRoot = path.join(repoRoot, "android");
const generatedApk = path.join(
  androidRoot,
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
);

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function resolvedWorkRoot(homeDirectory) {
  if (!homeDirectory || !path.isAbsolute(homeDirectory)) {
    throw new Error("HOME must be an absolute path.");
  }
  return fs.realpathSync(path.join(homeDirectory, "work"));
}

function validateStableDebugKeystore(file, expectedUid = process.getuid?.()) {
  if (!file || !path.isAbsolute(file)) {
    throw new Error("VOGEL_DEBUG_KEYSTORE must name the stable debug keystore by absolute path.");
  }
  const metadata = fs.lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("VOGEL_DEBUG_KEYSTORE must be a regular file, not a symlink.");
  }
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error("VOGEL_DEBUG_KEYSTORE must be owned by the current user.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("VOGEL_DEBUG_KEYSTORE must not grant group or other access.");
  }
  return fs.realpathSync(file);
}

function validateCanonicalPairing(pairingCode) {
  if (!PAIRING_CODE_PATTERN.test(pairingCode)) {
    throw new Error("Bootstrap file does not match the required pairing format.");
  }
  const proof = pairingCode.slice(pairingCode.lastIndexOf(".") + 1);
  let decoded;
  try {
    decoded = Buffer.from(proof, "base64url");
  } catch {
    throw new Error("Bootstrap proof is not canonical base64url.");
  }
  if (decoded.length !== 32 || decoded.toString("base64url") !== proof) {
    throw new Error("Bootstrap proof must canonically encode exactly 32 bytes.");
  }
}

export function readPrivatePairingFile(file, homeDirectory, expectedUid = process.getuid?.()) {
  if (!file || !path.isAbsolute(file)) {
    throw new Error("VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE must be an absolute path.");
  }
  const workRoot = resolvedWorkRoot(homeDirectory);
  const metadata = fs.lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Bootstrap input must be a regular file, not a symlink.");
  }
  const resolved = fs.realpathSync(file);
  if (!pathInside(workRoot, resolved)) {
    throw new Error("Bootstrap input must resolve beneath $HOME/work.");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("Bootstrap input must have exact mode 0600.");
  }
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error("Bootstrap input must be owned by the current user.");
  }
  if (metadata.size < 1 || metadata.size > 160) {
    throw new Error("Bootstrap input is empty or oversized.");
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.some((byte) => byte > 0x7f)) {
    throw new Error("Bootstrap input must contain ASCII only.");
  }
  const pairingCode = bytes.toString("ascii");
  validateCanonicalPairing(pairingCode);
  return { file: resolved, pairingCode };
}

export function validatePrivateOutputPath(output, homeDirectory) {
  if (!output || !path.isAbsolute(output)) {
    throw new Error("--out must be an absolute path under $HOME/work.");
  }
  const workRoot = resolvedWorkRoot(homeDirectory);
  const parent = fs.realpathSync(path.dirname(output));
  const resolved = path.join(parent, path.basename(output));
  if (!pathInside(workRoot, resolved)) {
    throw new Error("--out must resolve beneath $HOME/work.");
  }
  if (fs.existsSync(resolved)) {
    throw new Error("Refusing to overwrite the existing APK.");
  }
  return resolved;
}

function runGradle(args, environment, spawn = spawnSync) {
  const result = spawn(path.join(androidRoot, "gradlew"), args, {
    cwd: androidRoot,
    env: environment,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error("The local bootstrap Gradle operation failed.");
  }
}

export function buildAndroidReadBootstrap({
  pairingFile,
  output,
  processEnv = process.env,
  spawn = spawnSync,
  generatedApkPath = generatedApk,
}) {
  if (processEnv.CI) {
    throw new Error("Android read-bootstrap builds are forbidden in CI.");
  }
  const { file } = readPrivatePairingFile(pairingFile, processEnv.HOME);
  const stableDebugKeystore = validateStableDebugKeystore(
    processEnv.VOGEL_DEBUG_KEYSTORE,
  );
  const destination = validatePrivateOutputPath(output, processEnv.HOME);
  const buildEnvironment = {
    ...processEnv,
    CONVEX_READ_TOKEN: "",
    CONVEX_SYNC_TOKEN: "",
    VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
    VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE: file,
  };
  const gradleFlags = [
    ":app:assembleDebug",
    "--no-build-cache",
    "--no-configuration-cache",
    "--no-daemon",
    "--rerun-tasks",
  ];
  let buildSucceeded = false;
  try {
    runGradle(gradleFlags, buildEnvironment, spawn);
    buildSucceeded = true;
    if (!fs.statSync(generatedApkPath).isFile()) {
      throw new Error("Gradle did not produce the expected bootstrap APK.");
    }
    fs.copyFileSync(generatedApkPath, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  } finally {
    try {
      runGradle(
        [":app:clean", "--no-build-cache", "--no-configuration-cache", "--no-daemon"],
        {
          ...processEnv,
          CONVEX_READ_TOKEN: "",
          CONVEX_SYNC_TOKEN: "",
          VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE: "",
        },
        spawn,
      );
    } catch (cleanupError) {
      if (buildSucceeded) throw cleanupError;
    }
  }
  return { output: destination };
}

function usage() {
  console.log(`Usage:
  VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE="$HOME/work/.../pairing.txt" \\
    node scripts/build-android-read-bootstrap.mjs --out "$HOME/work/.../vogel-vault-bootstrap.apk"

The input and output paths must be absolute and beneath $HOME/work. The input
must be an owned, regular, non-symlink mode-0600 file. CI and Gradle caches are
forbidden. The pairing value itself is never accepted in argv.
`);
}

export function main(args = process.argv.slice(2), processEnv = process.env) {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.length !== 2 || args[0] !== "--out") {
    throw new Error("Expected exactly --out <absolute-path>.");
  }
  const pairingFile = processEnv.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE;
  if (!pairingFile) {
    throw new Error("VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE is required.");
  }
  const result = buildAndroidReadBootstrap({
    pairingFile,
    output: args[1],
    processEnv,
  });
  console.log(`Wrote one local bootstrap APK to ${result.output}.`);
  console.log("No pairing value was printed; Gradle intermediates were cleaned.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : "Bootstrap build failed."}`,
    );
    process.exitCode = 1;
  }
}
