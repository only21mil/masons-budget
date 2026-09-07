# Lane C — budget month contract

Branch: `parent/cleanup-month-contract`  
Base: Buzz Vogel Vault main `@ 3a893d5`  
Scope: #291 month spelling, #294 device allowGap, #295 Apple UTC current month

## What changed

### 1. Month spelling split (#291 / da8796d…)

Device category upsert/delete compared the request month string to `existing.month` verbatim. Operator import stores English labels (`"August 2026"`); Android/Linux send canonical `yyyy-MM` → `ENTITY_CONFLICT`.

- Added `requireCanonicalBudgetMonthMatch` in `convex/tables.ts`.
- `upsertBudgetCategoryCore` and `deleteBudgetCategoryCore` now compare via `canonicalBudgetMonth` on **both** sides.
- Stored document spelling is **not** rewritten on upsert/delete (carry still uses `storedBudgetMonthLike` on advance).
- Apple `categoryDeletionIntent` now canonicalizes legacy English labels before eligibility (mirrors carry).

No production doc migration: migrate-compare only.

### 2. Close device `allowGap` (#294)

- Removed `allowGap` from `copyBudgetPlanForwardFromDevice` args.
- Device path always passes `allowGap: false` into the core helper (next-month-only).
- Operator multi-month advance remains on `operatorImport` (unchanged).
- Linux comment updated to match; renderer still never sends gaps.

### 3. Apple current month = UTC (#295)

- `CategoryDetailView.monthKey` default calendar is UTC Gregorian (`utcMonthCalendar`), matching Android `YearMonth.now(UTC)`, Linux/server `toISOString().slice(0, 7)`.
- `BudgetView` / carry eligibility call sites use the default (no local Gregorian override).

## Tests run

- `npx vitest run --config convex/vitest.config.ts` — **780 passed** (includes `budgetPlanCarry` + `budgetCategoryLifecycle`, including English-month upsert/delete and non-adjacent carry rejection).
- `npm run domain:test` — **195 passed**.
- Apple XCTest not executed here (no macOS runner in this worktree). New cases added in `AppleScreenAdoptionTests.swift` for UTC default + English budget month deletion intent.

## Commit

Local only; not pushed. See `git log -1` on this branch.

## Residual risks

- Live docs still mix English and `yyyy-MM` spellings until a deliberate operator migration; clients and guards now agree, but any code that still does raw string equality on `budgetDocuments.month` outside these cores can still drift.
- Apple UI month *strip* / spend filtering still uses local calendars for display scoping; only trusted-current-month eligibility for carry/delete was aligned to UTC.
- `copyBudgetPlanForwardCore` still accepts an internal `allowGap` flag; only the public device mutation is closed. Nothing else calls it with `true` today.
- Swift tests for the new Apple cases need a macOS CI/local Xcode run before merge confidence on Apple.
