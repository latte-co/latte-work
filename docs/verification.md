# Verification — 2026-09-22

## Automated local gate

`make ci` on macOS arm64 / Rust 1.97 / Node 24:

- Rustfmt, Prettier, Clippy with warnings denied.
- Generated Rust-to-TypeScript contract consistency.
- actionlint and ShellCheck.
- 7 Rust unit tests: protocol, SSH argument safety, Claude decoding and permission
  responses, project path containment, request deduplication and restart recovery.
- 5 final-server-binary E2E tests using a deterministic CLI fixture: singleton
  exclusion, multiple clients, disconnect/reconnect, explicit allow/deny, expired
  approval rejection, native resume, duplicate send, concurrent sessions,
  process-group cancellation, malformed/early-exit errors, file limits, Git,
  browsing directories before registration, named projects, and host isolation.
- 6 frontend tests: transcript replay/turn/approval handling and host-scoped
  project identity, offline catalog retention, and malformed/unavailable storage.
- TypeScript strict check, production Vite build, Rustdoc with warnings denied.

The fake CLI is explicitly a test fixture, not the product's agent. These tests
are independent of provider authentication and do not claim real model execution.

## Real Claude Code

Installed CLI: `2.1.278 (Claude Code)`.

- Live initialization/control handshake succeeded.
- Live server → Claude → persisted text/result returned `LATTE_WORK_SMOKE_OK`.
- Live permission callback reached the server; denial was accepted by Claude.
- A separate live allow test approved only the exact disposable `approval.txt`
  write and verified its `LATTE_APPROVAL_OK` contents after completion.
- Optional reproducible checks: `python3 scripts/smoke-claude.py` and
  `python3 scripts/smoke-claude.py --approval`. These use the host's real Claude
  login and disposable directories; they are deliberately outside `make ci`.

## Native macOS application

Used the bundled Tauri app, not a browser mock:

- Added the implementation worktree as a local project using the UI.
- Displayed its file listing and README contents in the right pane.
- Sent a real task and rendered Claude text and tool events.
- Pasted and sent Chinese text; a resumed turn returned
  `中文输入正常，LATTE_DESKTOP_OK。`.
- Quit Desktop while that turn was running and reopened it. The project and
  history recovered, the turn continued, and the server instance ID remained
  `3842247f-18e0-46a9-acd8-28271f512049` across the desktop restart.

The final release bundle was separately launched, recovered persisted projects
and sessions, and passed the new-task keyboard shortcut and file-preview checks.
The desktop and bundled/standalone server were verified as macOS arm64. The
standalone deliverable is byte-identical to the bundled server. Project-owned
ad-hoc signing passes `codesign --verify --deep --strict`.

This validates Chinese paste; a manual Chinese IME composition test is separate.

## Boundaries

SSH transport is implemented, including argument validation and the same server
connect bridge. No real remote host was used in this validation pass. Linux
server and macOS desktop jobs are defined in GitHub Actions; no remote CI has
run because this repository has not been published. Branch protection has not
been configured. There is no coverage percentage claim.

The app is not Developer ID signed or notarized. V0.1 does not implement remote
binary deployment, integrated terminals, other agents, or Windows. Host daemon
crash recovery reports Unknown; it does not promise continuation of a partially
executed tool or cleanup after SIGKILL/power loss.

## Project creation follow-up

The updated release app was exercised through native macOS UI:

- No global host selector; the sidebar project row includes its host.
- Creation form device menu shows this computer and the add-remote entry.
- Add-remote opens the SSH form; closing it returns to project creation.
- Add opens the real macOS folder picker. Cancel returns without selecting
  a path or enabling creation.
- Selecting the existing implementation directory fills its name and absolute
  path. Creation selects the existing project without a duplicate and preserves
  its prior sessions. No model request was sent in this follow-up.
- `make ci` passed with 12 Rust tests and 6 frontend tests; `make package`
  rebuilt the release app with the native dialog plugin and protocol v2 server.
