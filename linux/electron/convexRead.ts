// The Vogel Vault — Linux client, Convex read plumbing. MAIN PROCESS ONLY.
//
// Reads were entirely unauthenticated until 2026-07-26: the deployment URL,
// committed in this repo and baked into every shipped client, was the only thing
// between the internet and the household's whole financial history.
// `validateReadToken` in convex/dataFiles.ts now gates `get`, `getVersions`,
// `list` and `listTodoTombstones`, fail-closed, behind an `ALLOW_TOKENLESS_READ`
// hatch that exists so the cutover cannot lock live clients out.
//
// This file is the Linux half of step (2) of that cutover — "ship clients that
// send the token" — landed early so the Linux client is not what blocks step (3)
// (docs/convex-read-auth-cutover.md). It mirrors the Android package added in
// B6, adapted to the one thing Android does not have: a renderer that must never
// see any of it.
//
// Four rules this module exists to enforce.
//
//  1. **Off by default.** Merging and wiring this changes nothing observable.
//     With the kill switch unset no socket is opened, and the app keeps
//     rendering the sanitized fixtures in src/renderer/data/fixtures.ts.
//  2. **The credential is never a constant.** Not in source, not in a `define`,
//     not in the bundle. It arrives through the process environment at launch,
//     lives in a `#private` field, and has no public accessor.
//  3. **Nothing reaches the renderer but a read model.** The renderer gets file
//     metadata and a status. Never the credential, never the deployment URL,
//     never a server-authored string — see `RemoteSnapshotResult`.
//  4. **No Electron, no filesystem, no network here.** Same discipline as
//     csvExport.ts: everything is pure except an injected poster, so
//     scripts/qa-preload-boundary.mjs imports this module and exercises it
//     directly, with no display, no deployment and no build step.

/** Environment as this module reads it. Injected so it can be exercised. */
export type ReadEnvironment = Readonly<Record<string, string | undefined>>

/**
 * The three settings, all runtime.
 *
 * Prefixed as one family so they are greppable and so a shell that happens to
 * carry the deployment's own `CONVEX_READ_TOKEN` — a Convex admin's shell, or an
 * MC2 sync host — does not silently configure a desktop app. iOS holds the
 * equivalents under the `convex_deployment_url` / `convex_read_token`
 * UserDefaults keys; the deployment itself calls the secret `CONVEX_READ_TOKEN`.
 */
export const READ_ENV_KEYS = {
  /** The kill switch. Anything but "1"/"true" is off, including unset. */
  enabled: "VOGEL_VAULT_REMOTE_READ",
  deploymentUrl: "VOGEL_VAULT_CONVEX_URL",
  credential: "VOGEL_VAULT_CONVEX_READ_TOKEN",
} as const

/**
 * Why this process can or cannot read from the deployment.
 *
 * Named states rather than a boolean because the runbook has to tell "we are not
 * configured" apart from "we are configured but sending nothing" — the second
 * reads fine against a permissive deployment and dies the instant the hatch is
 * removed, which is the exact failure the staged cutover exists to prevent.
 */
export type RemoteReadReadiness =
  | "disabled"
  | "unconfigured"
  | "insecure-endpoint"
  | "ready-unauthenticated"
  | "ready"

/** Ceilings on anything this module will accept from the network. */
export const REMOTE_READ_LIMITS = {
  /** `dataFiles:list` returns metadata for a household's files. 13 today. */
  maxFiles: 256,
  /** A metadata listing that needs a megabyte is not a metadata listing. */
  maxResponseBytes: 1_048_576,
  maxFileNameLength: 128,
  /** Floor between two actual requests. See `createRemoteReader`. */
  minIntervalMs: 5_000,
} as const

/**
 * Resolved read settings.
 *
 * A class with a `#private` credential rather than a plain object, because a
 * plain object gets logged. `#private` fields are invisible to `JSON.stringify`,
 * to `String()`, and to `util.inspect` — which is what `console.log` uses — so
 * the credential cannot reach a log line through the ordinary accidents.
 * `toJSON` and `toString` are then belt to that braces.
 */
