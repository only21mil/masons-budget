# Convex codegen safety

`npm run codegen` checks the committed schema checksum and API module inventory
against local sources. It runs `scripts/check-convex-generated-change.sh HEAD`
without Convex, credentials, package downloads, or remote requests. It does not
regenerate bindings or prove declaration freshness inside existing modules.
Local TypeScript checks and the existing credential-free CI checks remain useful.
Never edit a checksum to present an unperformed generation as successful.

## Remote preparation requires separate approval

Convex 1.42.3 ordinary codegen calls authenticated `start_push`. It can persist
pending schemas, allocate tables, and prepare indexes. The inspected path does
not call `finish_push`, which activates the running code. Those are different
effects; a claim of no running-code activation does not establish no remote
change. `--dry-run` is not an approved nonwriting substitute and the wrapper
refuses it. Direct `npx convex codegen` bypasses these guards and remains subject
to the same remote-action approval gate.

Before remote generation, obtain Victor's explicit approval for the exact
reviewed revision, target URL and persistent preparation effects. An effect
acknowledgement flag records neither approval nor its validity. A feature-fix
request, passing CI, and this document do not approve a production action.

Only after that approval, use an already approved process that injects
`CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`. Despite their names,
the inspected CLI accepts these as a direct URL/admin-key pair and uses the URL
unchanged. The wrapper supports exact HTTPS `*.convex.cloud` origins only. It
requires the injected URL to equal the explicit command target. It never prints
the pair or passes the key in command arguments. Do not put secret values in a
command line, repository, report or log.

If that approved injection is unavailable, stop. This change does not create or
convert credentials, establish a new authentication route, or authorize auth
setup. Ordinary `CONVEX_DEPLOY_KEY`, its `CONVEX_DEPLOYMENT_TOKEN` alias, project
keys, preview keys, logged-in deployment selection and production defaults are
not supported by this wrapper. Existing login configuration cannot select the
target when the validated direct pair is used.

Use the exact approved URL in place of the non-production example below. This
is an invocation template, not approval to run it:

```sh
npm run codegen:remote -- --target-url https://approved-example-123.convex.cloud --acknowledge-remote-preparation
```

The wrapper refuses any other `CONVEX_*` variable, legacy mismatch flags, Node
preload overrides, `.env`, or `.env.local`. It checks file existence without
reading their contents. Use an approved clean execution context; do not remove
another lane's files or alter credentials to get past a refusal. Extra CLI
arguments are rejected, including target, key and env-file overrides.

The subprocess uses the already installed Convex 1.42.3 entrypoint directly,
with only the validated pair and basic execution variables. Other versions fail
closed until their selection and preparation contracts receive review. The
wrapper disables CLI telemetry with `CI=1` and suppresses CLI stdout/stderr,
including error objects, since failures can echo secrets or server content.
A failure after CLI startup may already have remote effects. Do not retry
without assessing those effects under the approval gate. Typechecking is
disabled in that subprocess; run the existing local TypeScript checks separately.

After success, the wrapper records the schema checksum only if the local schema
has stayed unchanged during execution. Review all generated-file differences
and commit them. The checksum remains a convention, not proof of approval or
who ran generation. Concurrent source edits invalidate the reviewed revision;
use an isolated checkout without another writer for the approved action.

For a clean-tree comparison after explicit approval, the stronger remote check
accepts the same target and acknowledgement arguments:

```sh
scripts/verify-convex-generated-freshness.sh --target-url https://approved-example-123.convex.cloud --acknowledge-remote-preparation
```

That script performs remote preparation, then checks generated-file drift. It
must never be described as a local-only check or run automatically in ordinary
CI. Without the explicit arguments it refuses before starting Convex.

## Existing incident remains unresolved

The two recorded codegen invocations on 2026-09-13 used a wrapper that silently
defaulted to production. Inherited environment and deploy-key precedence could
have changed the actual target. Their resolved target and persistent effects
remain unknown. No running-code activation was established. This source fix
does not establish that production was untouched, inspect deployment metadata,
or resolve the B2 operational hold. Follow-up is tracked under issue #358.