- The idle v1 daemon was stopped after checking it had no running/waiting
  sessions, then the new app started the v2 server against the existing state.

Remote directory browsing is covered through the real server binary and
private socket; no live SSH host or remote native-UI path was tested.

## Sidebar collapse follow-up

The release app was rebuilt and checked in the native UI. Clicking the project
name hides both task rows, changes both disclosure controls to collapsed, and
keeps the current project/conversation visible. Clicking the same name again
restores the task rows. The arrow uses the same toggle behavior. TypeScript,
production frontend build, formatting, packaging and strict signing passed.

## Project name focus styling

Native release UI screenshots confirm the project-name group has one complete
rounded focus border around both folder icon and input, with no clipped inner
outline. Tab moves focus away and restores the neutral border; Shift-Tab restores
the group border. Formatting, TypeScript, release packaging and signing passed.


## Provider catalog and Agent bindings (2026-09-22)

- `make ci` passed: 16 Rust tests (8 server unit tests, 6 final-binary integration
  tests, 2 client/protocol tests), 6 frontend tests, generated TS contract, Clippy
  with warnings denied, typecheck/build, and rustdoc.
- The Provider catalog accepts all three protocol kinds independently from Agent
  selection. Claude compatibility is checked by the server and native adapter.
  Tests cover revisions, atomic persistence, schema-1 migration, permission 600,
  retained secrets, invalid updates, local binding, and imported-snapshot cleanup.
- Two real server processes and a deterministic SSH executable fixture exercise
  the same `Client::ssh` byte bridge used in deployment. A selected local snapshot
  is copied and bound remotely; updating locally leaves the remote version intact
  until sync. Offline sync preserves the old copy, resume uses the new model after
  sync, and unbinding removes unreferenced imported credentials. No real SSH host
  or real external model provider was used; those deployment paths are unverified.
- Real Claude Code 2.1.278, with disposable HOME/project/state and a localhost
  Anthropic fixture, completed tool -> approval -> file write -> reply. Continuing
  the same native session used the updated model. Saving OpenAI Chat/Responses
  configurations succeeded, and associating either with Claude was rejected.
  No paid model API was called.
- Native packaged UI verified the separate Provider / Code Agent pages, absence
  of host selection in Provider management, dark application-owned protocol menu,
  keyboard ArrowDown/Enter selection, and Claude's compatible-only provider list.
  Saving an Agent binding returned visible success and was verified via the server.
  Disposable UI fixtures were removed and the original binding restored. The
  release sidecar also passed the real-CLI localhost smoke above.

## Project context menus (2026-09-22)

- `make ci` passed with 17 Rust and 6 frontend tests. The added final-binary
  test covers validated rename, active-task removal rejection, reversible
  removal, reconnect persistence, preserved files and sessions, and restoring
  the original project identity by adding the same directory.
- `make package` and strict bundle signing verification passed. The running
  desktop uses protocol v5 with the updated local server; the old idle daemon
  was stopped only after checking for running or waiting sessions.
- Native UI verified that right-clicking empty space or selected input text
  does not open the default WebView menu. Project right-click exposes pin,
  edit, local Finder reveal, and remove. Pin/unpin changes ordering and the
  pinned preference survives desktop restart. Finder reveal selected the exact
  disposable fixture directory.
- The native automation reader lost the window tree/screenshot after opening
  the edit dialog; a desktop restart restored observation. Edit/remove dialogs
  therefore do not have a complete native UI acceptance result in this pass.
  Their server behavior is covered by the integration test above.
- Test input was cleared, the disposable project unpinned and removed from the
  visible catalog, and its directory retained. No model request was sent.

Section management and chat archiving are outside this four-action iteration.

## Independent settings page (2026-09-22)

- Replaced chained connection/Agent/Provider dialogs with one full-window settings
  page. Connection and Agent settings and the local Provider catalog are sibling
  tabs, with persistent navigation and a return-to-workbench action.
