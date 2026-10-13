# Muse provider: what was checked

October 12–13, 2026. [ADR-0079](../adr/0079-muse-is-a-thread-provider.md). Native probes, scripted protocol checks and the running desktop journey are recorded separately below. The original native probes were not repeated during the review fixes.

## The real client (Muse 1.1.1, MSP schema 1, over `muse serve`)

Driven over stdio with newline-delimited JSON-RPC from a throwaway script, in a scratch workspace:

- `initialize` answers `serverInfo` 1.1.1 and schema version 1; `model/list` answers the signed-in catalog (`muse-wonder-full-1.0`, provider `meta`) with no session.
- `session/start` with no approval mode reports effective `promptUnmatched` from the host's sealed startup mode. `onRequest` and `allowAll` are refused at start and by `session/setApprovalMode` as `commandRejected` / `approval_mode_ceiling`; `denyUnmatched` (stricter) is accepted. This is why connecting probes which modes may be offered instead of promising them.
- A turn streams `turn/started`, a completed `userMessage` item carrying the turn's `commandId`, `item/delta` text, `session/tokenUsage`, and `turn/completed`. `session/resume` answers the folded history inline, including tool calls with visible output, and `session/list` sees the durable session.
- `session/read` and `view/page` answer `methodNotFound` in 1.1.1, so history is read by resuming. The view cursor still reads `pending:seam-c-session-view-fold` on lifecycle notices; the adapter treats cursors as opaque.
- `session/setModel` answers an asynchronous `accepted` ack, not the new model, and later notifies `session/modelChanged`; the adapter confirms a model change by resuming, never from the ack. `session/compact` on a session with no run is refused (`missing_run`). `turn/interrupt` ends the turn as cancelled.
- Under this machine's own Muse policy, a file write inside the workspace and a shell command ran without an approval prompt (the policy matched them), so the approval and structured-question flows are verified against the published MSP schema and the scripted fake, not live. The adapter maps both from the schema's typed notifications and never answers one itself.
- `muse exec` was not used: it speaks the raw session log, which MSP's own contract reserves for forensics. Threads ride `muse serve`. Review removed side writing: `denyUnmatched` can still allow policy-matched tools, and the checked floor has no independently enforced all-tools disable control. Side writing returns no text before starting a process or sending material; titles and Git drafts retain Sotto's fallback text.

## The adapter, through its contract

`tests/fixtures/fakeMuseAgent.mjs` is a scripted MSP host. `tests/integration/museAdapter.test.ts` runs the shared adapter contract (`tests/integration/adapterContract.ts`) against it: connect, create, stream, takeover, restart, questions, explicit permissions, interrupt, uncertain reconciliation, lazy sessions, settings, images and client handoff. Muse-specific tests cover probed modes, effort per turn, steering, version refusal, environment isolation and side writing that starts nothing. The contract skips are the fixture's: no background-work, live-settings or lost-confirmation driver.

Request regressions cover optional omissions, duplicate and long labels, staged approvals, stale requirements, invalid answers that send nothing, and lost acknowledgements. Recovery tests script immediate resume replies, repeated gaps, newer turns and pending requests arriving during a read, and old reply snapshots arriving after live words. They check visible and SQLite history, continued streaming, no duplicate messages, prompt guards after process death, and creation replay retaining its original approval-mode envelope.

`tests/integration/museAdapterLive.test.ts` repeats the core journey against the real client under `SOTTO_MUSE_LIVE=1`. It was not run for this change: on this machine the Windows `muse` is a shim into WSL (and reports 1.4.6 there), so the Windows app has no native Muse binary to spawn. It needs a machine with a native Muse install.

## The Owl gate

The immutable startup gate is checked in desktop/headless construction, discovery, cached workspace reads, coordinator dispatch, routing and direct socket commands. Stable neither probes nor starts Muse and exposes no Muse models, projects or threads. Saved defaults, organization, history, activities, answer ownership, drafts, follow-ups and attachments stay dormant through history-off and return in Owl. Legacy remote drafts are preserved without exposure until their provider is known. The desktop journey below also checks a stable restart and Owl return.

