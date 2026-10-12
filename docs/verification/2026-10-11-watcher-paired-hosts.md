# Watcher on paired hosts, October 11, 2026

Ticket 5 adds owning-host admission and positional reads over optional host-v1 features. This work is on `feat/watcher-hosts`, based on ticket 4 at `1a00332ce`. It is local work for the lead to integrate; nothing was pushed or published.

## Behavior

`watcher-control` carries closed start/send/queue/steer/stop/settle operations with the master's original request, retry, target, ownership generation and receipt identities. `watcher-reads` carries bounded owning-store reads and scoped text-free ownership, receipt and evidence projections. Both socket listeners require the SSH-recorded paired desktop. General pairings and phones cannot forge an origin, including through ordinary commands. The local tool bearer never crosses the connection. These features write no permission policy and answer no request.

The desktop reserves its shared capacity before sending. Its original permission ceiling is retained for the request, while current desktop admission and the host's own default remain checks. The host imports the operation into the existing Watcher service and rechecks connection, ownership, native turn/head, pending cards and permission at the existing provider writer. Hosts run enforcement on either release track and create no master or wake loop. Stable desktops construct no Watcher or remote automation path. Phone projections retain Watcher; phone interaction remains ticket 8 after its prototype.

Reconnect reads the owning receipts and never resends mutations. Dispatch uncertainty holds capacity. Host restart retains identities and removes the live connection guard; an old queued operation cannot become another send. Projection fingerprints are separate from detail revisions, event sequences and message positions. Snapshots prioritize outstanding operations within their thousand-record bound; exact operation reads remain separate. History resets return the owning epoch with position -1.

## Regression proof

The focused run passed 55 tests across `watcherPairedHosts`, `watcherTools`, `watcherNativeFences` and `socketHostFeatures` in 25.08 seconds. The ten paired-host cases cover feature negotiation and stable refusal; explicit routing without selection changes; start/send/read/stop/settle; history reset; lost acknowledgement and reconnect; host restart without replay; phone/socket and native takeover; queue and steer turn identities; late native questions at the writer; forged identities and ordinary-command origins; both permission ceilings; and confirmed remote Stop all after a default changes.

The native queue test appends external input to the fake Codex session log, finishes the running turn, and verifies that the pre-send read publishes takeover and cancels the queue before another `turn/start`. The held-preparation question test verifies one initial native turn and zero `request/answer` calls before and after machine Stop. A history-off host record contains the text-free origin and excludes the distinctive synthetic prompt.

Focused failures caught a laptop-catalog steer check and a refused start remaining eligible for Stop all. A final envelope inspection also added an explicit equality check between the inner and outer request IDs; the focused ten-case rerun passed in 8.54 seconds. These checks now pass. Tests wait for observed turn completion and socket idle state before injecting the next scenario. Initial typecheck/lint also caught the live harness's JavaScript import and CommonJS fixture conventions; the harness now uses the build subprocess and an ES module launcher.

## Live forge proof

The opt-in native run began at 21:18:23 UTC (14:18:23 Pacific) and passed in 50.11 seconds. A temporary Windows desktop profile ran a real Codex Watcher through the production runtime and paired socket service. Its isolated forge host ran this branch's plain Node bundle with Node 24.21.0 through mise, in an owned `~/tmp/sotto-watcher-hosts-<uuid>` folder with its own data and ephemeral port. A second isolated host used the ticket-4 build at `1a00332ce`, which lacks the features. Neither used the running forge host or its data.

The laptop Watcher started one forge worker with a one-line instruction, read its thread and operation, sent one follow-up, read it and stopped it. Selection stayed unchanged. The same desktop admission boundary refused start against the older host with `HOST_FEATURE_UNAVAILABLE`, before any mutation packet. The older-host refusal was a direct boundary probe, requiring no additional model turn. There were three master turns (one was event news) and two worker turns, five total under the six-turn ceiling. No prompt text, model output, protocol body or token is in the result metadata.

