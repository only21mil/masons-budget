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
  readReleaseVerification,
  renderResult,
  renderFailure,
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

function releaseFixture(change = () => {}) {
  const calls = [];
  const request = async (url, token) => {
    assert.equal(token, "test-token");
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
    assert.ok(!url.href.includes("betaTesters"));
    calls.push(url);
    let document;
    if (url.pathname === "/v1/apps/123/betaGroups") {
      assert.equal(url.searchParams.get("fields[betaGroups]"), "isInternalGroup,hasAccessToAllBuilds");
      document = { data: [{ type: "betaGroups", id: "private-group", attributes: {
        isInternalGroup: true, hasAccessToAllBuilds: false,
      } }], links: { next: null } };
    } else if (url.pathname === "/v1/betaGroups/private-group/relationships/builds") {
      document = { data: ["IOS", "MAC_OS"].map(platform => ({ type: "builds", id: `build-${platform.replace("_", "-")}` })),
        links: { next: null } };
    } else if (url.pathname === "/v1/builds") {
      const platform = url.searchParams.get("filter[preReleaseVersion.platform]");
      assert.ok(["IOS", "MAC_OS"].includes(platform));
      assert.equal(url.searchParams.get("filter[app]"), "123");
      assert.equal(url.searchParams.get("filter[version]"), "45");
      assert.equal(url.searchParams.get("filter[preReleaseVersion.version]"), "0.5.0");
      document = { data: [{ type: "builds", id: `build-${platform.replace("_", "-")}`,
        attributes: { version: "45", processingState: "VALID", expired: false }, relationships: {
          app: { data: { type: "apps", id: "123" } },
          preReleaseVersion: { data: { type: "preReleaseVersions", id: `version-${platform.replace("_", "-")}` } },
        } }], included: [
        { type: "apps", id: "123", attributes: { bundleId: "com.sats21m.masonsbudget" } },
        { type: "preReleaseVersions", id: `version-${platform.replace("_", "-")}`, attributes: { platform, version: "0.5.0" } },
      ], links: { next: null } };
    } else if (/^\/v1\/builds\/build-(IOS|MAC-OS)\/buildBetaDetail$/u.test(url.pathname)) {
      assert.equal(url.searchParams.get("fields[buildBetaDetails]"), "internalBuildState,externalBuildState,build");
      assert.equal(url.searchParams.get("include"), "build");
      assert.equal(url.searchParams.get("fields[builds]"), "version");
      document = { data: { type: "buildBetaDetails", id: "private-detail", attributes: {
        internalBuildState: "IN_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION",
      }, relationships: { build: { data: { type: "builds", id: url.pathname.split("/")[3] } } } },
      included: [{ type: "builds", id: url.pathname.split("/")[3], attributes: { version: "45" } }] };
    } else assert.fail(`Unexpected endpoint ${url.pathname}`);
    change(document, url);
    return document;
  };
  return { request, calls };
}

test("release check verifies both exact builds and reports only fixed statuses/counts", async () => {
  const fixture = releaseFixture();
  const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
  assert.equal(result.classification, "AVAILABLE_TO_EXISTING_GROUPS");
  assert.deepEqual(result.platforms.map(item => item.platform), ["IOS", "MAC_OS"]);
  assert.ok(result.platforms.every(item => item.processingState === "VALID" && item.internalGroupCount === 1));
  const output = JSON.stringify(result);
  for (const hidden of ["123", "private-group", "private-detail", "build-IOS", "test-token"]) assert.ok(!output.includes(hidden));
});

test("exact build GET tolerates optional reverse linkage and included metadata without changing readiness", async () => {
  const relationships = [undefined, null, {}, { build: null }, { build: {} }, { build: { data: null } },
    { build: { links: { related: "PRIVATE_SENTINEL" } } }, "matching"];
  for (const relationship of relationships) {
    for (const included of [undefined, null, [], "matching", "no-attributes", "null-attributes", "no-version", "null-version"]) {
      for (const ready of [true, false]) {
        const fixture = releaseFixture((d, u) => {
          if (u.pathname.endsWith("/buildBetaDetail")) {
            if (relationship !== "matching") d.data.relationships = relationship;
            if (typeof included !== "string") d.included = included;
            else if (included === "no-attributes") delete d.included[0].attributes;
            else if (included === "null-attributes") d.included[0].attributes = null;
            else if (included === "no-version") delete d.included[0].attributes.version;
            else if (included === "null-version") d.included[0].attributes.version = null;
            if (!ready) d.data.attributes.internalBuildState = "READY_FOR_BETA_TESTING";
          }
        });
        const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
        assert.equal(result.classification, ready ? "AVAILABLE_TO_EXISTING_GROUPS" : "NOT_READY");
        assert.equal(fixture.calls.length, 6);
        assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
      }
    }
  }
});

