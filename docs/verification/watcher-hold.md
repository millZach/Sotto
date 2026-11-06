# Watcher's hold and the band in its room

Checked on forge (Omarchy, Linux) on November 5, 2026, in the built app under `xvfb-run`, for #2234. While Watcher's own
provider is limited or failing, Sotto holds the news it would wake Watcher with, and the room shows one band under its
top strip. Zach picked variant A, a band in the room, from `docs/prototypes/watcher-limit-recovery-prototype.html` at the
tag `prototype/watcher-audit-2026-11-05`. ADR-0144's November 5 amendment records the decision.

## What was done

`tests/e2e/watcher.spec.ts`, "while Watcher's provider is limited or failing, one band under the strip is the one
notice, at every size (#2234)", seeds Watcher's room with a hold on the Owl track, with Watcher's last turn failed. It ran
in dark and light, with reduced motion, at 1600x1000, 1280x800 and the 820x560 minimum. At each size nothing
overflowed or clipped, and every line of the band met 4.5:1 on the surface under it (`artifacts/watcher-hold/readings.json`).

- **Limited.** "Watcher's Claude Code limit resets Thursday at 1:01 pm. Sotto is holding 37 news until then." There
  is no Try now, since a limit with a reset waits for it. **What's held** opens from the keyboard, says "6 from pull
  requests, 31 from threads. Watcher gets it in one message at the reset. A message you send goes first.", and its
  `aria-expanded` follows. The sentence stays on one line at 820x560. Watcher's composer still takes a message.
- **Failing.** "Claude Code isn't answering. Sotto holds news and tries again every few minutes. Holding 12 so far.",
  with **Try now**, the last try's time, and **Details** closed. Opened, Details shows the provider's error and "Failing
  since 11:22 am · 17 tries". Try now went, and the band said when.
- **No reply.** The failed turn keeps its "Failed after 1m 00s" line, and its error shows nowhere in the conversation.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/watcher-hold/hold-limited-dark-1280x800.png` | Limited, What's held open, dark, 1280x800 |
| `artifacts/watcher-hold/hold-limited-light-820x560.png` | Limited, light, at the minimum window |
| `artifacts/watcher-hold/hold-failing-light-1280x800.png` | Failing, Details open, light, 1280x800 |
| `artifacts/watcher-hold/hold-failing-dark-820x560.png` | Failing, dark, at the minimum window |

The band arrives with the limit restart band's motion, which reduced motion turns off. Its colours come from theme roles
in `src/renderer/src/watcher/watcher.css`, which `themeTokens.test.ts` checks.

What the room cannot show was checked against main's own coordinator and Watcher in
`tests/integration/watcherHold.test.ts`, over the fake Codex app server. When Watcher's turn failed, the room's hold read
failing with the provider's error. A worker's finish was held, and Watcher got no send. The user's message to Watcher went
to its queue rather than starting a turn. Try now sent that message first, and once its turn finished, the held news went
in one wake. The restarts for work left are in `tests/unit/main/limitRestart.test.ts`, and the hold's own rules in
`tests/unit/main/watcherHold.test.ts`.

## Not checked here

Windows and macOS were not captured. The design captures do not cover Watcher's room, so no baseline changes. A live
Claude Code limit or outage was not reproduced: the band and the hold were driven by a seeded room and by the fake
provider. Light and dark were checked on the T3 Code theme only.
