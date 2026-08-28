#!/usr/bin/env node

import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const linuxRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const APPROVED_CONVEX_ORIGIN = "https://keen-elephant-452.convex.cloud"

function fail(message) {
  throw new Error(message)
}

function value(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

function quoteDesktopArgument(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`
}

export function configuredLauncherSource() {
  return `#!/usr/bin/env bash
set -euo pipefail

readonly install_dir="$(cd -- "$(dirname -- "$(readlink -f -- "\${BASH_SOURCE[0]}")")" && pwd)"
readonly app_image="\${install_dir}/Vogel-Vault.AppImage"

if ! command -v secret-tool >/dev/null 2>&1; then
  printf '%s\n' "Vogel Vault requires secret-tool to read its production credential." >&2
  exit 1
fi

credential="$(secret-tool lookup application vogel-vault purpose convex-read || true)"
readonly credential
if [[ -z "\${credential}" ]]; then
  printf '%s\n' "Vogel Vault's production read credential is unavailable in the login keyring." >&2
  exit 1
fi

export VOGEL_VAULT_REMOTE_READ=1
export VOGEL_VAULT_CONVEX_URL='${APPROVED_CONVEX_ORIGIN}'
export VOGEL_VAULT_CONVEX_READ_TOKEN="\${credential}"
export VOGEL_VAULT_DEVICE_WRITES=1

exec "\${app_image}" "$@"
`
}

export function desktopEntrySource(commandPath, iconPath) {
  const command = quoteDesktopArgument(commandPath)
  return `[Desktop Entry]
Type=Application
Name=Vogel Vault
Comment=Private family Bitcoin and budget dashboard
Exec=${command} %U
TryExec=${commandPath}
Icon=${iconPath}
Terminal=false
Categories=Office;Finance;
StartupWMClass=vogel-vault
`
}

async function replaceSymlink(target, linkPath) {
  await rm(linkPath, { force: true })
  await symlink(target, linkPath)
}

export async function installLinuxApp({ appImage, prefix, iconSource = path.join(linuxRoot, "build", "icon.png") }) {
  const source = path.resolve(appImage)
  const installPrefix = path.resolve(prefix)
  if (installPrefix === path.parse(installPrefix).root) fail("Refusing to install into the filesystem root.")
  if (!existsSync(source)) fail(`AppImage does not exist: ${source}`)
  if (!existsSync(iconSource)) fail(`Launcher icon does not exist: ${iconSource}`)

  const installDir = path.join(installPrefix, "opt", "vogel-vault")
  const binDir = path.join(installPrefix, "bin")
  const applicationsDir = path.join(installPrefix, "share", "applications")
  const iconsDir = path.join(installPrefix, "share", "icons", "hicolor", "512x512", "apps")
  await Promise.all([
    mkdir(installDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(applicationsDir, { recursive: true }),
    mkdir(iconsDir, { recursive: true }),
  ])

  const installedAppImage = path.join(installDir, "Vogel-Vault.AppImage")
  const installedLauncher = path.join(installDir, "vogel-vault-launch")
  const installedIcon = path.join(iconsDir, "vogel-vault.png")
  const desktopEntry = path.join(applicationsDir, "vogel-vault.desktop")
  const nextAppImage = `${installedAppImage}.next-${process.pid}`
  const nextLauncher = `${installedLauncher}.next-${process.pid}`
  const nextDesktop = `${desktopEntry}.next-${process.pid}`

  await copyFile(source, nextAppImage)
  await chmod(nextAppImage, 0o755)
  await rename(nextAppImage, installedAppImage)

  await writeFile(nextLauncher, configuredLauncherSource(), { mode: 0o755 })
  await chmod(nextLauncher, 0o755)
  await rename(nextLauncher, installedLauncher)

  await copyFile(iconSource, installedIcon)
  await Promise.all([
    replaceSymlink(installedLauncher, path.join(binDir, "vogel-vault")),
    replaceSymlink(installedLauncher, path.join(binDir, "vogel-vault-launch")),
  ])

  await writeFile(nextDesktop, desktopEntrySource(path.join(binDir, "vogel-vault"), installedIcon), {
    mode: 0o644,
  })
  await rename(nextDesktop, desktopEntry)

  return {
    installedAppImage,
    installedLauncher,
    command: path.join(binDir, "vogel-vault"),
    launcherCommand: path.join(binDir, "vogel-vault-launch"),
    desktopEntry,
  }
}

function usage() {
  console.log(`Usage:
  node scripts/install-linux.mjs --appimage <approved AppImage> [--prefix <path>]

Installs one approved AppImage under the user prefix. Both command names and the
desktop entry run the same keyring-backed configured launcher. Default prefix:
$HOME/.local
`)
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--help") || args.includes("-h")) {
    usage()
    return
  }
  const appImage = value(args, "--appimage", null)
  if (appImage === null) fail("--appimage is required.")
  const home = env.HOME?.trim()
  const prefix = value(args, "--prefix", home ? path.join(home, ".local") : null)
  if (prefix === null) fail("--prefix is required when HOME is unavailable.")

  const installed = await installLinuxApp({ appImage, prefix })
  console.log(`Installed Vogel Vault at ${installed.installedAppImage}`)
  console.log(`Command: ${installed.command}`)
  console.log(`Desktop entry: ${installed.desktopEntry}`)
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`install-linux: ${error instanceof Error ? error.message : "installation failed"}`)
    process.exitCode = 1
  })
}