test("unknown beta states never grant access and do not block the other matching audience", async () => {
  for (const internal of [true, false]) {
    const matching = internal ? "internalBuildState" : "externalBuildState";
    const other = internal ? "externalBuildState" : "internalBuildState";
    for (const state of [undefined, null, "", "PRIVATE_SENTINEL", "in_beta_testing", "IN_BETA_TESTING "]) {
      for (const unknownAudience of [matching, other]) {
        for (const linked of [true, false]) {
          const fixture = releaseFixture((d, u) => {
            if (u.pathname.endsWith("/betaGroups")) d.data[0].attributes.isInternalGroup = internal;
            if (!linked && u.pathname.endsWith("/relationships/builds")) d.data = [];
            if (u.pathname.endsWith("/buildBetaDetail")) {
              d.data.attributes[matching] = "IN_BETA_TESTING";
              d.data.attributes[other] = "IN_BETA_TESTING";
              d.data.attributes[unknownAudience] = state;
            }
          });
          const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
          const available = linked && unknownAudience === other;
          assert.equal(result.classification, available ? "AVAILABLE_TO_EXISTING_GROUPS" : "NOT_READY");
          assert.ok(result.platforms.every(p => p[unknownAudience] === "UNKNOWN" && p.available === available));
          assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
        }
      }
    }
  }
  for (const attributes of [undefined, null, {}]) {
    const fixture = releaseFixture((d, u) => {
      if (u.pathname.endsWith("/buildBetaDetail")) d.data.attributes = attributes;
    });
    const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
    assert.equal(result.classification, "NOT_READY");
    assert.ok(result.platforms.every(p => p.internalBuildState === "UNKNOWN" && p.externalBuildState === "UNKNOWN"));
  }
});

test("every documented beta state requires IN_BETA_TESTING for the audience with access", async () => {
  const internalStates = ["PROCESSING", "PROCESSING_EXCEPTION", "MISSING_EXPORT_COMPLIANCE",
    "READY_FOR_BETA_TESTING", "IN_BETA_TESTING", "EXPIRED", "IN_EXPORT_COMPLIANCE_REVIEW"];
  const externalStates = [...internalStates, "READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW",
    "IN_BETA_REVIEW", "BETA_REJECTED", "BETA_APPROVED", "NOT_APPLICABLE"];
  for (const internal of [true, false]) {
    for (const state of internal ? internalStates : externalStates) {
      const field = internal ? "internalBuildState" : "externalBuildState";
      const fixture = releaseFixture((d, u) => {
        if (u.pathname.endsWith("/betaGroups")) d.data[0].attributes.isInternalGroup = internal;
        if (u.pathname.endsWith("/buildBetaDetail")) {
          delete d.data.relationships;
          delete d.included;
          d.data.attributes = { [field]: state };
        }
      });
      const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
      assert.equal(result.classification, state === "IN_BETA_TESTING" ? "AVAILABLE_TO_EXISTING_GROUPS" : "NOT_READY");
      assert.ok(result.platforms.every(p => p[field] === state));
    }
  }
});

