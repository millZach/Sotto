# Independent thread providers and Sotto coordinator

The provider-settings correction separates Sotto's reasoning coordinator from the native clients running threads. Codex, Claude Code and Grok Build can stay connected together. Configure agents chooses the coordinator account/model/effort; Providers manages each native connection and its catalog. Existing threads retain their native provider and session.

## Verification

- Full unit suite: **2,304 passed, 9 skipped** across 140 files. Subsequent final changes passed 129 focused backend/recovery/identity tests and 75 renderer tests. TypeScript for main and renderer, ESLint and production build passed.
- Electron journeys: 28 passed on the first run; one outdated test still looked for coordinator fields directly on Settings. It passed after following Settings → Agents → Configure agents. The final build passed all 10 affected subscription, voice and thread-workspace journeys after the Configure agents label change.
- Design gate: all 6 capture journeys passed; the manifest verifier confirmed **83 exact capture tuples**, including Settings at 100/125/150/200% scale. The former account capture is now Providers.
- Actual Windows native acceptance: exactly one synthetic READY prompt each to Codex (`gpt-6-astra`), Claude (`default`) and Grok (`grok-4.6`) in one isolated profile/project. All three appeared together. No tools were requested and the synthetic project remained empty.
- Changing the coordinator from Codex to Claude preserved all native connections, model IDs, Sotto thread IDs and registry bindings. Disconnecting Claude retained its history and left Codex/Grok usable. Reconnecting and restarting preserved the three native session aliases, with exactly one user prompt per thread.
- Final restore-only run after backend `699dffe` and the integrated renderer: **passed in 23.9 seconds**, no additional prompts. Turning off agent control through the UI left all three providers connected; reconnecting Claude did not turn the coordinator on; restart reconnected all three while coordination stayed off.
- Backend regressions cover stalled provider connection/reconnection outside the healthy send path, failed/disabled provider isolation, same-provider model changes, unknown project-registration recovery, legacy pending action ownership, and existing project memory/policy scope preservation without cross-provider authority leaks.
- Independent review found and verified fixes for coordinator enablement coupling, historical project scope migration, bulk renderer connection queueing, and per-provider reconnection. Final review reported no material concerns.

The [fresh-run evidence](../../artifacts/multi-provider-live/evidence.json) and [final restore evidence](../../artifacts/multi-provider-live/restore-evidence.json) identify the synthetic profile and observed identities. These native tests exercise installed clients rather than the E2E mock host. Packaged deployment, unrelated voice performance and physical microphone latency are outside this correction.

## Rendered review

The supplied T3 reference's provider list, independent toggles, selected details and Configuration/Models tabs are implemented using Sotto's black Crossing surfaces, warm white text and teal selection. The selected provider is the focus; actual account connection and model controls occupy the detail panel. Unsupported T3 controls were not added as placeholders.

Inspected the actual Windows renderer at 1080px and a deliberately narrowed 760px window. The desktop list keeps Claude Code on one line. At 760px, the three choices move above the detail panel; the settings scrollport has no horizontal overflow and the model field remains reachable. The review caught and fixed a pre-existing fixed field width that overflowed the narrow settings pane, plus scroll-spy alignment and captures taken before scrolling/animation had settled.

- [Connected providers, Configuration](../../artifacts/multi-provider-live/all-connected-claude-configuration.png)
- [Selected provider's Models](../../artifacts/multi-provider-live/all-connected-claude-models.png)
- [Narrow desktop](../../artifacts/multi-provider-live/providers-760.png)
- [Only Claude disconnected](../../artifacts/multi-provider-live/disabled-claude-configuration.png)
- [Separate coordinator configuration](../../artifacts/multi-provider-live/independent-coordinator.png)
- [Actionable connection error, isolated fixture](../../artifacts/multi-provider-live/fixture-provider-error.png) — visual error-state check without native calls or account changes.

Keyboard arrows switch Configuration/Models and retain tab focus. The selected panel's 160ms arrival animation was observed through completion, with opacity returning to 1 and no cropping; reduced-motion rules remove it. Provider-specific retry behavior and unavailable thread controls have renderer regression coverage.

Within the scoped panel, the five non-control text purposes are the Providers heading, purpose sentence, selected-provider context, Local connection heading and native sign-in instruction. Provider choices, switches, two tabs, default-model field and their statuses are essential operating controls/feedback. The selected provider's repeated name supplies master/detail context. Duplicate coordinator error output was removed. Control labels are at least 14px, secondary statuses 12px and the detail heading 18px; existing Sotto navigation and typography are retained.

## Dev handoff

The previous dev instance had no running threads or unsent composer text before it was closed. The new watcher runs this implementation on `work/thread-providers` with the normal Sotto profile, and the visible app was verified on Settings → Providers. Existing preferences were retained: Codex connected, Claude and Grok disabled until selected. All three provider controls are present and the application reports no connection error. Changes are committed locally; this correction has not been pushed or merged.
