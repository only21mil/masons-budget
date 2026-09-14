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

// Fixed codes only. No response values, object keys, paths or raw errors enter
// diagnostics. The renderer checks these allowlists again at the output boundary.
const RELEASE_STAGES = new Set([
  "APP_LOOKUP", "LATEST_BUILD", "RELEASE_INPUT", "GROUPS", "GROUP_BUILDS", "BUILDS", "BETA_DETAIL",
]);
const RELEASE_REASONS = new Set([
  "REQUEST_FAILED", "UNEXPECTED_EXCEPTION", "JSON_PARSE", "DOCUMENT_OBJECT", "DATA_ARRAY",
  "APP_NOT_VISIBLE", "APP_AMBIGUOUS", "LATEST_BUILD_COUNT", "LATEST_BUILD_OBJECT",
  "LATEST_BUILD_ID_TYPE", "LATEST_BUILD_ID_EMPTY", "LATEST_ATTRIBUTES_OBJECT",
  "LATEST_VERSION_TYPE", "LATEST_VERSION_EMPTY", "LATEST_DATE_TYPE", "LATEST_DATE_INVALID",
  "INPUT_INVALID", "PAGE_REPEAT", "PAGE_LIMIT", "PAGE_RECORD_LIMIT", "LINKS_OBJECT",
  "LINKS_ARRAY", "RECORD_TYPE", "RECORD_ID", "RECORD_DUPLICATE", "NEXT_TYPE", "NEXT_URL",
  "NEXT_ORIGIN", "NEXT_PATH", "NEXT_USERNAME", "NEXT_PASSWORD", "NEXT_HASH",
  "NEXT_QUERY_COUNT", "NEXT_QUERY_VALUE", "NEXT_QUERY_EXTRA", "NEXT_CURSOR_COUNT",
  "NEXT_CURSOR_EMPTY", "NEXT_URL_LENGTH", "GROUP_LIMIT", "GROUP_INTERNAL_BOOLEAN",
  "GROUP_ALL_BUILDS_BOOLEAN", "BUILD_COUNT", "PRERELEASE_RELATION_TYPE", "PRERELEASE_RELATION_ID",
  "APP_RELATION_TYPE", "APP_RELATION_ID", "INCLUDED_ARRAY", "PRERELEASE_INCLUDED_COUNT",
  "PRERELEASE_VERSION", "PRERELEASE_PLATFORM", "APP_INCLUDED_COUNT", "APP_BUNDLE",
  "BUILD_NUMBER", "BUILD_PROCESSING_STATE", "BUILD_EXPIRED_BOOLEAN", "DETAIL_TYPE", "DETAIL_ID",
  "DETAIL_BUILD_RELATION_TYPE", "DETAIL_BUILD_RELATION_ID", "DETAIL_INCLUDED_BUILD_COUNT",
  "DETAIL_INCLUDED_BUILD_NUMBER", "DETAIL_INTERNAL_STATE", "DETAIL_EXTERNAL_STATE",
]);

function invalidResponse(reason) {
  const error = new PreflightError(CLASSIFICATION.INVALID_RESPONSE);
  error.reason = reason;
  throw error;
}

function releaseFailure(error, stage, platform) {
  const safeError = new PreflightError(error instanceof PreflightError ?
    error.classification : CLASSIFICATION.INTERNAL_ERROR);
  safeError.releaseDiagnostic = { stage,
    reason: RELEASE_REASONS.has(error?.reason) ? error.reason :
      error instanceof PreflightError ? "REQUEST_FAILED" : "UNEXPECTED_EXCEPTION",
    ...(platform ? { platform } : {}),
  };
  return safeError;
}

async function releaseStage(stage, action) {
  try { return await action(); }
  catch (error) { throw releaseFailure(error, stage); }
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
      invalidResponse("JSON_PARSE");
    }
  }

  fail(CLASSIFICATION.INTERNAL_ERROR);
}

function requireDataArray(document, invalid = () => fail(CLASSIFICATION.INVALID_RESPONSE)) {
  if (document === null || typeof document !== "object") invalid("DOCUMENT_OBJECT");
  if (!Array.isArray(document.data)) invalid("DATA_ARRAY");
  return document.data;
}

