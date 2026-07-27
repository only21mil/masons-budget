# Convex production deploy hatch state

Checked: 2026-07-27

Target: production (`prod:keen-elephant-452`)

Source base: `build/finish-vogel-vault` at `e2d0781`

## Verdict

**Do not deploy from this evidence.** The production escape-hatch and token
configuration remains unknown because both authorized read-only commands failed
before reaching the deployment. The checkout did not have a
`CONVEX_DEPLOYMENT` binding, and the CLI reported:

```text
No CONVEX_DEPLOYMENT set, run `npx convex dev` to configure a Convex project
```

No suggested configuration command was run. In particular, no `convex dev`,
`deploy`, `run`, import/export, or environment mutation was performed.

## Production state

| Variable | Current production state |
| --- | --- |
| `ALLOW_TOKENLESS_READ` | **Unknown.** The environment listing failed. Repository documentation recorded it absent on 2026-07-26, but that is not a current production observation. |
| `ALLOW_TOKENLESS_SYNC` | **Unknown.** Both the environment listing and the direct read failed. |
| `CONVEX_READ_TOKEN` | **Unknown** (presence only could not be determined). |
| `CONVEX_SYNC_TOKEN` | **Unknown** (presence only could not be determined). |

The names of other configured production variables also could not be
determined. The failed listing returned no variable names or values.

## Commands attempted

These were the only Convex production commands run:

```bash
npx convex env list --prod
npx convex env get ALLOW_TOKENLESS_SYNC --prod
```

Their output was captured privately to avoid exposing environment values. Both
commands exited unsuccessfully with the missing-deployment-binding error above.

## Required state and correction

The deploy gate requires both `ALLOW_TOKENLESS_READ` and
`ALLOW_TOKENLESS_SYNC` to be absent, with both `CONVEX_READ_TOKEN` and
`CONVEX_SYNC_TOKEN` configured. A configured token is not sufficient when its
matching hatch is `"true"` because the hatch is evaluated first.

After an authorized operator supplies the production deployment binding, repeat
the read-only preflight and do not deploy unless the required state is
confirmed. If either hatch is present, remove it with the corresponding exact
command:

```bash
npx convex env remove ALLOW_TOKENLESS_READ --prod
npx convex env remove ALLOW_TOKENLESS_SYNC --prod
```

Those mutation commands are recorded for the authorized deploy operator; they
were **not** run during this check.