- `make ci` passed (17 Rust and 6 frontend tests); subsequent navigation refinements
  passed frontend formatting, strict TypeScript checking and production build.
  The signed release app embeds the final `index-pzHYbEzu.js` asset, verified from
  the executable, and passed strict bundle signature verification.
- Native packaged UI verified both tab layouts, mouse and arrow-key switching,
  Provider form retention across switches, reconnect staying on the settings page,
  and Escape returning to the workbench while retaining its unsent input.
  Escape in the protocol dropdown closes only the dropdown.
- Cleared both disposable drafts without saving configuration or sending a model
  request. The unchanged v5 server continued running during the desktop update.

## Model selection and settings alignment (2026-09-22)

- `make ci` passed: 19 Rust tests and 6 frontend tests, formatting, generated
  protocol consistency, Clippy, frontend typecheck/build and Rustdoc.
- Final-server tests cover CLI alias selection, clearing a resumed override,
  Provider-specific validation, per-turn model changes, unchanged Provider
  defaults, reconnect persistence, model-aware duplicate rejection, legacy
  request-table migration, and model catalogs across the SSH transport fixture.
- Real Claude Code 2.1.278 against a disposable localhost Anthropic fixture
  completed a tool/approval turn using the Provider default and a resumed turn
  selecting another configured model. The default remained unchanged and both
  requests used the expected model. No paid model API was called.
- Native release UI verified the return action below the window control area,
  separate default/extra-model fields, editing and saving the model list, and
  the composer menu containing exactly the bound Provider's models plus Default.
  Keyboard selection updated the composer label; Home restored Default.
- The UI-only fixture was deleted after restoring the original binding; no
  task was sent from the desktop during this check. Protocol v6 was launched
  after confirming the prior daemon had no running/waiting tasks. Release
  packaging and strict bundle signature verification passed.

## Compact session activity (2026-09-22)

- Replaced separate call/result cards with ID-paired inline disclosures. Adjacent
  operations form one collapsed group; commentary separates groups. Errors and
  approval controls remain individually visible. Expanded output is scrollable
  and bounded to 300 CSS pixels; full input/output remain available.
- Conversation body now uses 15px text and distinct Markdown heading sizes;
  repeated Agent labels no longer interrupt each assistant paragraph. Tool rows
  use action descriptions and compact paths, with full paths in details/tooltips.
- `make ci` passed (19 Rust tests and 14 frontend tests). Final projection/path
  refinements also passed all 14 frontend tests, TypeScript and formatting; the
  release packaging rebuilt the final frontend (`index-CdOwc4zq.js`).
- Eight activity tests cover out-of-order results, commentary boundaries, errors,
  approvals, unmatched results, reused IDs across turns, interrupted operations,
  and descriptive labels. No protocol or host execution changes were made.
- `make package` and strict bundle signature verification passed. The app was
  installed at `.local/artifacts/Latte Work.app`, with the prior bundle preserved
  in `.local/before-message-flow/`. After macOS was unlocked, native UI validation
  confirmed the existing project-structure conversation now renders its 22
  call/result cards as one summary containing 5 commands and 6 file reads.
  Mouse expansion, paired input/output, independent bounded output scrolling,
  keyboard collapse, group collapse, and the larger Markdown typography were
  verified in the packaged app. The existing host daemon stayed running during
  the desktop replacement; no model request was sent during validation.

## Collapsible project sidebar (2026-09-22)

- Added a persistent upper-left sidebar toggle beside the macOS window controls.
  Hiding the sidebar also removes its resize divider and gives the conversation
  the available width. The control remains accessible when collapsed. Sidebar
  visibility and preferred width are saved locally; expanding constrains the
  right workspace if needed. Conversation and sidebar components stay mounted.
