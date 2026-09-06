// The ledger background each treatment paints, shared by the renderer and the
// main process so the Electron window's first frame matches the shell.
//
// The renderer owns the persisted treatment (localStorage in AppState.tsx) and
// publishes it through the document's theme-color meta. Main listens for the
// resulting did-change-theme-color event, repaints the window, and stores the
// treatment beside the profile data so the next launch creates the window in
// the right colour before any HTML loads. No IPC channel or preload method is
// involved; the renderer can only ever pick one of the two values below.

export type LedgerWindowTheme = "dark" | "light"

/** Exact --vv-ledger-bg values from src/renderer/styles/ledger-foundations.css. */
export const LEDGER_WINDOW_BACKGROUND: Readonly<Record<LedgerWindowTheme, string>> = {
  dark: "#050505",
  light: "#f4f3ee",
}

export const DEFAULT_LEDGER_WINDOW_THEME: LedgerWindowTheme = "dark"

/** Same rule as the renderer: exactly "light" means light, anything else is dark. */
export function parseLedgerWindowTheme(value: unknown): LedgerWindowTheme {
  return typeof value === "string" && value.trim() === "light" ? "light" : DEFAULT_LEDGER_WINDOW_THEME
}

/**
 * Map a reported theme colour back to a treatment. Chromium reports the meta
 * value as #rrggbb, sometimes with an opaque alpha suffix; anything that is not
 * one of the two ledger backgrounds is ignored rather than painted.
 */
export function ledgerThemeForBackground(color: unknown): LedgerWindowTheme | null {
  if (typeof color !== "string") return null
  const normalised = color.trim().toLowerCase().replace(/^(#[0-9a-f]{6})ff$/, "$1")
  for (const theme of ["dark", "light"] as const) {
    if (LEDGER_WINDOW_BACKGROUND[theme] === normalised) return theme
  }
  return null
}