test("beta detail rejects contradictory identities and malformed supplied metadata with fixed diagnostics", async () => {
  const cases = [
    ["DETAIL_ID", d => { delete d.data.id; }],
    ["DETAIL_ID", d => { d.data.id = null; }],
    ["DETAIL_BUILD_RELATION_ID", d => { d.data.relationships.build.data.id = null; }],
    ["DETAIL_BUILD_RELATION_ID", d => { delete d.data.relationships.build.data.id; }],
    ["DETAIL_BUILD_RELATION_ID", d => { d.data.relationships.build.data.id = "another-build"; delete d.included; }],
    ["DETAIL_INCLUDED_BUILD_ID", d => { delete d.data.relationships; d.included[0].id = "another-build"; }],
    ["DETAIL_INCLUDED_BUILD_ID", d => { d.included[0].id = null; }],
    ["DETAIL_INCLUDED_BUILD_ID", d => { delete d.included[0].id; }],
    ["DETAIL_INCLUDED_BUILD_ID", d => { d.included[0].type = "betaTesters"; }],
    ["DETAIL_INCLUDED_BUILD_ID", d => { d.included = [null]; }],
    ["DETAIL_INCLUDED_BUILD_COUNT", d => { d.included.push({ ...d.included[0], id: "another-build" }); }],
    ["DETAIL_INCLUDED_BUILD_NUMBER", d => { delete d.data.relationships; d.included[0].attributes.version = "46"; }],
    ["DETAIL_INCLUDED_BUILD_NUMBER", d => { d.included[0].attributes.version = 45; }],
    ["DETAIL_INTERNAL_STATE", d => { d.data.attributes.internalBuildState = {}; }],
    ["DETAIL_EXTERNAL_STATE", d => { d.data.attributes.externalBuildState = {}; }],
  ];
  for (const malformed of [false, true, 0, 1, [], "PRIVATE_SENTINEL"]) {
    cases.push(
      ["DETAIL_BUILD_RELATION_TYPE", d => { d.data.relationships = malformed; }],
      ["DETAIL_BUILD_RELATION_TYPE", d => { d.data.relationships.build = malformed; }],
      ["DETAIL_BUILD_RELATION_TYPE", d => { d.data.relationships.build.data = malformed; }],
      ["DETAIL_ATTRIBUTES_OBJECT", d => { d.data.attributes = malformed; }],
      ["DETAIL_ATTRIBUTES_OBJECT", d => { d.included[0].attributes = malformed; }],
    );
    if (!Array.isArray(malformed)) cases.push(["DETAIL_INCLUDED_ARRAY", d => { d.included = malformed; }]);
    if (typeof malformed !== "string") {
      for (const [field, reason] of [["internalBuildState", "DETAIL_INTERNAL_STATE"], ["externalBuildState", "DETAIL_EXTERNAL_STATE"]]) {
        cases.push([reason, d => { d.data.attributes[field] = malformed; }]);
      }
    }
  }
  cases.push(["DETAIL_INCLUDED_ARRAY", d => { d.included = {}; }]);
  for (const [reason, change] of cases) {
    const fixture = releaseFixture((d, u) => { if (u.pathname.endsWith("/buildBetaDetail")) change(d); });
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
      e => assertDiagnostic(e, "BETA_DETAIL", reason, "IOS"));
  }
  for (const document of [null, [], {}, "PRIVATE_SENTINEL", { data: null }, { data: [] }]) {
    const fixture = releaseFixture();
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", u =>
      u.pathname.endsWith("/buildBetaDetail") ? document : fixture.request(u, "test-token")),
    e => assertDiagnostic(e, "BETA_DETAIL", "DETAIL_TYPE", "IOS"));
  }
});

test("processing, missing, expired, unlinked and ready-but-undistributed builds are not availability", async () => {
  const changes = [
    (d, u) => { if (u.pathname === "/v1/builds") d.data[0].attributes.processingState = "PROCESSING"; },
    (d, u) => { if (u.pathname === "/v1/builds" && u.searchParams.get("filter[preReleaseVersion.platform]") === "MAC_OS") d.data = []; },
    (d, u) => { if (u.pathname === "/v1/builds") d.data[0].attributes.expired = true; },
    (d, u) => { if (u.pathname.endsWith("/relationships/builds")) d.data = []; },
    (d, u) => { if (u.pathname.endsWith("/buildBetaDetail")) d.data.attributes.internalBuildState = "READY_FOR_BETA_TESTING"; },
  ];
  for (const change of changes) {
    const fixture = releaseFixture((d, u) => {
      change(d, u);
      if (u.pathname.endsWith("/buildBetaDetail")) {
        delete d.data.relationships;
        delete d.included;
      }
    });
    const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
    assert.equal(result.classification, "NOT_READY");
  }
});

