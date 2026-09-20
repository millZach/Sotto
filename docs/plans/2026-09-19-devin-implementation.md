# Devin local provider implementation — issue 150

Status: compatibility experiment in progress. The adapter is not implemented or registered.

## Scope and acceptance

Implement [issue 150](https://github.com/millZach/Sotto/issues/150) on the current branch as requested by the implement skill. Starting commit: da44e95413adff7486e43ef4a07fe8689dd8d2b0 originally on perf/agents-json-writes. The checkout was subsequently detached at that same commit; work now uses feat/devin-local-provider. Preserve unrelated prototypes and existing commits.

- [ ] Prove native authentication, permissions, session recovery, delivery reconciliation, and takeover before wiring the provider.
- [ ] Record the actual compatibility and privacy decision in an ADR and README.
- [ ] Implement the dedicated adapter through AgentHost, SottoThreadHost, and ConfiguredProviderHost.
- [ ] Pass the existing shared adapter contract without waiving required guarantees.
- [ ] Add Devin to the existing provider UI without enabling terminal/coordinator/personal-chat support.
- [ ] Verify affected Electron journeys and live Windows/Apple silicon macOS behavior.
- [ ] Run typecheck regularly, focused tests during development, and full CI gates once at completion.
- [ ] Complete the required two-axis code review and commit only this work.

## Verified native findings

The bundled CLI exists at the Devin Desktop installation's windsurf extension, under devin/bin/devin.exe; PATH discovery alone misses it. It reports version 3000.10.31 (b98cc431).

A no-prompt probe in a disposable folder initialized ACP 1 successfully with clientInfo.name set to sotto and filesystem/terminal client capabilities false. The native agent reports name affogato and version 0.0.0-dev, so its handshake version cannot stand in for the executable version.

Advertised capabilities include loadSession, session list/delete/additionalDirectories, image input, and embedded context. Only the devin-browser authentication method was advertised. These are advertisements, not proof that Sotto's complete flows work.

Native authentication now succeeds after Zach completed browser sign-in. Synthetic native model/permission/recovery checks have run in a disposable folder. No credential files have been read or copied.

Before sign-in, session creation succeeded but its model option list was empty. After sign-in, the catalog contained about 385 models. Successful creation alone is not proof of account readiness.

ACP starts a session in accept-edits. Launching with --permission-mode normal still produces accept-edits. session/set_mode with normal returns an empty success, while session/set_config_option with mode normal returns accept-edits. The advertised options are accept-edits, smart, ask, plan, and bypass. A supported approval-required policy remains unproven; successful RPC alone cannot confirm it.

Probe output contains selected capability/configuration facts and method/key names only. Protocol text, native stderr contents, credentials, and transcripts are not logged.

## Implementation map

Reuse the existing message-event path, provider snapshot publisher, idle reaper, and atomic metadata store. Grok's native history and permission extensions are not portable to Devin.

ProviderId is coupled to terminal launch support today. Adding Devin requires explicitly retaining the existing supported terminal providers and filtering terminal catalogs/defaults; a Devin thread model must not create an unsupported terminal command.

Keep subscription reasoning and personal-chat provider catalogs unchanged. The composite provider host requires a host for each provider schema entry, including test fixtures.

## Desktop UI acceptance

The requested surface is Sotto's existing desktop Providers/Threads experience, not a new design. Preserve its list/detail layout, Figtree, theme tokens, clear status/copy, current focus order, Escape behavior, and existing motion. Use the established provider connection feedback; no new decorative motion or layout is needed.

Inspect missing CLI, signed-out, incompatible policy, connected, streaming, question, permission, interrupt, and reconnect states at 1600×1000, 1280×800, and 820×560, in light/dark and reduced motion. No overflow, clipping, inaccessible controls, or contrast regressions. The scene that proves the addition is a Devin thread receiving and answering a permission in the existing pane.

## Current gaps

See [native compatibility evidence](../verification/2026-09-19-devin-native-compatibility.md) for the current results and the correction to the early Normal-mode inference. Login, text streaming, same-session replay, UUID identity, lock reporting, permission deny/allow under an explicit ask profile, cancellation at a pending permission, a structured enum question, and separately authored ACP input identity have been exercised.

The required approval boundary, privacy decision/account settings/destinations, full question/recovery/takeover semantics, and Apple silicon verification are not yet established. The feature remains at the compatibility gate, with no adapter or UI changes.

Baseline validation: npm run typecheck passed before any application change. No implementation gates, application review, or release verification have been claimed.
