# Issue 74 daily workspace verification

The acceptance evidence is split into explicit lanes. A synthetic provider can prove Sotto's routing and recovery behavior but cannot prove an installed provider's native persistence or network performance. A local bare Git repository can prove the reviewed commit is pushed without publishing this source repository.

## Integrated daily journey

`tests/e2e/daily-workspace.spec.ts` runs the production Electron window, preload, controller, persistence, worktree creation, files, terminal, embedded browser and Git services. It uses an owned `sotto-e2e-daily-workspace-*` temporary profile and project; cleanup passes the existing owned-profile guard. All Git writes stay in that disposable project, its worktrees and local bare remote.

The first scenario opens a project through public agent IPC and creates independent Codex and Claude fixture threads. It sends separate prompts from the rendered panes, inspects a diagram and command activity, focuses the review pane while Tools stays pinned to implementation, then edits the implementation worktree through a real Windows terminal. Files and Changes show that edit while the other worktree and original branch remain unchanged. The embedded localhost page has neither the Sotto bridge nor Node `require`. UI controls stage and commit the reviewed file and push the exact new commit to the owned bare remote.

The real PR service reports that a local remote does not support GitHub pull requests and disables creation. Only after the real push, the test replaces the two PR IPC response handlers with the same narrowly scoped, faithful response pattern used by `scripts/inspect-phase5-git.mjs`. The rendered PR form sends its edited body, base, owner and reviewed revision exactly once, then displays the returned PR/check status. This proves the form/action/status integration; **no actual GitHub PR is created**. `tests/unit/main/gitPullRequests.test.ts` separately exercises the production service's native command argument selection, changed-target rejection, existing-PR handling and lost-acknowledgement reconciliation.

The second scenario joins mixed-provider pane drafts, a queued follow-up, thread/project settle and restore, pinned Tools, light/theme/browser preferences, disconnect/reconnect and a full Electron restart. Project restore retains the previously settled thread. Drafts retain their owners. Queued text does not dispatch on reconnect/restart; explicit resume dispatches once to its original thread without clearing the newer draft. The final rendered state is also checked at 820 × 560.

Tools open/surface/pin/width are explicitly session-scoped in `toolsPanelStore.ts`, consistent with #55 requiring retention across focus changes. They survive reconnect in the running renderer; after a full restart the panel starts closed and reopening follows the focused thread. This report does not claim Tools chrome is restored across restart.

The fixture provider intentionally starts from seeded provider history after restart. This test claims recovery of Sotto-owned state, not native provider transcript persistence. Installed-provider restart evidence belongs to the separate native lane.

## Commands and evidence

```powershell
npx playwright test tests/e2e/daily-workspace.spec.ts --workers=1 --output=test-results/issue74-daily
```

Run `npm run build` first when source changed. Curated captures and the actual local commit identities are written to `artifacts/issue-74-daily-workspace/`. The test failure captures are diagnostics, not passing acceptance evidence.

Verified on Windows on 2026-09-14 against the rebuilt app: **2/2 passed in 27.1 seconds** (daily tools/publish 20.3 s; recovery 6.2 s). Scoped ESLint passed. The saved local proof records distinct original/committed hashes, confirms the bare remote has exactly the reviewed new commit, and records zero renderer errors and zero real GitHub writes.

Curated images, visually inspected:

- [Mixed threads, diagram and expanded command activity](../../artifacts/issue-74-daily-workspace/mixed-threads-diagram-activity.png)
- [Real owned push followed by fixture PR status](../../artifacts/issue-74-daily-workspace/owned-push-fixture-pr.png)
- [Reconnect with another pane focused, pinned Tools, queue and newer draft](../../artifacts/issue-74-daily-workspace/reconnect-pinned-drafts-light.png)
- [Restarted workspace at the minimum content size, queued message sent once and newer draft retained](../../artifacts/issue-74-daily-workspace/restored-queue-minimum-light.png)
- [Machine-readable local Git proof](../../artifacts/issue-74-daily-workspace/daily-proof.json)

The pane tab strip correctly replaces the side-by-side layout when Tools reduces the remaining width. The minimum window retains the composer, queue action, provider status and footer navigation; transcript history scrolls independently. No product changes were needed in this harness's lane.

## Complementary coverage and release limits

- Personal chat/provider ownership: `phase-four-personal-providers.spec.ts`; editable prompt generation: `phase-four-prompts.spec.ts`; native skill references: `phase-three-skills-bridge.spec.ts`.
- Voice routing uses the deterministic microphone/transcription fixtures in `phase-five-personal-voice.spec.ts`; physical microphone, transcription latency and actual voice playback remain deferred for issue 74.
- Real native provider/account checks and long-history local-feedback/stream/pane measurements are separate issue-74 lanes; their reports must distinguish network latency from local renderer timing.
- This harness runs on Windows. Important journeys have not been repeated on supported Apple-silicon macOS in this session and must not be called cross-platform verified.
- The native foundation under #24 is a separate gate, covered by the issue-74 native verification lane and its current issue status; this fixture harness does not independently establish that delivery or claim a shipped release.