export function selectExactApp(document, bundleId, invalid = () => fail(CLASSIFICATION.INVALID_RESPONSE)) {
  const apps = requireDataArray(document, invalid);
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

  if (exactMatches.length === 0) {
    const error = new PreflightError(CLASSIFICATION.BUNDLE_NOT_VISIBLE);
    error.reason = "APP_NOT_VISIBLE";
    throw error;
  }
  if (exactMatches.length !== 1 || apps.length !== 1) {
    const error = new PreflightError(CLASSIFICATION.BUNDLE_AMBIGUOUS);
    error.reason = "APP_AMBIGUOUS";
    throw error;
  }
  return exactMatches[0].id;
}

export function classifyLatestBuild(document, invalid = () => fail(CLASSIFICATION.INVALID_RESPONSE)) {
  const builds = requireDataArray(document, invalid);
  if (builds.length === 0) return "NONE";
  if (builds.length !== 1) invalid("LATEST_BUILD_COUNT");

  const build = builds[0];
  if (build === null || typeof build !== "object") invalid("LATEST_BUILD_OBJECT");
  if (typeof build.id !== "string") invalid("LATEST_BUILD_ID_TYPE");
  if (build.id.length === 0) invalid("LATEST_BUILD_ID_EMPTY");
  if (build.attributes === null || typeof build.attributes !== "object") invalid("LATEST_ATTRIBUTES_OBJECT");
  if (typeof build.attributes.version !== "string") invalid("LATEST_VERSION_TYPE");
  if (build.attributes.version.length === 0) invalid("LATEST_VERSION_EMPTY");
  if (typeof build.attributes.uploadedDate !== "string") invalid("LATEST_DATE_TYPE");
  if (!Number.isFinite(Date.parse(build.attributes.uploadedDate))) invalid("LATEST_DATE_INVALID");
  return "VISIBLE";
}

// Keep pagination at the exact endpoint, app and platform selected by this
// caller. Never forward the bearer token to a server-supplied arbitrary URL.
function nextBuildPage(value, initialUrl, invalid = () => fail(CLASSIFICATION.INVALID_RESPONSE)) {
  if (typeof value !== "string") invalid("NEXT_TYPE");
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid("NEXT_URL");
  }
  if (url.origin !== APP_STORE_CONNECT_ORIGIN) invalid("NEXT_ORIGIN");
  if (url.pathname !== initialUrl.pathname) invalid("NEXT_PATH");
  if (url.username) invalid("NEXT_USERNAME");
  if (url.password) invalid("NEXT_PASSWORD");
  if (url.hash) invalid("NEXT_HASH");
  for (const [name, expected] of initialUrl.searchParams) {
    if (url.searchParams.getAll(name).length !== 1) invalid("NEXT_QUERY_COUNT");
    if (url.searchParams.get(name) !== expected) invalid("NEXT_QUERY_VALUE");
  }
  for (const name of url.searchParams.keys()) {
    if (!initialUrl.searchParams.has(name) && name !== "cursor") invalid("NEXT_QUERY_EXTRA");
  }
  if (url.searchParams.getAll("cursor").length !== 1) invalid("NEXT_CURSOR_COUNT");
  if (!url.searchParams.get("cursor")) invalid("NEXT_CURSOR_EMPTY");
  if (url.href.length > 8192) invalid("NEXT_URL_LENGTH");
  return url;
}

function numericBuild(value) {
  if (typeof value !== "string" || !/^[0-9]{1,15}$/u.test(value)) {
    fail(CLASSIFICATION.INVALID_RESPONSE);
  }
  return Number(value);
}

function numericVersion(value) {
  if (typeof value !== "string" || !/^[0-9]{1,4}(?:\.[0-9]{1,4}){0,2}$/u.test(value)) {
    fail(CLASSIFICATION.INVALID_RESPONSE);
  }
  return value;
}

