# Vogel Vault GitHub Migration Report — 2026-06-03

Linear:
- Project: `Vogel Vault -> GitHub Migration`
- Build lane: SAT-1224
- Follow-behind lane: SAT-1225

## Summary

Codex started the migration lane and verified that GitHub already has the private canonical candidate repo:

- GitHub repo: `only21mil/masons-budget`
- Visibility: private
- URL: `https://github.com/only21mil/masons-budget`
- Default branch on GitHub: `main`
- Active local branch: `codex/SAT-691-build-22-regression-fixes`
- Active local branch is aligned with `origin/codex/SAT-691-build-22-regression-fixes` at `a56645c`.

No app build, archive, upload, TestFlight action, signing credential handling, public visibility change, external send, or repo push was performed.

## Changes Made Locally

- Repaired stale Git metadata that blocked history scanning:
  - Pruned dead worktree metadata for stale Mac-side Claude/Codex worktrees.
  - Removed invalid local branch ref `refs/heads/claude/busy-chaplygin-1bb81e`.
  - `git fsck --no-dangling` is now clean.
- Changed local `origin` from SSH to HTTPS:
  - Old SSH remote could not read GitHub from DGX (`Permission denied (publickey)`).
  - New remote is `https://github.com/only21mil/masons-budget.git`.
  - `git fetch origin --prune` succeeds.
- Set upstream for `codex/SAT-691-build-22-regression-fixes` to `origin/codex/SAT-691-build-22-regression-fixes`.
- Tightened `.gitignore` for local-only and distribution-sensitive artifacts:
  - `.convex/`
  - `Build/`, `Archives/`, `*.xcarchive`, `*.pkg`, `*.dmg`, `*.app`
  - `*.p8`, `AuthKey_*.p8`, `*.p12`, `*.mobileprovision`, `*.provisionprofile`

## Verification

- `gh repo view only21mil/masons-budget` confirms private repo and default branch.
- `gh api repos/only21mil/masons-budget/branches` confirms branches:
  - `main`
  - `codex/SAT-691-build-22-regression-fixes`
  - `claude/busy-chaplygin-1bb81e`
- `git fetch origin --prune` succeeds after HTTPS remote change.
- `git rev-list --left-right --count HEAD...origin/codex/SAT-691-build-22-regression-fixes` returned `0 0`.
- `.github/workflows/deploy.yml` is manual-only via `workflow_dispatch`; normal pushes should not auto-run TestFlight.
- `git diff --check` is clean.

## Blockers / Risks

1. Gitleaks history scan finds one historical `generic-api-key` finding:
   - File: `MasonsBudget/MasonsBudget/Services/ConvexClient.swift`
   - Commit: `869f000d7944f79898d8b585383c75366e32f622`
   - The commit already exists on GitHub.
   - The secret value was not printed or copied into this report.

2. Gitleaks worktree scan finds one ignored local Convex config finding:
   - File: `.convex/local/default/config.json`
   - This file is ignored and not tracked.
   - `.gitignore` now explicitly ignores `.convex/`.

3. The current working tree has pre-existing app/code changes unrelated to repo migration:
   - 13 modified tracked files plus 3 untracked files before this report.
   - The dirty changes include app behavior changes and `CURRENT_PROJECT_VERSION` changing from 32 to 33.
   - Do not blindly commit or push the dirty tree as part of GitHub migration.

4. Historical secret handling needs a decision before declaring the repo clean:
   - Option A: accept that the historical value was already pushed to the private repo and is rotated/dead, then proceed with documented risk.
   - Option B: rewrite Git history and force-push cleaned branches, which requires explicit approval because it rewrites existing GitHub history.
   - Option C: create a fresh sanitized repo/import if history rewrite risk is too high.

## Claude Code Follow-Behind Tasks

SAT-1225 should verify:

1. Fresh clone over HTTPS works from DGX or the intended build host.
2. The clone has the expected branches and no SSH dependency.
3. `.gitignore` covers `.convex/`, Apple signing files, and build/archive/export artifacts.
4. The workflow remains manual-only and cannot auto-upload TestFlight from normal pushes.
5. The historical gitleaks finding is treated as a blocker until Victor/Sats chooses accept-rotated, rewrite-history, or fresh-sanitized-import.
6. Dirty app changes are not bundled into migration unless separately reviewed and approved.

## Current Recommended Next Step

Pause before any push that changes GitHub history or packages the dirty tree. Decide the historical secret policy first, then let Claude Code run SAT-1225 as the independent follow-behind verifier.