export class RemoteReadSettings {
  readonly readiness: RemoteReadReadiness
  /** Full query endpoint, main-process only. Null unless usable. */
  readonly endpoint: string | null
  readonly hasCredential: boolean

  readonly #credential: string | null

  constructor(readiness: RemoteReadReadiness, endpoint: string | null, credential: string | null) {
    this.readiness = readiness
    this.endpoint = endpoint
    this.hasCredential = credential !== null
    this.#credential = credential
  }

  /**
   * The only way to the credential, and it has exactly one caller: the request
   * builder below. Nothing exports it, nothing else in the app can reach it, and
   * it never crosses the preload bridge.
   */
  credentialOrNull(): string | null {
    return this.#credential
  }

  /** Presence, never a value. */
  toJSON(): { readiness: RemoteReadReadiness; configured: boolean; credential: string } {
    return {
      readiness: this.readiness,
      configured: this.endpoint !== null,
      credential: this.hasCredential ? "present" : "absent",
    }
  }

  toString(): string {
    return `RemoteReadSettings(${this.readiness}, credential=${this.hasCredential ? "present" : "absent"})`
  }
}

/**
 * A deployment URL is usable only over HTTPS.
 *
 * Refused rather than downgraded: cleartext would put the read credential and
 * the family's finances on the wire in the clear, and "not configured" is a far
 * more legible failure than a silent plaintext read.
 */
function secureQueryEndpoint(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  if (parsed.hostname === "") return null
  return `${raw.replace(/\/+$/, "")}/api/query`
}

