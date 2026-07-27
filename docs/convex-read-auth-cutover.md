# Convex Read-Auth Cutover Runbook

Turning on read authentication in one step locks every live client out of the
household's data. This runbook is the ordered procedure that avoids that, the
observable signal for each step, and the rollback when a client starts failing.

Companion script: `scripts/verify-read-auth.sh`. It is the observable signal
for every step below.

---

## Where things stand

Until 2026-07-26 every Convex *query* was unauthenticated. The deployment URL
— committed at `scripts/convex-codegen.mjs:7` and baked into every shipped
client binary — was the only thing standing between the internet and the
household's complete financial history. `validateReadToken` in
`convex/dataFiles.ts` now gates `get`, `getVersions`, `list` and
`listTodoTombstones`, fail-closed, with an `ALLOW_TOKENLESS_READ` escape hatch.

**The hatch is the design, not a shortcut.** Enforcing in one step would lock
out the TestFlight build already on Victor's phone. Same pattern as
`CONVEX_SYNC_TOKEN` for mutations (SAT-1326).

**The hatch outranks the token** — `ALLOW_TOKENLESS_READ=true` admits every
caller even once `CONVEX_READ_TOKEN` is set, so *removing the hatch* is the
enforcement flip, not setting the token. Read Trap 1 before doing anything;
it also names the hazard that choice buys.

Measured state of the production deployment on 2026-07-26:

```
$ scripts/verify-read-auth.sh
verify-read-auth: https://keen-elephant-452.convex.cloud
  probe: dataFiles:list (metadata only — never dataFiles:get)
  unauthenticated query: ACCEPTED (13 data files visible)
STATE: OPEN
```

Reads are open right now, and the gated code is not deployed yet.

---

## Two traps that change the order

Both were found by probing the live deployment. Read them before touching
anything.

### Trap 1 — the hatch outranks the token, so a set token can do nothing

`validateReadToken` checks the hatch **first**:

```
if (ALLOW_TOKENLESS_READ === "true") { warn("PERMISSIVE …"); return }
if (!CONVEX_READ_TOKEN) throw            // fail-closed, nothing configured
if (!token || token !== CONVEX_READ_TOKEN) throw
```

So `ALLOW_TOKENLESS_READ=true` admits every caller **even when
`CONVEX_READ_TOKEN` is set**. Setting the token is a preparatory step, not the
flip. *Removing the hatch is the enforcement flip.*

This is deliberate, and it was the opposite until 2026-07-26. The original code
consulted the hatch only when the token was unset, which meant step 3 below
started enforcing the moment you pressed enter and locked out every reader that
did not yet send a token — including the phone. The two designs fail in
opposite directions:

| | failure mode | who notices |
| --- | --- | --- |
| hatch loses (old) | everyone locked out, remotely, immediately | the household, by the app being broken |
| hatch wins (now) | enforcement quietly did not happen | `verify-read-auth.sh` printing `OPEN`, in one command |

The second is recoverable by someone who is not already locked out. That is the
whole argument.

> ⚠️ **The hazard this buys, stated plainly: a set `CONVEX_READ_TOKEN` is not
> evidence of enforcement.** The deployment can list the variable, look
> configured, and still be serving the family's finances to anyone with the URL.
> Two things detect it, and nothing else does:
>
> - `scripts/verify-read-auth.sh` reports `STATE: OPEN`.
> - Every permissive admission logs `PERMISSIVE: ALLOW_TOKENLESS_READ=true is
>   admitting this call and CONVEX_READ_TOKEN is set but IGNORED …` to the
>   deployment log. Unthrottled, one line per call, on purpose.
>
> Never declare the cutover done on the strength of `npx convex env list`. Run
> the script. The same applies to `ALLOW_TOKENLESS_SYNC` and writes.

The upside is a rollback that stays atomic forever: `npx convex env set
ALLOW_TOKENLESS_READ true` restores permissive reads in seconds, from any state,
without touching `CONVEX_READ_TOKEN` and without a redeploy.

