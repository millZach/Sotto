# Fast mode in the composer, October 26, 2026

[ADR-0143](../adr/0143-fast-mode-is-a-thread-setting.md) puts a fast mode toggle on Claude Code and Codex threads: a bolt after the model chip, Zach's pick A of the `prototype/composer-fast-mode` tag. This note says how the bolt was checked in the built app, what the captures show, and what the tests prove about the providers.

## How the captures were made

The app was built with `npm run build` and launched through Playwright on the `phase3-workspace` e2e scenario, the one whose fake models carry their provider. That scenario's catalog has no model with fast mode, so for this check only, `src/main/e2e/agentEffects.ts` was patched to give its Claude and Codex models fast mode, the five effort levels and Sotto's four permission modes, and to save `fastMode` on a settings change. The patch and the throwaway spec that drove it were removed afterwards and are not committed; the e2e host and its design captures are unchanged. The thread is a new one on the fake Claude model before its first send, which is where a new thread's chips first show.

The toggle was pressed with Space while it had focus, then focus was moved off it, so the captures show the bolt at rest.

## What the captures show

At 1280×800 the composer is wide enough for every chip's words:

- off: [dark](../../artifacts/composer-fast-mode/composer-1280-off-dark.png), [light](../../artifacts/composer-fast-mode/composer-1280-off-light.png)
- on: [dark](../../artifacts/composer-fast-mode/composer-1280-on-dark.png), [light](../../artifacts/composer-fast-mode/composer-1280-on-light.png)

At the 820×560 minimum the pane is 560 px wide, under the 720 px where permissions shows its shield:

- off: [dark](../../artifacts/composer-fast-mode/composer-820-off-dark.png), [light](../../artifacts/composer-fast-mode/composer-820-off-light.png)
- on: [dark](../../artifacts/composer-fast-mode/composer-820-on-dark.png), [light](../../artifacts/composer-fast-mode/composer-820-on-light.png)
- [pointed at while on, dark](../../artifacts/composer-fast-mode/composer-820-hover-dark.png): the chips' hover wash.

In every capture the row reads model, bolt, effort, permissions, Watch. The bolt is 28 by 28 px, inside the composer card, and the chip row's scroll width equals its width, so nothing overflows; 1600×1000 was checked the same way. Off, the bolt is an outline in the muted text colour; on, it is filled in the accent text colour. Space toggled it and focus stayed on it.

## Contrast

The bolt is a graphic on a control, so it needs 3:1 against the composer card. The colours were read from the running window, the off state's `opacity: .75` blended over the card:

| State | Dark | Light |
| --- | --- | --- |
| Off, muted text at 0.75 | 5.34:1 | 3.53:1 |
| On, accent text | 11.41:1 | 6.62:1 |

Both pass, so the opacity stays at .75. Light's off state is the closest, at 3.53:1.

## What the tests prove

Against the fake Claude Code and Codex clients in `tests/fixtures/`, not a live client:

- Claude Code launches with `--settings {"fastMode":true}` only where fast mode runs. A running CLI gets `apply_flag_settings`, and fast mode goes off before a model change and on after one. A CLI that refuses to turn it on leaves the refusal standing: the model it had already taken is put back, nothing restarts, and the thread shows fast mode off. A spare started without the flag is not used for a first send that turns it on.
- Codex names `priority` or `default` on start, resume and fork only where the model offers Fast, and on `thread/settings/update` only where the model offers it or the thread is leaving a model it ran fast on. A fork starts on `default`. A change shows as on only once Codex reports the Fast tier. A thread on a model without Fast starts and forks whatever tier Codex reports, since Sotto asked for none.
- The renderer draws the bolt only for a Claude Code or Codex model that offers fast mode, sends `fastMode` on a press, and says a refusal and an unconfirmed change in fast mode's own words.

The live checks were narrower: codex-cli 0.164.0's `model/list`, `thread/start` and `thread/settings/update` were probed with ephemeral threads and no prompt, and Claude Code 2.1.310's catalog with its metadata-only `initialize`. No thread has run a turn in fast mode against a real provider.