test("existing external groups and internal all-build groups are counted according to their own beta state", async () => {
  for (const external of [true, false]) {
    const fixture = releaseFixture((d, u) => {
      if (u.pathname.endsWith("/betaGroups")) {
        d.data[0].attributes.isInternalGroup = !external;
        d.data[0].attributes.hasAccessToAllBuilds = !external;
      }
      if (!external && u.pathname.endsWith("/relationships/builds")) d.data = [];
      if (external && u.pathname.endsWith("/buildBetaDetail")) {
        d.data.attributes.internalBuildState = "READY_FOR_BETA_TESTING";
        d.data.attributes.externalBuildState = "IN_BETA_TESTING";
      }
    });
    const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
    assert.equal(result.classification, "AVAILABLE_TO_EXISTING_GROUPS");
    assert.ok(result.platforms.every(item => item[external ? "externalGroupCount" : "internalGroupCount"] === 1));
  }
});

test("omitted or null all-build flags require exact build links and the matching beta state", async () => {
  for (const isInternalGroup of [true, false]) {
    for (const flag of [undefined, null]) {
      for (const linked of [true, false]) {
        for (const inBetaTesting of [true, false]) {
          const fixture = releaseFixture((d, u) => {
            if (u.pathname.endsWith("/betaGroups")) {
              d.data[0].attributes.isInternalGroup = isInternalGroup;
              if (flag === undefined) delete d.data[0].attributes.hasAccessToAllBuilds;
              else d.data[0].attributes.hasAccessToAllBuilds = flag;
            }
            if (u.pathname.endsWith("/relationships/builds")) {
              // Another build ID must never establish access to this release.
              if (!linked) d.data = [{ type: "builds", id: "another-build" }];
            }
            if (u.pathname.endsWith("/buildBetaDetail")) {
              d.data.attributes.internalBuildState = isInternalGroup && inBetaTesting ?
                "IN_BETA_TESTING" : "READY_FOR_BETA_TESTING";
              d.data.attributes.externalBuildState = !isInternalGroup && inBetaTesting ?
                "IN_BETA_TESTING" : "READY_FOR_BETA_SUBMISSION";
            }
          });
          const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
          const available = linked && inBetaTesting;
          assert.equal(result.classification, available ? "AVAILABLE_TO_EXISTING_GROUPS" : "NOT_READY");
          assert.equal(fixture.calls.filter(u => u.pathname.endsWith("/relationships/builds")).length, 1);
          for (const platform of result.platforms) {
            assert.equal(platform.internalGroupCount, Number(isInternalGroup && linked));
            assert.equal(platform.externalGroupCount, Number(!isInternalGroup && linked));
            assert.equal(platform.available, available);
          }
        }
      }
    }
  }
});

test("malformed all-build flags fail before relationship reads even when builds would be linked", async () => {
  for (const isInternalGroup of [true, false]) {
    for (const flag of ["true", "false", "", 0, 1, [], {}, [true]]) {
      const fixture = releaseFixture((d, u) => {
        if (u.pathname.endsWith("/betaGroups")) {
          d.data[0].attributes.isInternalGroup = isInternalGroup;
          d.data[0].attributes.hasAccessToAllBuilds = flag;
        }
      });
      await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
        e => assertDiagnostic(e, "GROUPS", "GROUP_ALL_BUILDS_BOOLEAN"));
      assert.equal(fixture.calls.length, 1);
    }
  }
});

test("external all-build flag never grants access without an exact build link", async () => {
  const fixture = releaseFixture((d, u) => {
    if (u.pathname.endsWith("/betaGroups")) {
      d.data[0].attributes.isInternalGroup = false;
      d.data[0].attributes.hasAccessToAllBuilds = true;
    }
    if (u.pathname.endsWith("/relationships/builds")) d.data = [];
    if (u.pathname.endsWith("/buildBetaDetail")) d.data.attributes.externalBuildState = "IN_BETA_TESTING";
  });
  const result = await readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request);
  assert.equal(result.classification, "NOT_READY");
  assert.ok(result.platforms.every(item => item.externalGroupCount === 0 && !item.available));
});

test("release check rejects mismatched identity, ambiguous build and unrecognized status", async () => {
  for (const change of [
    d => { d.data[0].attributes.version = "46"; },
    d => { d.included[1].attributes.platform = "TV_OS"; },
    d => { d.included[1].attributes.version = "0.4.0"; },
    d => { d.included[0].attributes.bundleId = "com.sats21m.buzz"; },
    d => { d.data[0].relationships.app.data.id = "999"; },
    d => { d.data.push({ ...d.data[0], id: "second-build" }); },
    d => { d.data[0].attributes.processingState = "private-response"; },
  ]) {
    const fixture = releaseFixture((d, u) => { if (u.pathname === "/v1/builds") change(d); });
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
      error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
  }
  for (const change of [
    d => { d.data.relationships.build.data.id = "wrong-build"; },
    d => { d.included[0].id = "wrong-build"; },
    d => { d.included[0].attributes.version = "46"; },
    d => { d.included.push(d.included[0]); },
  ]) {
    const fixture = releaseFixture((d, u) => { if (u.pathname.endsWith("/buildBetaDetail")) change(d); });
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
      error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
  }
});