### Trap 2 — clients cannot send the token before the gated code is deployed

The currently deployed functions have no `token` argument in their validators.
An extra argument is an `ArgumentValidationError`, which production returns as
a bare `Server Error`:

```
$ CONVEX_READ_TOKEN=… scripts/verify-read-auth.sh
  unauthenticated query: ACCEPTED (13 data files visible)
  control query (deliberately wrong token): REJECTED, reason not attributable to auth — [Request ID: …] Server Error
  CONVEX_READ_TOKEN in this shell: present
  known-good token query: REJECTED, reason not attributable to auth — [Request ID: …] Server Error
  hint: the deployment appears to reject a 'token' argument, so the
        gated code is probably not deployed yet.
STATE: OPEN
```

A client that starts sending a read token today does not degrade gracefully —
every one of its queries fails. Ship token-sending clients only after step 2.

---

## Blast radius, honestly

| Reader | Sends a read token? | What breaks at enforcement | How loud |
| --- | --- | --- | --- |
| **iOS TestFlight build on Victor's phone** | Only if that specific build contains the `ConvexConfig.readToken` plumbing *and* the token has been injected into `UserDefaults` | Every query throws; no balances, budget, transactions or todos | Loud — the app is visibly broken in Victor's hand |
| **MC2 sync bridge — `scripts/mc2-to-convex.mjs`, tombstone pull** | No. `fetchTodoTombstones` calls `listTodoTombstones` with `{}` | Falls into its own `catch`, logs `WARN todo tombstones unavailable`, returns `[]`, sync continues | **Silent.** Deleted todos stop being removed locally and resurrect on the next pull. This is the worst failure in the table because nothing appears wrong |
| **MC2 sync bridge — app-transaction / data pulls** | No. Three `client.query(api.dataFiles.get, …)` sites, no token, no `catch` | Throws and aborts the sync run; in `--watch` mode the loop dies | Loud, but only if someone is watching the log |
| **`mission-control/server.js`** | Unknown — it lives outside this repo and could not be audited from here | Unknown | Unknown. Audit it before the flip; do not assume |
| **Linux client** | N/A — still on `linux/src/renderer/data/fixtures.ts`, no Convex client exists | Nothing today | Silent, because it is not connected. It must be *born* sending the token |
| **Android client** | N/A — still on `android/domain/.../Fixtures.kt` | Nothing today | Same |
| **Mobile pairing / mobile writeback** | N/A — those are mutations, gated by `CONVEX_SYNC_TOKEN` and device tokens | Nothing. Read auth does not touch them | — |

The two things most likely to bite: the phone (loud, embarrassing, in Victor's
hand) and the tombstone pull (silent, corrupts todo state over days).

---

## Preconditions

- Victor has explicitly approved the cutover session. Every step below mutates
  live production config; none of it is free-play.
- You can reach the deployment and `scripts/verify-read-auth.sh` runs clean.
- You know how to set the token on **every** reader in the blast-radius table,
  or you have consciously accepted that an unaudited reader will break.
- A token exists, generated fresh (`openssl rand -hex 32`), held only in a
  password manager and in deployment/host environment. Never in a file in this
  repo, never in a commit, never in a log line, never in a test fixture. Report
  it as present or absent, never by value.
- Do the flip when Victor is physically at the phone. The phone is the only
  reader whose state you cannot inspect remotely.

Throughout, `DEPLOY` means:

```bash
export DEPLOY="CONVEX_DEPLOYMENT=prod:keen-elephant-452"
```

matching how `scripts/convex-codegen.mjs` derives the prod deployment.

---

## The cutover

Convex environment variables take effect on the running deployment
immediately — no redeploy needed. That is what makes step 5 reversible in
seconds, and also why step 5 is dangerous the instant you press enter. Steps 1
through 4 are all permissive: nothing in them can lock a client out.