export async function readBuildNumbers(appId, token, request = requestJson) {
  // The app ID remains private. Restrict it before it becomes a URL path.
  if (!/^[0-9]+$/u.test(appId)) fail(CLASSIFICATION.INVALID_RESPONSE);
  const inventory = [];
  for (const platform of ["IOS", "MAC_OS"]) {
    for (const source of ["builds", "buildUploads"]) {
      const initialUrl = new URL(source === "builds" ? "/v1/builds" :
        `/v1/apps/${appId}/buildUploads`, APP_STORE_CONNECT_ORIGIN);
      initialUrl.searchParams.set("limit", "200");
      if (source === "builds") {
        initialUrl.searchParams.set("filter[app]", appId);
        initialUrl.searchParams.set("filter[preReleaseVersion.platform]", platform);
        initialUrl.searchParams.set("fields[builds]", "version,preReleaseVersion");
        initialUrl.searchParams.set("include", "preReleaseVersion");
        initialUrl.searchParams.set("fields[preReleaseVersions]", "version,platform");
      } else {
        initialUrl.searchParams.set("filter[platform]", platform);
        initialUrl.searchParams.set("fields[buildUploads]",
          "cfBundleVersion,cfBundleShortVersionString,platform");
      }
      let url = initialUrl;
      const seenPages = new Set();
      const seenRecords = new Set();
      while (url) {
        // Twenty pages per endpoint/platform bounds the entire lookup to at
        // most 16,000 metadata records. Refuse truncation or moving duplicates.
        const pageKey = new URL(url);
        pageKey.searchParams.sort();
        if (seenPages.has(pageKey.href) || seenPages.size >= 20) {
          fail(CLASSIFICATION.INVALID_RESPONSE);
        }
        seenPages.add(pageKey.href);
        const document = await request(url, token);
        const records = requireDataArray(document);
        if (records.length > 200 || !document.links || typeof document.links !== "object" ||
            Array.isArray(document.links)) {
          fail(CLASSIFICATION.INVALID_RESPONSE);
        }
        for (const record of records) {
          if (record?.type !== source || typeof record.id !== "string" ||
              !record.id || seenRecords.has(record.id) || !record.attributes) {
            fail(CLASSIFICATION.INVALID_RESPONSE);
          }
          seenRecords.add(record.id);
          let version;
          let buildNumber;
          if (source === "builds") {
            const relation = record.relationships?.preReleaseVersion?.data;
            if (relation?.type !== "preReleaseVersions" || !relation.id ||
                !Array.isArray(document.included)) fail(CLASSIFICATION.INVALID_RESPONSE);
            const matches = document.included.filter(item =>
              item?.type === "preReleaseVersions" && item.id === relation.id);
            if (matches.length !== 1 || matches[0].attributes?.platform !== platform) {
              fail(CLASSIFICATION.INVALID_RESPONSE);
            }
            version = numericVersion(matches[0].attributes.version);
            buildNumber = numericBuild(record.attributes.version);
          } else {
            if (record.attributes.platform !== platform) fail(CLASSIFICATION.INVALID_RESPONSE);
            version = numericVersion(record.attributes.cfBundleShortVersionString);
            buildNumber = numericBuild(record.attributes.cfBundleVersion);
          }
          inventory.push({ platform, source, version, buildNumber });
        }
        url = document.links.next == null ? null : nextBuildPage(document.links.next, initialUrl);
      }
    }
  }
  return {
    inventory,
    highestObservedBuildNumber: inventory.length === 0 ? null :
      Math.max(...inventory.map(item => item.buildNumber)),
  };
}

// Apple enum definitions: /documentation/appstoreconnectapi/{internal,external}betastate.
// Only fixed enum values reach the report; identifiers and group names never do.
const INTERNAL_BETA_STATES = new Set([
  "PROCESSING", "PROCESSING_EXCEPTION", "MISSING_EXPORT_COMPLIANCE",
  "READY_FOR_BETA_TESTING", "IN_BETA_TESTING", "EXPIRED", "IN_EXPORT_COMPLIANCE_REVIEW",
]);
const EXTERNAL_BETA_STATES = new Set([...INTERNAL_BETA_STATES,
  "READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW",
  "BETA_REJECTED", "BETA_APPROVED", "NOT_APPLICABLE",
]);
const validResourceId = value => typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/u.test(value);

