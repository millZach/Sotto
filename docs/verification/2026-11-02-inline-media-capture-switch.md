# The switch for every picture and video an agent makes (inline media, part 7)

November 2, 2026. Forge (Linux), built app under a virtual display; not installed or released. ADR-0170, decisions 22 to 24.

## What was proved in the running app

`tests/e2e/inline-media-every-picture.spec.ts`: a Codex thread over the fake app server writes a screenshot into its git-ignored `test-results/` and ends.

- **On, as it starts:** the turn shows the file as a tile, **Open picture 1 of 1, from Pictures and videos it wrote**, without the agent calling `show_in_thread`.
- **The row:** **Show every picture and video an agent makes** is on, in Settings → Threads under **What agents can do without asking**. It fits at 1280x800 in dark and light, and at the 820x560 minimum.
- **Off, from Settings:** the setting saves as off. The next turn writes a second file and ends, and the thread still has one tile.

`tests/e2e/inline-media.spec.ts` and `inline-media-shown.spec.ts` now set the switch off and pass as written: a screenshot a tool took and a file a turn wrote show nothing until the agent shows them. With `inline-media` off, the first shows nothing either way.

Captures in `artifacts/inline-media/`:

- `written-tile-1280-dark.png`
- `switch-1280-dark.png`
- `switch-1280-light.png`
- `switch-820-light.png`

## What was proved by tests, not seen

- **Tool results and viewed pictures, on and off:** `shownMedia.test.ts` and `toolPictureCapture.perf.test.ts`, through the store and through the Codex projection.
- **Turned off during a turn:** `writtenMedia.test.ts`. The turn's end lists nothing.
- **A headless host:** `hostDelegation.test.ts`, unit and integration, over a real socket. A recorded desktop is offered `every-agent-picture`, its answer survives a restart, a desktop that sends no word of it doesn't erase it, an older host is never sent the field, and a stable host doesn't offer it. No host's thread was seen gaining or losing a tile.

## Not checked

- The iPhone. It has no switch and no code changed; it shows what its computer kept.
- Windows and macOS. CI covers their gates; the journeys above ran on Linux.

## Performance

Median of three runs on forge. Main is bd229c329.

| | Main | Branch, switch off | Branch, switch on |
|---|---|---|---|
| Codex update, words alone | 5.29 µs | 5.42 µs | 5.63 µs |
| Codex update, Computer Use screenshot | 16.22 µs | 16.22 µs | 2.1 ms the first time, kept once |
| Codex update, `view_image` | 5.00 µs | 4.95 µs | read once, off the update path |
| Cursor update, screenshot | 1.37 µs | 1.47 µs | not timed |
| Pictures kept, file reads, per step | 0, 0 | 0, 0 | 1, 1 |
| A turn's end | nothing | nothing | 5.4 ms listing, 0.4 ms looking |

The turn's end is `writtenMediaTurnEnd.perf.test.ts`: a working copy with 300 committed pictures, a `node_modules` of 3,000 files and 43 listed files. `ownerScaleWorkBudget` and `streamingCopyBudget` pass unchanged, with no budget raised.

So off costs what main costs, and on, the default, costs what parts 3 and 4 cost before request-only: one hash of each picture a tool hands back, and one listing at each turn's end.