test("release pagination preserves endpoint and exact filters without forwarding credentials", async () => {
  for (const endpoint of ["/v1/apps/123/betaGroups", "/v1/betaGroups/private-group/relationships/builds", "/v1/builds"]) {
    for (const change of [
      (d) => { d.links = []; },
      (d, u) => { d.links.next = [u.href]; },
      (d) => { d.links.next = "https://evil.example/v1/builds?cursor=next"; },
      (d, u) => { const next = new URL(u); next.searchParams.set("cursor", "next"); next.searchParams.set("filter[app]", "999"); d.links.next = next.href; },
      (d, u) => { const next = new URL(u); next.pathname = "/v1/betaTesters"; next.searchParams.set("cursor", "next"); d.links.next = next.href; },
    ]) {
      const fixture = releaseFixture((d, u) => { if (u.pathname === endpoint) change(d, u); });
      await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
        error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
      assert.equal(fixture.calls.filter(u => u.pathname === endpoint).length, 1);
    }
  }
});

test("release preflight opt-in requires paired numeric inputs, fixed bundle and source/run binding before requests", async () => {
  const options = { ASC_RELEASE_VERSION: "0.5.0", ASC_RELEASE_BUILD: "45", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "456" };
  for (const override of [
    { ASC_RELEASE_BUILD: "" }, { ASC_RELEASE_VERSION: "" }, { ASC_RELEASE_BUILD: "45\nprivate" },
    { ASC_BUNDLE_ID: "com.sats21m.buzz" }, { GITHUB_SHA: "" }, { GITHUB_RUN_ID: "private" },
  ]) {
    await assert.rejects(runPreflight({ env: { ...validEnv, ...options, ...override },
      request: async () => assert.fail("invalid configuration must not make requests") }),
    error => error.classification === CLASSIFICATION.INVALID_CONFIGURATION);
  }
});

