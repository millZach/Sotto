# Client updates, and the pins that blocked them

Evidence for `docs/adr/0020-provider-client-updates.md` and `docs/plans/2026-09-21-provider-client-updates.md`. Windows 11, this worktree, 2026-09-21.

## What the machine and the registry actually said

Read-only. No client was installed or replaced while writing this.

| Client | Installed here | `latest` on registry.npmjs.org | Channel found |
| --- | --- | --- | --- |
| Claude Code | 2.1.278 | 2.1.278 (`@anthropic-ai/claude-code`) | its own installer, `~/.local/bin/claude` |
| Codex | 0.155.1 | 0.155.1 (`@openai/codex`) | npm global, `%APPDATA%/npm` |
| Grok Build | 1.0.5 | 1.0.40 (`@xai-official/grok`) | npm global, `%APPDATA%/npm` |
| Devin | not installed here | not asked | the Devin app |

Grok is 35 patch releases behind, and before this change Sotto refused every version but 1.0.5, so taking the update would have broken the connection. That is the case the change exists for.

A read-only ACP `initialize` against the installed Grok 1.0.5 (no authenticate, no session, no paid turn) also answered `currentModelId: grok-4.7` with `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6` and `grok-4.5` in `modelState`, each reporting low/medium/high/xhigh except 4.5. Model catalogs come from the client, so 4.7 needed no code; its published rate is priced in `usageRates.ts` under `2026-09-21-standard-v3`.

## What the tests prove

`tests/unit/main/providerClientUpdates.test.ts` (13): 1.0.5 reads as older than 1.0.40, which a string compare gets backwards; the registry is asked once an hour and cached in between; an unreachable registry and an unreadable installed version both claim nothing; Devin is never asked about and is never offered an install; an npm global layout is recognised from the package beside the binary, while a bun or Homebrew path is named and not driven; an update refuses while a thread of that provider is working and proceeds when forced; the order is disconnect, install, reconnect, and the card then reports the version actually running; a failed install keeps the installed version, reports the installer's own last line and puts the connection back; the check holds nothing while it is turned off; and an install runs on the provider lane, leaving `globalLaneBusy` false and other commands answering while npm runs.

`tests/unit/renderer/clientUpdateCard.test.tsx` (7) and the three added cases in `tests/unit/renderer/providersSettings.test.tsx`: the card says nothing when every client is current; it names installed and published versions and sends the press; a working thread turns the press into "Update anyway" and carries `force`; an install Sotto will not drive shows the command instead of a button; a failure shows the installer's words and "Your installed version is unchanged"; nothing is pressable while an update runs; Escape puts the card down; the provider settings line carries the same sentence, the newer-than-checked note, and the one switch that turns the whole check off.

`tests/integration/grokAdapterFailures.test.ts` and `tests/integration/devinPolicyBoundary.test.ts` now hold the new contract against the fake providers: a client older than the checked version is still refused before `authenticate`, another protocol version is still refused, and a newer client (Grok 1.0.40, Devin 3000.11.02) connects and reports both the version running and the version Sotto checked.

`tests/unit/main/providerSwitch.test.ts` caught the settings gotcha in `AGENTS.md` while this was written: a new defaulted field must be re-extended on the `configure` patch, or every unrelated save resets it. It is re-extended.

## Gates

`npm run typecheck`, `npm run lint` and the full suite pass; the suite run for this note is recorded in the pull request.

## Not proved here

The card has not been photographed in the running app, and no client has actually been installed through it. Both need a real behind-client on a real profile: on this machine that means connecting Grok and pressing Update, which installs 1.0.40 over 1.0.5. That is the user's call, not a test's, and it is the one step left before this can be called finished. The three shapes the card was chosen from are in `design/provider-updates/provider-update-notice.html`, over a committed capture of the Threads page at 1:1 in light and dark.
