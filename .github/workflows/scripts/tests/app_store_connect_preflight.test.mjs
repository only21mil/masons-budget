import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { after, before, test } from "node:test";

import {
  CLASSIFICATION,
  PreflightError,
  classifyLatestBuild,
  createToken,
  parsePrivateKey,
  requestJson,
  readBuildNumbers,
  renderResult,
  runPreflight,
  selectExactApp,
} from "../app_store_connect_preflight.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const validEnv = {
  ASC_API_KEY_P8: privatePem,
  ASC_KEY_ID: "ABCDEFGHIJ",
  ASC_ISSUER_ID: "12345678-1234-1234-1234-123456789abc",
  ASC_BUNDLE_ID: "com.sats21m.masonsbudget",
};

function classificationOf(callback) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PreflightError);
  return caught.classification;
}

test("accepts raw and strictly base64-wrapped P-256 PKCS#8 PEM values", () => {
  assert.equal(parsePrivateKey(privatePem).asymmetricKeyType, "ec");
  assert.equal(
    parsePrivateKey(privatePem.replaceAll("\n", "\r\n")).asymmetricKeyType,
    "ec",
  );
  assert.equal(
    parsePrivateKey(Buffer.from(privatePem).toString("base64")).asymmetricKeyType,
    "ec",
  );
});

test("rejects malformed base64 and non-P-256 private keys", () => {
  assert.equal(
    classificationOf(() => parsePrivateKey("not+strict=base64")),
    CLASSIFICATION.INVALID_PRIVATE_KEY,
  );
  const { privateKey: wrongCurve } = generateKeyPairSync("ec", {
    namedCurve: "secp384r1",
  });
  const wrongPem = wrongCurve.export({ format: "pem", type: "pkcs8" });
  assert.equal(
    classificationOf(() => parsePrivateKey(wrongPem)),
    CLASSIFICATION.INVALID_PRIVATE_KEY,
  );
});

test("creates an ES256 JWT with a raw 64-byte P-256 signature", () => {
  const token = createToken({
    keyId: validEnv.ASC_KEY_ID,
    issuerId: validEnv.ASC_ISSUER_ID,
    privateKey: parsePrivateKey(privatePem),
    nowSeconds: 1_700_000_000,
  });
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, "base64url")), {
    alg: "ES256",
    kid: validEnv.ASC_KEY_ID,
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, "base64url")), {
    iss: validEnv.ASC_ISSUER_ID,
    iat: 1_700_000_000,
    exp: 1_700_001_200,
    aud: "appstoreconnect-v1",
  });
  const signature = Buffer.from(encodedSignature, "base64url");
  assert.equal(signature.length, 64);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    ),
    true,
  );
});

test("requires one and only one exact bundle result", () => {
  assert.equal(
    selectExactApp(
      {
        data: [
          {
            id: "opaque-app-id",
            attributes: { bundleId: validEnv.ASC_BUNDLE_ID },
          },
        ],
      },
      validEnv.ASC_BUNDLE_ID,
    ),
    "opaque-app-id",
  );
  assert.equal(
    classificationOf(() =>
      selectExactApp({ data: [] }, validEnv.ASC_BUNDLE_ID),
    ),
    CLASSIFICATION.BUNDLE_NOT_VISIBLE,
  );
  assert.equal(
    classificationOf(() =>
      selectExactApp(
        {
          data: [
            {
              id: "opaque-app-id",
              attributes: { bundleId: validEnv.ASC_BUNDLE_ID },
            },
            {
              id: "unexpected-id",
              attributes: { bundleId: "com.example.other" },
            },
          ],
        },
        validEnv.ASC_BUNDLE_ID,
      ),
    ),
    CLASSIFICATION.BUNDLE_AMBIGUOUS,
  );
});

test("classifies the latest build without returning Apple identifiers", () => {
  assert.equal(classifyLatestBuild({ data: [] }), "NONE");
  assert.equal(
    classifyLatestBuild({
      data: [
        {
          id: "opaque-build-id",
          attributes: {
            version: "123",
            uploadedDate: "2026-07-26T12:00:00Z",
          },
        },
      ],
    }),
    "VISIBLE",
  );
});