test("release preflight binds the sanitized observation to its workflow and fails readiness for a missing Mac build", async () => {
  for (const missingMac of [false, true]) {
    const fixture = releaseFixture((d, u) => {
      if (missingMac && u.pathname === "/v1/builds" &&
          u.searchParams.get("filter[preReleaseVersion.platform]") === "MAC_OS") d.data = [];
    });
    const result = await runPreflight({ env: { ...validEnv,
      ASC_RELEASE_VERSION: "0.5.0", ASC_RELEASE_BUILD: "45", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "456",
    }, request: async (url) => {
      if (url.pathname === "/v1/apps") return { data: [{ type: "apps", id: "123", attributes: { bundleId: validEnv.ASC_BUNDLE_ID } }] };
      if (url.pathname === "/v1/builds" && url.searchParams.has("sort")) return { data: [] };
      return fixture.request(url, "test-token");
    } });
    assert.equal(result.preflight, missingMac ? "FAIL" : "PASS");
    assert.equal(result.releaseVerification.workflowSha, "a".repeat(40));
    assert.equal(result.releaseVerification.runId, "456");
    assert.ok(!renderResult(result).includes("private-group"));
  }
});

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
    if (request.url === "/invalid-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("PRIVATE_SENTINEL secret@example.test");
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

test("rejects malformed links containers and array next URLs without treating inventory as complete", async () => {
  for (const endpoint of ["builds", "buildUploads"]) {
    for (const shape of ["empty-array", "array-with-next", "array-next-url"]) {
      let calls = 0;
      await assert.rejects(readBuildNumbers("123", "token", async url => {
        calls += 1;
        if (endpoint === "buildUploads" && url.pathname === "/v1/builds") {
          return { data: [], links: {} };
        }
        const next = nextPage(url);
        const links = shape === "empty-array" ? [] :
          shape === "array-with-next" ? [{ next }] : { next: [next] };
        return { data: [], links };
      }), error => error.classification === CLASSIFICATION.INVALID_RESPONSE);
      assert.equal(calls, endpoint === "builds" ? 1 : 2);
    }
  }
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


function assertDiagnostic(error, stage, reason, platform) {
  assert.equal(error.classification, CLASSIFICATION.INVALID_RESPONSE);
  const expected = { stage, reason, ...(platform ? { platform } : {}) };
  assert.deepEqual(error.releaseDiagnostic, expected);
  const report = renderFailure(error);
  assert.ok(report.includes(`RELEASE_DIAGNOSTIC=${JSON.stringify(expected)}`));
  for (const hidden of ["PRIVATE_SENTINEL", "private-group", "private-detail", "build-IOS",
    "test-token", "secret@example.test", "https://", privatePem, validEnv.ASC_KEY_ID, validEnv.ASC_ISSUER_ID]) {
    assert.equal(report.includes(hidden), false, `Leaked ${hidden === privatePem ? "fixture key" : hidden}`);
  }
  return true;
}

test("release diagnostics identify individual group, build and beta-detail predicates without response values", async () => {
  const cases = [
    ["GROUPS", "GROUP_INTERNAL_BOOLEAN", d => { d.data[0].attributes.isInternalGroup = "PRIVATE_SENTINEL"; }],
    ["GROUPS", "GROUP_ALL_BUILDS_BOOLEAN", d => { d.data[0].attributes.hasAccessToAllBuilds = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "BUILD_COUNT", d => { d.data.push({ ...d.data[0], id: "another-build" }); }],
    ["BUILDS", "PRERELEASE_RELATION_TYPE", d => { d.data[0].relationships.preReleaseVersion.data.type = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "PRERELEASE_RELATION_ID", d => { d.data[0].relationships.preReleaseVersion.data.id = "secret@example.test"; }],
    ["BUILDS", "APP_RELATION_TYPE", d => { delete d.data[0].relationships.app; }],
    ["BUILDS", "APP_RELATION_ID", d => { d.data[0].relationships.app.data.id = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "INCLUDED_ARRAY", d => { d.included = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "PRERELEASE_INCLUDED_COUNT", d => { d.included.pop(); }],
    ["BUILDS", "PRERELEASE_VERSION", d => { d.included[1].attributes.version = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "PRERELEASE_PLATFORM", d => { d.included[1].attributes.platform = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "APP_INCLUDED_COUNT", d => { d.included.shift(); }],
    ["BUILDS", "APP_BUNDLE", d => { d.included[0].attributes.bundleId = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "BUILD_NUMBER", d => { d.data[0].attributes.version = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "BUILD_PROCESSING_STATE", d => { d.data[0].attributes.processingState = "PRIVATE_SENTINEL"; }],
    ["BUILDS", "BUILD_EXPIRED_BOOLEAN", d => { d.data[0].attributes.expired = "PRIVATE_SENTINEL"; }],
    ["BETA_DETAIL", "DETAIL_TYPE", d => { d.data.type = "PRIVATE_SENTINEL"; }],
    ["BETA_DETAIL", "DETAIL_ID", d => { d.data.id = "secret@example.test"; }],
    ["BETA_DETAIL", "DETAIL_BUILD_RELATION_TYPE", d => { d.data.relationships.build.data.type = "PRIVATE_SENTINEL"; }],
    ["BETA_DETAIL", "DETAIL_BUILD_RELATION_ID", d => { d.data.relationships.build.data.id = "PRIVATE_SENTINEL"; }],
    ["BETA_DETAIL", "DETAIL_INCLUDED_BUILD_COUNT", d => { d.included.push(d.included[0]); }],
    ["BETA_DETAIL", "DETAIL_INCLUDED_BUILD_NUMBER", d => { d.included[0].attributes.version = "PRIVATE_SENTINEL"; }],
    ["BETA_DETAIL", "DETAIL_INTERNAL_STATE", d => { d.data.attributes.internalBuildState = { PRIVATE_SENTINEL: true }; }],
    ["BETA_DETAIL", "DETAIL_EXTERNAL_STATE", d => { d.data.attributes.externalBuildState = { PRIVATE_SENTINEL: true }; }],
  ];
  for (const [stage, reason, change] of cases) {
    const fixture = releaseFixture((d, u) => {
      const selected = stage === "GROUPS" ? u.pathname.endsWith("/betaGroups") :
        stage === "BUILDS" ? u.pathname === "/v1/builds" : u.pathname.endsWith("/buildBetaDetail");
      if (selected) {
        d.PRIVATE_SENTINEL = { name: "secret@example.test", token: "test-token" };
        change(d);
      }
    });
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
      e => assertDiagnostic(e, stage, reason, stage === "GROUPS" ? undefined : "IOS"));
  }
});

test("release page diagnostics bind list failures to the group, relationship or selected platform stage", async () => {
  for (const [stage, endpoint, platform] of [
    ["GROUPS", "/v1/apps/123/betaGroups", undefined],
    ["GROUP_BUILDS", "/v1/betaGroups/private-group/relationships/builds", undefined],
    ["BUILDS", "/v1/builds", "MAC_OS"],
  ]) {
    for (const [reason, change] of [
      ["DATA_ARRAY", d => { d.data = "PRIVATE_SENTINEL"; }],
      ["PAGE_RECORD_LIMIT", d => { d.data = Array(201).fill(d.data[0]); }],
      ["LINKS_OBJECT", d => { d.links = "PRIVATE_SENTINEL"; }],
      ["LINKS_ARRAY", d => { d.links = []; }],
      ["RECORD_TYPE", d => { d.data[0].type = "PRIVATE_SENTINEL"; }],
      ["RECORD_ID", d => { d.data[0].id = "secret@example.test"; }],
      ["RECORD_DUPLICATE", d => { d.data.push(d.data[0]); }],
      ["NEXT_TYPE", d => { d.links.next = ["PRIVATE_SENTINEL"]; }],
      ["NEXT_URL", d => { d.links.next = "PRIVATE_SENTINEL"; }],
    ]) {
      const fixture = releaseFixture((d, u) => {
        if (u.pathname === endpoint && (!platform || u.searchParams.get("filter[preReleaseVersion.platform]") === platform)) change(d);
      });
      await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
        e => assertDiagnostic(e, stage, reason, platform));
    }
  }
});

test("release pagination reports the exact rejected URL guard before any follow-up request", async () => {
  const cases = [
    ["NEXT_ORIGIN", u => { u.hostname = "secret.example.test"; }],
    ["NEXT_PATH", u => { u.pathname = "/PRIVATE_SENTINEL"; }],
    ["NEXT_USERNAME", u => { u.username = "PRIVATE_SENTINEL"; }],
    ["NEXT_PASSWORD", u => { u.password = "PRIVATE_SENTINEL"; }],
    ["NEXT_HASH", u => { u.hash = "PRIVATE_SENTINEL"; }],
    ["NEXT_QUERY_COUNT", u => { u.searchParams.append("limit", "PRIVATE_SENTINEL"); }],
    ["NEXT_QUERY_VALUE", u => { u.searchParams.set("limit", "PRIVATE_SENTINEL"); }],
    ["NEXT_QUERY_EXTRA", u => { u.searchParams.set("PRIVATE_SENTINEL", "secret@example.test"); }],
    ["NEXT_CURSOR_COUNT", u => { u.searchParams.delete("cursor"); }],
    ["NEXT_CURSOR_EMPTY", u => { u.searchParams.set("cursor", ""); }],
    ["NEXT_URL_LENGTH", u => { u.searchParams.set("cursor", "PRIVATE_SENTINEL".repeat(1000)); }],
  ];
  for (const [reason, mutate] of cases) {
    const fixture = releaseFixture((d, u) => {
      const next = new URL(nextPage(u));
      mutate(next);
      d.links.next = next.href;
    });
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", fixture.request),
      e => assertDiagnostic(e, "GROUPS", reason));
    assert.equal(fixture.calls.length, 1);
  }
  for (const [mode, reason, expectedCalls] of [["cycle", "PAGE_REPEAT", 2], ["bound", "PAGE_LIMIT", 20]]) {
    let calls = 0;
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", async u => {
      calls += 1;
      return { data: [], links: { next: nextPage(u, mode === "cycle" ? "same" : `cursor-${calls}`) } };
    }), e => assertDiagnostic(e, "GROUPS", reason));
    assert.equal(calls, expectedCalls);
  }
  await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", async () => ({
    data: Array.from({ length: 51 }, (_, i) => ({ type: "betaGroups", id: `group-${i}` })), links: {},
  })), e => assertDiagnostic(e, "GROUPS", "GROUP_LIMIT"));
});

test("only release opt-in failures expose fixed app and latest-build stage diagnostics", async () => {
  for (const verifyRelease of [false, true]) {
    for (const [stage, reason, page] of [
      ["APP_LOOKUP", "DOCUMENT_OBJECT", null],
      ["APP_LOOKUP", "DATA_ARRAY", { data: "PRIVATE_SENTINEL" }],
      ["LATEST_BUILD", "LATEST_BUILD_COUNT", { data: [{}, {}] }],
      ["LATEST_BUILD", "LATEST_DATE_INVALID", { data: [{ id: "PRIVATE_SENTINEL", attributes: {
        version: "45", uploadedDate: "secret@example.test",
      } }] }],
    ]) {
      const env = { ...validEnv, ...(verifyRelease ? { ASC_RELEASE_VERSION: "0.5.0", ASC_RELEASE_BUILD: "45",
        GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "456" } : {}) };
      await assert.rejects(runPreflight({ env, request: async u => {
        if (u.pathname === "/v1/apps" && stage !== "APP_LOOKUP") {
          return { data: [{ id: "123", attributes: { bundleId: validEnv.ASC_BUNDLE_ID } }] };
        }
        return page;
      } }), e => {
        if (verifyRelease) return assertDiagnostic(e, stage, reason);
        assert.equal(e.releaseDiagnostic, undefined);
        assert.equal(renderFailure(e).includes("RELEASE_DIAGNOSTIC="), false);
        return true;
      });
    }
  }
});

test("request and unexpected errors retain only classification and a fixed release stage", async () => {
  for (const thrown of [new Error("PRIVATE_SENTINEL secret@example.test"),
    new PreflightError(CLASSIFICATION.AUTHORIZATION_REJECTED)]) {
    thrown.reason = "PRIVATE_SENTINEL";
    thrown.response = { private: "secret@example.test" };
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", async () => { throw thrown; }), e => {
      assert.equal(e.classification, thrown instanceof PreflightError ? CLASSIFICATION.AUTHORIZATION_REJECTED : CLASSIFICATION.INTERNAL_ERROR);
      assert.deepEqual(e.releaseDiagnostic, { stage: "GROUPS", reason:
        thrown instanceof PreflightError ? "REQUEST_FAILED" : "UNEXPECTED_EXCEPTION" });
      assert.equal(renderFailure(e).includes("PRIVATE_SENTINEL"), false);
      assert.equal(renderFailure(e).includes("secret@example.test"), false);
      assert.equal(e.response, undefined);
      return true;
    });
  }
  for (const document of [null, "PRIVATE_SENTINEL"]) {
    await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", async () => document),
      e => assertDiagnostic(e, "GROUPS", "DOCUMENT_OBJECT"));
  }
});

