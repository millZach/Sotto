# Client updates, and the pins that blocked them

Evidence for `docs/adr/0021-provider-client-updates.md` and `docs/plans/2026-09-21-provider-client-updates.md`. Windows 11, 2026-09-21. The built app was run on a throwaway user-data folder, since deleted, so nothing here touched the real profile; the clients and their sign-ins are the machine's own, which is why connecting worked at all.

## What the machine and the registry said, before

| Client | Installed | `latest` on registry.npmjs.org | Channel found |
| --- | --- | --- | --- |
| Claude Code | 2.1.278 | 2.1.278 (`@anthropic-ai/claude-code`) | its own installer, `~/.local/bin/claude.exe` |
| Codex | 0.155.1 | 0.155.1 (`@openai/codex`) | npm global, vendored binary inside the package |
| Grok Build | 1.0.5 | 1.0.40 (`@xai-official/grok`) | npm global, binary in `~/.grok/bin` |
| Devin | not installed here | not asked | the Devin app |

Grok was 35 patch releases behind, and Sotto's exact pin was what kept it there: connecting to 1.0.40 would have failed with "requires Grok CLI 1.0.5".

## What running it found

Four things that tests could not have found, because each one was a fact about this machine rather than about the code.

1. **The registry answers 406 to the header the check sent.** `accept: application/vnd.npm.install-v1+json` is the abbreviated packument type, valid on `/<package>` and refused on `/<package>/latest`. Every check failed with "Sotto could not reach the registry to see what is published", which is the right sentence for the wrong reason. The check now sends `application/json`, and a test pins the header by answering 406 to anything else.
2. **Codex's version is inside a user agent.** The app server reports `sotto/0.155.1 (Windows 10.0.26200; x86_64) unknown (sotto; 1.0)` — its version, the OS's, and Sotto's own. Taking the first token read the installed version as `sotto`. It now reads the product's own version out of a user agent, and falls back to the first version-shaped run of digits.
3. **npm owns a client whose binary lives somewhere else.** Grok Build resolves to `~/.grok/bin/grok.exe`, 142 MB with no `node_modules` anywhere near it, so it was read as a client that updates itself. `grok update` then answered `Error: program not found`, and `grok update --check --json` explained why: `{"currentVersion":"1.0.5","latestVersion":null,"installer":"npm","error":"program not found"}`. The client says npm installed it, and its own updater cannot find npm. Detection now asks the npm global root as well as the path, so Grok reads as npm; only a client npm does not own updates itself.
4. **`cmd /s /c` loses its quoting.** Running `cmd /d /s /c "C:\…\npm.cmd" install -g …` answered `operable program or batch file.` — the tail of "is not recognized as an internal or external command". npm now runs as `npm-cli.js` under this process's own Node through `ELECTRON_RUN_AS_NODE`: no shell, no quoting.

## What then happened, in the running app

With those four fixed, the card appeared in the corner of the real window with the real reading:

```
grok  installed 1.0.5  published 1.0.40  behind  channel npm  command "npm install -g @xai-official/grok@latest"
codex installed 0.155.1 published 0.155.1 current
```

![The card, with Grok Build behind](../../artifacts/provider-client-updates/01-card-grok-behind.png)

Pressing **Update** disconnected Grok, ran npm, and reconnected:

![Updating](../../artifacts/provider-client-updates/02-card-updating.png)

The install worked. `~/.grok/bin/` gained `grok-1.0.40.exe`, `grok.exe` became the new binary with the old one kept as `grok.exe.old`, and `grok.exe --version` answered `grok 1.0.40 (eb1a2256660d)`.

**But the app still reported 1.0.5 after reconnecting**, because a Grok leader process from before the update was still alive and answered for it. The card said "Clients updated · Now 1.0.5", which is a lie the user can check by looking at the version beside it. That is the fifth finding, and the reason the reading now has an `unchanged` outcome: when the installer finishes and the version does not move, the card says "A client did not change · The update ran, but this client is the one still open", names the version it is still on, and says to close other windows and connect again.

On the next launch, with no stale leader, the app connected to the new client:

```
grok  connected  "1.0.40 / ACP 1"  verifiedVersion "1.0.5"
grok  installed 1.0.40  published 1.0.40  behind false
```

![Settings at 1600x1000, dark](../../artifacts/provider-client-updates/03-settings-1600x1000-dark.png)

