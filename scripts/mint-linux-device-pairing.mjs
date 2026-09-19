#!/usr/bin/env node

// Mint one household-admin Linux pairing from a trusted operator machine.
// Its four capabilities authorize both closed household owner/source pairs.
// The pairing secret is written only to a 0600 file and is never printed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_CONVEX_ORIGIN = "https://framework-desktop.tail69757d.ts.net";
export const RESPONSE_LIMIT_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LINUX_DEVICE_CAPABILITIES = [
  "todos:write",
  "transactions:write",
  "budget:write",
  "bitcoin:write",
];
export const DEVICE_PROFILES = ["victor", "rachel", "mason", "maddox"];

const scriptPath = fileURLToPath(import.meta.url);

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function approvedConvexOrigin(rawUrl) {
  if (
    rawUrl !== APPROVED_CONVEX_ORIGIN &&
    rawUrl !== `${APPROVED_CONVEX_ORIGIN}/`
  ) {
    throw new Error(
      `CONVEX_URL must be exactly ${APPROVED_CONVEX_ORIGIN} ` +
        "(no credentials, port, path, query, or fragment).",
    );
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("CONVEX_URL must be the approved household HTTPS origin.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== APPROVED_CONVEX_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `CONVEX_URL must be exactly ${APPROVED_CONVEX_ORIGIN} ` +
        "(no credentials, port, path, query, or fragment).",
    );
  }
  return APPROVED_CONVEX_ORIGIN;
}

async function readCappedJson(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_LIMIT_BYTES) {
    throw new Error("Pairing response exceeded the safe size limit.");
  }
  if (!response.body) {
    throw new Error("Pairing response had no body.");
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
      throw new Error("Pairing response exceeded the safe size limit.");
    }
    chunks.push(value);
  }

  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Pairing response was not valid JSON.");
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
    throw new Error("Pairing response did not match the expected schema.");
  }
}

export async function mintLinuxDevicePairing({
  convexUrl,
  syncToken,
  name,
  profile,
  hours,
  output,
  fetchImpl = fetch,
  randomBytes = crypto.randomBytes,
  now = Date.now(),
}) {
  const convexOrigin = approvedConvexOrigin(convexUrl);
  if (!DEVICE_PROFILES.includes(profile)) {
    throw new Error(`profile must be one of: ${DEVICE_PROFILES.join(", ")}.`);
  }
  if (!syncToken) {
    throw new Error(
      "CONVEX_SYNC_TOKEN is required on the trusted operator machine.",
    );
  }
  if (fs.existsSync(output)) {
    throw new Error("Refusing to overwrite the existing pairing file.");
  }

  const pairId = `linux-${base64url(randomBytes(9))}`;
  const secret = base64url(randomBytes(32));
  const pairingCode = `${pairId}.${secret}`;
  const proofHash = crypto
    .createHash("sha256")
    .update(pairingCode, "utf8")
    .digest("hex");
  const expiresAt = now + hours * 60 * 60 * 1000;

  let response;
  try {
    response = await fetchImpl(`${convexOrigin}/api/mutation`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "dataFiles:createMobilePairing",
        args: {
          pairId,
          proofHash,
          expiresAt,
          createdBy: name,
          capabilities: LINUX_DEVICE_CAPABILITIES,
          profile,
          token: syncToken,
        },
        format: "json",
      }),
    });
  } catch {
    throw new Error(
      "The approved Convex pairing request failed; no secret file was written.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `The approved Convex pairing request failed (${response.status}); ` +
        "no secret file was written.",
    );
  }
  const body = await readCappedJson(response);
  validateSuccessResponse(body, pairId, expiresAt);

  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    output,
    `${JSON.stringify(
      {
        version: 1,
        pairingCode,
        expiresAt,
        capabilities: LINUX_DEVICE_CAPABILITIES,
        profile,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  fs.chmodSync(output, 0o600);
  return { output };
}

function value(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined
    ? args[index + 1]
    : fallback;
}

function usage() {
  console.log(`Usage:
  node scripts/mint-linux-device-pairing.mjs [options]

Options:
  --name <name>  Household-admin device label. Default: Vogel Vault Linux
  --hours <n>    Pairing lifetime. Default: 24
  --profile <p>  Required credential-bound task profile.
  --out <path>   0600 secret JSON destination.
  --dry-run      Validate configuration without minting, writing, or generating secrets.

Requires CONVEX_SYNC_TOKEN in the process environment unless --dry-run.
On the approved host, load it without output before running:
  set -a; . "$HOME/.config/sats/secrets.env"; set +a
Only the approved household origin ${APPROVED_CONVEX_ORIGIN} is accepted.
`);
}

export async function main(
  args = process.argv.slice(2),
  processEnv = process.env,
) {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const name = value(args, "--name", "Vogel Vault Linux").trim();
  const hours = Number(value(args, "--hours", "24"));
  const profile = value(args, "--profile", null);
  const output = path.resolve(
    value(
      args,
      "--out",
      path.join(
        processEnv.HOME || ".",
        ".config",
        "vogel-vault",
        "linux-device-pairing.json",
      ),
    ),
  );
  const dryRun = args.includes("--dry-run");
  if (!name || name.length > 80) {
    throw new Error("--name must contain 1-80 characters.");
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error("--hours must be greater than 0 and at most 168.");
  }
  if (profile === null || !DEVICE_PROFILES.includes(profile)) {
    throw new Error(`--profile must be one of: ${DEVICE_PROFILES.join(", ")}.`);
  }

  const convexOrigin = approvedConvexOrigin(
    processEnv.CONVEX_URL || APPROVED_CONVEX_ORIGIN,
  );
  const syncToken = processEnv.CONVEX_SYNC_TOKEN || "";

  if (dryRun) {
    console.log(
      "DRY RUN: no request, file write, or secret generation occurred.",
    );
    console.log(`convexOrigin=${convexOrigin}`);
    console.log(`name=${name}`);
    console.log(`hours=${hours}`);
    console.log(`capabilities=${LINUX_DEVICE_CAPABILITIES.join(",")}`);
    console.log(`profile=${profile}`);
    console.log(`out=${output}`);
    return;
  }

  await mintLinuxDevicePairing({
    convexUrl: convexOrigin,
    syncToken,
    name,
    profile,
    hours,
    output,
  });
  console.log(`Minted one household-admin Linux pairing into ${output}.`);
  console.log("The pairing secret was not printed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : "Pairing failed."}`,
    );
    process.exitCode = 1;
  });
}
