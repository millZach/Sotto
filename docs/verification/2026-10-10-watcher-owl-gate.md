# Watcher gate and Owl promotion, October 10, 2026

The release-source rule recorded here is historical, superseded by ADR-0072's October 13 switch rule. Stable now ships a clean, CI-green main commit without an Owl prerequisite. The checks and results below record what was verified at the time.

Scope: Windows x64 in the `command-center` worktree, starting at `a940ad79f`. Local changes, verification and commits. Stable 0.1.36 was published from `f3e5e2041` while this work was in progress; new examples use 0.1.37. The source manifest stays at this branch's 0.1.35 until the lead merges main.

## Watcher gate

Main reads the running version once before constructing storage and the agent runtime, and passes the resulting gate to Watcher's paths. Owl enables it; stable disables it. Only unpackaged runs honor `SOTTO_WATCHER_ENABLED=1` or `0`. Packaged builds ignore it. The renderer's `useWatcherEnabled()` reads main's flag through the existing update-status bridge and fails closed until it arrives.

Stable omits Watcher identities and both special kinds from shell, detail and event reads, startup selection, sidebar search, panes and drafts. Direct commands, early native starts, provider launch profiles, observations, background recovery and remote answer paths refuse or omit them before a provider or wire action. This starting revision has no separate Watcher room, capacity control or running `sotto_threads` coordinator; the gate protects its existing profile seam without adding unfinished features. Owl retains the branch's behavior. The Owl header, styles and design baselines are untouched.

Stable preserves the complete `agents.json` Watcher record, `workspace.json` kinds and `watcherInFlightLimit`, including Settings saves and reset. Dormant drafts, inline images, attachment files, queues, SQLite rows, subagent records, checkpoints, recovery copies and request receipts remain saved in main. History-off cleanup clears ordinary data while retaining Watcher's data for Owl. ADR-0072 clarifies that exception because this brief requires every Watcher record to survive a stable save; Owl's history-off behavior is unchanged. Unreadable recovery copies remain intact until readable. Retention metadata grants no launch profile or permission.

The lead's October 10 scope decision excludes renderer view state from Watcher's saved records. A layout or selection pointing at a Watcher thread does not survive a stable session: stable handles it exactly like a missing thread, and an ordinary layout edit may drop the hidden pane. Owl does not restore it afterward. This is acceptable because main's Watcher records remain whole and ordinary selection, focus and layout keep their existing behavior. The layout store, pane grid and shell cache are exactly `a940ad79f`; the selection-intent, settlement and reply-ordering machinery was removed. Renderer changes are only the hook, visibility filter and its call sites.

## Real profile round trip

`node tools/verify-owl-profile.mjs` mirrors the October 9 probe against this branch with the gate off. It uses the real `WorkspaceHost`, `AgentControl` startup/privacy/save/shutdown, `ThreadRegistry`, SQLite `ThreadStore`, `SettingsRepository` and `AgentCredentials`. An Owl profile is written, opened and saved by stable, and reopened by Owl. Providers and keys are synthetic; no native session or paid call is made.

Real output:

```text
preserved: watcher=true, agents=true, threadKindsAndTitles=true,
settings=true, messages=true, credential=true
threads=11, stableVisibleThreads=8, messages=5, watcherCapacity=6
corruptBackups=[]
```

[Complete retained value snapshots](../../artifacts/watcher-gate/profile.json) compare agents, workspace, registry bindings, settings and SQLite rows, including ordinary records. Additional tests cover creation identities whose kind is still `project`, kind-only history, history-off startup and transitions, legacy singleton/image-only drafts, mixed and unreadable recovery copies, and 512 dormant plus 512 ordinary remote drafts. They compare values or content bytes and check ordinary cleanup and limits separately.

## Running app and package

The built app's two Watcher journeys passed in 11.0 seconds. Each uses an isolated owned profile and the real running version: stable from the source manifest, Owl from a temporary manifest declaring `0.1.37-owl.20261011.1`. No gate override is set. Stable hides both kinds and their search results, and direct early-start and manual-send attempts return no Watcher or a plain Owl refusal. Ordinary Send and reply work on both tracks. Settings offers no Watcher control on this starting branch.

The stable journey seeds a four-pane layout containing both Watcher kinds, resizes the ordinary split with the keyboard, reloads, closes an ordinary pane and reloads again. Ordinary edits drop the hidden panes through the unchanged layout store. Reopening the same profile in Owl shows both Watcher conversations in the sidebar, with their saved kinds intact, but does not restore those dropped panes.

Both tracks were captured in dark and light with reduced motion, at 1600x1000, 1280x800 and 820x560. Bounds assertions passed and all twelve images were opened at original resolution: text and controls fit, the existing sidebar scrolls at the minimum, and stable contains no Watcher. The Owl header is unchanged. The six neighboring branding journeys passed in 16.7 seconds without replacing their historical captures.

Captures: [stable dark, 1600](../../artifacts/watcher-gate/stable-dark-1600x1000.png), [1280](../../artifacts/watcher-gate/stable-dark-1280x800.png), [820](../../artifacts/watcher-gate/stable-dark-820x560.png); [stable light, 1600](../../artifacts/watcher-gate/stable-light-1600x1000.png), [1280](../../artifacts/watcher-gate/stable-light-1280x800.png), [820](../../artifacts/watcher-gate/stable-light-820x560.png). [Owl dark, 1600](../../artifacts/watcher-gate/owl-dark-1600x1000.png), [1280](../../artifacts/watcher-gate/owl-dark-1280x800.png), [820](../../artifacts/watcher-gate/owl-dark-820x560.png); [Owl light, 1600](../../artifacts/watcher-gate/owl-light-1600x1000.png), [1280](../../artifacts/watcher-gate/owl-light-1280x800.png), [820](../../artifacts/watcher-gate/owl-light-820x560.png).