That last line is the pin change proved live: **Sotto is running a Grok client the old exact pin would have refused**, it says so ("It is newer than the 1.0.5 Sotto has checked"), and a read-only ACP `initialize` against 1.0.40 confirms the protocol it was checked against — ACP 1, `cached_token`, and the same catalog with `grok-4.7` current.

The machine was left on the published version: package `@xai-official/grok` 1.0.40, binary 1.0.40.

## What 0.1.12 shipped without

Claude Code showed "Connect this provider to read its installed version" while it was connected. Its
adapter only learns a version from a running session's `system/init` frame, so a connected but idle
provider had none, and the check skips a provider whose installed version it cannot read. Codex takes
its version from `initialize` and Grok and Devin from theirs; Claude had no equivalent. It is now
asked for `--version` at connect, and the four read together:

```
claude  2.1.278     published 2.1.278     channel self-update
codex   0.155.1     published 0.155.1     channel npm
grok    1.0.40      published 1.0.40      channel npm
devin   3000.10.31  not asked             channel devin-app
```

![Claude Code's version, read at connect](../../artifacts/provider-client-updates/05-claude-version.png)

A provider that is connected but has no reading yet no longer reads as one that needs connecting.

## The design gate

The Installed client block and its switch were checked in the running app at **1600x1000, 1280x800 and 820x560**, in dark and in light, measuring `scrollWidth`/`clientWidth` on the block at each: nothing overflows or clips at any of them, and the sentence wraps to two lines at the 820 minimum rather than being cut.

![Settings at 820x560, light](../../artifacts/provider-client-updates/04-settings-820x560-light.png)

The card could not be re-staged at those sizes. Every installed client is now current, and the one that was behind cannot be put back: copying the older binary over `~/.grok/bin/grok.exe` fails with `Device or resource busy`, because a running client holds it — the same constraint the update sequence is built around. The card was captured at the window's default size while Grok was genuinely behind (above); its width is `min(360px, calc(100vw - 40px))` fixed to the bottom-right corner, so the 820 minimum leaves it a 20px gutter, and its reduced-motion and light-mode rules are in `clientUpdates.css` beside the tokens the rest of the app uses. A run at the three sizes with a behind client is worth doing the next time one appears.

## The review

Both axes of `/code-review` ran against `origin/main...HEAD` before merge. Fixed from them: the Settings press forced an update past a working thread while its label still read "Update" (it now reads "Update anyway" and the line says what will stop); "Update all" did the same for every row; a reading was dropped when its provider would not reconnect, taking the sentence about it off the card; a dismissal did not take a failed or unchanged card down; npm's last line could carry a home folder and user name to the card, to Settings and to the turn record, which is now dropped and redacted; a refusal claimed Sotto did not know how a client was installed even when the real reason was that it was already current; and `CLIENT_NAMES` was duplicated with two different names for Devin. Left as they are: the POSIX npm roots (macOS is a supported target), and the `--tt-corner-inset` name for a measured layout value.

## What the tests prove

`tests/unit/main/providerClientUpdates.test.ts` (20): 1.0.5 reads as older than 1.0.40, which a string compare gets backwards; the client's own version is found in a protocol note and in a user agent; the registry is asked as plain JSON, once an hour, cached in between; an unreachable registry and an unreadable version claim nothing; Devin is never asked about; npm is recognised from a vendored binary, from a package beside the launcher, and from the global root when the binary lives elsewhere; bun and Homebrew are named rather than driven; an update refuses while a thread works and proceeds when forced; the order is disconnect, install, reconnect; a failed install keeps the version, reports the installer's last line and restores the connection; an install that changes nothing reports `unchanged`; a client that will not reconnect still reports the install; the check holds nothing while it is off; and an install runs on the provider lane, leaving `globalLaneBusy` false.

`tests/unit/renderer/clientUpdateCard.test.tsx` (7) and three cases in `tests/unit/renderer/providersSettings.test.tsx` cover the card's states, the working-thread wording and its `force`, the command-instead-of-a-button row, Escape, and the settings line with its switch.

`tests/integration/grokAdapterFailures.test.ts` and `tests/integration/devinPolicyBoundary.test.ts` hold the version contract against the fake providers: older than checked is refused before `authenticate`, another protocol version is refused, and a newer client (Grok 1.0.40, Devin 3000.11.02) connects and reports both versions.

## Gates

`npm run typecheck`, `npm run lint`, `npm run notices:verify` and `node scripts/release-external-dependencies.mjs` pass. The full suite run is recorded in the pull request.
