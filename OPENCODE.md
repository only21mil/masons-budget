# Vogel Vault coding-agent instructions

Read `AGENTS.md` in this repo before doing any work. It carries the app-specific
rules, the family/visibility contract, and the release path.

Two things to know before you touch anything:

- **Tracking is GitHub only.** Branch, then open a pull request. Do not use
  Linear. Do not commit to `main`.
- **Nothing is kept locally.** Clone where you need it, push the branch, delete
  the checkout. Builds run in GitHub Actions, not on a workstation.

## App Build Approval Gate

Do not start a distributable app build without Victor's explicit approval.

Freely: fix bugs, file GitHub issues, edit code, run static checks and tests.

Stop and ask before: bumping the build number for distribution, archiving,
exporting, uploading to TestFlight or the App Store, notarizing, or any other
release or distribution step. Releases run through
`.github/workflows/deploy.yml`, which is `workflow_dispatch` only — triggering it
is the gate.
