#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const releaseDir = path.join(root, "release")
const repoRoot = path.dirname(root)

function fail(message) {
  console.error(`package-linux: ${message}`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    stdio: "inherit",
  })
  if (result.error) fail(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} exited ${result.status ?? "without a status"}`)
}

if (process.platform !== "linux") fail(`Linux packages must be built on Linux, not ${process.platform}.`)
if (process.arch !== "x64") fail(`This package path is pinned to x86_64; current architecture is ${process.arch}.`)

const builderCli = path.join(repoRoot, "node_modules", "electron-builder", "cli.js")
if (!existsSync(builderCli)) fail("electron-builder is not installed; run `npm ci` at the repository root.")

await rm(releaseDir, { recursive: true, force: true })
run("npm", ["run", "build:release"])
run(process.execPath, [builderCli, "--linux", "deb", "AppImage", "--x64", "--publish", "never"])

const artifacts = (await readdir(releaseDir))
  .filter((name) => name.endsWith(".deb") || name.endsWith(".AppImage"))
  .sort()

const debs = artifacts.filter((name) => name.endsWith(".deb"))
const appImages = artifacts.filter((name) => name.endsWith(".AppImage"))
if (debs.length !== 1 || appImages.length !== 1) {
  fail(`expected one x86_64 .deb and one x86_64 AppImage, found ${artifacts.join(", ") || "none"}.`)
}
if (artifacts.some((name) => !name.includes("x86_64"))) {
  fail(`artifact names must identify x86_64 explicitly: ${artifacts.join(", ")}.`)
}

const checksumLines = []
for (const name of artifacts) {
  const bytes = await readFile(path.join(releaseDir, name))
  checksumLines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`)
}
await writeFile(path.join(releaseDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, { mode: 0o644 })

run(process.execPath, [path.join(root, "scripts", "package-verify-linux.mjs")])
console.log(`package-linux: wrote ${artifacts.join(", ")} and SHA256SUMS`)