- `make ci` passed (19 Rust and 14 frontend tests), as did release packaging and
  strict signature verification. The new app is running from `.local/artifacts/`;
  the previous bundle is preserved in `.local/before-sidebar-toggle/`.
- Native packaged UI verified collapse/expand, preserved unsent draft and open
  tool disclosures during toggling, and collapsed-state persistence after a full
  restart. Expanding after restart restored the resized sidebar width. The
  disposable draft was cleared without sending; the existing daemon was retained.

## Tool result scroll containment (2026-09-22)

- Added `overscroll-behavior: contain` to the bounded `.activity-output` region.
  Native scrolling remains browser-managed; boundary scrolling cannot chain to
  the surrounding conversation. No event interception or host changes were added.
- Reproduced the old behavior in the packaged app: after reaching the tool output
  bottom, a second downward scroll moved the conversation into the final answer.
  Verified the fix against the same stored AGENTS.md result: extra downward
  scrolling at the bottom and upward scrolling at the top both left the outer
  conversation stationary. Scrolling outside the result still moved the session.
- `make ci` passed (19 Rust and 14 frontend tests), release packaging and strict
  bundle signature verification passed. The updated app is running from
  `.local/artifacts/Latte Work.app`; the prior bundle is preserved under
  `.local/before-tool-scroll/`. No model request was sent during native validation.

## Inline model selector styling (2026-09-22)

- Removed the composer's persistent model pill background and border; model text
  now uses regular 14px type, a compact chevron gap, and a transparent inline
  trigger. Kept hover/focus feedback and bounded long-label truncation. Provider
  settings selects and model-selection semantics are unchanged.
- Formatting, TypeScript/production frontend build, release packaging, and strict
  bundle signature verification passed. Native packaged UI verified the new
  inline appearance, opening the current catalog, and Escape dismissal retaining
  sonnet. No task was sent or configuration changed during validation.
- Updated `.local/artifacts/Latte Work.app` is running; the previous application
  bundle is preserved in `.local/before-model-style/`.

## Unified panel toggle placement (2026-09-22)

- Moved the sidebar toggle into the main title bar, before the project icon/name.
  Both panel toggles now share 32x28 buttons, 19px icons, muted color and hover
  styling, and the same vertical alignment. Removed the right toggle's special
  gold active treatment. Collapsed sidebar layout reserves macOS control space.
- Title text can truncate and the action area cannot shrink, preserving access to
  the controls in narrower layouts. Right-toggle labels now reflect open/closed
  state and expose `aria-expanded` and the workspace target.
- Formatting, TypeScript/production build, release packaging and strict bundle
  signature verification passed. Native packaged UI verified both panels could
  expand from collapsed state and the left control's new title-bar placement.
  The updated application is running; prior bundle is preserved under
  `.local/before-panel-toggle-alignment/`. No model request was sent.

## Panel icon size alignment (2026-09-22)

- Reduced both title-bar panel toggle icons from 19px to 16px, matching the
  adjacent project folder icon. Kept their shared 32x28 click targets unchanged.
- Formatting, TypeScript/production frontend build, release packaging, and strict
  bundle signature verification passed. Native packaged UI confirmed the smaller
  icons in the title bar with both panels expanded. No model request was sent.
- The updated `.local/artifacts/Latte Work.app` is running; the previous bundle is
  preserved in `.local/before-panel-icon-size/`.

## Native title-bar control alignment (2026-09-22)

- Configured the macOS traffic-light inset at x=16, y=24 through Tauri's
  existing `trafficLightPosition` support, bringing the native controls down
  toward the 57px title bar's center line. Panel icons remain 16px and use the
  existing shared button styling.
- Formatting, TypeScript/production frontend build, release packaging, and strict
  bundle signature verification passed. Packaged UI verified sidebar expansion
  and collapse; both panels were returned to the user's collapsed state.
- The screen-sharing indicator covered native traffic lights during CUA capture,
  so precise visual alignment of those controls could not be directly verified.
  No model request was sent. The previous bundle is preserved under
  `.local/before-native-titlebar-alignment/`; the updated application is running.

