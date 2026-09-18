// Remembers which ledger treatment the shell last published so the next launch
// creates the window in that treatment's background before any HTML loads.
//
// Kept out of main.ts on purpose: the boundary guard
// (scripts/qa-preload-boundary.mjs) holds main's own writeFile calls to the
// path a native save dialog returned. This store writes one fixed file under
// userData, and the only bytes it can write are the strings "dark" or "light".
// The renderer never names the path and never supplies the content; main maps
// the theme-color event onto one of the two values first (shared/ledgerWindow.ts).

import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"

import {
  type LedgerWindowTheme,
  parseLedgerWindowTheme,
} from "../shared/ledgerWindow.ts"

const LEDGER_THEME_FILE = "ledger-theme"

export interface LedgerThemeStore {
  /** Synchronous so createWindow can use it; a missing or odd file reads as dark. */
  readonly read: () => LedgerWindowTheme
  /** Never rejects; a read-only profile directory costs one wrong first frame. */
  readonly write: (theme: LedgerWindowTheme) => Promise<void>
}

export function createLedgerThemeStore(userDataPath: string): LedgerThemeStore {
  const filePath = path.join(userDataPath, LEDGER_THEME_FILE)
  return {
    read: () => {
      try {
        return parseLedgerWindowTheme(readFileSync(filePath, "utf8"))
      } catch {
        return parseLedgerWindowTheme(null)
      }
    },
    write: (theme) => writeFile(filePath, parseLedgerWindowTheme(theme), "utf8").catch(() => {}),
  }
}
