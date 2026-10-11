# Watcher's room, October 11, 2026

Ticket 6 of [the Watcher plan](../plans/2026-10-08-command-center.md#ticket-6--add-the-third-room-and-sidebar-overview) adds Watcher's room to Sotto Owl: the owl in the room switch, the Overview, Watcher's own pane, Threads in flight, and the badge on watched threads. The look is the [approved owl mock-up](C:/Users/zache/AppData/Local/zstack-scratch/owl-prototype/index.html) with Zach's quiet badges, which stays outside the repository; ADR-0073 records the picks. This note says what was built, what I worked out where the mock-up did not reach, and how it was checked on the built app.

## What an Owl build shows

- **The switch.** The sidebar foot reads Dictate, the owl, Threads. The owl is alone, 16 pixels, and its tooltip and accessible name are Watcher. While Watcher's room is open the owl is in the accent colour; elsewhere it takes its tab's text colour. Only the lit tab is in the Tab order, the arrow keys, Home and End move between the three rooms, and a press hands focus to the lit tab of the page it opens, since each page draws its own switch. The strip's switch, where a page still wears one, comes from the same definition. Stable keeps Dictate | Threads.
- **The first time.** The room says what Watcher is and offers it on one of the user's own Codex, Claude Code or Grok Build models, with the model and effort chips the composer uses. Devin is never offered. **Start Watcher** asks main to create it through the room contract and selects nothing on the Threads page. A refusal is said in main's own words, and the choice stays.
- **The Overview.** In the sidebar's own frame (top row, night sky, foot, collapsing and resizing), with no Threads | Terminal switch, search or New thread: every other thread across the connected hosts, grouped Needs you, Ready for review, Working, Landing, Quiet and Idle by the shared `watcherOverview` projection. Each row has its ring, title and clock; its provider mark, Watcher's owl when watched, its project and host, and where it stands; a waiting thread's request on its own line. Settled and archived threads fold under **Settled** at the end of Idle. Each group heading is a button with its count in its name.
- **Watcher's pane.** Watcher's real thread pane, under its own header: the owl, Watcher, the meter (**2 of 4 watched**, or **2 of 4** where the pane is narrow) and **More Watcher actions**. Its composer is labelled Watcher message, reads "Ask about your threads, or say what to start or send", and says **Ask before changes** with a lock where a thread's permissions choice would be. It offers no skills, branch toolbar, Git action or thread menu, and its model chip offers only its own provider's models, even before its first send: another provider is another Watcher (ADR-0073), whose flow comes later. Its replies are signed Watcher, with the owl.
- **Threads in flight.** More Watcher actions opens a small panel holding the one setting, one to eight, which saves through main's `setLimit` as it changes. Lowering it stops nothing, so the meter can read **2 of 1 watched** until fewer are in flight. Escape or a press outside closes the panel and returns focus to its button.
- **A watched thread.** The owl right after its provider logo, at the logo's size and in its row's muted text colour, in its sidebar row, its Overview row and its pane's header. It is an image named Watched by Watcher, never a control. Its composer says **Watched by Watcher. If you send here, Watcher stops sending to it.**
- **Threads.** The Threads page, and the sidebar beside Dictate, History and Help, leave the current Watcher to its room. Watcher history stays listed with the ordinary threads.

Stable shows and reads none of it: no owl, no room, no badge, no note, and no call to a Watcher bridge.

## Where it lives

- `src/renderer/src/watcher/` is the room: `WatcherView.tsx` (the room, its first entry, header, meter and Threads in flight), `WatcherOverview.tsx`, `WatcherOwl.tsx` (the owl and the badge), `watcherRoom.tsx` (the projection, read through the contract's bridge only while the gate is on) and `watcher.css`, which is on the `owned` list `themeTokens.test.ts` checks.
- `src/renderer/src/components/AppShell.tsx` holds the one room definition (`appRooms`), the `watcher` navigation's room and layout, and the focus hand-over. `SidebarFrame.tsx` draws the foot's switch from it, and its frame is now a shell shared by the Threads sidebar and the Overview; the Threads sidebar's DOM is unchanged.
- `ThreadPane.tsx`, `ThreadComposer.tsx`, `ThreadOptions.tsx` and `ThreadTranscript.tsx` gained narrow props for Watcher's header, its pinned asking mode and its signed replies. `ThreadSidebar.tsx` draws the badge.
- `src/shared/watcherRoom.ts` is ticket 3's contract, carried byte for byte from `feat/watcher-thread-tools` (768a3ab2b). The preload half lives on that branch.
- `src/renderer/src/e2e/watcherStandIn.ts` stands in for main's Watcher bridge in an end-to-end run that seeds a projection.

## What I worked out

- **The first entry is new.** The mock-up starts with Watcher already running. The first entry is built from what the app already has: the empty page's layout, the composer's model and effort chips, one button. It has not had Zach's eye.
- **Overview rows report and do not open.** Opening a thread beside Watcher, **Open to answer** and thread cards are ticket 7. Until then a row is plain list text, with no control that would lead nowhere, and the guide says to open the thread on the Threads page. The mock-up's "checked 20 s ago" and its refresh are left out too: the contract carries no check time, and a refresh with nothing to check would be a dead control. **Read by you**, **Read by Watcher** and **Observed** wait for the projection to carry them.
- **Stop all is left to ticket 7.** The contract has it, but its confirmation, partial results and receipts are ticket 7's, and half of it would be a control that does less than it says.
- **Threads in flight lives in the room.** The plan allowed the room's More actions or Settings. In the room it is one press from the meter it changes, and Settings stays as it was.
- **The meter counts main's in-flight threads,** not the badges: a watched thread waiting for nothing holds no slot. Its accessible value is the words on screen, "2 of 4 watched".
- **The Overview leans its status colours toward the text.** The warning and success colours are tuned against the canvas. On a sidebar they can fall under 4.5:1: Tropic's light **Needs you** heading read 4.32:1. The Overview mixes them a fifth of the way toward the text colour, which raises contrast in light and dark alike, to 5.65:1 on Tropic light.
- **The night sky stays.** An Owl sidebar's header has it beside Dictate, History and Help, so the Overview keeps it, and switching rooms does not change the header.
- **Watcher history stays on Threads** until Watcher has a place for it. Only the current Watcher moves to the room.
- **The owl glyph** is the mock-up's: build/tray-template.svg's 16-unit owl, no beak, eyes cut through.

## How it was run

`tests/e2e/watcher.spec.ts` runs the output of `npm run build` on owned e2e profiles with the `design-threads` fixture, never Zach's data, on the Owl track through `tests/e2e/support/releaseTrack.ts`. Main's Watcher side is ticket 3's, so each run seeds a projection through the stand-in: Release notes 1.4 stands for the current Watcher, with its history replaced by a Watcher conversation, and Watcher has started and watches Visual gate flake and Footer links, two in flight of four. These runs check the room, not main. The run published with `SOTTO_E2E_EVIDENCE=publish`; the measured values are in [readings.json](../../artifacts/watcher-room/readings.json).

- **First entry.** The room offers the fixture's models, opens on Sonnet 4.5, and **Start Watcher** opens Watcher's pane without a selection on the Threads page ([capture](../../artifacts/watcher-room/first-entry-sotto-dark-1280x800.png)).
- **Overview and badges.** The groups read Needs you 2, Working 2, Idle 4, in that order, with Watcher not among them. Footer links shows the owl in its sidebar row, its Overview row and its pane header, and its composer note; Weekly note shows none. Release notes 1.4 is not in the Threads list.
- **Threads in flight.** Choosing 3 shows **2 of 3 watched** and saves `watcherInFlightLimit: 3` in Sotto's settings. Escape closes the panel and focus returns to More Watcher actions.
- **Keyboard.** From each room and from Settings, Help and History, Home, End and the arrow keys reach Dictate, Watcher and Threads, and focus lands on the lit tab of the page that opens. From the lit owl, Tab goes History, Settings, Help, Check for updates, Resize sidebar, More Watcher actions, the conversation, its copy buttons, then Watcher message.
- **Sizes and themes.** At 1600x1000, 1280x800 and 820x560, in Sotto and Tropic, dark and light, nothing overflows or clips (`pageBoundProblems`), and Watcher message and More Watcher actions stay inside the window. At 820x560 the meter reads **2 of 4** and the Overview scrolls. Captures: Sotto dark at [1600](../../artifacts/watcher-room/room-sotto-dark-1600x1000.png), [1280](../../artifacts/watcher-room/room-sotto-dark-1280x800.png) and [820](../../artifacts/watcher-room/room-sotto-dark-820x560.png); Sotto light at [1600](../../artifacts/watcher-room/room-sotto-light-1600x1000.png), [1280](../../artifacts/watcher-room/room-sotto-light-1280x800.png) and [820](../../artifacts/watcher-room/room-sotto-light-820x560.png); Tropic [dark](../../artifacts/watcher-room/room-tropic-dark-1280x800.png) and [light](../../artifacts/watcher-room/room-tropic-light-1280x800.png) at 1280; the Threads page with its badges [at 1280](../../artifacts/watcher-room/threads-watched-sotto-dark-1280x800.png).
- **Reduced motion.** With reduced motion from the system alone, and from Sotto's setting alone, a working thread's ring runs no animation ([capture](../../artifacts/watcher-room/room-sotto-dark-1280x800-reduced-motion-setting.png)).
- **Stable.** With the same projection seeded, the switch has two tabs, no owl, badge or note appears, and Release notes 1.4 stays in the Threads list.
- `tests/e2e/watcher-gate.spec.ts` now expects the Watcher tab on Owl, the current Watcher out of the Threads list on Owl and Watcher history in it, and still none of either on stable.

### Contrast

Measured on the built app from computed colours, each piece of text against the surface under it (the night band at the top of an Owl sidebar, the sidebar below it). The lowest reading of each kind across the three sizes:

| Theme | Mode | Overview's muted text | Needs you | Working | Titles and requests | Meter | Ask before changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sotto | dark | 7.76 | 10.79 | 10.23 | 11.12 | 13.59 | 9.20 |
| Sotto | light | 6.26 | 5.89 | 6.74 | 9.73 | 10.44 | 6.95 |
| Tropic | dark | 5.78 | 8.97 | 13.92 | 8.97 | 10.04 | 6.23 |
| Tropic | light | 5.67 | 5.65 | 14.42 | 9.52 | 10.85 | 6.21 |

## Against the mock-up

Side by side at the same size, the mock-up's quiet-badge captures on the left and the built app on the right: [the room, dark](../../artifacts/watcher-room/compare-room-1280x800-dark.png), [the room, light](../../artifacts/watcher-room/compare-room-1280x800-light.png), [the room at 820x560](../../artifacts/watcher-room/compare-room-820x560-dark.png) and [the Threads page](../../artifacts/watcher-room/compare-threads-1280x800-dark.png). The switch, the tile, the Overview's rows, groups and counts, the header with the owl and the meter, the composer and the badges sit where the mock-up has them, in its colours; their sizes are the app's own sidebar and pane, which the mock-up copied. What differs is ticket 7's: the mock-up opens Fix flaky login test beside Watcher, with tabs at 820x560, and shows Stop all, thread cards, Open to answer and Watcher's name on the briefs it sent a worker. The built Overview also has no check time or refresh, as above.

## Not proven here

- Watcher's real main side. The room reads ticket 3's contract types, and its bridge reaches main only when ticket 3's preload and IPC are merged beside it; these runs used the stand-in.
- macOS and Linux, and scaling above 100%.
- `npm run design:verify` compares stable only. Its result for this branch is in the pull request.