## Collapsed-sidebar new conversation control (2026-09-22)

- Added a 16px new-conversation icon immediately after the sidebar toggle,
  visible only when the sidebar is hidden. It uses the existing create-session
  handler, project/connection availability checks, and error reporting.
- Formatting, TypeScript/production frontend build, release packaging, and strict
  signature verification passed. The rebuilt bundle includes the native window
  control positioning update and is available at `.local/manual-test/Latte Work.app`.
- Native interaction testing is left to the user as requested; no app restart or
  conversation creation was performed for this change.

## Title-bar height based on native control center (2026-09-22)

- User-provided native screenshot showed title-bar content below the window
  controls. Replaced the 57px main/workspace headers with one shared 44px
  title-bar height, matching the sidebar/settings native-control strip.
  Kept native button placement unchanged. Workspace header cannot flex-shrink.
- Formatting, TypeScript/production build, release packaging and strict signature
  verification passed. Updated `.local/manual-test/Latte Work.app` for the user's
  manual comparison; previous test bundle is in `.local/before-titlebar-height/`.
  No native visual verification is claimed for this build, and no task was sent.

## Compact collapsed title-bar controls (2026-09-22)

- Reduced collapsed title-bar left padding from 104px to 80px and grouped the
  sidebar/new-conversation controls with a 4px gap. The folder/title moves 30px
  left to meet the reading column in the user's supplied layout. Expanded-sidebar
  placement, icon sizes, native-control positions and click targets are unchanged.
- Formatting, TypeScript/production build, release packaging and strict signature
  verification passed. The refreshed manual-test bundle is ready for user testing;
  the preceding bundle is preserved in `.local/before-titlebar-spacing/`.
  No native UI validation or model request was performed for this adjustment.

## Global pinned conversations and session menu (2026-09-22)

- Added a separate cross-project/host pinned section above Projects. The original
  project row remains, and both entries share session state. Source project/host
  appears in tooltips; duplicate titles show a source subtitle. Empty pin sections
  hide automatically. Pin time controls ordering; no project reassignment occurs.
- Session menus support rename, pin/unpin, manual unread/read, archive/restore,
  copy title/ID/conversation Markdown, and stop for active runs. The menu supports
  keyboard navigation, Escape, and Shift+F10. Archive clears pins, rejects active
  runs, and disables new sends until restored; each project has an archived view.
- Protocol v7 persists metadata on the owning host with backward-compatible JSON
  defaults. Local and SSH use the same endpoints. Remote servers must be upgraded.
- `make ci` passed: 22 Rust tests (including final-binary host isolation/metadata
  requests) and 19 frontend tests, plus formatting, Clippy, types, build and docs.
  A subsequent CSS nowrap adjustment passed formatting and release frontend build.
  Release packaging and strict signature checks passed.
- Native packaged UI verified right-click menus in both project and pinned entries,
  duplicate entry retention, unread synchronization, opening the pinned original,
  archive removing the pin, archived-list access, and restoring input/records
  without restoring the pin. QA metadata was returned to unpinned/read/unarchived.
  The Markdown submenu opened, but subsequent CUA reads returned an empty window
  and screenshots became unavailable; native copy preview/clipboard and rename
  submission are not claimed as verified. Pagination/export and rename persistence
  have automated coverage. No live SSH UI test was performed.
- The idle local v6 daemon was replaced by v7 after checking no running/waiting
  sessions and backing up SQLite under `.local/before-session-menu/`. Conversation
  event count remained 1940 before and after native verification; no prompt was
  sent. New signed bundles are in `.local/manual-test/` and `.local/artifacts/`.

## Shared UI design foundations (2026-09-22)

- Added `docs/design-system.md` and `src/tokens.css` for shared color roles,
  typography, spacing, radii, controls, focus, disabled states and overlays.
  README and contributor guidance link the standard. Shared layout/form/menu
  styles now reference these values; transcript reading geometry is retained.