### Step 0 — Baseline

```bash
scripts/verify-read-auth.sh --expect open
```

**Signal:** `STATE: OPEN`, `EXPECT OPEN: OK`, exit 0.

If this already prints `ENFORCED`, stop — someone else moved. Reconcile before
continuing.

**Rollback:** none needed; nothing changed.

### Step 1 — Set the hatch *before* deploying the gate

```bash
env $DEPLOY npx convex env set ALLOW_TOKENLESS_READ true
env $DEPLOY npx convex env list
```

**Check:** `ALLOW_TOKENLESS_READ` appears in the list.

**Signal:** `scripts/verify-read-auth.sh --expect open` still passes. This step
is a deliberate no-op against the currently deployed code — the variable does
nothing until the gated code lands, which is exactly the point. Setting it
first means there is never a window in which enforcement is live by accident.

**Rollback:** `env $DEPLOY npx convex env remove ALLOW_TOKENLESS_READ`.

### Step 2 — Deploy the gated code (still permissive)

```bash
env $DEPLOY npx convex deploy
```

**Check immediately afterwards:**

```bash
scripts/verify-read-auth.sh --expect open
CONVEX_READ_TOKEN="$THE_TOKEN" scripts/verify-read-auth.sh
```

**Signal:** the unauthenticated probe is still `ACCEPTED` (`STATE: OPEN`), and
the authenticated probe is now also `ACCEPTED` rather than `Server Error`. Both
succeeding is the proof that the gated code is live *and* the hatch is holding
it open — the token argument is now accepted and ignored. The deployment log
should show a `PERMISSIVE: ALLOW_TOKENLESS_READ=true …` line for each of those
probes; its absence means the gated code did not land.

**If the unauthenticated probe comes back `REJECTED` here, you have an
outage.** The hatch did not take. Go to rollback immediately.

**Rollback:**

```bash
env $DEPLOY npx convex env set ALLOW_TOKENLESS_READ true   # if it was missing
scripts/verify-read-auth.sh --expect open
```

If that does not restore `OPEN` within a minute, redeploy the previous commit's
`convex/` directory. Reverting the code is slower than fixing the variable, so
always try the variable first.

### Step 3 — Set the token everywhere (deployment still permissive)

Set it on the deployment first. This is inert while the hatch is on — Trap 1 —
which is exactly why it is safe to do before the readers are ready:

```bash
env $DEPLOY npx convex env set CONVEX_READ_TOKEN "$THE_TOKEN"
env $DEPLOY npx convex env list          # presence only; never print the value
scripts/verify-read-auth.sh --expect open
```

**Signal:** still `STATE: OPEN`. If this prints `ENFORCED`, the hatch is not in
place — go to step 1's rollback before doing anything else.

Then set the same value on the readers, one at a time:

- **MC2 sync hosts:** `CONVEX_READ_TOKEN` in the same environment that already
  carries `CONVEX_SYNC_TOKEN`. Requires the read sites in
  `scripts/mc2-to-convex.mjs` to actually pass it (task B2) — passing the env
  var to a script that ignores it proves nothing.
- **iOS:** inject via `ConvexConfig.setReadToken(_:)` (task B3). It is stored in
  `UserDefaults`, never bundled, never committed. The build on the phone must
  be one that contains this plumbing; if it is not, this step means shipping a
  new TestFlight build first, which is its own approval gate.