test("queries the exact bundle before the latest build and returns classifications only", async () => {
  const calls = [];
  const result = await runPreflight({
    env: validEnv,
    request: async (url, token) => {
      calls.push({ url, token });
      if (calls.length === 1) {
        return {
          data: [
            {
              id: "opaque-app-id",
              attributes: { bundleId: validEnv.ASC_BUNDLE_ID },
            },
          ],
        };
      }
      return {
        data: [
          {
            id: "opaque-build-id",
            attributes: {
              version: "123",
              uploadedDate: "2026-07-26T12:00:00Z",
            },
          },
        ],
      };
    },
  });

  assert.deepEqual(result, {
    preflight: "PASS",
    bundleVisibility: "EXACT_MATCH",
    latestBuild: "VISIBLE",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/v1/apps");
  assert.equal(
    calls[0].url.searchParams.get("filter[bundleId]"),
    validEnv.ASC_BUNDLE_ID,
  );
  assert.equal(calls[1].url.pathname, "/v1/builds");
  assert.equal(calls[1].url.searchParams.get("filter[app]"), "opaque-app-id");
  assert.equal(calls[1].url.searchParams.get("sort"), "-uploadedDate");
});

let server;
let origin;
let requests = 0;

before(async () => {
  server = http.createServer((request, response) => {
    requests += 1;
    if (request.url === "/retry") {
      if (requests < 3) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("raw Apple body must never escape: RETRY_SECRET");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
      return;
    }
    if (request.url === "/unauthorized") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"errors":[{"detail":"RAW_APPLE_SECRET"}]}');
      return;
    }
    if (request.url === "/hang") {
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("retries retryable statuses only up to the configured bound", async () => {
  requests = 0;
  const document = await requestJson(new URL("/retry", origin), "redacted-token", {
    transport: http,
    maxAttempts: 3,
    timeoutMs: 1_000,
    sleepImpl: async () => {},
  });
  assert.deepEqual(document, { data: [] });
  assert.equal(requests, 3);
});

test("maps Apple errors to a redacted classification without a raw body", async () => {
  requests = 0;
  await assert.rejects(
    requestJson(new URL("/unauthorized", origin), "redacted-token", {
      transport: http,
      maxAttempts: 3,
      timeoutMs: 1_000,
      sleepImpl: async () => {},
    }),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.AUTHENTICATION_REJECTED);
      assert.equal(error.message.includes("RAW_APPLE_SECRET"), false);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("bounds request timeouts and retries", async () => {
  requests = 0;
  await assert.rejects(
    requestJson(new URL("/hang", origin), "redacted-token", {
      transport: http,
      maxAttempts: 2,
      timeoutMs: 20,
      sleepImpl: async () => {},
    }),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.REQUEST_TIMEOUT);
      return true;
    },
  );
  assert.equal(requests, 2);
});

function buildPage(platform, number, { next = null, id = `build-${number}` } = {}) {
  return {
    data: [{ type: "builds", id, attributes: { version: number },
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "version-id" } } } }],
    included: [{ type: "preReleaseVersions", id: "version-id",
      attributes: { version: "0.5.0", platform } }],
    links: { next },
  };
}

function uploadPage(platform, number) {
  return { data: [{ type: "buildUploads", id: "private-upload-id",
    attributes: { cfBundleVersion: number, cfBundleShortVersionString: "0.5.0", platform } }],
    links: {} };
}

function nextPage(url, cursor = "page-two") {
  const next = new URL(url);
  next.searchParams.set("cursor", cursor);
  return next.href;
}

test("build inventory includes all pages, both platforms and higher reserved uploads", async () => {
  const calls = [];
  const result = await readBuildNumbers("123456789", "private-token", async (url, token) => {
    calls.push(new URL(url));
    assert.equal(token, "private-token");
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
    assert.equal(url.searchParams.has("filter[expired]"), false);
    assert.equal(url.searchParams.has("filter[state]"), false);
    assert.equal(url.searchParams.has("filter[preReleaseVersion.version]"), false);
    assert.equal(url.searchParams.has("filter[cfBundleShortVersionString]"), false);
    if (url.pathname === "/v1/builds") {
      assert.equal(url.searchParams.get("filter[app]"), "123456789");
      const platform = url.searchParams.get("filter[preReleaseVersion.platform]");
      return buildPage(platform, url.searchParams.has("cursor") ? "46" : "44", {
        next: url.searchParams.has("cursor") ? null : nextPage(url),
      });
    }
    assert.equal(url.pathname, "/v1/apps/123456789/buildUploads");
    return uploadPage(url.searchParams.get("filter[platform]"), "49");
  });
  assert.equal(calls.length, 6);
  assert.equal(result.highestObservedBuildNumber, 49);
  assert.equal(result.inventory.length, 6);
  assert.deepEqual(new Set(result.inventory.map(item => item.platform)), new Set(["IOS", "MAC_OS"]));
  const rendered = renderResult({ preflight: "PASS", bundleVisibility: "EXACT_MATCH", latestBuild: "VISIBLE", buildNumbers: result });
  for (const forbidden of ["private-token", "123456789", "private-upload-id", "version-id", "build-44"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
});

test("empty inventories are complete observations, not a selected next number", async () => {
  let calls = 0;
  const result = await readBuildNumbers("123", "token", async () => {
    calls += 1;
    return { data: [], links: {} };
  });
  assert.equal(calls, 4);
  assert.deepEqual(result, { inventory: [], highestObservedBuildNumber: null });
});

test("rejects pagination escaping the origin, exact app, platform or sparse query before sending auth", async () => {
  const mutations = [
    url => { url.protocol = "http:"; },
    url => { url.hostname = "evil.example"; },
    url => { url.username = "private-user"; },
    url => { url.hash = "fragment"; },
    url => { url.pathname = "/v1/apps/999/buildUploads"; },
    url => { url.searchParams.set("filter[app]", "999"); },
    url => { url.searchParams.delete("filter[app]"); },
    url => { url.searchParams.set("filter[preReleaseVersion.platform]", "TV_OS"); },
    url => { url.searchParams.set("fields[builds]", "individualTesters"); },
    url => { url.searchParams.append("filter[app]", "999"); },
    url => { url.searchParams.set("include", "individualTesters"); },
    url => { url.searchParams.append("arbitrary", "1"); },
    url => { url.searchParams.append("cursor", "duplicate"); },
  ];
  for (const mutate of mutations) {
    let calls = 0;
    await assert.rejects(readBuildNumbers("123", "token", async url => {
      calls += 1;
      const next = new URL(nextPage(url));
      mutate(next);
      return buildPage("IOS", "44", { next: next.href });
    }), error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
    assert.equal(calls, 1);
  }
});

test("refuses repeated pages, duplicate records and excessive pagination without partial success", async () => {
  for (const mode of ["cycle", "duplicate", "bound"]) {
    let calls = 0;
    await assert.rejects(readBuildNumbers("123", "token", async url => {
      calls += 1;
      return buildPage("IOS", "44", {
        id: mode === "duplicate" ? "same-record" : `record-${calls}`,
        next: nextPage(url, mode === "cycle" ? "same-cursor" : `cursor-${calls}`),
      });
    }), error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
    assert.equal(calls, mode === "bound" ? 20 : 2);
  }
});

test("refuses unorderable numbers, nonnumeric versions, mismatched platforms and missing relationships", async () => {
  const invalidPages = [
    buildPage("MAC_OS", "44"),
    buildPage("IOS", "44.1"),
    buildPage("IOS", "-1"),
    buildPage("IOS", "9007199254740992"),
    buildPage("IOS", "PRIVATE_SECRET"),
    { ...buildPage("IOS", "44"), included: [] },
    { ...buildPage("IOS", "44"), links: null },
  ];
  const badVersion = buildPage("IOS", "44");
  badVersion.included[0].attributes.version = "PRIVATE_SECRET";
  invalidPages.push(badVersion);
  for (const page of invalidPages) {
    await assert.rejects(readBuildNumbers("123", "token", async () => page), error => {
      assert.equal(error.message.includes("PRIVATE_SECRET"), false);
      return error.classification === CLASSIFICATION.INVALID_RESPONSE;
    });
  }
  for (const page of [uploadPage("MAC_OS", "44"), uploadPage("IOS", "invalid")]) {
    await assert.rejects(readBuildNumbers("123", "token", async url =>
      url.pathname === "/v1/builds" ? { data: [], links: {} } : page),
    error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
  }
});

test("number lookup is opt-in and restricted to the fixed Vogel Vault bundle before requests", async () => {
  let calls = 0;
  for (const env of [
    { ...validEnv, ASC_BUILD_NUMBER_LOOKUP: "yes" },
    { ...validEnv, ASC_BUILD_NUMBER_LOOKUP: "true", ASC_BUNDLE_ID: "com.other.app" },
  ]) {
    await assert.rejects(runPreflight({ env, request: async () => { calls += 1; } }),
      error => error.classification === CLASSIFICATION.INVALID_CONFIGURATION);
  }
  assert.equal(calls, 0);
  const result = await runPreflight({ env: { ...validEnv, ASC_BUILD_NUMBER_LOOKUP: "true" },
    request: async url => {
      calls += 1;
      if (url.pathname === "/v1/apps") return { data: [{ id: "123", attributes: { bundleId: validEnv.ASC_BUNDLE_ID } }] };
      return { data: [], links: {} };
    } });
  assert.equal(calls, 6);
  assert.deepEqual(result.buildNumbers, { inventory: [], highestObservedBuildNumber: null });
});
