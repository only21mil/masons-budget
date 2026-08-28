#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const releaseDir = path.join(root, "release")
const require = createRequire(import.meta.url)
const asar = require("@electron/asar")

function fail(message) {
  throw new Error(`package-verify: ${message}`)
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

async function exactlyOneArtifact(extension) {
  if (!existsSync(releaseDir)) fail("linux/release does not exist; run `npm run package:linux` first.")
  const matches = (await readdir(releaseDir)).filter((name) => name.endsWith(extension)).sort()
  if (matches.length !== 1) fail(`expected one ${extension} artifact, found ${matches.join(", ") || "none"}.`)
  if (!matches[0].includes("x86_64")) fail(`${matches[0]} does not identify the x86_64 architecture.`)
  return path.join(releaseDir, matches[0])
}

function validateAsar(archive, label) {
  const entries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/"))
  const required = ["/package.json", "/dist/index.html", "/dist-electron/main.js", "/dist-electron/preload.cjs"]
  for (const expected of required) {
    if (!entries.includes(expected)) fail(`${label} app.asar is missing ${expected}.`)
  }

  const forbidden = entries.filter(
    (entry) => entry.endsWith(".map") || entry.includes("screenshots.html") || entry.includes("/screenshots/"),
  )
  if (forbidden.length > 0) fail(`${label} app.asar includes release-forbidden files: ${forbidden.join(", ")}.`)

  const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"))
  if (packaged.main !== "dist-electron/main.js") fail(`${label} package main is ${JSON.stringify(packaged.main)}.`)
  if (packaged.desktopName !== "vogel-vault") {
    fail(`${label} package desktopName is ${JSON.stringify(packaged.desktopName)}.`)
  }
  if (packaged.author?.name !== "Victor Vogel") fail(`${label} package author is not Victor Vogel.`)
  if (packaged.homepage !== "https://github.com/only21mil/masons-budget") {
    fail(`${label} package homepage is ${JSON.stringify(packaged.homepage)}.`)
  }
  if (!String(packaged.description).includes("private family Bitcoin and budget dashboard")) {
    fail(`${label} package description is missing the product identity.`)
  }
}

const temp = await mkdtemp(path.join(tmpdir(), "vv-package-verify-"))
try {
  const appImage = await exactlyOneArtifact(".AppImage")

  await chmod(appImage, 0o755)
  const appImageRoot = path.join(temp, "appimage")
  await mkdir(appImageRoot)
  execFileSync(appImage, ["--appimage-extract"], { cwd: appImageRoot, stdio: "inherit" })
  const appImageAsars = (await filesUnder(appImageRoot)).filter((file) =>
    file.endsWith(`${path.sep}resources${path.sep}app.asar`),
  )
  if (appImageAsars.length !== 1) fail(`AppImage extraction contained ${appImageAsars.length} app.asar files.`)

  validateAsar(appImageAsars[0], "AppImage")

  const checksumPath = path.join(releaseDir, "SHA256SUMS")
  if (!existsSync(checksumPath)) fail("SHA256SUMS is missing.")
  execFileSync("sha256sum", ["--check", "--strict", checksumPath], { cwd: releaseDir, stdio: "inherit" })

  console.log("package-verify: PASS — AppImage metadata, x86_64 naming, checksum, extraction, and ASAR payload match.")
} finally {
  await rm(temp, { recursive: true, force: true })
}