- Project creation uses a 520px dialog, 24px padding, a 48px composed name field,
  one neutral focus border and explicit disabled button colors. Removed the gold
  border/shadow combination. Settings fields/selects use 40px controls, action
  buttons 36px, context/menu items 36px, and auxiliary UI text is at least 11px.
  Added Select start/end alignment; model menus align to the trigger's right edge.
- Formatting, TypeScript/production frontend build, release packaging and strict
  bundle signature verification passed. All referenced CSS variables resolve
  (except intentional runtime sidebar/workspace widths). Representative text
  contrast calculations: primary 12.18:1, secondary 7.57:1, muted on elevated
  surface 4.57:1, placeholder on input 4.71:1. This is not a full accessibility audit.
- Native screenshots verified the project dialog's single focus edge, disabled
  create action, rounded keyboard focus on the source selector, settings/Provider
  form typography and controls, and model popup staying inside the conversation.
  The session menu's AX contents and dismissal were checked, but its screenshot
  was unavailable. No Provider was saved and no model task was sent.
- New bundles are available in `.local/manual-test/` and `.local/artifacts/`; the
  previous bundles are retained under `.local/before-design-system/`. The host
  daemon was retained. This styling pass did not rerun the full Rust CI suite.

## Collapsible sidebar sections (2026-09-22)

- Pinned and Projects headings are independent disclosure buttons with 14px
  chevrons, keyboard focus and expanded/controls accessibility attributes.
  Their visibility preferences persist locally and default to expanded; hiding
  either list preserves the selected session and project-level disclosure state.
- Formatting, TypeScript/frontend build, release packaging and strict bundle
  signature verification passed. Native checks covered independent collapse,
  both sections collapsed, restart persistence, Space/Return expansion and
  keyboard focus. The separate project plus button opened the empty creation
  dialog while Projects stayed collapsed after dismissal.
- Both sections were left expanded in the updated `.local/manual-test/` app;
  `.local/artifacts/` contains the same build. Prior bundles are preserved in
  `.local/before-sidebar-sections/`. No session, project or Provider was created,
  and no agent prompt was sent. The existing host daemon was retained.

## Sidebar menu density and unsaved conversations (2026-09-22)

- New Task is a plain 36px menu row with a 16px MessageCirclePlus icon matching
  the topbar. New Task, Pinned and Projects use the same 13px typography; section
  rows are 32px high with 8px/4px vertical margins. Native screenshots checked
  expanded and collapsed layouts and the final icon; default rows have no card
  border or background, with hover/focus feedback retained.
- New Task and Cmd/Ctrl+N now select an in-memory blank conversation. Creation
  is deferred until nonempty submission. Polling preserves draft selection;
  explicit navigation resets the composer, and delayed creation responses do
  not select over a newer view. A send guard prevents overlapping submissions.
- Formatting, TypeScript/production frontend build, all 22 frontend tests
  (including 3 selection regressions), release packaging and strict signature
  verification passed. No protocol/backend changes or full Rust CI rerun.
- Native verification plus read-only SQLite counts: 7 existing sessions stayed
  at 7 after New Task, entering an unsent marker and Cmd+N. First submission of
  `Only reply LATTE_DRAFT_SAVE_OK. Do not call tools or read files.` created
  exactly one session (8 total), which completed. A subsequent unsent draft was
  closed with the app; count remained 8 and neither unsent marker appeared in
  events. The submitted smoke conversation and all prior sessions were retained.
- Final signed apps are in `.local/manual-test/` and `.local/artifacts/`;
  previous builds are preserved under `.local/before-sidebar-density/`.

## Remove project pinning (2026-09-22)

- Removed the project menu pin action, local project-pin preference handling,
  pin-first sorting and project pin glyph. Projects always render as folders.
  Session pinning and its separate sidebar section remain unchanged.