Earlier setup failures involved Windows tar paths, provider connection and missing host identity in the temporary connection file. All occurred before a model turn and were cleaned up. Final metadata is in the ignored `artifacts/watcher-paired-hosts/live.json`. The temporary connection files were removed. Every recorded host and SSH PID was checked absent, and no owned remote folder remained. The live build preceded the final full-master metadata binding, aggregate catalog correction, failed-start participation fix, inner/outer request check and headless-master recovery guard; the final local gates cover those changes. The model budget was not reused for another live run.

The temporary live desktop profile remains gitignored. Its 15 entries contain no filesystem links, and its processes are stopped. Automatic approval review rejected recursive removal with "blocked by policy"; no other profile was touched. The retained result metadata is separate from this runtime profile.

## Gates

The seven required commands passed in order on `1125541ca`. The final suite began after the requested free-memory check returned 13,334,380 KB. Real output is retained in the ignored logs under `artifacts/watcher-paired-hosts/`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 774 files and 9,546 tests passed, 59 files and 281 tests skipped; 1,076.91 seconds |
| `npm run notices:verify` | Exit 0; 189 components verified |
| `npm run build` | Exit 0; main, host, preload and renderer built |
| `npm run test:socket` | Exit 0; 22 files and 466 tests passed, 10 tests skipped; 143.84 seconds |
| `npm run build:host` | Exit 0; plain Node host built in 1.82 seconds |

The first complete suite passed 773 files and 9,545 tests, with one failure in the exhaustive host request list, 59 files and 281 tests skipped, in 1,097.12 seconds. That list omitted the two newly named operations. Commit `1125541ca` fixes the assertion; all twelve tests in its isolated rerun passed in 0.659 seconds. Production behavior did not change, and no listed load-sensitive suite failed. The final ordered run above includes the correction.

An early partial suite was stopped on its verified owned process tree when the inner/outer request check was added. It is not counted as a pass. Its remaining recorded child PIDs were checked absent before the final run.

## Running desktop

`npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/hosts.spec.ts` passed all four journeys in 23.5 seconds against the rebuilt Electron app. The journeys cover stable/Owl saved records, ordinary sends, layout restoration and keyboard pane resizing, local-host-off refusals, the client-only Hosts page, keyboard device selection and Escape, failed SSH setup without saving a host, and preserved dictation settings.

Both themes and reduced motion passed at 1600x1000, 1280x800 and 820x560 with no horizontal overflow. I inspected the minimum-size captures: ordinary thread controls remain visible, stable omits the saved special kinds, Owl keeps both kinds, and the host dialog scrolls vertically within the window. These are synthetic fixtures, with no live prompt or output. Selected evidence:

- Stable: [dark](../../artifacts/watcher-paired-hosts/stable-dark-820x560.png), [light](../../artifacts/watcher-paired-hosts/stable-light-820x560.png).
- Owl: [dark](../../artifacts/watcher-paired-hosts/owl-dark-820x560.png), [light](../../artifacts/watcher-paired-hosts/owl-light-820x560.png).
- Existing Add host dialog: [dark](../../artifacts/watcher-paired-hosts/host-add-picked-820-dark.png), [light](../../artifacts/watcher-paired-hosts/host-add-picked-820-light.png).

The launched Electron processes were closed by the owned-profile harness. No renderer changed and no design baseline was regenerated.

## Remaining scope

There are no renderer or phone UI changes, no new dependency or network host, and no design baseline regeneration. The paired-host proof covers a native Windows master and Linux worker over an SSH forward, not a Tailscale TLS certificate path, macOS or installed desktop packaging. The lead owns main integration, the two-axis PR review and CI after pushing. Tickets 6–8 supply the room, receipts and phone experience.

## Reviewed wakeups merge follow-up

Merge `403a3a1d5` joins this branch at `f7dccc8ba` with `feat/watcher-wakeups` at `2b3a1a4e2`. The incoming branch carries the two ticket-3 review rounds, ticket 4's native-frame sizing check and its authorized main changes, including version 0.1.37. No renderer change was authored here, and no live forge check was repeated.

The merge body records each conflict. `.gitignore` keeps the paired-host generated-folder exclusion and the incoming selected thread-tool evidence exceptions. `eslint.config.mjs` keeps the paired-host, `.t` and Omarchy exclusions. The first `watcher.ts` hunk combines the paired permission ceiling with page/choice expiry, validating choice IDs only on their owning host. The second keeps all paired-host methods alongside the incoming `prunePages` method.