The paired Watcher integration keeps that gate on its remote snapshots and read/control paths. Held Muse requests are refused before transport; mixed lists that cannot hide Muse at their owning host are refused without rewriting pages or counts. Ordinary Codex scopes and Muse-enabled Owl calls retain their complete responses. Regressions cover native and qualified model/project IDs, legacy Muse labels, distinct qualified Codex projects with the same short name, initial ownership without a UI subscriber, and a known Muse thread omitted by a later snapshot. Text-free receipt reconciliation and stored records stay intact. Headless Watcher worker admission follows ADR-0073 independently of the Muse gate and creates no headless master.

Host setup and visual admission share tool eligibility: Muse and Devin are excluded, and a stale Muse setup selection is refused before dispatch. Browser tools, Watcher, skills and side writing remain unavailable.

The restart observer keeps dormant Muse resume records before setting, age, count, absence and capacity pruning. The workspace is initialized before that observer starts. A controlled real-runtime check using the old snapshot accessor deleted the saved Muse row in all three setting-off, expired and capped cases; the corrected runtime and neighboring resume files pass all 50 tests. The actual stores retain the exact Muse record, ordinary counterparts are pruned, and no Muse connect, command or side call occurs. Separate observer/follow-up/gate neighbors pass all 82 tests, including capacity bounds and one resume after Muse becomes available again.

Update all keeps Muse's native updater. A held Muse desktop checks the raw target before a wildcard client-version request can enumerate connected Muse, including a direct socket caller. The old omission reached both actual command recorders; both intended refusal assertions failed. Corrected gateway, named-host routing and Update all neighbors pass all 159 tests, including 67 gate cases. Local and remote client-host readings hide Muse without changing the saved readings, and an ordinary named queue reaches its chosen machine with the desktop-only host ID stripped.

The later Usage integration keeps its four-provider numeric contract separate from Muse. A regression uses the real runtime, coordinator, workspace and numeric store: Muse sends normally, no Muse numeric row or native quota read occurs, and an ordinary Codex prompt still counts. Restoring only the old unconditional Usage submission guard made the accepted Muse send falsely report failed numeric persistence; restoring the supported-provider guard passes that same case. Other cases cover dormant saved Muse messages with Usage on and off and provider-switch token, replay and quota boundaries. The latest PR records the complete neighboring, full-suite and packaged results separately from this controlled check. All five Owl features remain held; Muse and Usage independently select a matching Owl headless host while that host gates itself from its own version.

The phone Watcher integration exposed a numeric-origin mismatch. An authenticated phone user instruction carried its permission context into dispatch, where any context was counted as Watcher automation. A regression over the actual paired socket, coordinator and numeric store reproduced the accepted native echo followed by user zero and Watcher one. Classification now checks the Watcher operation identity and retains the phone's permission context; wake-ups keep priority. The regression also checks exact draft deduplication, automated Watcher work, ordinary desktop input and absence of prompt words in the numeric rows. This is scripted socket proof, not a native phone-client journey.

## Discovery, updates and Settings

The maker's [Windows installer](https://dev.meta.ai/install.ps1), [POSIX installer](https://dev.meta.ai/install.sh), [installation guide](https://dev.meta.ai/docs/muse-code) and [stable feed](https://api.meta.ai/muse-code/channels/muse-stable) were inspected read-only. Discovery/update tests use owned native-install fixtures and a scripted downloader/runner; they do not install Muse.

Tests check bounded version records, native executable signatures, configured/default roots, manager priority, stable/canary channels, stale records and outside-directory links. Discovery starts the versioned native binary directly, avoiding the launcher's automatic updater. A full-build version is accepted only when identification and the exact resolved binary agree.

