import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(repoRoot, "scripts/mint-mobile-pairing-slots.mjs");

test("dry-run validates inputs without a token, request, or file write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vv-mobile-pair-dry-"));
  const output = path.join(directory, "pairing-urls.json");
  const b64Output = path.join(directory, "pairing-urls.b64");

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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
