# Traex integration validation — 2026-10-17

Base: `a436bb45f3092f89d914a2cd85492bb2843bf6ab`, branch
`feature/traex-agent`. The runtime and UI sources were validated before commit;
`main` was preserved. Native contracts were inspected from installed CLI help,
generated app-server bindings and real protocol responses.

## Local automated gate

The final serial `make ci` passed:

- Formatting, generated protocol types, workflow/shell lint and workspace
  all-target Clippy with warnings denied.
- 128 Server unit tests, 627 frontend tests and 76 final-binary E2E tests,
  plus the other workspace unit and documentation tests.
- Both native WebKit boundary harnesses, frontend typecheck/build and Rustdoc.

The deterministic Traex fixture runs without login or model calls. Its E2E cases
cover discovery, prompt-free open, streaming, reconnect/resume, durable queueing,
single-use approvals, structured questions, cancellation, failed/EOF turns,
Provider reconfiguration and redaction. Variant coverage verifies saved Max
selection, close/reopen, variant-specific effort validation, switching back to
Standard and applying queued selections after explicit resumption.

Native builds and E2E were run serially. No test was skipped or weakened.

## Installed real CLI

The final macOS validation used `traecli 0.210.1-alpha.3`; Linux SSH validation used
`traecli 0.210.1-alpha.2`. Disposable projects and isolated Server state separated
these checks from existing user conversations.

`scripts/smoke-traex.py` checked native model metadata, permission discovery and
prompt-free thread opening. `scripts/smoke-traex-model-variants.py` confirmed that
GPT-6.1-Sol accepts explicit `max` and `standard` thread configuration, with the
native catalog reporting 475,000 and 800,000 context windows respectively.
An additional isolated Server harness seeded only its disposable saved model
field, opened through the public protocol, and observed real Traex acknowledge
both native modes without sending a prompt or creating user events.

`scripts/smoke-traex-providers.py` exercised all nine protocol/auth combinations
against disposable localhost model fixtures: Anthropic Messages, OpenAI Chat and
OpenAI Responses, each with Bearer, raw API key and no authentication. It checked
endpoints, model changes, same native identity through idle reconfiguration and
close/resume, restoration of CLI configuration, isolation from inherited headers,
and absence of credentials from argv and durable files. These final mode and
Provider checks made no paid model-service calls. Both the exact signed macOS
Server embedded in the DMG and the Linux release Server passed.

## Native presentation

The Agent selection and conversation controls were checked in an isolated native
app with deterministic CLI events: keyboard Agent selection, retained drafts,
saved-task Agent identity, welcome label, permissions, execution/disabled states,
Stop, visible tool approval and structured question responses.

Follow-up checks used the actual ModelSelector and settings components inside an
isolated real WKWebView. Native model names remain in one column, with IDs in
hover text; long names truncate without horizontal scrolling. Claude aliases
retain their secondary column. Standard / Max opens independently of Effort;
selection, focus restoration, layered Escape, disabled controls and viewport
bounds passed. The final automated component check dispatched keyboard events
inside the page and captured real WebKit focus styles and layout. It is separate
from a full installed-app interaction claim.

## Packaging and SSH deployment

`make package` produced an arm64 DMG and checked image checksum, read-only remount,
Finder layout metadata, payload hashes and the strict bundle signature. Signing
is ad-hoc; no Developer ID signing or notarization is claimed.

- DMG SHA-256: `22dfc85bd75b658bfe4036db0a6c2ff2e6e6469d360d09490ac80ccac9fcaff1`
- Embedded macOS Server SHA-256: `ec89821f8a1f4f22bd1a9c50087e6af0b97ff9031a0631aaa3ff290960316aa6`
- Linux Server SHA-256: `9e522ca041c97d1c4e74376a4269db825ab8f06fcc6c03be24a148805a0e1363`

The Linux Server was built from the same runtime/UI source snapshot and deployed
to the SSH host after it became idle. The instance-bound upgrade handshake
replaced the daemon without cancelling a task or replaying prompts. Old binary
and consistent SQLite backups were retained; project, session and event counts
were unchanged across the switch. The deployed Server advertised Traex and returned
both GPT backend variants. No production model turn over SSH is claimed.

## Limits and retained evidence

Running-turn message insertion, native slash-command discovery, offline native
title edits and child transcript reads remain explicitly unsupported. Ordinary
FIFO queueing and explicit stop-and-send use the common runtime. App Providers
do not synthesize backend modes or reasoning capabilities absent native evidence.

Logs, source manifests, native reports and screenshots remain under the ignored
`.oh-my-code/validation/traex-agent/` directory. Distributable artifacts and their
provenance were also preserved outside the build target. Scoped Rust build outputs
were cleaned only after checking occupancy; dependency caches and unrelated
worktrees were preserved. Generated bundles, credentials, databases and logs are
excluded from the PR.

## PR #15 review follow-up

The follow-up to `30a296f` fixes duplicate completion-only assistant text,
hover-driven submenu focus and late interrupt errors after an explicitly
completed turn. Early completions are bounded and wait for matching native start
evidence; unrelated turn IDs cannot settle the admitted turn. Active-turn
interrupt failures remain errors.

The follow-up's complete serial `make ci` passed with 132 Server unit tests,
631 frontend tests and 78 final-binary E2E tests, plus formatting, generated
types, workflow/shell lint, all-target Clippy, native WebKit boundary tests,
frontend typecheck/build and documentation checks. No test was skipped or weakened.

Focused checks passed: 14 Traex adapter/metadata/provider unit tests, 12 model
selector/picker tests and seven final-binary Traex E2E tests. Regressions cover
completion deduplication/reset/limits, both start-evidence orders, stopping before
admission, stale completions, late interrupt errors and follow-up execution in the
same native process. Approval coverage adds file/permission accept/deny/single-use
unit cases and a valid command-accept E2E flow; empty-thread close/reopen remains
prompt-free and never attempts to resume a missing rollout.

The actual updated ModelSelector also passed 19 assertions in an isolated native
WKWebView: hover preview keeps focus on the parent, arrows navigate the correct
menu, explicit click/Right enters modes, Escape restores focus, and disabled
triggers/unsupported Effort cannot open menus. Input events were dispatched
inside the page; this is native WebKit component evidence, separate from a full
installed-app interaction claim. The harness yields to browser tasks for rendering
rather than relying on background-throttled timers. Reports and harness sources
are retained under ignored `log/traex-review-fixes/`.

The earlier DMG and deployed SSH Server hashes above describe the build before
this follow-up; those artifacts were not replaced as part of the PR repair.
