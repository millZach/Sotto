# Settings → Providers as one list

Checked on Windows on October 23, 2026, in the built app on branch `feat/providers-list`. Settings → Providers is one card
with a row per provider, and a row opens in place to show what the Configuration and Models tabs used to. Zach picked
variant A, the list, from three prototypes (A, the list; B, a rail and detail; C, overview first), with each provider's
mark on a badge in its own colour. The prototype is kept as the tag `prototype/providers-settings`. The change goes straight
to stable: it is not an Owl feature. ADR-0110 is amended for it, since its decision 3 made each provider a card of its own.

## What changed

The provider cards, the detail card under them and its two tabs are gone. Each row's header is one button that opens and
closes the row, with a chevron, the provider's mark in the ink on a badge of its provider colour, the name, a status dot and
its word, and the version the client reports. Beside it are **Update to** and the published version, while an update can
be installed and checks are on, and the row's switch. An open row shows Local connection with Connect or Disconnect and
the refresh button, OpenCode's Model sources, Installed client with Update and Check again, Muse's sign-in line and shell
sandbox, Installation steps, the Devin note and the Threads with Muse or OpenCode details on the left, and the models on the
right. Below 680 pixels of list the models go under the rest, and below 600 the status and version go under the name. A
provider's error shows under its row whether the row is open or not. One row is open at a time, Codex's to begin with, as
the prototype opens one and the old page showed Codex first. Pressing the open row's header, or Escape inside the row,
closes it and leaves focus on the header. Up and Down move between headers, round from one end to the other, and Home and
End go to the first and last. "Choose what new threads start with under Agents." sits under the list, and Check for client
updates stays at the bottom.

Muse had no colour of its own, so `--tt-provider-muse` is new in both modes. OpenCode's light token is the dark shade its
mark is drawn in elsewhere, too dark under the ink, so its badge takes `--tt-provider-opencode-badge`, a pale shade in both
modes. `themeTokens.test.ts` lists both as constants, and the Omarchy readability check holds the ink to 4.5:1 on every
badge.

## What was done

A temporary capture spec, deleted before committing, launched the `success` fixture with the Muse and OpenCode fixtures
and both Owl features on, connected Codex, Claude Code, Muse and OpenCode, opened Settings → Providers and put away the
client updates card. It opened a row, scrolled it near the top and captured the window at 1600x1000, 1280x800 and the
820x560 minimum, in dark and light. At each capture it measured the list and the Settings scroll for sideways overflow and
every element in the list for clipped content; there was none at any size. The OpenCode fixture reports 2.0.31 against a
published 2.1.4, so its row showed **Update to 2.1.4** on its header, closed or open, and Update in its Installed client.

At 1600 and 1280 wide the header reads on one line, the statuses and versions in columns down the list, and the open row
has its connection and client beside its models, with Agent setting in the accent. At 820x560 each name has its status and
version under it, the switches line up down the list with or without the update beside them, and an open row's models
follow its client. From the keyboard, Down from Codex's header moved focus to Claude Code's and Enter opened it.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/providers-list/codex-dark-1600x1000.png` | Codex open, OpenCode's Update to 2.1.4, the whole page, dark |
| `artifacts/providers-list/codex-light-1280x800.png` | Codex open, light |
| `artifacts/providers-list/codex-dark-820x560.png` | Codex open at the minimum, its models under its client, dark |
| `artifacts/providers-list/codex-light-820x560.png` | The same, light |
| `artifacts/providers-list/closed-dark-820x560.png` | Every row closed at the minimum, the switches in line |
| `artifacts/providers-list/keyboard-claude-dark-820x560.png` | Claude Code opened from the keyboard, its header focused |
| `artifacts/providers-list/muse-dark-1280x800.png` | Muse open: its sign-in line, client, shell sandbox and models |
| `artifacts/providers-list/muse-light-820x560.png` | Muse open at the minimum, light |
| `artifacts/providers-list/opencode-light-1600x1000.png` | OpenCode open: Model sources, its update and its models, light |
| `artifacts/providers-list/opencode-dark-820x560.png` | OpenCode open at the minimum, dark |

The design baselines `settings-providers` and `settings-providers-light` were regenerated on this computer from the pages
and appearance capture specs, and only those two were kept with their manifest entries.

## Specs run

After `npm run build`: `providers-this-computer`, `opencode-provider`, `opencode-sign-in` and `host-opencode` passed.
`native-provider-selection`, `devin-provider` and `muse-provider` passed everything on this page and failed later, on
things this change does not touch: the first expects nine Settings pages where the app now shows Watcher and Performance
too, the second waits for a New thread dialog with Thread options that the current new-thread flow no longer opens, and
the third's relaunch into Owl found Muse needing attention with "Cannot access 'localRuntime' before initialization", an
error from `src/main/index.ts`. `multi-provider-live` needs live providers and was updated but not run.

## Not checked here

Screen readers were not run: that the header reads its name, its state and its status rests on `aria-expanded` and
`aria-describedby`, not on a listening check. Reduced motion was set for the captures, so the arrival animation was not
looked at. A failed update, a queued update and a provider needing attention were checked by the unit tests, not in
captures. macOS and Linux were not checked.
