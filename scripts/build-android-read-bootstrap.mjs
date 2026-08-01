#!/usr/bin/env node

// Build a clean replacement APK or one private combined bootstrap APK. Gradle
// reads any pairing value from a validated private path in
// VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE; it is never accepted in argv or printed.

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
const appBuildRoot = path.join(androidRoot, "app", "build");
const generatedBuildConfig = path.join(
  appBuildRoot,
  "generated",
  "source",
  "buildConfig",
  "debug",
  "com",
  "sats21m",
  "vogelvault",
  "BuildConfig.java",
);

export const GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE =
  "android-read-bootstrap-apk-v1";

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
    throw new Error("The bootstrap Gradle operation failed.");
  }
}

function validateCiBuildEnvironment(environment) {
  if (!environment.CI) return;
  const approved =
    environment.CI === "true" &&
    environment.GITHUB_ACTIONS === "true" &&
    environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    environment.VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE ===
      GITHUB_ACTIONS_READ_BOOTSTRAP_PURPOSE;
  if (!approved) {
    throw new Error(
      "Android read-bootstrap builds are forbidden in CI outside the approved GitHub Actions workflow_dispatch path.",
    );
  }
}

function scrubIntermediates(directory, spawn = spawnSync) {
  if (!fs.existsSync(directory)) return;
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Refusing to scrub an unexpected Android build path.");
  }
  const result = spawn(
    "find",
    [directory, "-xdev", "-type", "f", "-exec", "shred", "-u", "--", "{}", "+"],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Could not shred Android read-bootstrap intermediates.");
  }
  fs.rmSync(directory, { recursive: true, force: true });
  if (fs.existsSync(directory)) {
    throw new Error("Android read-bootstrap intermediates remained after cleanup.");
  }
}

function validateCleanBuildConfig(file, pairingCode) {
  const buildConfig = fs.readFileSync(file, "utf8");
  const emptyReadToken = 'public static final String CONVEX_READ_TOKEN = "";';
  const emptyBootstrap =
    'public static final String CONVEX_READ_BOOTSTRAP_PAIR = "";';
  const readOnlyIntent =
    "public static final boolean CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE = false;";
  if (
    !buildConfig.includes(emptyReadToken) ||
    !buildConfig.includes(emptyBootstrap) ||
    !buildConfig.includes(readOnlyIntent) ||
    (pairingCode && buildConfig.includes(pairingCode))
  ) {
    throw new Error("The clean replacement build retained read-bootstrap material.");
  }
}

function validateCombinedBootstrapBuildConfig(file, pairingCode) {
  const buildConfig = fs.readFileSync(file, "utf8");
  const emptyReadToken = 'public static final String CONVEX_READ_TOKEN = "";';
  const embeddedBootstrap =
    `public static final String CONVEX_READ_BOOTSTRAP_PAIR = "${pairingCode}";`;
  const todoWriteIntent =
    "public static final boolean CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE = true;";
  if (
    !buildConfig.includes(emptyReadToken) ||
    !buildConfig.includes(embeddedBootstrap) ||
    !buildConfig.includes(todoWriteIntent)
  ) {
    throw new Error(
      "The bootstrap build did not contain the exact combined enrollment intent.",
    );
  }
}