- Formatting, TypeScript/frontend build, release packaging and strict signature
  verification passed. Native verification showed the project menu contains
  Edit, Reveal in Finder and Remove only, the project row uses a folder, and
  a pinned conversation still offers Unpin. No records were changed for this check.
- Updated signed apps are in `.local/manual-test/` and `.local/artifacts/`;
  prior apps are preserved under `.local/before-remove-project-pin/`.

## Compact model menu and reasoning effort (2026-09-22)

- Model and effort selectors use single-line 36px menu items, menu headings,
  right-aligned popovers and no repeated Agent subtitle. The composer shows
  a separate subdued effort value. Known unsupported models disable effort;
  switching to one resets an unsupported selection to automatic.
- Protocol v8 carries nullable effort in sends/sessions, exposes adapter/model
  choices and adds effort to durable request identity. Legacy session JSON and
  SQLite request tables migrate without losing duplicate protection. The Claude
  adapter supplies per-turn effort through argv and private settings/env; auto
  clears the previous override without modifying user CLI configuration files.
- Full `make ci` passed: 24 Rust tests and 22 frontend tests, formatting, generated
  types, Clippy, workflow/shell lint, production web build and Rust docs. Added
  persistence/dedup/migration and final-binary launch/resume/reset coverage.
  Release packaging and strict bundle signature verification passed.
- Real Claude CLI 2.1.278 with localhost Anthropic fixtures passed:
  Sonnet 4.6/high produced API effort high; resumed Opus 4.7/low produced low;
  resumed automatic restored API effort xhigh. Tool approval and Provider
  protocol-rejection checks also passed. No paid model endpoint was called.
- Native UI verified compact menus, keyboard selection, visible High value,
  Haiku automatic/disabled state and restoration to Default/Auto. Existing user
  state stayed at 8 sessions / 1952 events; no native test prompt was sent.
  The idle local v7 daemon was backed up under `.local/before-effort/` and replaced
  by v8. Remote hosts require the matching v8 server; live SSH was not tested.
- Updated signed bundles are in `.local/manual-test/` and `.local/artifacts/`.

## Sidebar titlebar toggle placement (2026-09-22)

- Expanded sidebar owns its collapse button at the top-right, beside the session
  boundary. Collapsed layout keeps restore and new-conversation controls in the
  main titlebar. Both states reuse the existing 16px icon / 32x28px hit target and
  44px titlebar; no protocol or persistence changes.
- `make fmt-check`, `make web-build`, release `make package` and strict bundle
  signature verification passed. Native screenshots and clicks verified both
  placements and a collapse/restore cycle; no prompt was submitted.
- Updated app bundles are in `.local/manual-test/` and `.local/artifacts/`;
  previous bundles are preserved in `.local/before-sidebar-toggle-position/`.

## Agent-owned effort capabilities (2026-09-22)

- Claude model/effort policy now lives in its adapter. The shared registry only
  dispatches by Agent; unimplemented agents return no choices. Model catalog and
  send validation continue to consume the same policy. Generic UI help no longer
  assumes Claude. Protocol v8 and existing Claude launch behavior are unchanged.
- `make test` passed 26 Rust tests and 22 frontend tests, including new checks
  that unsupported Agents do not inherit Claude choices and that Claude model
  restrictions remain distinct. Formatting, server Clippy with denied warnings,
  production web build, release packaging and strict signature checks passed.
- Updated desktop launched from `.local/manual-test/`; matching artifact is in
  `.local/artifacts/`. The existing daemon was retained because this is a policy
  relocation with unchanged behavior. No new native prompt or real-CLI smoke run
  was performed for this refactor; adapter behavior is covered by fixture tests.

## Combined model and native-effort selector (2026-09-22)

- One composer trigger shows the model and Agent-native English effort value.
  The model menu owns a fixed Reasoning effort entry opening a separate submenu;
  labels use raw model IDs and effort values, with default/auto for unset values.
  Menu placement is clamped to the viewport and model scrolling is contained.
