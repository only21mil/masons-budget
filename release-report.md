# Vogel Vault — Budget App Release Report

**Date:** 2026-09-16  
**Main SHA:** [`337dfd9`](https://github.com/only21mil/masons-budget/commit/337dfd9bae23890375788c7f414f9e53683ec7a6)  
**Marketing version:** 0.5.0 · **Build:** 45 (`MasonsBudget/project.yml`)

---

## Summary

Navigation redesign landed on all three clients (Linux, Android, Apple) via PRs #422–#424. Delivery authority flipped to GitHub-primary (PR #421). Linux nav-redesign build is verified on Framework Desktop (F-D). Apple TestFlight build 45 is in ASC beta testing but was cut from pre-nav-redesign main; a new `both`-platform release at current main requires Victor action. Android device deploy and Buzz repo doc-flip remain blocked on infrastructure access.

---

## 1. Navigation redesign

Five primary tabs in order: **Home, Budget, Activity, Bitcoin, Tasks**.

| Feature | Detail |
|---------|--------|
| Home | Dashboard renamed; content unchanged |
| Tasks | Today renamed/consolidated |
| Bitcoin | Internal segments: Overview · Net Worth · Retirement |
| Gear menu | Family, Settings, Export moved behind top-right gear |
| Profile switcher | Stays visible in app bar |
| Display units | BTC / SATS / USD toggle preserved on money screens |

Handoff reference: `internal/NAVIGATION_REDESIGN_HANDOFF.md` in the Project store.

### Merged PRs

| Order | PR | Title | Merge SHA |
|------:|----|-------|-----------|
| 1 | [#422](https://github.com/only21mil/masons-budget/pull/422) | feat(linux): navigation redesign — 5-tab primary nav | [`5ea0563`](https://github.com/only21mil/masons-budget/commit/5ea05638b948ba654cf436e767ae7f8c3e155a79) |
| 2 | [#423](https://github.com/only21mil/masons-budget/pull/423) | feat(android): five-tab navigation redesign with Bitcoin segments | [`ea269ee`](https://github.com/only21mil/masons-budget/commit/ea269ee94042b9391eabc6af19023dd66362305f) |
| 3 | [#424](https://github.com/only21mil/masons-budget/pull/424) | feat(ios): five-tab navigation redesign with Bitcoin segments | [`77162b4`](https://github.com/only21mil/masons-budget/commit/77162b4dca599810a5c046e982f1e490ecf65af1) |

Merge sequence evidence: `internal/merge-sequence-422-421-report.md`.

### CI evidence (all green before merge)

| PR | Primary CI run | Key checks |
|----|----------------|------------|
| #422 | [34968629535](https://github.com/only21mil/masons-budget/actions/runs/34968629535) | Linux client, Android client, Convex, shared domain, golden decoders, actionlint |
| #423 | [34968649807](https://github.com/only21mil/masons-budget/actions/runs/34968649807) | Android client, Convex, shared domain, golden decoders, actionlint |
| #424 | [34968649896](https://github.com/only21mil/masons-budget/actions/runs/34968649896) | Apple client, Verify committed Xcode project, Convex, shared domain, golden decoders |
| #421 | [34974711757](https://github.com/only21mil/masons-budget/actions/runs/34974711757) | All three clients + Apple verify (post-rebase) |

Restore/reopen context: old PRs #417–#419 were closed after branch prune; replacement PRs #422–#424 opened with fresh CI (`internal/delivery/navigation-redesign-restore-report.md`).

---

## 2. Framework Desktop (Linux) install — verified

| Item | Value |
|------|-------|
| Host | Framework Desktop (`framework-desktop`, worker `79e90790-bcbe-4f83-9d32-4d43bbac3803`) |
| AppImage | `Vogel-Vault-0.1.1-x86_64.AppImage` (131,287,035 bytes) |
| SHA256 | `57149ece9c5c1489c88e263389f447a76da81c58ec05109a37d78fd3349a9d9d` |
| Nav strings in bundle | Home, Budget, Activity, Bitcoin, Tasks — all present |
| `smoke:packaged` | 19/19 PASS |
| Install paths | `~/.local/opt/vogel-vault/`, `~/.local/bin/vogel-vault-launch` |

Evidence: `internal/linux-deploy/nav-redesign-fd-deploy-2026-09-15.md`.

---

## 3. GitHub-primary flip & Buzz mirror

PR [#421](https://github.com/only21mil/masons-budget/pull/421) merged at `337dfd9`. `AGENTS.md`, `CLAUDE.md`, `OPENCODE.md`, CI reuse docs, and receipt labels now state **GitHub is authoritative; Buzz relay is read mirror**.

Umbrella tracker: [issue #420](https://github.com/only21mil/masons-budget/issues/420) — remaining cutover work.

### Mirror timer (CD-8) — stopped for Budget

Before the flip, `buzz-github-mirror.timer` (2-minute relay→GitHub force-prune) deleted GitHub-only branches within ~100 s of push. Victor stopped the timer; Budget flip branch survived on origin after push. Timer must stay disabled (or reversed) before any GitHub-primary workflow is considered safe repo-wide.

### Buzz repo push — blocked (403)

`cursor[bot]` has write access to `only21mil/masons-budget` but **not** `only21mil/buzz`:

```
remote: Permission to only21mil/buzz.git denied to cursor[bot].
```

**Victor action:** Grant Cursor GitHub App **Contents: Read and write** on `only21mil/buzz`, then push `cursor/github-primary-flip-7988` (local commit `0f5921d` / `9a02767`) and open a draft PR.

Evidence: `internal/delivery/buzz-github-primary-flip-push-blocked.md`, `internal/delivery/github-primary-flip-execution.md`.

### Issue/PR backfill — Victor must choose

| Option | Summary |
|--------|---------|
| **A. Full backfill** | Import all open Buzz issues/PRs to GitHub with `buzz-id → github-number` map; close Buzz originals |
| **B. Open-only + frozen archive** | Import open items only; closed history stays on relay as read-only archive |
| **C. Cutover without backfill** | Freeze Buzz; re-file open items manually on GitHub (not recommended) |

Plan detail: `internal/delivery/github-primary-buzz-mirror-flip-plan.md` §5.

### Still open on #420

- Relay-side freeze reads and lane-freeze confirmation
- Relay-only commit convergence (Step 2)
- GitHub→Buzz mirror automation with SLA (Step 4)
- B9 tooling re-point (Buzz CLI, `pre-freeze.sh`, announcements, `buzz-protect`)
- Re-open lanes + retention decision + observed GitHub-only landing per repo

---

## 4. Device & TestFlight status

### Apple (TestFlight / ASC)

| Target | Status | Evidence |
|--------|--------|----------|
| macOS build 45 | VALID / IN_BETA_TESTING | [Deploy run 34798492128](https://github.com/only21mil/masons-budget/actions/runs/34798492128) @ `43b1ba7` |
| iOS build 45 | VALID / IN_BETA_TESTING | [Deploy run 34794379822](https://github.com/only21mil/masons-budget/actions/runs/34794379822) @ `f201df1` (6 commits behind nav-redesign main) |
| ASC preflight | Both platforms AVAILABLE_TO_EXISTING_GROUPS | [Run 34798809206](https://github.com/only21mil/masons-budget/actions/runs/34798809206) |
| Mason MBP install | Build available; install not verified by agents | ASC state only |
| Rachel MBA install | Build available; install not verified | No recipient email in repo |

**Gap:** Last TestFlight upload predates nav-redesign merges (#422–#424). iOS and macOS were not uploaded as a unified `both` run at `337dfd9`.

### Android (Pixel Fold + Mason's Pixel 10)

| Device | Status |
|--------|--------|
| Pixel Fold (`100.113.52.90:5555`) | UNREACHABLE — Tailscale not authenticated on cloud workers |
| Mason's Pixel 10 (`100.127.99.62:5555`) | UNREACHABLE — same blocker |
| APK deploy @ `77162b4` | NOT installed — requires `framework-desktop` worker or Victor `adb` from tailnet |

Evidence: `internal/device-status.md`, `internal/android-nav-redesign-device-deploy-report.md`.

---

## 5. Victor's open actions

1. **TestFlight at nav-redesign main** — Bump `CURRENT_PROJECT_VERSION` to 46 in `MasonsBudget/project.yml`, commit to main, then dispatch:
   ```bash
   gh workflow run deploy.yml -R only21mil/masons-budget --ref main \
     -f platform=both -f apple_runner=mbp
   ```
2. **TestFlight install** — Open TestFlight on Mason MBP and Rachel MBA (family internal tester Apple IDs).
3. **Buzz repo grant** — Cursor app write access to `only21mil/buzz`; push doc-flip branch and open PR.
4. **Backfill option** — Choose A, B, or C for issue/PR sync (issue #420).
5. **Mirror automation** — Stand up GitHub→Buzz mirror job; confirm CD-8 timer stays off/reversed.
6. **Android deploy** — Run on `framework-desktop` or dispatch `clients.yml`; install to Fold devices via tailnet `adb`.
7. **Tailscale auth** — If cloud agents need device access: authenticate tailnet or provide `TS_AUTHKEY`.

---

## 6. Model pins & CI rules

### Worker model pins (effective 2026-09-15)

| Role | Pin |
|------|-----|
| Coordinator | Muse Spark 1.3 (`high` / `xhigh` / `max` gated) |
| Executor | `composer-2.5` Standard (not fast) |
| Scale / overflow (>200K) | `cursor-grok-4.6-xhigh` Standard (not fast) |
| Reviewer / escalation | `cursor-grok-4.6-xhigh` Standard (not fast) |
| Research | `composer-2.5` Standard; Grok only for escalation |

Never GLM, DeepSeek, or Contributor tier with private code.  
Canonical: `docs/worker-model-pins.md`.

### CI red auto-fix rule (2026-09-15)

Diagnose on first red; collect every failure from the run; fix all at once; one push; no new CI run until the last run is fully fixed. Linked across `preferences.md`, cloud-agent-operations, review-and-babysit policy, and framework lane template.  
Audit: `internal/ci-batch-fix-global-audit.md`.

---

## 7. Evidence index

| Topic | Path / link |
|-------|-------------|
| Main commit | https://github.com/only21mil/masons-budget/commit/337dfd9bae23890375788c7f414f9e53683ec7a6 |
| Nav handoff | `internal/NAVIGATION_REDESIGN_HANDOFF.md` |
| Merge sequence | `internal/merge-sequence-422-421-report.md` |
| Nav restore | `internal/delivery/navigation-redesign-restore-report.md` |
| F-D Linux deploy | `internal/linux-deploy/nav-redesign-fd-deploy-2026-09-15.md` |
| GitHub-primary execution | `internal/delivery/github-primary-flip-execution.md` |
| Buzz 403 blocker | `internal/delivery/buzz-github-primary-flip-push-blocked.md` |
| Flip plan | `internal/delivery/github-primary-buzz-mirror-flip-plan.md` |
| TestFlight report | `internal/delivery/testflight-release-20260915-report.md` |
| Android deploy | `internal/android-nav-redesign-device-deploy-report.md` |
| Device status | `internal/device-status.md` |
| Model pins | `docs/worker-model-pins.md` |
| CI rule audit | `internal/ci-batch-fix-global-audit.md` |
| Umbrella issue | https://github.com/only21mil/masons-budget/issues/420 |

---

*Generated 2026-09-16 · Vogel Vault Budget app release lane*
