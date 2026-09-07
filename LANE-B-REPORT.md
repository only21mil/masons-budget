# Lane B report — copy-budget-forward credential failure

## Root cause

The user-facing string `Plan not copied: the credential is missing or was rejected.` comes from Android `convexWriteFailureMessage` when `ConvexResult.Unauthorized` is returned.

Copy-forward was wired only to `tables:copyBudgetPlanForwardFromDevice`, which requires paired-device capability `budget:write`. Android read-bootstrap pairing accepts and stores credentials with **`todos:write` only** (any other capability set is treated as an invalid bootstrap response). So a normal Android device credential can never authorize the device carry mutation: missing credential → local `Unauthorized`; present todos-only credential → server `DEVICE_UNAUTHORIZED` → same `Unauthorized` banner.

Meanwhile Android budget **category upsert** already uses the household sync-token path (`tables:upsertBudgetCategory` via `ConvexMutationClient`). Copy-forward was added on the wrong auth surface for Android.

Linux and Apple keep using the paired-device route (`budget:write` / mobile pairing), which is correct for those clients.

## Fix

1. Added sync-token mutation `tables:copyBudgetPlanForward` in `convex/tables.ts` (adjacent-month only, no `allowGap`; receipt `deviceId` = `"sync-token"`).
2. Routed Android `BudgetPlanCarryGateway` through `ConvexMutationClient` + `ConvexMutation.CopyBudgetPlanForward`.
3. Taught sync-token client to classify structured `PLAN_EXISTS` so carry UX stays specific.

Did **not** change month storage spelling (Lane C). Did **not** push. Did **not** add a GitHub remote.

## Files changed

| File | Change |
| --- | --- |
| `convex/tables.ts` | New `copyBudgetPlanForward` sync-token mutation |
| `convex/budgetPlanCarry.test.ts` | Sync-token success, auth reject, no-gap tests |
| `android/.../ConvexMutation.kt` | `CopyBudgetPlanForward` → `tables:copyBudgetPlanForward` |
| `android/.../BudgetPlanCarryGateway.kt` | Use `ConvexMutationClient` |
| `android/.../VaultApplication.kt` | Wire carry gateway to sync-token client |
| `android/.../ConvexMutationClient.kt` | Classify structured `PLAN_EXISTS` |
| `android/.../BudgetPlanCarryGatewayTest.kt` | Assert sync-token wire + missing-token Unauthorized |
| `android/.../BudgetPlanCarryComposeTest.kt` | Assert sync-token path + credential banner |

## Tests run

```bash
npx vitest run --config convex/vitest.config.ts convex/budgetPlanCarry.test.ts
# Test Files  1 passed (1)
# Tests  12 passed (12)

cd android && ./gradlew :app:testDebugUnitTest \
  --tests 'com.sats21m.vogelvault.data.BudgetPlanCarryGatewayTest' \
  --tests 'com.sats21m.vogelvault.ui.BudgetPlanCarryComposeTest' \
  --tests 'com.sats21m.vogelvault.data.ConvexMutationTest'
# BUILD SUCCESSFUL
```

## Residual risk

- **Deploy required**: production must deploy the new `tables:copyBudgetPlanForward` export before an Android build that calls it will succeed.
- Android still needs a configured sync token (same as category upsert). Devices without it keep seeing the credential banner — now an accurate description for that client.
- Linux/Apple remain on `copyBudgetPlanForwardFromDevice`; if an Apple pairing lacks `budget:write`, they still get Apple’s “sync credential…” unauthorized copy (separate from this Android string).
- Longer-term: grant Android `budget:write` (or migrate category upsert off sync-token) so finance writes share one least-privilege surface.
