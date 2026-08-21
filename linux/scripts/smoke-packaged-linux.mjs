#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const releaseDir = path.join(root, "release")
const require = createRequire(import.meta.url)
const asar = require("@electron/asar")

function fail(message) {
  throw new Error(`smoke-packaged: ${message}`)
}

function onPath(command) {
  return (process.env.PATH ?? "").split(":").filter(Boolean).some((directory) => existsSync(path.join(directory, command)))
}

async function filesUnder(directory) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await visit(directory)
  return files
}

if (process.platform !== "linux" || process.arch !== "x64") {
  fail(`the packaged smoke is pinned to Linux x86_64, not ${process.platform}/${process.arch}.`)
}
if (!onPath("xvfb-run")) fail("xvfb-run is required so the packaged window smoke cannot silently skip.")

let electronBinary
try {
  electronBinary = require("electron")
} catch {
  fail("Electron is not installed; run `npm ci` at the repository root.")
}
if (typeof electronBinary !== "string" || !existsSync(electronBinary)) fail("the Electron binary is missing.")

const appImages = existsSync(releaseDir)
  ? (await readdir(releaseDir)).filter((name) => name.endsWith(".AppImage")).sort()
  : []
if (appImages.length !== 1) fail(`expected one AppImage, found ${appImages.join(", ") || "none"}.`)

const temp = await mkdtemp(path.join(tmpdir(), "vv-packaged-smoke-"))
try {
  const appImage = path.join(releaseDir, appImages[0])
  await chmod(appImage, 0o755)
  const extracted = path.join(temp, "appimage")
  await mkdir(extracted)

  const extraction = await new Promise((resolve) => {
    const child = spawn(appImage, ["--appimage-extract"], { cwd: extracted, stdio: "inherit" })
    child.on("error", (error) => resolve({ code: -1, error }))
    child.on("exit", (code) => resolve({ code: code ?? -1 }))
  })
  if (extraction.code !== 0) fail(`AppImage extraction failed${extraction.error ? `: ${extraction.error.message}` : ""}.`)

  const asars = (await filesUnder(extracted)).filter((file) => file.endsWith(`${path.sep}resources${path.sep}app.asar`))
  if (asars.length !== 1) fail(`AppImage contained ${asars.length} app.asar files.`)

  const appRoot = path.join(temp, "app")
  await mkdir(appRoot)
  asar.extractAll(asars[0], appRoot)

  const profileDir = path.join(temp, "profile")
  const outDir = path.join(temp, "smoke")
  await mkdir(profileDir)
  await mkdir(outDir)
  const reportPath = path.join(outDir, "smoke-report.json")
  const harness = path.join(root, "scripts", "smoke-electron-app.mjs")
  // Keep Chromium's OS sandbox enabled: this smoke exists to exercise the
  // packaged preload in the same sandboxed renderer boundary users receive.
  const args = [
    "-a",
    "--server-args=-screen 0 1920x1200x24",
    electronBinary,
    harness,
    `--user-data-dir=${profileDir}`,
  ]
  const environment = {
    ...process.env,
    VV_SMOKE_APP_ROOT: appRoot,
    VV_SMOKE_DENY_NETWORK: "1",
    VV_SMOKE_REPORT: reportPath,
    VV_SMOKE_OUT_DIR: outDir,
    VV_SMOKE_BUDGET_MS: "60000",
    VOGEL_VAULT_REMOTE_READ: "0",
  }
  delete environment.VITE_DEV_SERVER_URL
  delete environment.VOGEL_VAULT_CONVEX_URL
  delete environment.VOGEL_VAULT_CONVEX_READ_TOKEN

  const child = spawn("xvfb-run", args, {
    cwd: appRoot,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  })
  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    console.error(`smoke-packaged: no result after 75 seconds — killing pid ${child.pid}.`)
    child.kill("SIGKILL")
  }, 75_000)
  const exitCode = await new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`smoke-packaged: could not launch xvfb-run: ${error.message}`)
      resolve(-1)
    })
    child.on("exit", (code) => resolve(code ?? -1))
  })
  clearTimeout(killTimer)
  if (timedOut) fail("packaged payload exceeded its 75-second smoke budget.")

  let report
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"))
  } catch {
    fail(`packaged payload exited ${exitCode} without a readable smoke report.`)
  }
  if (exitCode !== 0 || !report.passed) fail(`packaged payload failed ${report.failed ?? "unknown"} smoke checks.`)
  if (!Array.isArray(report.networkAttempts)) fail("smoke report did not include network-attempt evidence.")
  if (report.networkAttempts.length !== 0) {
    fail(`packaged payload attempted network access: ${report.networkAttempts.join(", ")}.`)
  }

  console.log(`smoke-packaged: PASS — ${report.total}/${report.total} checks passed from the extracted AppImage with network disabled.`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