export function buildAndroidReadBootstrap({
  pairingFile,
  output,
  cleanOutput,
  cleanOnly = false,
  processEnv = process.env,
  spawn = spawnSync,
  generatedApkPath = generatedApk,
  generatedBuildConfigPath = generatedBuildConfig,
  intermediatesPath = appBuildRoot,
}) {
  validateCiBuildEnvironment(processEnv);
  const { file, pairingCode } = cleanOnly
    ? { file: "", pairingCode: "" }
    : readPrivatePairingFile(pairingFile, processEnv.HOME);
  const stableDebugKeystore = validateStableDebugKeystore(
    processEnv.VOGEL_DEBUG_KEYSTORE,
  );
  const destination = validatePrivateOutputPath(output, processEnv.HOME);
  const cleanDestination = cleanOutput
    ? validatePrivateOutputPath(cleanOutput, processEnv.HOME)
    : undefined;
  if (cleanDestination === destination) {
    throw new Error("Bootstrap and clean APK outputs must be different paths.");
  }
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
  try {
    if (cleanOnly) {
      runGradle(gradleFlags, buildEnvironment, spawn);
      if (!fs.statSync(generatedApkPath).isFile()) {
        throw new Error("Gradle did not produce the expected clean APK.");
      }
      validateCleanBuildConfig(generatedBuildConfigPath, pairingCode);
      fs.copyFileSync(generatedApkPath, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      return { output: destination, cleanOutput: undefined };
    }

    runGradle(gradleFlags, buildEnvironment, spawn);
    if (!fs.statSync(generatedApkPath).isFile()) {
      throw new Error("Gradle did not produce the expected bootstrap APK.");
    }
    validateCombinedBootstrapBuildConfig(
      generatedBuildConfigPath,
      pairingCode,
    );
    fs.copyFileSync(generatedApkPath, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);

    if (cleanDestination) {
      scrubIntermediates(intermediatesPath, spawn);
      runGradle(
        gradleFlags,
        {
          ...processEnv,
          CONVEX_READ_TOKEN: "",
          CONVEX_SYNC_TOKEN: "",
          VOGEL_DEBUG_KEYSTORE: stableDebugKeystore,
          VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE: "",
          VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE: "",
        },
        spawn,
      );
      if (!fs.statSync(generatedApkPath).isFile()) {
        throw new Error("Gradle did not produce the expected clean APK.");
      }
      validateCleanBuildConfig(generatedBuildConfigPath, pairingCode);
      fs.copyFileSync(
        generatedApkPath,
        cleanDestination,
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(cleanDestination, 0o600);
    }
  } finally {
    scrubIntermediates(intermediatesPath, spawn);
  }
  return { output: destination, cleanOutput: cleanDestination };
}

function usage() {
  console.log(`Usage:
  node scripts/build-android-read-bootstrap.mjs \\
    --clean-only --out "$HOME/work/.../vogel-vault-clean.apk"

  VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE="$HOME/work/.../pairing.txt" \\
    node scripts/build-android-read-bootstrap.mjs \\
      --out "$HOME/work/.../vogel-vault-bootstrap.apk" \\
      --clean-out "$HOME/work/.../vogel-vault-clean.apk"

The input and output paths must be absolute and beneath $HOME/work. The input
must be an owned, regular, non-symlink mode-0600 file. CI is allowed only through
the exact manual GitHub Actions path, and Gradle caches are forbidden. The
pairing value itself is never accepted in argv.
`);
}

export function main(args = process.argv.slice(2), processEnv = process.env) {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const cleanOnly =
    args.length === 3 && args[0] === "--clean-only" && args[1] === "--out";
  if (
    !cleanOnly &&
    !(
      (args.length === 2 && args[0] === "--out") ||
      (args.length === 4 && args[0] === "--out" && args[2] === "--clean-out")
    )
  ) {
    throw new Error(
      "Expected --clean-only --out <absolute-path>, or --out <absolute-path> and optional --clean-out <absolute-path>.",
    );
  }
  const pairingFile = processEnv.VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE;
  if (!cleanOnly && !pairingFile) {
    throw new Error("VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE is required.");
  }
  const result = buildAndroidReadBootstrap({
    pairingFile,
    output: cleanOnly ? args[2] : args[1],
    cleanOutput: cleanOnly ? undefined : args[3],
    cleanOnly,
    processEnv,
  });
  console.log(
    `Wrote one ${cleanOnly ? "clean replacement" : "private bootstrap"} APK to ${result.output}.`,
  );
  if (result.cleanOutput) {
    console.log(`Wrote one clean replacement APK to ${result.cleanOutput}.`);
  }
  console.log("No pairing value was printed; Gradle intermediates were shredded.");
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