- Formatting, production frontend build, all 22 frontend tests, release packaging
  and strict bundle signature verification passed. No protocol/backend changes.
- Native checks passed: open model menu, keyboard enter effort submenu, select
  high and observe the combined trigger, select haiku and observe disabled effort,
  restore default/auto, mouse-open submenu, Left/Escape return and close. No prompt
  was sent. Trigger/main-menu screenshots were inspected; the native screenshot
  tool could not capture the focused submenu, so submenu visuals at narrow window
  sizes remain unverified (its options and selection were verified through AX).
- Updated bundles are in `.local/manual-test/` and `.local/artifacts/`; previous
  copies remain in `.local/before-combined-model/`. Existing daemon is unchanged.

## Narrower model menus (2026-09-22)

- Main menu width reduced from 260px to 200px; effort submenu from 188px to
  140px. Footer reads Effort, preserving native English values and full model
  names in tooltips. Position calculations match the new widths.
- Formatting, frontend typecheck/build, release packaging and strict signature
  verification passed. Native main-menu screenshot confirms footer text fits;
  keyboard submenu open/return preserves the user's sonnet/high selection.
- Updated manual-test/artifact bundles launched successfully; backups are in
  `.local/before-narrow-model/`. No prompt was submitted or daemon replaced.

## Native model names and stable selection columns (2026-09-22)

- Unbound Claude model catalogs expose display-only native names from allowlisted
  Host settings, scoped by optional registered project ID. NAME falls back to the
  mapped model ID, then the UI falls back to the original alias. Bound Providers
  do not inherit native names. Wire additions are defaulted and remain v8-compatible.
- Menu rows show the custom name plus a subdued alias; the composer shows only
  the custom name (or original alias) plus effort where supported. Model and effort
  rows always reserve a 15px checkmark column, so selection does not move labels.
  The 200px / 140px menu widths remain unchanged.
- Full make ci passed: 31 Rust and 24 frontend tests, type generation check,
  Clippy, shell/workflow checks, frontend build and Rust docs. New coverage includes
  source precedence, bounded/invalid files, metadata-only output, Host/project
  scoping, Provider isolation, backward compatibility and unchanged selection IDs.
  Final check-column styling passed formatting, production build, packaging and
  strict signature verification after the full gate.
- Native UI/AX verified custom names and alias labels for all four model families,
  composer display of deepseek-v4.1-flash and alwaysday1, and model/effort navigation.
  After the final alignment update, the running bundle and menu contents were
  checked; further screenshot interaction was stopped when the user operated the
  app concurrently. No native prompt was sent; session/event counts remained
  8 / 2078 across the idle daemon replacement.
- Old daemon and SQLite state were backed up under .local/before-model-labels/;
  pre-alignment bundles are in .local/before-model-labels-align/. Final signed
  bundles are in .local/manual-test/ and .local/artifacts/. Remote SSH was not run;
  older Hosts gracefully display raw aliases until updated.

## Global focus without border changes (2026-09-22)

- Removed global 2px focus outlines, activity focus outlines, and focus border
  color changes on the composer, form fields and project name container. All
  controls preserve their normal border on click/focus. Keyboard navigation uses
  a translucent background overlay; text fields use their caret and selection.
  Existing menu highlights and normal dialog shadows remain. The design-system
  contract now explicitly forbids focus outlines, extra edges and focus shadows.
- Formatting, TypeScript/production frontend build, native release packaging and
  strict bundle signature verification passed. This change is CSS/tokens/docs only.
- Native AX showed an active user task throughout packaging. The running app was
  not quit or replaced, so native visual verification of this update is pending.
  New bundle: .local/artifacts/Latte Work.app; previous artifact retained under
  .local/before-focus-style/. The running .local/manual-test/ bundle is unchanged.
