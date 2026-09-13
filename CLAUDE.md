# Vogel Vault coding-agent instructions

Follow `AGENTS.md` in this repo. Reuse its instructions when supplied in context
or already read this session. Read it before work when those instructions are
missing, stale, or lost after compaction. Load task-scoped references when their
triggers apply, including all applicable safety and review instructions.
`AGENTS.md` carries the app-specific rules, family/visibility contract, and
release path.

Two things to know before you touch anything:

- **Tracking follows the Buzz-first rules in `AGENTS.md`.** GitHub is the CI
  mirror. Do not use Linear or commit to `main`.
- **Nothing is kept locally.** Clone where you need it, push the branch, delete
  the checkout. Builds run in GitHub Actions, not on a workstation.

## App Build Approval Gate

Do not start a distributable app build without Victor's explicit approval.

Freely: fix bugs, file Buzz issues, edit code, run static checks and tests.

Stop and ask before: bumping the build number for distribution, archiving,
exporting, uploading to TestFlight or the App Store, notarizing, or any other
release or distribution step. Releases run through
`.github/workflows/deploy.yml`, which is `workflow_dispatch` only — triggering it
is the gate.
