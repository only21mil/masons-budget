import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(repoRoot, "scripts/mint-mobile-pairing-slots.mjs");

test("dry-run validates inputs without a token, request, or file write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vv-mobile-pair-dry-"));
  const output = path.join(directory, "pairing-urls.json");
  const b64Output = path.join(directory, "pairing-urls.b64");
  const manifestOutput = path.join(directory, "pairing-urls-slots.json");

  try {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--dry-run",
        "--build",
        "999",
        "--count",
        "2",
        "--days",
        "1",
        "--profile",
        "victor",
        "--out",
        output,
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          CONVEX_SYNC_TOKEN: "",
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(
      result.stdout,
      /no Convex mutation will be sent and no files will be written/,
    );
    assert.match(result.stdout, /build=999/);
    assert.match(result.stdout, /count=2/);
    assert.match(result.stdout, /days=1/);
    assert.match(result.stdout, /profile=victor/);
    await assert.rejects(access(output), /ENOENT/);
    await assert.rejects(access(b64Output), /ENOENT/);
    await assert.rejects(access(manifestOutput), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the archive-embedding b64 payload is no longer produced (L-10)", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(script, "utf8"),
  );
  assert.ok(
    !/writeFileSync\([^)]*\.b64/.test(source),
    "mint script must not write a base64 claim-secret payload",
  );
  assert.ok(
    !/MC2_BUNDLED_PAIRING_URLS_B64\s*=/.test(source),
    "mint script must not instruct feeding distributable archive manifests",
  );
  assert.match(source, /redacted slot manifest/);
});

test("refuses unapproved origins and redirects before writing any credential", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vv-mobile-pair-origin-"));
  const outputDir = path.join(directory, "out");
  const syncToken = "synthetic-sync-token-for-origin-test";

  // Every child fetch is routed to this local server, which redirects the
  // credential-bearing POST. No request may leave the machine.
  const requestedPaths = [];
  const server = http.createServer((request, response) => {
    request.resume();
    requestedPaths.push(request.url);
    if (request.url === "/api/mutation") {
      response.writeHead(307, { Location: "/redirected" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "success", value: null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const preload = path.join(directory, "route-fetch.mjs");
  await writeFile(
    preload,
    "const realFetch = globalThis.fetch;\n" +
      "globalThis.fetch = (_url, init) => realFetch(process.env.VV_TEST_ROUTE, init);\n",
  );

  async function mint(convexUrl) {
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      CONVEX_SYNC_TOKEN: syncToken,
      VV_TEST_ROUTE: `http://127.0.0.1:${server.address().port}/api/mutation`,
      ...(convexUrl === undefined ? {} : { CONVEX_URL: convexUrl }),
    };
    const child = spawn(
      process.execPath,
      [
        "--import",
        preload,
        script,
        "--build",
        "999",
        "--count",
        "1",
        "--profile",
        "victor",
        "--out",
        path.join(outputDir, "pairing-urls.json"),
      ],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [status] = await once(child, "close");
    return { status, output };
  }

  try {
    for (const convexUrl of [
      "http://framework-desktop.tail69757d.ts.net",
      "https://example.invalid",
      "https://user:pass@framework-desktop.tail69757d.ts.net",
      "https://framework-desktop.tail69757d.ts.net/path",
    ]) {
      const result = await mint(convexUrl);
      assert.equal(result.status, 2, convexUrl);
      assert.match(result.output, /CONVEX_URL must be exactly/);
      assert.doesNotMatch(result.output, new RegExp(syncToken));
    }
    assert.deepEqual(requestedPaths, []);

    const redirected = await mint(undefined);
    assert.notEqual(redirected.status, 0);
    assert.deepEqual(requestedPaths, ["/api/mutation"]);
    await assert.rejects(readdir(outputDir), /ENOENT/);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