- **Linux / Android:** these must send the token from their first Convex commit
  (tasks B6, #14). There is no legacy build to protect, so there is no reason
  to let them be born tokenless.
- **`mission-control/server.js`:** audit and update it in its own repo.

**Check after each reader:** it still works. Permissive mode accepts a correct
token, a wrong token and no token alike, so a reader that is now sending the
token behaves identically — which is the whole point of doing this before the
flip.

**Signal:** every reader is functioning and, by direct inspection of its
configuration, is sending the token.

**Rollback:** unset the variable on that reader. Nothing on the server changed.

### Step 4 — Soak permissively, and be honest about what you cannot confirm

**This is the weakest link in the runbook.** In permissive mode the server
accepts a correct token, a wrong token and no token alike. It cannot tell you
which readers are ready, and it cannot tell you whether the value you
distributed matches the value on the deployment. There is no server-side proof
available until the flip.

Soak here — at least 48 hours, and long enough to cover one full MC2 sync
cycle, one phone session, and one use of each wired desktop client. This is the
cheap part of the cutover: nothing is enforced, so nothing can break. Spend the
time here rather than after step 5.

Confirmation is client-side inspection, one reader at a time:

- MC2 hosts: the variable is present in the service environment, and the
  running process was restarted after it was set.
- iOS: the app was launched after the token was injected and reads succeed.
- Linux/Android: the code path that attaches the token is the only read path.

Also grep the deployment log for the `PERMISSIVE:` lines. They confirm the
gated code is live and the hatch is what is holding it open — they do *not*
tell you anything about which readers are sending a token.

Write down the list of readers you inspected and the ones you could not. The
ones you could not are the ones that will break in step 5, and step 5's
rollback is what covers them.

**Do not skip to step 5 hoping the flip itself will tell you.** It will — by
breaking things. That is acceptable only because rollback is fast, and only if
Victor is present.

### Step 5 — The enforcement flip

Removing the hatch is the flip. One command; enforcement is live the instant it
returns.

```bash
env $DEPLOY npx convex env remove ALLOW_TOKENLESS_READ
```

**Check, within seconds:**

```bash
scripts/verify-read-auth.sh --expect enforced
CONVEX_READ_TOKEN="$THE_TOKEN" scripts/verify-read-auth.sh
```

**Signal:** the unauthenticated probe is `REJECTED` with
`Unauthorized: invalid read token`, `STATE: ENFORCED`, and the authenticated
probe is `ACCEPTED`. Both halves matter — `ENFORCED` alone could also mean you
typo'd the deployment's token in step 3 and have locked out everyone including
yourself. This is the first moment the token's *value* is verifiable at all;
until now it was inert.

**Then, in this order, within the first two minutes:**

1. Open the app on the phone. Pull to refresh. Data still loads?
2. Run one MC2 sync cycle in the foreground. No `WARN todo tombstones
   unavailable`, no thrown `dataFiles.get`?
3. Linux/Android, if wired: load a screen that reads live data.

**ROLLBACK — if any client starts failing:**

```bash
env $DEPLOY npx convex env set ALLOW_TOKENLESS_READ true
scripts/verify-read-auth.sh --expect open
```

That is the whole rollback. It takes seconds, needs no redeploy, leaves
`CONVEX_READ_TOKEN` untouched, and works from any state — that is the payoff for
the hatch outranking the token. Confirm `STATE: OPEN` before you go debug
anything.

Do not attempt a partial fix while clients are down. Roll back first, diagnose
second. The data is exposed again while rolled back — that is a worse state
than enforced, but a better state than Victor's finances being unreadable with
no diagnosis, and it is the state that existed for months anyway.

### Step 6 — Confirm the hatch is gone and stays gone

There is nothing left to remove: step 5 already removed the only thing standing
between the deployment and enforcement. What is left is making sure it does not
quietly come back.

```bash
env $DEPLOY npx convex env list          # ALLOW_TOKENLESS_READ must be absent
scripts/verify-read-auth.sh --expect enforced
```

⚠️ If anyone re-sets `ALLOW_TOKENLESS_READ=true` for a rollback, **it is not a
temporary state that expires on its own.** The token stays set, the deployment
keeps looking configured, and reads are wide open until someone removes the
hatch again. Re-run `scripts/verify-read-auth.sh --expect enforced` after every
incident, and treat a `PERMISSIVE:` line in the deployment log outside a
declared cutover window as an open production incident.

Repeat the same check for writes: `ALLOW_TOKENLESS_SYNC` has the identical
precedence and the identical failure to notice.

---

## Failure symptoms, by client

Worth knowing before you are staring at one.

- **iOS:** `ConvexClient.call` sees `status == "error"` and throws
  `ConvexError.decodeFailed` carrying the message `Unauthorized: …`. The
  transport succeeded — HTTP 200 — so this is not a network error and will not
  look like one. Expect empty screens or stale cached data rather than an
  obvious "unauthorized" banner.
- **MC2 tombstone pull:** `WARN todo tombstones unavailable; continuing without
  delete pull` in the sync log, then normal-looking output. If you see this
  line after the flip, deletes are silently broken — treat it as a failure and
  roll back.
- **MC2 data pull:** an uncaught throw out of `pullAppTransactionsFromConvex`
  and friends; the sync run aborts.
- **The verify script:** `STATE: ENFORCED` when you expected `OPEN` is an
  outage in progress. `STATE: OPEN` when you expected `ENFORCED` is the Trap 1
  hazard: a hatch is still set and the token is being ignored. Nothing is
  broken, and that is the problem — the data is public and everything looks
  fine.
- **The deployment log:** a `PERMISSIVE: …` line outside a declared cutover
  window means reads (or writes) are open right now. Treat it as an incident,
  not a warning.

---

## Token rotation, later

Rotation has the same shape as the cutover. Overwriting `CONVEX_READ_TOKEN`
while clients still hold the old one is an instant lockout, so re-arm the hatch
first and the rotation becomes as safe as the original cutover:

1. `npx convex env set ALLOW_TOKENLESS_READ true` — permissive again, and now
   old-token, new-token and no-token clients all read fine.
2. Set the new `CONVEX_READ_TOKEN` on the deployment (inert), then roll it out
   to every reader.
3. Soak and inspect, exactly as step 4.
4. `npx convex env remove ALLOW_TOKENLESS_READ` — enforcement back on, with the
   new value.

Step 1 reopens the data to the internet for the length of the rotation. That is
a real cost, it needs Victor's approval each time, and it argues for keeping the
window short rather than for skipping the hatch.

---

## What `scripts/verify-read-auth.sh` does and does not prove

Does:

- Issues an unauthenticated `dataFiles:list` query and a deliberately wrong-token
  control probe, then classifies the result as `OPEN`, `ENFORCED`, `OUTAGE`,
  `CLOSED-UNCONFIRMED`, or `UNKNOWN`.
- Optionally issues a third probe with `CONVEX_READ_TOKEN` from the environment
  to distinguish working enforcement from a lockout.
- `--expect open|enforced` turns it into a gate: exit 0 on match, 1 on
  mismatch, 2 on indeterminate. Without `--expect` the exit code encodes all
  five states: 0 `ENFORCED`, 10 `OPEN`, 11 `OUTAGE`, 12
  `CLOSED-UNCONFIRMED`, and 2 `UNKNOWN`.
- Detect the Trap 1 hazard. A deployment with `CONVEX_READ_TOKEN` set and a
  hatch still on reports `OPEN`, which is the only external signal that a
  configured-looking deployment is not enforcing. This is the reason the hatch
  is allowed to outrank the token at all — run it after every cutover step and
  after every rollback.
- Runs queries only — no mutation, no write, no side effect — so it is safe to
  run repeatedly against production.

Does not:

- Touch `dataFiles:get`, or any payload. It probes `dataFiles:list`, which
  returns names, versions and timestamps. No financial content passes through
  it even when reads are wide open. This is enforced by a hardcoded probe path,
  not by a parameter you could get wrong.
- Print, log or persist a token value. The request body is built in a mode-0600
  temp file so the token never reaches argv, and the temp directory is removed
  on exit.
- Prove anything about a *client*. It tests the server's posture. Whether the
  phone in Victor's pocket sends a token is not observable from here — that is
  step 4's problem, and the reason step 5 needs him present.
