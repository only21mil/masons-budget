#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { appendFile } from "node:fs/promises";

const APP_STORE_CONNECT_ORIGIN = "https://api.appstoreconnect.apple.com";
const DEFAULT_BUNDLE_ID = "com.sats21m.masonsbudget";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const P256_CURVES = new Set(["prime256v1", "P-256", "secp256r1"]);

export const CLASSIFICATION = Object.freeze({
  MISSING_CONFIGURATION: "MISSING_CONFIGURATION",
  INVALID_CONFIGURATION: "INVALID_CONFIGURATION",
  INVALID_PRIVATE_KEY: "INVALID_PRIVATE_KEY",
  AUTHENTICATION_REJECTED: "AUTHENTICATION_REJECTED",
  AUTHORIZATION_REJECTED: "AUTHORIZATION_REJECTED",
  ENDPOINT_NOT_FOUND: "ENDPOINT_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  APPLE_UNAVAILABLE: "APPLE_UNAVAILABLE",
  APPLE_REQUEST_REJECTED: "APPLE_REQUEST_REJECTED",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  NETWORK_FAILURE: "NETWORK_FAILURE",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  BUNDLE_NOT_VISIBLE: "BUNDLE_NOT_VISIBLE",
  BUNDLE_AMBIGUOUS: "BUNDLE_AMBIGUOUS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

export class PreflightError extends Error {
  constructor(classification) {
    super(`App Store Connect preflight failed (${classification}).`);
    this.name = "PreflightError";
    this.classification = classification;
  }
}

function fail(classification) {
  throw new PreflightError(classification);
}

function strictBase64Decode(value) {
  const compact = value.replace(/\s+/gu, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)
  ) {
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }

  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== compact) {
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }
  return decoded.toString("utf8");
}

export function parsePrivateKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail(CLASSIFICATION.MISSING_CONFIGURATION);
  }

  const candidate = (
    value.includes("-----BEGIN PRIVATE KEY-----")
      ? value
      : strictBase64Decode(value)
  )
    .replaceAll("\r\n", "\n")
    .trim();

  if (
    !candidate.startsWith("-----BEGIN PRIVATE KEY-----\n") ||
    !candidate.endsWith("\n-----END PRIVATE KEY-----")
  ) {
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }

  let key;
  try {
    key = createPrivateKey({ key: candidate, format: "pem" });
  } catch {
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }

  if (
    key.type !== "private" ||
    key.asymmetricKeyType !== "ec" ||
    !P256_CURVES.has(key.asymmetricKeyDetails?.namedCurve)
  ) {
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }

  try {
    const probeSignature = sign("sha256", Buffer.from("asc-preflight-key-check"), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    if (probeSignature.length !== 64) {
      fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
    }
  } catch (error) {
    if (error instanceof PreflightError) {
      throw error;
    }
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }

  return key;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createToken({ keyId, issuerId, privateKey, nowSeconds }) {
  if (!/^[A-Z0-9]{10}$/u.test(keyId ?? "")) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      issuerId ?? "",
    )
  ) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }

  const issuedAt = nowSeconds ?? Math.floor(Date.now() / 1_000);
  const header = encodeJson({ alg: "ES256", kid: keyId, typ: "JWT" });
  const payload = encodeJson({
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 20 * 60,
    aud: "appstoreconnect-v1",
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (signature.length !== 64) {
    fail(CLASSIFICATION.INVALID_PRIVATE_KEY);
  }
  return `${signingInput}.${signature.toString("base64url")}`;
}

function classificationForStatus(statusCode) {
  if (statusCode === 401) return CLASSIFICATION.AUTHENTICATION_REJECTED;
  if (statusCode === 403) return CLASSIFICATION.AUTHORIZATION_REJECTED;
  if (statusCode === 404) return CLASSIFICATION.ENDPOINT_NOT_FOUND;
  if (statusCode === 429) return CLASSIFICATION.RATE_LIMITED;
  if (statusCode >= 500 && statusCode <= 599) {
    return CLASSIFICATION.APPLE_UNAVAILABLE;
  }
  return CLASSIFICATION.APPLE_REQUEST_REJECTED;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function requestOnce(url, token, { transport, timeoutMs, maxResponseBytes }) {
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    let timedOut = false;

    const rejectOnce = (classification) => {
      if (settled) return;
      settled = true;
      rejectRequest(new PreflightError(classification));
    };

    const request = transport.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "vogel-vault-asc-preflight/1",
        },
      },
      (response) => {
        const chunks = [];
        let received = 0;

        response.on("data", (chunk) => {
          if (settled) return;
          received += chunk.length;
          if (received > maxResponseBytes) {
            response.destroy();
            rejectOnce(CLASSIFICATION.RESPONSE_TOO_LARGE);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolveRequest({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", () => rejectOnce(CLASSIFICATION.NETWORK_FAILURE));
      },
    );

    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy();
    });
    request.on("error", () => {
      rejectOnce(
        timedOut ? CLASSIFICATION.REQUEST_TIMEOUT : CLASSIFICATION.NETWORK_FAILURE,
      );
    });
    request.end();
  });
}