async function releasePages(initialUrl, type, token, request) {
  let url = initialUrl;
  const records = [], seenPages = new Set(), seenRecords = new Set();
  while (url) {
    const pageKey = new URL(url);
    pageKey.searchParams.sort();
    if (seenPages.has(pageKey.href)) invalidResponse("PAGE_REPEAT");
    if (seenPages.size >= 20) invalidResponse("PAGE_LIMIT");
    seenPages.add(pageKey.href);
    const document = await request(url, token);
    const data = requireDataArray(document, invalidResponse);
    if (data.length > 200) invalidResponse("PAGE_RECORD_LIMIT");
    if (!document.links || typeof document.links !== "object") invalidResponse("LINKS_OBJECT");
    if (Array.isArray(document.links)) invalidResponse("LINKS_ARRAY");
    for (const record of data) {
      if (record?.type !== type) invalidResponse("RECORD_TYPE");
      if (!validResourceId(record.id)) invalidResponse("RECORD_ID");
      if (seenRecords.has(record.id)) invalidResponse("RECORD_DUPLICATE");
      seenRecords.add(record.id);
      records.push({ record, included: document.included });
    }
    url = document.links.next == null ? null : nextBuildPage(document.links.next, initialUrl, invalidResponse);
  }
  return records;
}

export async function readReleaseVerification(appId, version, number, token, request = requestJson) {
  let stage = "RELEASE_INPUT";
  let diagnosticPlatform;
  try {
    if (!/^[0-9]+$/u.test(appId) || numericVersion(version) !== version ||
        numericBuild(number) < 1) fail(CLASSIFICATION.INVALID_CONFIGURATION);
    const urlFor = (path, fields) => {
      const url = new URL(path, APP_STORE_CONNECT_ORIGIN);
      for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
      return url;
    };
    stage = "GROUPS";
    const groups = await releasePages(urlFor(`/v1/apps/${appId}/betaGroups`, {
      limit: "200", "fields[betaGroups]": "isInternalGroup,hasAccessToAllBuilds",
    }), "betaGroups", token, request);
    // Bound the number of group relationship requests as well as each page list.
    if (groups.length > 50) invalidResponse("GROUP_LIMIT");
    for (const { record: group } of groups) {
      stage = "GROUPS";
      if (typeof group.attributes?.isInternalGroup !== "boolean") invalidResponse("GROUP_INTERNAL_BOOLEAN");
      // Apple's BetaGroup schema makes this Boolean optional. Treat absence or
      // null as unknown, never as all-build access; explicit links still count.
      // https://developer.apple.com/documentation/appstoreconnectapi/betagroup/attributes-data.dictionary
      if (group.attributes.hasAccessToAllBuilds != null &&
          typeof group.attributes.hasAccessToAllBuilds !== "boolean") invalidResponse("GROUP_ALL_BUILDS_BOOLEAN");
      stage = "GROUP_BUILDS";
      group.buildIds = new Set((await releasePages(urlFor(`/v1/betaGroups/${group.id}/relationships/builds`, {
        limit: "200",
      }), "builds", token, request)).map(({ record }) => record.id));
    }
    const platforms = [];
    for (const platform of ["IOS", "MAC_OS"]) {
      diagnosticPlatform = platform;
      stage = "BUILDS";
      const builds = await releasePages(urlFor("/v1/builds", {
        limit: "200", "filter[app]": appId, "filter[version]": number,
        "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": platform,
        "fields[builds]": "version,processingState,expired,preReleaseVersion,app",
        include: "preReleaseVersion,app", "fields[preReleaseVersions]": "version,platform",
        "fields[apps]": "bundleId",
      }), "builds", token, request);
      if (builds.length > 1) invalidResponse("BUILD_COUNT");
      if (!builds.length) {
        platforms.push({ platform, processingState: "MISSING", available: false });
        continue;
      }
      const { record: build, included } = builds[0];
      const prerelease = build.relationships?.preReleaseVersion?.data;
      const app = build.relationships?.app?.data;
      if (prerelease?.type !== "preReleaseVersions") invalidResponse("PRERELEASE_RELATION_TYPE");
      if (!validResourceId(prerelease.id)) invalidResponse("PRERELEASE_RELATION_ID");
      if (app?.type !== "apps") invalidResponse("APP_RELATION_TYPE");
      if (app.id !== appId) invalidResponse("APP_RELATION_ID");
      if (!Array.isArray(included)) invalidResponse("INCLUDED_ARRAY");
      const versions = included.filter(item => item?.type === "preReleaseVersions" && item.id === prerelease.id);
      const apps = included.filter(item => item?.type === "apps" && item.id === appId);
      if (versions.length !== 1) invalidResponse("PRERELEASE_INCLUDED_COUNT");
      if (versions[0].attributes?.version !== version) invalidResponse("PRERELEASE_VERSION");
      if (versions[0].attributes?.platform !== platform) invalidResponse("PRERELEASE_PLATFORM");
      if (apps.length !== 1) invalidResponse("APP_INCLUDED_COUNT");
      if (apps[0].attributes?.bundleId !== DEFAULT_BUNDLE_ID) invalidResponse("APP_BUNDLE");
      if (build.attributes?.version !== number) invalidResponse("BUILD_NUMBER");
      if (!["PROCESSING", "FAILED", "INVALID", "VALID"].includes(build.attributes?.processingState)) {
        invalidResponse("BUILD_PROCESSING_STATE");
      }
      if (typeof build.attributes?.expired !== "boolean") invalidResponse("BUILD_EXPIRED_BOOLEAN");
      const result = { platform, processingState: build.attributes.processingState,
        expired: build.attributes.expired, available: false };
      if (result.processingState === "VALID") {
        stage = "BETA_DETAIL";
        const detailDocument = await request(urlFor(`/v1/builds/${build.id}/buildBetaDetail`, {
          "fields[buildBetaDetails]": "internalBuildState,externalBuildState,build",
          include: "build", "fields[builds]": "version",
        }), token);
        const detail = detailDocument.data;
        const includedBuilds = Array.isArray(detailDocument.included) ? detailDocument.included.filter(item =>
          item?.type === "builds" && item.id === build.id) : [];
        if (detail?.type !== "buildBetaDetails") invalidResponse("DETAIL_TYPE");
        if (!validResourceId(detail.id)) invalidResponse("DETAIL_ID");
        if (detail.relationships?.build?.data?.type !== "builds") invalidResponse("DETAIL_BUILD_RELATION_TYPE");
        if (detail.relationships.build.data.id !== build.id) invalidResponse("DETAIL_BUILD_RELATION_ID");
        if (includedBuilds.length !== 1) invalidResponse("DETAIL_INCLUDED_BUILD_COUNT");
        if (includedBuilds[0].attributes?.version !== number) invalidResponse("DETAIL_INCLUDED_BUILD_NUMBER");
        if (!INTERNAL_BETA_STATES.has(detail.attributes?.internalBuildState)) invalidResponse("DETAIL_INTERNAL_STATE");
        if (!EXTERNAL_BETA_STATES.has(detail.attributes?.externalBuildState)) invalidResponse("DETAIL_EXTERNAL_STATE");
        result.internalBuildState = detail.attributes.internalBuildState;
        result.externalBuildState = detail.attributes.externalBuildState;
        result.internalGroupCount = groups.filter(({ record: group }) => group.attributes.isInternalGroup &&
          (group.attributes.hasAccessToAllBuilds === true || group.buildIds.has(build.id))).length;
        result.externalGroupCount = groups.filter(({ record: group }) => !group.attributes.isInternalGroup &&
          group.buildIds.has(build.id)).length;
        result.available = !result.expired &&
          ((result.internalBuildState === "IN_BETA_TESTING" && result.internalGroupCount > 0) ||
           (result.externalBuildState === "IN_BETA_TESTING" && result.externalGroupCount > 0));
      }
      platforms.push(result);
    }
    return { version, buildNumber: Number(number), existingGroupCount: groups.length, platforms,
      classification: platforms.every(item => item.available) ? "AVAILABLE_TO_EXISTING_GROUPS" : "NOT_READY" };
  } catch (error) {
    if (stage === "RELEASE_INPUT" && error instanceof PreflightError) error.reason = "INPUT_INVALID";
    throw releaseFailure(error, stage, diagnosticPlatform);
  }
}

