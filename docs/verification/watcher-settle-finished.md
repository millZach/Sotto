# Settle finished threads

Checked on Windows on October 20, 2026. Watcher now settles a thread it watches once that thread's work is done and
Watcher has heard so, then stops watching it. **Settle finished threads** in Settings → Watcher turns this on and off, and
it is on by default. Zach picked layout A of three from the prototype tagged `prototype/watcher-settle-toggle`. ADR-0073's
October 20 amendment records the decisions.

## The setting, in the built app

`tests/e2e/watcher-settle-finished.spec.ts` launches the built app on the Owl track and opens Settings → Watcher. The
section leads with **Watched threads**, which holds the toggle, on. **Worker roles** follows under a heading of its own.
At 1600x1000, 1280x800 and the 820x560 minimum, nothing clips or overflows the page, and every heading and line of the toggle
meets 4.5:1 against its surface, in dark and in light. From the keyboard, Space turns the toggle off and on again, and
each press is saved.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/watcher-settle-finished/watcher-settings-1280x800-dark.png` | The section, dark, 1280x800 |
| `artifacts/watcher-settle-finished/watcher-settings-1280x800-light.png` | The same, light |
| `artifacts/watcher-settle-finished/watcher-settings-1600x1000-dark.png` | Dark, 1600x1000 |
| `artifacts/watcher-settle-finished/watcher-settings-820x560-dark.png` | Dark, at the minimum window |
| `artifacts/watcher-settle-finished/watcher-settings-1280x800-dark-off.png` | Turned off from the keyboard |

The toggle has no motion of its own beyond the switch's usual one, so reduced motion changes nothing. Its colours come
from the existing Settings group and Toggle styles. The Worker roles heading now uses the Settings group heading's theme
roles in `workerRoles.css`, which `themeTokens.test.ts` checks. `worker-roles.spec.ts` and `watcher-gate.spec.ts` passed
against the new section. Stable still shows no Watcher section.

## The behaviour

`tests/integration/watcherSettleFinished.test.ts` drives the real coordinator and Watcher over the fake Codex provider:

- A watched thread that finishes is not settled until Watcher's news turn about it has ended. Then it is settled and no
  longer watched. No notice is set and nothing more is sent to Watcher.
- While the setting is off, nothing is settled. Turned on, a thread that already qualifies is settled at once.
- A thread with an open question card, background work running, or a sub-agent whose end it could not see is left
  watched and unsettled.
- A thread whose delegated thread still works, or has a pull request open, is left alone until that ends.
- News still being saved to Watcher's queue does not count as heard.
- A thread with an open pull request is left alone, and is settled once that pull request is merged.
- A refused settle is tried once. Later updates don't ask again; the thread's next finished turn does, a turn the user
  sent included.

## Not checked here

The fake provider doesn't end Watcher's turns the way a real provider does, so a second wake-up to Watcher never goes in
that harness. Where a test needs Watcher to hear a second piece of news, it stands in for "Watcher has heard". The
settle of a paired host's thread goes through the same command the desktop's Settle sends there, after a second look,
and restores the watch if it fails. No automated test or live host covers that path. macOS and Linux were not checked. The design captures don't cover Settings → Watcher, so no baseline
changes.
