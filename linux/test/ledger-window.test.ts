import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { createLedgerThemeStore } from "../electron/ledgerThemeStore.ts"
import {
  DEFAULT_LEDGER_WINDOW_THEME,
  LEDGER_WINDOW_BACKGROUND,
  ledgerThemeForBackground,
  parseLedgerWindowTheme,
} from "../shared/ledgerWindow.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const foundations = readFileSync(
  join(root, "src", "renderer", "styles", "ledger-foundations.css"),
  "utf8",
)
const main = readFileSync(join(root, "electron", "main.ts"), "utf8")

describe("ledger window background", () => {
  it("matches the ledger background token of each treatment", () => {
    const [dark, light] = foundations.split('[data-vv-theme="light"]')
    expect(dark).toContain(`--vv-ledger-bg: ${LEDGER_WINDOW_BACKGROUND.dark}`)
    expect(light).toContain(`--vv-ledger-bg: ${LEDGER_WINDOW_BACKGROUND.light}`)
    expect(LEDGER_WINDOW_BACKGROUND).toEqual({ dark: "#050505", light: "#f4f3ee" })
  })

  it("reads the persisted treatment the way the renderer does", () => {
    expect(DEFAULT_LEDGER_WINDOW_THEME).toBe("dark")
    expect(parseLedgerWindowTheme("light")).toBe("light")
    expect(parseLedgerWindowTheme("light\n")).toBe("light")
    expect(parseLedgerWindowTheme("dark")).toBe("dark")
    expect(parseLedgerWindowTheme("sepia")).toBe("dark")
    expect(parseLedgerWindowTheme(null)).toBe("dark")
    expect(parseLedgerWindowTheme(undefined)).toBe("dark")
  })

  it("accepts only the two ledger backgrounds from the theme-color event", () => {
    expect(ledgerThemeForBackground("#050505")).toBe("dark")
    expect(ledgerThemeForBackground("#050505FF")).toBe("dark")
    expect(ledgerThemeForBackground("#050505ff")).toBe("dark")
    expect(ledgerThemeForBackground("#f4f3ee")).toBe("light")
    expect(ledgerThemeForBackground("#F4F3EEFF")).toBe("light")
    expect(ledgerThemeForBackground("#0a0d0c")).toBeNull()
    expect(ledgerThemeForBackground("#ffffff")).toBeNull()
    expect(ledgerThemeForBackground(null)).toBeNull()
    expect(ledgerThemeForBackground("")).toBeNull()
  })

  it("persists only dark or light under the profile directory", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const directory = await mkdtemp(join(tmpdir(), "vv-ledger-theme-"))
    try {
      const store = createLedgerThemeStore(directory)
      expect(store.read()).toBe("dark")
      await store.write("light")
      expect(await readFile(join(directory, "ledger-theme"), "utf8")).toBe("light")
      expect(store.read()).toBe("light")
      await store.write("dark")
      expect(store.read()).toBe("dark")
      // A directory that cannot be written is tolerated, never thrown.
      await expect(createLedgerThemeStore(join(directory, "missing")).write("light")).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("creates the Electron window in the persisted ledger colour and follows theme changes", () => {
    expect(main).not.toMatch(/backgroundColor:\s*["']#[0-9a-f]{6}/i)
    expect(main).toContain("backgroundColor: LEDGER_WINDOW_BACKGROUND[ledgerTheme.read()]")
    expect(main).toMatch(
      /did-change-theme-color[\s\S]*?ledgerThemeForBackground\(color\)[\s\S]*?window\.setBackgroundColor\(LEDGER_WINDOW_BACKGROUND\[theme\]\)[\s\S]*?void ledgerTheme\.write\(theme\)/,
    )
  })
})
