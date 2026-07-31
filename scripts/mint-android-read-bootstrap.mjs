#!/usr/bin/env node

// Mint one short-lived Android read + todo-write bootstrap on a trusted host.
// The raw proof is written only to a new mode-0600 file under $HOME/work. Convex
// receives only its SHA-256 hash, and no secret or derivative is printed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_CONVEX_ORIGIN = "https://keen-elephant-452.convex.cloud";
export const DEFAULT_TTL_MINUTES = 15;
export const MAX_TTL_MINUTES = 30;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RESPONSE_LIMIT_BYTES = 16 * 1024;
export const ANDROID_BOOTSTRAP_CAPABILITIES = Object.freeze(["todos:write"]);
export const PAIRING_CODE_PATTERN =
  /^android-read-[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/;

const scriptPath = fileURLToPath(import.meta.url);

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function validateTtlMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TTL_MINUTES) {
    throw new Error(
      `--minutes must be an integer from 1 to ${MAX_TTL_MINUTES}.`,
    );
  }
  return minutes;
}

function parseArgs(args) {
  let output;
  let minutes = DEFAULT_TTL_MINUTES;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out") {
      if (output !== undefined || args[index + 1] === undefined) {
        throw new Error("--out must be supplied exactly once with a path.");
      }
      output = args[++index];
    } else if (argument === "--minutes") {
      if (args[index + 1] === undefined) {
        throw new Error("--minutes requires a value.");
      }
      minutes = validateTtlMinutes(args[++index]);
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (output === undefined) {
    throw new Error("--out is required; there is no default secret destination.");
  }
  return { output, minutes, dryRun, help: false };
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function validateOutputPath(output, homeDirectory) {
  if (!homeDirectory || !path.isAbsolute(homeDirectory)) {
    throw new Error("HOME must be an absolute path.");
  }
  if (!output || !path.isAbsolute(output)) {
    throw new Error("--out must be an absolute path under $HOME/work.");
  }
  const workRoot = fs.realpathSync(path.join(homeDirectory, "work"));
  const parent = fs.realpathSync(path.dirname(output));
  const resolvedOutput = path.join(parent, path.basename(output));
  if (!pathInside(workRoot, resolvedOutput)) {
    throw new Error("--out must resolve beneath $HOME/work.");
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error("The --out parent must be an existing directory.");
  }
  if (fs.existsSync(resolvedOutput)) {
    throw new Error("Refusing to overwrite the existing bootstrap file.");
  }
  return resolvedOutput;
}

async function readCappedJson(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_LIMIT_BYTES) {
    throw new Error("Bootstrap response exceeded the safe size limit.");
  }
  if (!response.body) {
    throw new Error("Bootstrap response had no body.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error("Bootstrap response exceeded the safe size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new Error("Bootstrap response was not valid JSON.");
  }
}

function validateSuccessResponse(body, pairId, expiresAt) {
  const bodyKeys =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];
  const valueKeys =
    typeof body?.value === "object" &&
    body.value !== null &&
    !Array.isArray(body.value)
      ? Object.keys(body.value).sort()
      : [];
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    body.status !== "success" ||
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    body.value.pairId !== pairId ||
    body.value.expiresAt !== expiresAt ||
    bodyKeys.join(",") !== "status,value" ||
    valueKeys.join(",") !== "expiresAt,pairId"
  ) {
    throw new Error("Bootstrap response did not match the expected schema.");
  }
}

function writePrivateFile(output, pairingCode) {
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW |
    fs.constants.O_WRONLY;
  const descriptor = fs.openSync(output, flags, 0o600);
  try {
    fs.writeFileSync(descriptor, pairingCode, { encoding: "ascii" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(output, 0o600);
}

export async function mintAndroidReadBootstrap({
  syncToken,
  minutes = DEFAULT_TTL_MINUTES,
  output,
  homeDirectory,
  fetchImpl = fetch,
  randomBytes = crypto.randomBytes,
  now = Date.now(),
}) {
  if (!syncToken) {
    throw new Error("CONVEX_SYNC_TOKEN is required on the trusted operator host.");
  }
  const ttlMinutes = validateTtlMinutes(minutes);
  const destination = validateOutputPath(output, homeDirectory);
  const pairId = `android-read-${base64url(randomBytes(18))}`;
  const proof = base64url(randomBytes(32));
  const pairingCode = `${pairId}.${proof}`;
  if (!PAIRING_CODE_PATTERN.test(pairingCode)) {
    throw new Error("Generated bootstrap pairing did not match the wire contract.");
  }
  const proofHash = crypto.createHash("sha256").update(proof, "ascii").digest("hex");
  const expiresAt = now + ttlMinutes * 60 * 1000;

  let response;
  try {
    response = await fetchImpl(`${APPROVED_CONVEX_ORIGIN}/api/mutation`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "dataFiles:createAndroidReadBootstrap",
        args: {
          pairId,
          proofHash,
          expiresAt,
          capabilities: ANDROID_BOOTSTRAP_CAPABILITIES,
          token: syncToken,
        },
        format: "json",
      }),
    });
  } catch {
    throw new Error("The approved bootstrap request failed; no file was written.");
  }
  if (!response.ok) {
    throw new Error(
      `The approved bootstrap request failed (${response.status}); no file was written.`,
    );
  }
  const body = await readCappedJson(response);
  validateSuccessResponse(body, pairId, expiresAt);
  writePrivateFile(destination, pairingCode);
  return { output: destination };
}

function usage() {
  console.log(`Usage:
  node scripts/mint-android-read-bootstrap.mjs --out <absolute-path> [options]

Options:
  --out <path>     Required new mode-0600 file beneath $HOME/work.
  --minutes <n>    Pairing lifetime, 1-${MAX_TTL_MINUTES}. Default: ${DEFAULT_TTL_MINUTES}.
  --dry-run        Validate configuration without a request, file, or secret generation.

CONVEX_SYNC_TOKEN must come from the environment. No credential is accepted in argv.
`);
}

export async function main(args = process.argv.slice(2), processEnv = process.env) {
  const options = parseArgs(args);
  if (options.help) {
    usage();
    return;
  }
  if (processEnv.CI) {
    throw new Error("Android read-bootstrap minting is forbidden in CI.");
  }
  const output = options.output;
  validateOutputPath(output, processEnv.HOME);
  if (options.dryRun) {
    console.log("DRY RUN: no request, file write, or secret generation occurred.");
    console.log(`minutes=${options.minutes}`);
    console.log(`capabilities=${ANDROID_BOOTSTRAP_CAPABILITIES.join(",")}`);
    console.log(`out=${output}`);
    return;
  }
  await mintAndroidReadBootstrap({
    syncToken: processEnv.CONVEX_SYNC_TOKEN || "",
    minutes: options.minutes,
    output,
    homeDirectory: processEnv.HOME,
  });
  console.log(
    `Minted one short-lived Android read + todo-write bootstrap into ${output}.`,
  );
  console.log("No pairing value or derivative was printed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : "Bootstrap mint failed."}`,
    );
    process.exitCode = 1;
  });
}