test("failure output allowlists diagnostic fields and classification even for forged error properties", () => {
  for (const diagnostic of [
    { stage: "PRIVATE_SENTINEL", reason: "LINKS_OBJECT" },
    { stage: "GROUPS", reason: "PRIVATE_SENTINEL" },
    { stage: "GROUPS", reason: "LINKS_OBJECT", platform: "PRIVATE_SENTINEL", name: "secret@example.test" },
  ]) {
    const e = new PreflightError("PRIVATE_SENTINEL");
    e.releaseDiagnostic = diagnostic;
    const output = renderFailure(e);
    assert.ok(output.includes("CLASSIFICATION=INTERNAL_ERROR"));
    assert.equal(output.includes("PRIVATE_SENTINEL"), false);
    assert.equal(output.includes("secret@example.test"), false);
  }
});

test("malformed JSON receives a fixed parse reason without retaining the body or changing default output", async () => {
  const request = async () => requestJson(new URL("/invalid-json", origin), "test-token", {
    transport: http, maxAttempts: 1, timeoutMs: 1_000,
  });
  await assert.rejects(readReleaseVerification("123", "0.5.0", "45", "test-token", request),
    e => assertDiagnostic(e, "GROUPS", "JSON_PARSE"));
  await assert.rejects(request(), e => {
    assert.equal(e.classification, CLASSIFICATION.INVALID_RESPONSE);
    assert.equal(e.releaseDiagnostic, undefined);
    assert.equal(renderFailure(e).includes("RELEASE_DIAGNOSTIC="), false);
    assert.equal(renderFailure(e).includes("PRIVATE_SENTINEL"), false);
    return true;
  });
});
