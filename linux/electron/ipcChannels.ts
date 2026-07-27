// Every IPC channel the app has, in one place.
//
// Main and preload import the same constant so a renamed channel cannot leave
// one side listening on a name nobody sends to, and so the boundary guard can
// prove the two sides still agree.

/** Renderer → main, invoke/handle. Writes a CSV the user chooses a path for. */
export const CSV_EXPORT_CHANNEL = "vogel-vault:export-csv"

/**
 * Renderer → main, invoke/handle. Returns a metadata-only snapshot of the
 * Convex deployment, or a status saying why there is none.
 *
 * The renderer takes no argument here and gets no endpoint back. The deployment
 * URL and the read credential live in the main process; see electron/convexRead.ts.
 */
export const CONVEX_READ_CHANNEL = "vogel-vault:read-remote-snapshot"

/** Renderer → main, invoke/handle. Closed typed row/document request union. */
export const CONVEX_ROWS_CHANNEL = "vogel-vault:query-convex-rows"
