// Every IPC channel the app has, in one place.
//
// Main and preload import the same constant so a renamed channel cannot leave
// one side listening on a name nobody sends to, and so the boundary guard can
// prove the two sides still agree.

/** Renderer → main, invoke/handle. Writes a CSV the user chooses a path for. */
export const CSV_EXPORT_CHANNEL = "vogel-vault:export-csv"
