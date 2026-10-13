# Muse provider: what was checked

October 12, 2026. ADR-0075. Everything below is either a probe against the installed Muse client on this machine or the scripted fake the contract runs against; the two are never blurred.

## The real client (Muse 1.1.1, MSP schema 1, over `muse serve`)

Driven over stdio with newline-delimited JSON-RPC from a throwaway script, in a scratch workspace:

- `initialize` answers `serverInfo` 1.1.1 and schema version 1; `model/list` answers the signed-in catalog (`muse-wonder-full-1.0`, provider `meta`) with no session.
- `session/start` with no approval mode reports effective `promptUnmatched` from the host's sealed startup mode. `onRequest` and `allowAll` are refused at start and by `session/setApprovalMode` as `commandRejected` / `approval_mode_ceiling`; `denyUnmatched` (stricter) is accepted. This is why connecting probes which modes may be offered instead of promising them.
- A turn streams `turn/started`, a completed `userMessage` item carrying the turn's `commandId`, `item/delta` text, `session/tokenUsage`, and `turn/completed`. `session/resume` answers the folded history inline, including tool calls with visible output, and `session/list` sees the durable session.
- `session/read` and `view/page` answer `methodNotFound` in 1.1.1, so history is read by resuming. The view cursor still reads `pending:seam-c-session-view-fold` on lifecycle notices; the adapter treats cursors as opaque.
- `session/setModel` answers an asynchronous `accepted` ack, not the new model, and later notifies `session/modelChanged`; the adapter confirms a model change by resuming, never from the ack. `session/compact` on a session with no run is refused (`missing_run`). `turn/interrupt` ends the turn as cancelled.
- Under this machine's own Muse policy, a file write inside the workspace and a shell command ran without an approval prompt (the policy matched them), so the approval and structured-question flows are verified against the published MSP schema and the scripted fake, not live. The adapter maps both from the schema's typed notifications and never answers one itself.
- `muse exec` was not used: it speaks the raw session log, which MSP's own contract reserves for forensics. Threads and side calls both ride `muse serve`; side calls use `--no-session-log` so nothing durable is left behind.

## The adapter, through its contract

`tests/fixtures/fakeMuseAgent.mjs` is a scripted MSP host. `tests/integration/museAdapter.test.ts` runs the shared adapter contract (`tests/integration/adapterContract.ts`) against it — connect, create, send and stream, takeover, restart, questions, permissions both ways, interrupt and disconnect never approving, uncertain reconciliation, lazy sessions and the reaper, settings results, images, side writing, and the client-update section — plus Muse-specific cases: probed permission modes under a ceiling, effort sent per turn, steering, refusal of an old client and of another MSP version, `META_API_KEY` kept out of the client's environment, question answers by label and as free text, and side writing leaving no thread. The contract skips are the fixture's, as with Grok's: no background-work driver, no live-settings driver, no lost-confirmation driver.

`tests/integration/museAdapterLive.test.ts` repeats the core journey against the real client under `SOTTO_MUSE_LIVE=1`. It was not run for this change: on this machine the Windows `muse` is a shim into WSL (and reports 1.4.6 there), so the Windows app has no native Muse binary to spawn. It needs a machine with a native Muse install.

## The Owl gate

With the feature off, the runtime registers a stand-in host: no models, no threads, nothing started, and the renderer asks `useOwlFeature('muse')` before showing the provider in Settings → Providers, a host's tiles, or first-run setup. The saved adapter records are untouched. This is covered by construction (the stand-in is the only host stable can build) and by the existing Owl gate tests for the list itself; the running app was not driven for this change.

## Gates

In the worktree on Windows: `npm run typecheck`, `npm run lint` and `npm run notices:verify` pass, and `npm test -- --maxWorkers=2` passes 9,808 of 10,115 tests (306 skipped). The one failure, `agentTargetRefresh`'s manual-prompt deadline race, is in a file this change does not touch and passes on its own in under a second; it lost its race under full-suite load on a mounted worktree. Every test that names the provider set or the Owl list was updated for the fifth provider and the second feature, and each passes. The iPhone and Android provider names were updated in source; neither was compiled here (the iPhone client builds only on macOS CI, and Android has no CI job yet). Muse has no drawn provider mark yet — its product mark is not in the repository — so it shows its initial, `M`, where the other providers draw theirs; the settings test says so beside the assertion it relaxes.