export async function runPreflight({ env = process.env, request = requestJson } = {}) {
  const requiredNames = ["ASC_API_KEY_P8", "ASC_KEY_ID", "ASC_ISSUER_ID"];
  if (requiredNames.some((name) => !env[name])) {
    fail(CLASSIFICATION.MISSING_CONFIGURATION);
  }

  const bundleId = env.ASC_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  if (env.ASC_BUILD_NUMBER_LOOKUP && !["true", "false"].includes(env.ASC_BUILD_NUMBER_LOOKUP)) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }
  const lookupBuildNumbers = env.ASC_BUILD_NUMBER_LOOKUP === "true";
  const verifyRelease = Boolean(env.ASC_RELEASE_VERSION || env.ASC_RELEASE_BUILD);
  if (verifyRelease && (!/^[0-9]{1,4}(?:\.[0-9]{1,4}){0,2}$/u.test(env.ASC_RELEASE_VERSION ?? "") ||
      !/^[1-9][0-9]{0,14}$/u.test(env.ASC_RELEASE_BUILD ?? "") ||
      !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? "") || !/^[0-9]+$/u.test(env.GITHUB_RUN_ID ?? ""))) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }
  if ((lookupBuildNumbers || verifyRelease) && bundleId !== DEFAULT_BUNDLE_ID) {
    fail(CLASSIFICATION.INVALID_CONFIGURATION);
  }
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
  const appId = verifyRelease ? await releaseStage("APP_LOOKUP", async () =>
    selectExactApp(await request(appsUrl, token), bundleId, invalidResponse)) :
    selectExactApp(await request(appsUrl, token), bundleId);

  const buildsUrl = new URL("/v1/builds", APP_STORE_CONNECT_ORIGIN);
  buildsUrl.searchParams.set("filter[app]", appId);
  buildsUrl.searchParams.set("sort", "-uploadedDate");
  buildsUrl.searchParams.set("limit", "1");
  buildsUrl.searchParams.set("fields[builds]", "version,uploadedDate");
  const latestBuild = verifyRelease ? await releaseStage("LATEST_BUILD", async () =>
    classifyLatestBuild(await request(buildsUrl, token), invalidResponse)) :
    classifyLatestBuild(await request(buildsUrl, token));
  const buildNumbers = lookupBuildNumbers ? await readBuildNumbers(appId, token, request) : undefined;
  const releaseVerification = verifyRelease ? {
    ...await readReleaseVerification(appId, env.ASC_RELEASE_VERSION, env.ASC_RELEASE_BUILD, token, request),
    workflowSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
  } : undefined;

  return {
    preflight: releaseVerification?.classification === "NOT_READY" ? "FAIL" : "PASS",
    bundleVisibility: "EXACT_MATCH",
    latestBuild,
    ...(buildNumbers ? { buildNumbers } : {}),
    ...(releaseVerification ? { releaseVerification } : {}),
  };
}