export async function requestJson(
  url,
  token,
  {
    transport = https,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    sleepImpl = sleep,
  } = {},
) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5 ||
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1
  ) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await requestOnce(url, token, {
        transport,
        timeoutMs,
        maxResponseBytes,
      });
    } catch (error) {
      const retryable =
        error instanceof PreflightError &&
        (error.classification === CLASSIFICATION.REQUEST_TIMEOUT ||
          error.classification === CLASSIFICATION.NETWORK_FAILURE);
      if (!retryable || attempt === maxAttempts) throw error;
      await sleepImpl(250 * 2 ** (attempt - 1));
      continue;
    }

    if (RETRYABLE_STATUS_CODES.has(response.statusCode) && attempt < maxAttempts) {
      await sleepImpl(250 * 2 ** (attempt - 1));
      continue;
    }
    if (response.statusCode !== 200) {
      fail(classificationForStatus(response.statusCode));
    }

    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      fail(CLASSIFICATION.INVALID_RESPONSE);
    }
  }

  fail(CLASSIFICATION.INTERNAL_ERROR);
}

function requireDataArray(document) {
  if (
    document === null ||
    typeof document !== "object" ||
    !Array.isArray(document.data)
  ) {
    fail(CLASSIFICATION.INVALID_RESPONSE);
  }
  return document.data;
}

export function selectExactApp(document, bundleId) {
  const apps = requireDataArray(document);
  const exactMatches = apps.filter(
    (app) =>
      app !== null &&
      typeof app === "object" &&
      typeof app.id === "string" &&
      app.id.length > 0 &&
      app.attributes !== null &&
      typeof app.attributes === "object" &&
      app.attributes.bundleId === bundleId,
  );

  if (exactMatches.length === 0) fail(CLASSIFICATION.BUNDLE_NOT_VISIBLE);
  if (exactMatches.length !== 1 || apps.length !== 1) {
    fail(CLASSIFICATION.BUNDLE_AMBIGUOUS);
  }
  return exactMatches[0].id;
}

export function classifyLatestBuild(document) {
  const builds = requireDataArray(document);
  if (builds.length === 0) return "NONE";
  if (builds.length !== 1) fail(CLASSIFICATION.INVALID_RESPONSE);

  const build = builds[0];
  if (
    build === null ||
    typeof build !== "object" ||
    typeof build.id !== "string" ||
    build.id.length === 0 ||
    build.attributes === null ||
    typeof build.attributes !== "object" ||
    typeof build.attributes.version !== "string" ||
    build.attributes.version.length === 0 ||
    typeof build.attributes.uploadedDate !== "string" ||
    !Number.isFinite(Date.parse(build.attributes.uploadedDate))
  ) {
    fail(CLASSIFICATION.INVALID_RESPONSE);
  }
  return "VISIBLE";
}

export async function runPreflight({ env = process.env, request = requestJson } = {}) {
  const requiredNames = ["ASC_API_KEY_P8", "ASC_KEY_ID", "ASC_ISSUER_ID"];
  if (requiredNames.some((name) => !env[name])) {
    fail(CLASSIFICATION.MISSING_CONFIGURATION);
  }

  const bundleId = env.ASC_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(bundleId)) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }

  const privateKey = parsePrivateKey(env.ASC_API_KEY_P8);
  const token = createToken({
    keyId: env.ASC_KEY_ID,
    issuerId: env.ASC_ISSUER_ID,
    privateKey,
  });

  const appsUrl = new URL("/v1/apps", APP_STORE_CONNECT_ORIGIN);
  appsUrl.searchParams.set("filter[bundleId]", bundleId);
  appsUrl.searchParams.set("limit", "2");
  const appId = selectExactApp(await request(appsUrl, token), bundleId);

  const buildsUrl = new URL("/v1/builds", APP_STORE_CONNECT_ORIGIN);
  buildsUrl.searchParams.set("filter[app]", appId);
  buildsUrl.searchParams.set("sort", "-uploadedDate");
  buildsUrl.searchParams.set("limit", "1");
  buildsUrl.searchParams.set("fields[builds]", "version,uploadedDate");
  const latestBuild = classifyLatestBuild(await request(buildsUrl, token));

  return {
    preflight: "PASS",
    bundleVisibility: "EXACT_MATCH",
    latestBuild,
  };
}

export function renderResult(result) {
  return [
    `APP_STORE_CONNECT_PREFLIGHT=${result.preflight}`,
    `BUNDLE_VISIBILITY=${result.bundleVisibility}`,
    `LATEST_BUILD=${result.latestBuild}`,
    "Apple identifiers, credential material, and response bodies are intentionally omitted.",
  ].join("\n");
}

async function appendSummary(report) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## App Store Connect preflight\n\n\`\`\`text\n${report}\n\`\`\`\n`,
      "utf8",
    );
  } catch {
    process.stderr.write("::warning::Could not append the redacted preflight summary.\n");
  }
}

async function main() {
  try {
    const result = await runPreflight();
    const report = renderResult(result);
    process.stdout.write(`${report}\n`);
    await appendSummary(report);
  } catch (error) {
    const classification =
      error instanceof PreflightError
        ? error.classification
        : CLASSIFICATION.INTERNAL_ERROR;
    const report = [
      "APP_STORE_CONNECT_PREFLIGHT=FAIL",
      `CLASSIFICATION=${classification}`,
      "Apple identifiers, credential material, and response bodies are intentionally omitted.",
    ].join("\n");
    process.stderr.write(`::error::${report.replaceAll("\n", " ")}\n`);
    await appendSummary(report);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await main();
}
