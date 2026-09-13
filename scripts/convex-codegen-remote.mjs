#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localEnvironment, repoRoot } from "./convex-codegen.mjs";

const acknowledgement = "--acknowledge-remote-preparation";
const help = `Usage: npm run codegen:remote -- --target-url <https://deployment.convex.cloud> ${acknowledgement}
Requires Victor's separate approval for this revision and target before invocation.
The flag acknowledges effects; it does not grant or verify approval.
Convex 1.42.3 codegen sends authenticated start_push requests and may persist
pending schemas, tables, or index work. It does not call finish_push.
Requires an already approved injected CONVEX_SELF_HOSTED_URL/ADMIN_KEY pair.
No default target, local env files, deploy-key selection, or CLI passthrough.
CLI output is suppressed to keep credentials out of logs. See docs/convex-codegen-safety.md.`;

export function prepareRemote({
  args = process.argv.slice(2),
  env = process.env,
  root = repoRoot,
  io = fs,
  run = spawnSync,
  log = console.log,
} = {}) {
  if (args.length === 1 && args[0] === "--help") {
    log(help);
    return 0;
  }
  // Deliberately no passthrough, including --dry-run, --url and --admin-key.
  if (args.length !== 3 || args[0] !== "--target-url" || args[2] !== acknowledgement) {
    log("Remote preparation refused: explicit target and effect acknowledgement required. See codegen:remote -- --help.");
    return 1;
  }
  const target = args[1];
  if (!/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/.test(target)) {
    log("Remote preparation refused: target must be an exact Convex Cloud HTTPS origin.");
    return 1;
  }
  // Check variable names before touching values, including the deploy-key alias.
  // An unknown future CONVEX_* override must fail closed as well.
  const allowed = new Set(["CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"]);
  if (Object.keys(env).some((name) =>
    (name.startsWith("CONVEX_") && !allowed.has(name)) ||
    ["EXPECTED_CONVEX_URL", "ALLOW_CONVEX_TARGET_MISMATCH", "NODE_OPTIONS", "NODE_PATH"].includes(name))) {
    log("Remote preparation refused: ambiguous Convex or Node environment overrides are present. Values were not logged.");
    return 1;
  }
  if ([".env", ".env.local"].some((file) => io.existsSync(path.join(root, file)))) {
    log("Remote preparation refused: local env files could alter CLI selection. Their contents were not read.");
    return 1;
  }
  if (env.CONVEX_SELF_HOSTED_URL !== target || !env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim()) {
    log("Remote preparation refused: the approved injected direct URL/admin-key pair is absent or does not match the explicit target. Do not create or convert credentials to bypass this guard.");
    return 1;
  }
  try {
    const packageRoot = path.join(root, "node_modules/convex");
    const installed = JSON.parse(io.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (installed.version !== "1.42.3") {
      log("Remote preparation refused: only the inspected Convex 1.42.3 target-selection contract is supported.");
      return 1;
    }
    // Snapshot before starting. Never attest a schema edited during preparation.
    const schemaPath = path.join(root, "convex/schema.ts");
    const schemaBefore = io.readFileSync(schemaPath);
    log("Starting explicitly selected remote preparation. CLI output is suppressed; the target may acquire persistent preparation state.");
    const result = run(process.execPath, [path.join(packageRoot, "bin/main.js"), "codegen", "--typecheck", "disable"], {
      cwd: root,
      env: {
        ...localEnvironment(env),
        CI: "1", // Convex 1.42.3 disables Sentry initialization in CI.
        CONVEX_SELF_HOSTED_URL: target,
        CONVEX_SELF_HOSTED_ADMIN_KEY: env.CONVEX_SELF_HOSTED_ADMIN_KEY,
      },
      // Errors can echo credentials or server content. Never forward them.
      stdio: "ignore",
    });
    if (result.status !== 0) {
      log("Remote preparation failed. Remote effects may already have occurred; no schema attestation was written. Do not retry without assessing those effects under the approval gate.");
      return 1;
    }
    if (!schemaBefore.equals(io.readFileSync(schemaPath))) {
      log("Remote preparation completed but schema.ts changed during execution. No attestation was written.");
      return 1;
    }
    const digest = createHash("sha256").update(schemaBefore).digest("hex");
    io.writeFileSync(path.join(root, "convex/schema.sha256"), `${digest}  convex/schema.ts\n`);
    log("Remote preparation completed; schema checksum recorded. Run local TypeScript checks separately. This is no claim that the deployment was untouched.");
    return 0;
  } catch {
    log("Remote preparation could not complete. Details suppressed to protect credentials. If the CLI started, remote effects remain possible; do not retry automatically.");
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = prepareRemote();
}