export function renderResult(result) {
  return [
    `APP_STORE_CONNECT_PREFLIGHT=${result.preflight}`,
    `BUNDLE_VISIBILITY=${result.bundleVisibility}`,
    `LATEST_BUILD=${result.latestBuild}`,
    ...(result.buildNumbers ? [`BUILD_NUMBERS=${JSON.stringify(result.buildNumbers)}`] : []),
    ...(result.releaseVerification ? [`RELEASE_VERIFICATION=${JSON.stringify(result.releaseVerification)}`] : []),
    "Apple identifiers, credential material, and response bodies are intentionally omitted.",
  ].join("\n");
}

export function renderFailure(error) {
  const classification = error instanceof PreflightError &&
    Object.values(CLASSIFICATION).includes(error.classification) ?
    error.classification : CLASSIFICATION.INTERNAL_ERROR;
  const diagnostic = error instanceof PreflightError ? error.releaseDiagnostic : undefined;
  const safeDiagnostic = diagnostic && RELEASE_STAGES.has(diagnostic.stage) &&
    RELEASE_REASONS.has(diagnostic.reason) ? {
      stage: diagnostic.stage, reason: diagnostic.reason,
      ...(["IOS", "MAC_OS"].includes(diagnostic.platform) ? { platform: diagnostic.platform } : {}),
    } : undefined;
  return [
    "APP_STORE_CONNECT_PREFLIGHT=FAIL",
    `CLASSIFICATION=${classification}`,
    ...(safeDiagnostic ? [`RELEASE_DIAGNOSTIC=${JSON.stringify(safeDiagnostic)}`] : []),
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
    if (result.releaseVerification && result.releaseVerification.classification !== "AVAILABLE_TO_EXISTING_GROUPS") {
      process.exitCode = 1;
    }
  } catch (error) {
    const report = renderFailure(error);
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
