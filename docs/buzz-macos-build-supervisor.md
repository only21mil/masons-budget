# MBP unsigned build supervisor

The existing `m5mbp` GitHub runner keeps the signing role. A root-owned supervisor
runs public Buzz source and dependencies as the dedicated `buzzbuild` UID, inside
Seatbelt. This account has no runner registration, credentials, login shell,
password authentication, home contents, or supplementary groups. Same-UID
Seatbelt alone is insufficient: an MBP probe read a public parent-environment
canary through `KERN_PROCARGS2`. No real secrets were read by that probe.

## Exact installed contract

The only runner sudo rule is:

```sudoers
m5mbp ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/buzz-macos-build/buzz_macos_build_supervisor.py
```

The supervisor takes no command-line arguments. JSON on stdin contains exactly
`source_sha`, `version`, `arch`, `updater_public_key`, `updater_endpoint`, `run_id`,
`run_attempt`, `workflow_sha`, and `output_dir`, all strings. The caller identity
comes from sudo's `SUDO_UID`, checked against the fixed `m5mbp` account. Requests
cannot choose an account, root command, source repository, or installation path.
The updater endpoint is fixed to the existing Buzz release channel.

The client hashes all six installed payload files against its exact workflow
checkout. The supervisor separately validates their root ownership, ancestor
permissions, absence of extended ACLs, and installation hashes. Its receipt must
match the request's full workflow commit. The receipt is public configuration,
not a credential. Every workflow change that changes the executing commit needs
an installation receipt for that exact commit, even if the payload bytes match.

The root-owned global state directory is `/private/var/db/buzz-macos-build`, mode
0711. Its global nonblocking lock permits one build at a time. Each build gets a
fresh `build-*` root with mode 0700, owned by UID/GID 590. The installer refuses
any preexisting `buzzbuild` account/group or use of numeric UID/GID 590. The
supervisor refuses any preexisting real or effective build-UID process.

After clearing supplementary groups and dropping GID and UID, the supervisor
executes installed `buzz_macos_build_boundary.py --payload ROOT` with a minimal
environment and closed inherited descriptors. The post-drop check reads kernel
groups through libc because macOS Python reports directory-service access
groups. Only the dedicated primary GID may remain in the kernel group list. Only that unprivileged payload
starts Seatbelt, clones the fixed public repository, and builds the exact source.
The supervisor does not execute checkout code as root. The supervisor drains build stdout/stderr through a pipe and retains only the
last 64 KiB in memory. On failure it emits that diagnostic tail as one base64
line, which cannot emit runner workflow commands or terminal control bytes.
Decode that public tail locally to investigate Hermit/compiler failures. The
boundary failure message itself is fixed and does not interpolate input values.

Before exporting, the supervisor kills all real/effective build-UID processes,
reaps its child, retires only the dedicated `user/590` launchd domain, and
requires two empty process readbacks. The domain teardown prevents launchd
from restarting the UID's notification helper after a process kill. A failed
teardown refuses export. Do not verify absence with `launchctl print user/590`:
that query creates the domain again. Use the successful exact-domain bootout
and non-creating process observations, including a delayed readback for live
acceptance. No other user or system domain is touched. It opens the caller's
empty mode-0700 output directory before launching the build and retains the
file descriptor. It transfers exactly `unsigned-{arch}.app.tar.gz` and
`build-{arch}.json`, as inert regular files. Component symlinks, output symlinks,
hardlinks, special files, extra outputs and oversized files fail closed. The
existing signing phase must still verify the archive and provenance. Root tree
cleanup completes before the supervisor reports success. A failed build,
drain, export, or cleanup must leave the workflow unable to upload or sign.

## Review and prepare

Review the coupled workflow, client, payload, Seatbelt profile, supervisor,
provisioning tool, and tests as one candidate. Live account, sudoers, and payload
changes require the controlling parent's GO after that review. The provisioning
tool is an operator tool and is never included in the runner sudo rule.

Use the current private `only21mil/workstation-bootstrap` checkout and documented
MBP operator route for developer tools:

