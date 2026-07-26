// The Vogel Vault — CSV export contract, shared by the preload bridge and the
// main process.
//
// Everything here is pure string work: no Electron, no filesystem, no path
// module. That is deliberate — the rules that decide whether a renderer payload
// is acceptable, and exactly what bytes reach disk, must be readable and
// testable on their own. scripts/qa-preload-boundary.mjs imports this module
// directly and exercises it.
//
// The trust model: the renderer supplies ROWS ONLY. It never supplies a
// directory, a path, or raw file bytes. The main process picks the destination
// through the OS save dialog and builds the file from these primitives.

/** What the renderer may send. Strings only — see `validateCsvRequest`. */
export interface CsvExportRequest {
  /** A name, never a path. Sanitised by `safeCsvFileName` before it is used. */
  readonly suggestedFileName: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

export type CsvExportResult =
  | { readonly status: "written"; readonly fileName: string; readonly rowCount: number }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly reason: string }

/**
 * Hard ceilings on anything crossing the bridge.
 *
 * A compromised renderer should not be able to make the main process allocate an
 * unbounded string or hand the user a multi-gigabyte save dialog. These are far
 * above any real household export.
 */
export const CSV_LIMITS = {
  maxColumns: 24,
  maxRows: 20_000,
  maxCellLength: 512,
  maxFileNameLength: 96,
} as const

export type CsvValidation =
  | { readonly ok: true; readonly request: CsvExportRequest }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate an untrusted payload from the renderer.
 *
 * Cells must be strings. That single rule is what keeps money exact: a bigint
 * cannot be structured-cloned into a JSON-ish payload without becoming a Number
 * somewhere, and a Number is a float. The renderer formats integer minor units
 * into decimal text before it sends anything, and a numeric cell arriving here
 * means that discipline broke — so it is rejected rather than written.
 */
export function validateCsvRequest(value: unknown): CsvValidation {
  if (typeof value !== "object" || value === null) return fail("The export request was not an object.")

  const candidate = value as Partial<Record<keyof CsvExportRequest, unknown>>

  if (typeof candidate.suggestedFileName !== "string") return fail("The export request had no file name.")

  if (!Array.isArray(candidate.columns)) return fail("The export request had no columns.")
  const columns: unknown[] = candidate.columns
  if (columns.length === 0) return fail("An export needs at least one column.")
  if (columns.length > CSV_LIMITS.maxColumns) return fail("Too many columns for one export.")
  for (const column of columns) {
    const problem = cellProblem(column)
    if (problem) return fail(`Column header rejected: ${problem}`)
  }

  if (!Array.isArray(candidate.rows)) return fail("The export request had no rows.")
  const rows: unknown[] = candidate.rows
  if (rows.length > CSV_LIMITS.maxRows) return fail("Too many rows for one export.")

  for (const row of rows) {
    if (!Array.isArray(row)) return fail("Every row must be an array of cells.")
    if (row.length !== columns.length) return fail("A row did not match the column count.")
    for (const cell of row) {
      const problem = cellProblem(cell)
      if (problem) return fail(`Cell rejected: ${problem}`)
    }
  }

  return {
    ok: true,
    request: {
      suggestedFileName: candidate.suggestedFileName,
      columns: columns as string[],
      rows: rows as string[][],
    },
  }
}

function fail(reason: string): CsvValidation {
  return { ok: false, reason }
}

function cellProblem(cell: unknown): string | null {
  if (typeof cell !== "string") return "cells must be strings"
  if (cell.length > CSV_LIMITS.maxCellLength) return "a cell was too long"
  // Newlines and other control characters are refused rather than quoted. One
  // record per line keeps the file diffable, and it removes the whole class of
  // CR/LF injection into the written bytes. Checked by code point rather than a
  // regex so the pattern itself stays free of control characters.
  for (let index = 0; index < cell.length; index += 1) {
    const code = cell.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return "a cell contained a control character"
  }
  return null
}

/**
 * Turn a renderer-supplied name into a bare, safe file name.
 *
 * Strips any directory component the renderer tried to smuggle in — including
 * Windows-style separators, which `path.basename` would not remove on Linux —
 * then reduces what is left to an allowlist. The result is only ever a
 * suggestion in the save dialog; the user still chooses the folder.
 */
export function safeCsvFileName(suggested: string): string {
  const lastSeparator = Math.max(suggested.lastIndexOf("/"), suggested.lastIndexOf("\\"))
  const base = lastSeparator >= 0 ? suggested.slice(lastSeparator + 1) : suggested
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, CSV_LIMITS.maxFileNameLength)
  const stem = cleaned.toLowerCase().endsWith(".csv") ? cleaned.slice(0, -4) : cleaned
  return `${stem === "" ? "vogel-vault-export" : stem}.csv`
}

/**
 * RFC 4180 serialisation: CRLF line endings, quotes doubled inside quoted
 * fields, and a header row. Values arrive already formatted — this function
 * never parses, rounds, or re-formats a number.
 */
export function serializeCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.map(escapeCell).join(",")]
  for (const row of rows) lines.push(row.map(escapeCell).join(","))
  // Trailing CRLF: every record, including the last, is terminated.
  return `${lines.join("\r\n")}\r\n`
}

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/

/**
 * Spreadsheets execute a cell that opens with =, +, @ or a control character, so
 * a merchant name out of a bank feed can become a formula. Such cells get a
 * leading apostrophe, which every spreadsheet reads as "this is text".
 *
 * A leading "-" is deliberately NOT guarded when the cell is a plain decimal:
 * that is what every negative amount looks like, and quoting it as text would
 * make the money column unsummable in the one tool people export CSV for.
 */
function needsFormulaGuard(cell: string): boolean {
  const first = cell.charAt(0)
  if (first === "=" || first === "+" || first === "@") return true
  if (first === "-") return !PLAIN_DECIMAL.test(cell)
  return false
}

function escapeCell(cell: string): string {
  const guarded = needsFormulaGuard(cell) ? `'${cell}` : cell
  const mustQuote =
    guarded !== cell ||
    guarded.includes('"') ||
    guarded.includes(",") ||
    guarded.includes("\n") ||
    guarded.includes("\r") ||
    guarded.trim() !== guarded
  return mustQuote ? `"${guarded.replace(/"/g, '""')}"` : guarded
}
