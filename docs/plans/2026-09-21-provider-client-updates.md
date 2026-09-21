# Tell the user a provider client is behind, and offer to install it

Branch: `feat/provider-client-updates`. Decision: `docs/adr/0021-provider-client-updates.md`. Mock-up: `design/provider-updates/provider-update-notice.html`.

## What was asked

Be told when a newer Claude Code, Codex, Grok Build or Devin client is published, and be able to install it from the app, the way T3 Code does it. Zach chose variant B from the mock-up: one card in the bottom-right corner holding every behind client, with one press to update them all.

## What the installed machine showed

| Client | Installed | Published | Install channel |
| --- | --- | --- | --- |
| Claude Code | 2.1.278 | 2.1.278 | its own installer in `~/.local/bin` |
| Codex | 0.155.1 | 0.155.1 | npm global |
| Grok Build | 1.0.5 | 1.0.40 | npm global |
| Devin | not installed here | — | inside the Devin desktop app |

Grok is the case the feature exists for, and it is also the case Sotto's exact version pin would block: connecting to 1.0.40 fails today with "requires Grok CLI 1.0.5". The pin work is part of this change, not a follow-up.

## Deliverables

- [x] Shared: the update record on the agent state, the two new commands, the setting.
- [x] Main: published-version lookup against `registry.npmjs.org` with an hourly cache and an injected fetch; channel detection from the resolved executable path; the update run, bounded and locked.
- [x] Main: disconnect, update, reconnect, re-read the version; refuse while a thread of that provider is working unless forced.
- [x] Main: exact version pins become verified minimums for Grok Build and Devin, with a recorded note when the installed client is newer.
- [x] Renderer: the corner card, its five states, and a durable line per provider in Settings → Providers so a dismissed card is not the only place it existed.
- [x] Tests: version comparison, channel detection, registry client failures, the refusal while a thread works, the update sequence, the renderer card.
- [x] Docs: ADR, README privacy line, `CONTEXT.md` terms, `docs/agent-control.md`, verification note (`docs/verification/2026-09-21-provider-client-updates.md`). The in-app captures are the one thing left: they need a real behind-client on a real profile, which is Zach's call to run.

## Test seams

`OpenVsxClient`'s injected `FetchLike` is the pattern for the registry client. The adapter fake-provider fixtures cover disconnect/reconnect. The update run takes an injected spawn so no test installs anything.

## Constraints

No new runtime dependency: `fetch` in main and a hand-rolled numeric version compare. The renderer never reaches the network. Nothing but a package name leaves the machine.