```bash
cd /Users/m5mbp/work/workstation-bootstrap
scripts/doctor --profile apple-primary
```

If tools are missing, change/review the appropriate maintained manifest and use
`scripts/bootstrap --host mbp` through that route. Do not install global Node,
pnpm, Rust, or Hermit as an ad hoc fix. This candidate needs system Python,
Bash, Git, curl, OpenSSL, sandbox-exec, ps/pkill and Xcode's clang. Hermit obtains
the source-pinned build tools inside the disposable build home. Xcode selection
and licenses are operator prerequisites. The installer checks tool presence and
clang resolution, without building an app or changing Xcode.

Prepare from a clean checkout at the exact full workflow commit approved for
installation. The installer cannot infer a later merge commit. Record that
commit and the printed manifest digest in the reviewed activation record.

```bash
/usr/bin/python3 -I .github/workflows/scripts/buzz_macos_build_provision.py prepare \
  --checkout /absolute/clean/Budget-checkout \
  --commit FULL_REVIEWED_WORKFLOW_SHA \
  --bundle /absolute/new/private/buzz-build-bundle
```

The bundle contains the six exact committed files plus `bundle.json`. Transfer
only those public files to the MBP with the existing operator connection.
Independently retain the manifest SHA-256 produced above. The root installer
checks that digest and every file hash, then holds the checked payload in memory
before writing installation files. Supply the reviewed provisioning script via
the same operator route and verify its own SHA-256 against the reviewed checkout
before executing it. No credentials belong in this bundle, argv, or logs.

## Install after GO

Run the exact reviewed operator script with the exact reviewed bundle digest:

```bash
sudo /usr/bin/python3 -I /absolute/reviewed/buzz_macos_build_provision.py install \
  --bundle /absolute/private/buzz-build-bundle \
  --manifest-sha256 REVIEWED_BUNDLE_SHA256
```

The installer does not overwrite or adopt existing installation state. It may
create missing fixed `libexec` and `sudoers.d` parents beneath protected parents.
It refuses a user-writable or ACL-bearing existing ancestor; do not broadly
change existing `/usr/local` ownership to bypass that refusal. Such a host
requires a reviewed path or ownership repair. The installer creates a public
installation manifest and a root-only state receipt, the disabled dedicated
account, six root-owned files, and a `visudo`-checked sudo rule published last.
No GitHub credentials are created or reused by the build account.

Keep the existing runner idle while installing. After installation, retain
readbacks of the exact commit/hashes, account UID/GID/shell and disabled-login
attributes, root file permissions/ACLs, `visudo -c`, and the absence of processes
under UID 590. Then run the approved workflow. Required live checks include a
public parent-environment canary across UIDs, denial of host-private file access,
normal Hermit activation/build completion, escaped-descendant termination,
malicious-output refusal, and successful two-file handoff. Linux focused tests
cover logic and filesystem behavior but do not prove macOS kernel isolation.

## Recovery and removal

A supervisor killed with SIGKILL or a host crash can leave a build root and UID
processes. The next build refuses preexisting UID processes. Do not bypass that
refusal or sign an earlier output. Revoke the exact sudo rule and have the root
operator terminate UID 590 processes, verify none remain, and inspect only the
owned build roots before an approved cleanup. Do not reuse a compromised or
uncertain account for another purpose.

Normal reviewed removal uses the retained installed commit:

```bash
sudo /usr/bin/python3 -I /absolute/reviewed/buzz_macos_build_provision.py remove \
  --commit FULL_INSTALLED_WORKFLOW_SHA
```

Removal revokes the exact sudo rule first, refuses live UID processes, stale
build roots, changed payload bytes or changed account identity, then removes
only the installed six-file payload, dedicated account/group and owned state.
Parent directories are preserved. Keep the original bundle and public receipt
in evidence before removal. Install a replacement with a newly reviewed bundle.
A partially failed installation preserves its state receipt and stops; account
creation failures or unexpected partial files require an exact operator recovery
plan, not automatic deletion of an existing host identity. No account or tool
was provisioned while preparing this candidate.