The reviewed outcome/refund helper, roster history bound, retry receipts before inactive-request refusal, working-copy snapshots, image request context, latest initial read window, restart cursors, stable Stop all ownership signature, relinquished-participant refusal, closed-service refusals and protected reads remain. Paired reads/admission now refuse a closed service with `NOT_CURRENT_WATCHER`; the desktop checks its current master and connection again before transmission. A definite pre-wire refusal retains its code and refund rules; uncertain transmission still holds its slot. No answer/grant, capacity source or phone filtering was added.

The paired regressions test one-time writer refusal refunds and receipt retries, original receipts after Stop all, stale master participation after settlement, valid confirmation across Watcher progress, invalid confirmation after takeover, closed entry points with no coordinator effect, and closure before transmission with no packet. All 81 focused cases across the four Watcher/socket files passed in 36.91 seconds.

### Corrections and earlier failures

The first typecheck found a fixture assigning `false` to the optional `true` stopped marker. `1aeeb9869` deletes that marker to model the stale projection, without changing its schema.

The first complete follow-up suite had one `THREAD_BUSY` failure in the new Stop all progress fixture: 777 files and 9,669 tests passed, 59 files and 284 tests skipped, in 1,230.66 seconds. The case passed alone but failed twice in thirty repetitions. A state probe caught sixteen cases where the desktop showed an earlier idle projection while the owning host still ran. `78f28dcc5` refreshes the owning host before the synthetic follow-up and checks both states. All thirty repetitions then passed; the temporary loop was removed. Production busy guards and deadlines were unchanged.

The next full suite had one boot-launch fixture error, with the same pass/skip counts, in 1,303.88 seconds; all Watcher cases passed. Its original case passed alone and in twenty repetitions. A whole boot-file rerun failed two related installation/handoff cases, then its diagnostic rerun passed all 35 cases with one skipped in 100.71 seconds. The earlier boot cause remains unconfirmed. `f4b83f291` records stop acknowledgement and stable launcher reason/cause in assertions; it changes no startup behavior or deadline. Temporary logging and repetition were removed. Both the final full suite and the later socket suite passed the boot cases.

### Final ordered gates

All eight requested commands passed in order on `f4b83f291`. The final full-suite memory check returned 10,595,440 KB (earlier full runs: 9,250,536 KB and 9,767,160 KB). Actual output is retained in the ignored `followup-*.log` files in the paired-host evidence folder, normalized to UTF-8 without BOM.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 778 files and 9,670 tests passed, 59 files and 284 tests skipped; 1,129.52 seconds |
| `npm run notices:verify` | Exit 0; 189 components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npm run test:socket` | Exit 0; 22 files and 466 tests passed, 10 skipped; 147.03 seconds |
| `npm run build:host` | Exit 0; plain Node host, 203 modules; 2.05 seconds |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; three journeys; 13.6 seconds |

The rebuilt Electron journeys retain stable/Owl ordinary Send/reply, saved-kind and bridge gating, layout/keyboard recovery and all local-host-off refusals. Both themes and reduced motion passed at 1600x1000, 1280x800 and the exact 820x560 content size. The incoming native-frame helper changes only the disposable test window's minimum. I inspected the new [Owl dark](../../artifacts/watcher-paired-hosts/merge-owl-dark-820x560.png) and [stable light](../../artifacts/watcher-paired-hosts/merge-stable-light-820x560.png) captures: sidebar, transcript and composer fit. Their 1230x840 physical pixels reflect the laptop's 150% scaling. Main bundle timestamp was 18:02:13 local; the final host bundle was 18:06:56. These captures contain synthetic fixtures only.

The owned-profile harness closed its Electron launches; a final inventory found zero Node, Electron or SSH processes with this worktree in their command line. No installed/package, macOS, Linux or phone UI proof was added. The original live proof and retained-profile limitation above remain unchanged. This merged native paired-host build was not live rechecked, as requested. Nothing was pushed; the lead still owns integration, review and CI.
