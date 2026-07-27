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