function trimmedOrNull(value: string | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * Read the switch.
 *
 * An allowlist of two spellings, not a truthiness test, so a stray
 * `VOGEL_VAULT_REMOTE_READ=0` or `=false` reads as off rather than as a
 * non-empty string.
 */
function switchIsOn(value: string | undefined): boolean {
  const normalised = trimmedOrNull(value)?.toLowerCase()
  return normalised === "1" || normalised === "true"
}

/**
 * Resolve settings from the environment, fail-closed at every branch.
 *
 * Configuration presence is deliberately not consent: a machine that already has
 * a URL and a credential still reads nothing until the switch is on.
 */
export function resolveRemoteReadSettings(env: ReadEnvironment): RemoteReadSettings {
  if (!switchIsOn(env[READ_ENV_KEYS.enabled])) {
    return new RemoteReadSettings("disabled", null, null)
  }

  const rawUrl = trimmedOrNull(env[READ_ENV_KEYS.deploymentUrl])
  if (rawUrl === null) return new RemoteReadSettings("unconfigured", null, null)

  const endpoint = secureQueryEndpoint(rawUrl)
  if (endpoint === null) return new RemoteReadSettings("insecure-endpoint", null, null)

  const credential = trimmedOrNull(env[READ_ENV_KEYS.credential])
  return new RemoteReadSettings(
    credential === null ? "ready-unauthenticated" : "ready",
    endpoint,
    credential,
  )
}

/** One data file, metadata only. There is no financial content in this type. */
export interface RemoteDataFileSummary {
  readonly name: string
  readonly version: number
  /** Epoch milliseconds, as the deployment stores it. */
  readonly updatedAt: number
}

/**
 * What the renderer is allowed to learn about the deployment: whether a read is
 * possible, whether it carried a credential, and what files exist.
 *
 * Every state is a string this module authors. Server text is never propagated:
 * a reason ends up in a log or on screen, and a response body from this
 * deployment is the household's financial data.
 *
 * `authenticated` is here for step 4 of the runbook. In permissive mode the
 * server cannot tell a client that sends the credential from one that does not,
 * so confirmation has to be client-side inspection — this is the Linux client's
 * answer to it, and it discloses nothing but a boolean.
 */
export type RemoteSnapshotResult =
  | {
      readonly status: "ok"
      readonly readAt: string
      readonly authenticated: boolean
      readonly files: readonly RemoteDataFileSummary[]
    }
  | { readonly status: "disabled" }
  | { readonly status: "unconfigured"; readonly reason: string }
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable"; readonly reason: string }

/** A raw HTTP answer. The poster does the socket; this module does the meaning. */
export interface JsonPostResponse {
  readonly httpStatus: number
  readonly body: string
  /**
   * The poster stopped reading at `maxResponseBytes`.
   *
   * Carried as a flag rather than inferred from `body.length`, because a byte
   * ceiling and a UTF-16 string length are not the same measure and a
   * multi-byte payload would slip under the comparison.
   */
  readonly truncated?: boolean
}

export type JsonPoster = (endpoint: string, requestBody: string) => Promise<JsonPostResponse>

/**
 * The one query this client makes: `dataFiles:list`, metadata only.
 *
 * `dataFiles:get` is deliberately absent. It is gated by the same credential, so
 * omitting it costs the cutover nothing, and there is no decoder yet — MC2 money
 * is decimal, `JSON.parse` turns a decimal into a float, and a float is not
 * money. Pulling the household's balances into this process before anything can
 * correctly read them would be surface with no consumer. The lane that writes
 * the decoder adds the call.
 *
 * It is also the exact probe scripts/verify-read-auth.sh uses, for the same
 * reason it uses it: it proves authorisation without moving any money.
 */
const LIST_QUERY_PATH = "dataFiles:list"

/**
 * Build the request body.
 *
 * `JSON.stringify`, never concatenation: hand-rolled escaping around a secret is
 * how a credential ends up mangled or, worse, breaking out of the string it was
 * meant to be inside.
 *
 * An absent credential is omitted rather than sent as "". The server is the
 * authority — while `ALLOW_TOKENLESS_READ=true` a credential-less read succeeds,
 * and the moment the hatch goes it fails closed as `unauthorized`. iOS and
 * Android both omit; matching them keeps every client producing one signal.
 */
function buildQueryBody(path: string, credential: string | null): string {
  const args: Record<string, string> = {}
  if (credential !== null) args.token = credential
  return JSON.stringify({ path, args, format: "json" })
}

function summariseFile(entry: unknown, seen: Set<string>): RemoteDataFileSummary | null {
  if (typeof entry !== "object" || entry === null) return null
  const record = entry as Record<string, unknown>

  const name = record["name"]
  if (typeof name !== "string" || name === "" || name.length > REMOTE_READ_LIMITS.maxFileNameLength) {
    return null
  }
  // A duplicate name means the listing is not what this client thinks it is.
  // Dropping the repeat keeps the renderer's keys unique without inventing one.
  if (seen.has(name)) return null

  const version = record["version"]
  const updatedAt = record["updatedAt"]
  if (!Number.isFinite(version) || !Number.isFinite(updatedAt)) return null

  seen.add(name)
  return { name, version: version as number, updatedAt: updatedAt as number }
}

/**
 * Turn a Convex `{ status, value, errorMessage }` envelope into a read model.
 *
 * The classification matches scripts/verify-read-auth.sh exactly, so the app and
 * the runbook's verification script cannot disagree about what the deployment
 * just said. `unauthorized` is kept apart from `unavailable`: once the hatch is
 * removed, a client that is not sending a valid credential gets a specific,
 * recognisable answer instead of vanishing into a generic error, and that is the
 * difference between diagnosing the cutover and guessing at it.
 */
export function parseSnapshotEnvelope(
  response: JsonPostResponse,
  readAt: string,
  authenticated: boolean,
): RemoteSnapshotResult {
  if (response.truncated === true || response.body.length > REMOTE_READ_LIMITS.maxResponseBytes) {
    return { status: "unavailable", reason: "The deployment sent more than a file listing." }
  }

  // A non-200 during the cutover is most likely trap 2 in the runbook: the gated
  // code is not deployed, so the `token` argument is an ArgumentValidationError.
  // The code, not the body — a body can echo anything.
  if (response.httpStatus !== 200) {
    return { status: "unavailable", reason: `The deployment answered HTTP ${response.httpStatus}.` }
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(response.body)
  } catch {
    return { status: "unavailable", reason: "The deployment's answer was not JSON." }
  }
  if (typeof envelope !== "object" || envelope === null) {
    return { status: "unavailable", reason: "The deployment's answer was not an envelope." }
  }

  const fields = envelope as Record<string, unknown>

  if (fields["status"] === "success") {
    const value = fields["value"]
    if (!Array.isArray(value)) {
      return { status: "unavailable", reason: "The file listing was not a list." }
    }
    const seen = new Set<string>()
    const files: RemoteDataFileSummary[] = []
    for (const entry of value.slice(0, REMOTE_READ_LIMITS.maxFiles)) {
      const summary = summariseFile(entry, seen)
      if (summary !== null) files.push(summary)
    }
    return { status: "ok", readAt, authenticated, files }
  }

  if (fields["status"] === "error") {
    // `validateReadToken` throws ConvexError("Unauthorized: …") for both the
    // fail-closed case and the wrong-credential case. Matching on that word is
    // coarse; the alternative is putting server text in a result that is shown
    // to a user and written to a log.
    const message = fields["errorMessage"] ?? fields["errorData"]
    if (typeof message === "string" && /unauthorized/i.test(message)) {
      return { status: "unauthorized" }
    }
    return { status: "unavailable", reason: "The deployment refused the query." }
  }

  return { status: "unavailable", reason: "The deployment's answer was in an unrecognised shape." }
}

export interface RemoteReader {
  /** Metadata only. Safe to hand straight to the renderer. */
  snapshot(): Promise<RemoteSnapshotResult>
}

export interface RemoteReaderOptions {
  /**
   * Re-read per call, not captured once, so flipping the switch off stops the
   * next request rather than the one after a restart.
   */
  readonly settings: () => RemoteReadSettings
  readonly post: JsonPoster
  readonly now?: () => Date
  /** Defaults to `REMOTE_READ_LIMITS.minIntervalMs`. */
  readonly minIntervalMs?: number
}

/**
 * The reader, with two guards against a renderer that is not behaving.
 *
 * Concurrent calls share one request: a loop of invokes must not become a loop
 * of requests against the family's deployment. Sharing the in-flight promise
 * gives every caller the same honest answer rather than an "already in progress"
 * error state the UI would have to render.
 *
 * Sequential calls are floored to one request per interval, answered from the
 * last result in between. Coalescing alone does nothing about a renderer that
 * awaits each call before making the next; this is the same reasoning as the
 * `exportInFlight` latch in main.ts — main does not get to assume the renderer
 * is well behaved. A metadata listing that is a few seconds old is not worth a
 * request anyway.
 */
export function createRemoteReader(options: RemoteReaderOptions): RemoteReader {
  const clock = options.now ?? (() => new Date())
  const minIntervalMs = options.minIntervalMs ?? REMOTE_READ_LIMITS.minIntervalMs
  let inFlight: Promise<RemoteSnapshotResult> | null = null
  let last: { at: number; result: RemoteSnapshotResult } | null = null

  async function read(): Promise<RemoteSnapshotResult> {
    const settings = options.settings()

    switch (settings.readiness) {
      case "disabled":
        return { status: "disabled" }
      case "unconfigured":
        return { status: "unconfigured", reason: "No deployment is configured on this machine." }
      case "insecure-endpoint":
        return { status: "unconfigured", reason: "The configured deployment is not HTTPS." }
      case "ready-unauthenticated":
      case "ready":
        break
    }

    const endpoint = settings.endpoint
    if (endpoint === null) {
      return { status: "unconfigured", reason: "No deployment is configured on this machine." }
    }

    const body = buildQueryBody(LIST_QUERY_PATH, settings.credentialOrNull())

    let response: JsonPostResponse
    try {
      response = await options.post(endpoint, body)
    } catch {
      // The thrown value is dropped on purpose. A fetch failure message carries
      // the URL, and through a proxy it can carry whatever a proxy chose to echo.
      return { status: "unavailable", reason: "The deployment could not be reached." }
    }

    return parseSnapshotEnvelope(response, clock().toISOString(), settings.hasCredential)
  }

  return {
    snapshot(): Promise<RemoteSnapshotResult> {
      if (inFlight !== null) return inFlight

      const now = clock().getTime()
      if (last !== null && now - last.at < minIntervalMs) return Promise.resolve(last.result)

      const started = read()
        .then((result) => {
          last = { at: clock().getTime(), result }
          return result
        })
        .finally(() => {
          inFlight = null
        })
      inFlight = started
      return started
    },
  }
}