`node tools/verify-watcher-package.mjs` passed against the actual unpacked stable executable with an isolated profile, automatic update checks and the local host off, and no e2e mode. Real output: `version=0.1.35, name=sotto, packaged=true, override=1, releaseTrack=stable, watcherEnabled=false, phase=idle`. The packaged build ignores the development override. Its [first-run capture](../../artifacts/watcher-gate/packaged-stable.png) was opened and inspected; the existing welcome screen and Get started control render fully.

## Promotion

Owl publication now prints reviewed `gh` commands with a twelve-character source suffix in the title and one full `Source commit:` line in the body, taken from `out/build-provenance.json`. It neither runs those commands nor publishes. The public, tokenless release check selects the newest published Owl, requires exactly one full source SHA, and compares it with a clean `git rev-parse HEAD`. A missing source never falls back to an older build or a tag target. Scripted feeds cover its decisions without network access.

Windows and Mac stable packaging run that check first and set the promoted Owl version's base in the packaged manifest. Source manifests stay unchanged, output names follow the packaged version, and offline directory/Linux/CI packaging stays unchanged. Owl keeps its existing stable host-archive target; promoted stable advertises its actual packaged version. The release-only host archive command also packages that promoted base in its filename, runtime manifest and bundled listeners; default host packaging and CI remain offline.

The release procedure promotes the chosen Owl commit after clean checkout, `npm ci`, normal gates and desktop smoke; publication is followed by the `Release X.Y.Z` pull request on main. Newer main commits wait for the next Owl. Daily Owl builds compare the newest Owl's source with `origin/main` and skip unchanged days. Mac ships the same promoted commit without a Mac Owl stage.

The real public-feed check returned this refusal, with exit 1:

```text
The newest Owl release, Sotto Owl 0.1.35-owl.20261010.1, names no single full source commit. Publish an Owl build with "Source commit: <full sha>" in its release body before making a stable release.
```

The scripted promotion/publication/packaging tests passed in the full suite. Release-only host archive verification additionally passed 33 focused tests; real default 0.1.35 and overridden 0.1.37 Windows host archives started with matching manifest, HTTP health and socket versions. Source manifests were byte-identical afterward. Mac/Linux host execution is not claimed.

## Gates and review

The requested commands ran in this order after the renderer simplification. These are actual results, including failures; neither the full suite nor design gate was repeated after the lead's instruction to run the gates once.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0; four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 1; 738 files passed, 56 skipped, 1 failed; 9,153 tests passed, 278 skipped, 1 failed; 1,048.26 seconds |
| `npm run notices:verify` | Exit 0; 182 components |
| `npm run build` | Exit 0 |
| `npm run design:verify` | Exit 1; 6 specs passed, 3 Help captures failed on their About version line |
| `npm run package:dir` | Exit 0; unchanged command; provenance, resource/dependency closure, normal startup, SQLite/FTS5 and native PTY exit 0 (`SOTTO_PTY_PACKAGE_OK`) |
| `npm run release:check` | Exit 1; expected refusal from the real public feed, called once at HEAD `a940ad79fe75abe36d81a5fe1d67709a2065e7eb`, which is not Owl 1's source |

The sole full-suite failure was the new Watcher surface fixture: it queried the contenteditable composer as an input value and put its prompt in the coordinator draft instead of the per-thread draft. The assertion and schema-valid fixture were corrected, without a runtime edit. The affected file then passed all four tests in 4.23 seconds, and its TypeScript test project passed. No named Git-heavy timeout occurred. An initial typecheck also caught a Playwright-only matcher option in that rewritten unit test; it was removed before the passing typecheck and full run above.

The three design failures are `help.png`, `help-light.png` and `scale-100-help.png`: 1,358, 1,303 and 1,358 changed pixels against a limit of 549. Inspection and raw-pixel comparison confined every difference to the About version line at x=470–692, y=1261–1271. Baselines say 0.1.34; this branch already says 0.1.35 at `a940ad79f`. No Help surface or stylesheet changed. This version drift remains a failed gate; no baseline was regenerated and the source version was not changed to hide it.

Electron's package loader automatically fetched its missing development binary during the first design launch (`node_modules/electron/dist/electron.exe` and `path.txt` created at 17:30). This was an unintended dependency download, despite the no-install instruction. No install command or Sotto installer was run; subsequent checks used that now-present runtime. No additional software was installed deliberately.

Free physical memory (KB) before the full suite/design/Watcher E2E/branding E2E/package probe was 12,169,000 / 12,056,060 / 12,412,464 / 12,594,588 / 12,554,860. The first Watcher E2E attempt used a renamed thread title as identity and filled Owl's old pane before selection settled. The fixture now keeps the thread ID and waits for the ordinary pane; the passing journeys above retain baseline runtime ordering.

The lead runs the two-axis review on the pull request; no further nested Codex reviews ran after the scope decision. Earlier interrupted and superseded runs do not count as final passes. Raw local output is retained in ignored `release/owl-*.log`, normalized to UTF-8 without a BOM.

macOS/Linux packages, actual publication, live updates and installation over Zach's profile are outside this local verification. Production dependencies remain exactly `zod` and `node-pty`; offline packaging commands and builder identity remain unchanged. Publishing requires a rebuild from the reviewed clean commit.
