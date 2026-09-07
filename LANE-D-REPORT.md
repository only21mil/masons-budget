# Lane D report — dead-code / overgrowth cleanup

**Worktree:** `/home/victor/work/vv-lane-deadcode`  
**Branch:** `parent/cleanup-deadcode`  
**Base:** Buzz main `@ 3a893d5`  
**Date:** 2026-09-07  
**Scope:** behavior-preserving cleanup only. No push. No GitHub remote added.

## Kept

| Item | Why |
| --- | --- |
| `AGENTS.md` | Canonical agent instructions |
| `CLAUDE.md` | Single stub pointer to `AGENTS.md` (OpenCode stub removed) |
| `docs/HANDOFF.md` | Tombstoned with stale banner; still linked from README / runbooks |
| `drafts/SwiftDataModels.swift` | Marked STALE; not deleted (historical sketch) |
| Apple blob fallback (`ConvexDataReader` / shipped blob readers) | Still present in production client code; **not proven row-only** |
| `tables.ts` god-file | Out of scope (Lane C collision risk) |
| Month spelling / allowGap / copy-forward credential / theme | Other lanes |
| Fixture legacy keys in Android/Swift parity decoders (`mc2TransactionsFileName` fallback keys) | Harmless decode fallbacks; fixtures already use `transactionsDataFileName` |

## Removed / extracted

| Change | Detail |
| --- | --- |
| **Extracted** `convex/tokenAuth.ts` | Shared `validateSyncToken` / `validateReadToken` / `warnPermissive` used by `dataFiles.ts`, `tables.ts`, `writeback.ts`, `marketQuotes.ts` |
| **Removed** `scripts/move-mc2-to-icloud.sh` | One-shot MC2→iCloud move script; dead |
| **Removed** `mc2TransactionsFileName` alias | From `shared/domain/src/family.ts`; writeback test now asserts `transactionsDataFileName` |
| **Removed** `OPENCODE.md` | Identical to `CLAUDE.md`; keep one pointer max |
| **Tombstone** `docs/HANDOFF.md` | Stale banner (audit 2026-07-29) |
| **Tombstone** `drafts/` | `drafts/README.md` + header note on SwiftData draft |
| **Doc touch** `docs/convex-deploy-hatch-state.md`, `AGENTS.md` | Point at `tokenAuth.ts` |

## Tests run

- `npm run convex:test` — **779 passed** (27 files)
- `npm run domain:test` — **195 passed**
- `npm run domain:typecheck` — **pass**

## Follow-ups (not done this lane)

1. **Apple blob fallback retirement** — `MasonsBudget/.../ConvexDataReader.swift` still has explicit legacy-blob fallbacks. Need strong production evidence that all shipped Apple clients are row-only before deletion.
2. Optional: drop Android/Swift fixture decoder legacy key aliases once all consumers only emit `transactionsDataFileName` / `btcBuysDataFileName` / `hasDedicatedChildFinanceFiles`.
3. `docs/HANDOFF.md` rewrite or archive once a current architecture note replaces it (README still points here).
4. Do not split `tables.ts` here — coordinate with Lane C.