Update tests check fixed feeds, bounded reads, unknown results on failure, version comparison and manual instructions. The fixed maker script is downloaded to a fresh temporary file, run into the same recognized maker-owned directory with login and PATH changes disabled, and cleaned afterward. Manager and unknown ownership are not replaced; keys and URL overrides are excluded. Empty catalogs and failed handoff retain the working client.

Zach selected prototype A and required the actual logo. The unchanged [product squiggle](https://muse.ai/images/favicon/app-squiggle.svg) appears in Settings and Threads. [Meta's launch announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) links to `muse.ai`; that site's declared favicon matches the implemented SVG path exactly. This is the current general Muse product mark; no separate Code-specific mark was established. The [selected prototype](https://github.com/millZach/Sotto/blob/a495286160a60a4e29f409a80f4a773ecfa8a2d2/docs/prototypes/muse-provider-settings.prototype.html) is captured under `prototype/muse-provider-settings-973`, outside the implementation branch. Renderer tests cover version checks, queued/updating/failure/manual states, sign-in copying, gates and asynchronous errors.

## Running desktop

Built with `npm run build`, then driven with `npx playwright test tests/e2e/muse-provider.spec.ts` on Windows. The journey uses the real renderer, preload, coordinator and Muse adapter over the scripted MSP child in an owned fresh profile. It is not a native Muse install.

- Settings selection/connection, sign-in command copying, installed version and Check again, keyboard tabs, model selection and Escape/focus restoration.
- Light/dark at 1600x1000, 1280x800 and 820x560, reduced motion on, no horizontal overflow. Measured sign-in text contrast is at least 6.71:1; Allow once is at least 15.74:1.
- Deny and Allow once reach the exact native choices. A required answer plus a blank optional answer reaches the wire unchanged.
- The steer is confirmed in provider history before completion, keeps the opening-message turn identity and reaches the completed state. Repeated gaps preserve one copy of missed words; streaming, cancellation and malformed-process restart settle correctly.
- Stable starts zero Muse processes and exposes none of its saved work. History-off keeps its records; Owl restores the same thread ID and conversation, including the steer.
- No renderer page errors or fixture protocol violations.

The captures were opened and inspected: [Settings dark](../../artifacts/muse-provider/settings-1600-dark.png), [minimum light](../../artifacts/muse-provider/settings-820-light.png), [connected client](../../artifacts/muse-provider/settings-connected-1280-dark.png), [permission minimum](../../artifacts/muse-provider/permission-820-light.png), [optional answer](../../artifacts/muse-provider/optional-question-820-light.png), [completed steer](../../artifacts/muse-provider/steered-thread-complete.png) and [Owl restoration](../../artifacts/muse-provider/owl-restored-thread.png). [Contrast measurements](../../artifacts/muse-provider/contrast.json) and [journey facts](../../artifacts/muse-provider/journey.json) retain the assertions. Ordinary reruns write ignored intermediate captures under `artifacts/e2e-runs/muse-provider/`.

## Gates

Workspace observation now stops at shutdown before starting initialization or reading provider/store state. A late Watcher observation previously requeued the completed initialization promise after disposal, starving timer deadlines when Muse was disabled. Fourteen deterministic lifecycle cases cover direct and queued observations across shutdown and preserve gated startup filtering; the old code failed eleven cases without hanging the runner. The fix and neighboring gate/history tests pass all 43 cases, and the original stalled Watcher tool case exits normally.

Typecheck, lint, notices verification and build pass locally. Final full-suite and packaged-build results are recorded in PR 973 after those gates finish. Independent Standards and Spec reviews have no unresolved findings after their closure checks.

**Not verified with native Muse on Windows:** the installed command is a WSL shim. No native installation, sign-in, installer update or live handoff was performed. Update UI states are covered by renderer tests and the prototype, and installer behavior by fixtures. Native iOS compile/tests run in macOS CI, not locally; Android was not built. Linux/macOS desktop journeys were not driven here. Design baselines were not regenerated.
