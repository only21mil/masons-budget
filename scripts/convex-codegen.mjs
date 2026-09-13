#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function localEnvironment(env) {
  // No credential, shell startup, Node preload, or Convex override inheritance.
  return { PATH: env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" };
}

export function checkGenerated({
  args = process.argv.slice(2),
  env = process.env,
  root = repoRoot,
  run = spawnSync,
  log = console.log,
} = {}) {
  if (args.length === 1 && args[0] === "--help") {
    log("Usage: npm run codegen\nChecks committed schema checksum and API module inventory locally. Does not generate bindings or contact Convex.\nRemote preparation requires separate Victor approval; see docs/convex-codegen-safety.md.");
    return 0;
  }
  if (args.length !== 0) {
    log("Local codegen checks accept no options. See npm run codegen -- --help.");
    return 1;
  }
  log("Checking local generated-file drift only. This does not prove generated declarations are fresh.");
  const result = run("/bin/bash", [path.join(root, "scripts/check-convex-generated-change.sh"), "HEAD"], {
    cwd: root,
    env: localEnvironment(env),
    stdio: "inherit",
  });
  return result.status === 0 ? 0 : 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = checkGenerated();
}
