import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("writes two distinct new private outputs and never replaces existing ones", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vv-mobile-pair-out-"));

  // Every child fetch is routed to this local server; no request leaves the machine.
  let requests = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests += 1;
      const { args } = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "success", value: { pairId: args.pairId } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const preload = path.join(directory, "route-fetch.mjs");
  await writeFile(
    preload,
    "const realFetch = globalThis.fetch;\n" +
      "globalThis.fetch = (_url, init) => realFetch(process.env.VV_TEST_ROUTE, init);\n",
  );

  async function mint(out) {
    const child = spawn(
      process.execPath,
      ["--import", preload, script, "--build", "999", "--count", "1", "--profile", "victor", "--out", out],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          CONVEX_SYNC_TOKEN: "synthetic-sync-token-for-output-test",
          VV_TEST_ROUTE: `http://127.0.0.1:${server.address().port}/api/mutation`,
        },
        stdio: "ignore",
      },
    );
    const [status] = await once(child, "close");
    return status;
  }

  try {
    for (const name of ["pairing-urls", "pairing-urls.JSON"]) {
      assert.equal(await mint(path.join(directory, "suffix", name)), 2, name);
    }
    await assert.rejects(readdir(path.join(directory, "suffix")), /ENOENT/);

    const existingOut = path.join(directory, "existing-out.json");
    await writeFile(existingOut, "prior\n", { mode: 0o644 });
    const existingManifestOut = path.join(directory, "existing-manifest.json");
    await writeFile(path.join(directory, "existing-manifest-slots.json"), "prior\n", { mode: 0o644 });
    const linkedOut = path.join(directory, "linked-out.json");
    await symlink(existingOut, linkedOut);
    const danglingOut = path.join(directory, "dangling-out.json");
    await symlink(path.join(directory, "missing-target.json"), danglingOut);
    for (const out of [existingOut, existingManifestOut, linkedOut, danglingOut]) {
      assert.equal(await mint(out), 2, path.basename(out));
    }
    assert.equal(await readFile(existingOut, "utf8"), "prior\n");
    assert.equal((await stat(existingOut)).mode & 0o777, 0o644);
    await assert.rejects(access(existingManifestOut), /ENOENT/);
    assert.equal(requests, 0);

    const out = path.join(directory, "fresh", "pairing-urls.json");
    assert.equal(await mint(out), 0);
    const manifest = path.join(directory, "fresh", "pairing-urls-slots.json");
    assert.equal(JSON.parse(await readFile(out, "utf8")).length, 1);
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).slots.length, 1);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.equal((await stat(manifest)).mode & 0o777, 0o600);
    assert.equal(requests, 1);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
