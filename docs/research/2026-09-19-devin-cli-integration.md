# Devin CLI integration feasibility

Research date: 2026-09-19. Scope: connecting the local Devin CLI to Sotto. This is a documentation and source assessment, not an implementation or live-provider verification. No Devin installation, authentication, inference, or paid usage was performed.

Subsequent implementation work found the bundled CLI, completed native sign-in, and ran synthetic compatibility probes. See the [native evidence and remaining gates](../verification/2026-09-19-devin-native-compatibility.md); the assessment below records the earlier documentation-only stage.

## Conclusion

Devin provides a supported integration surface: `devin acp`, an Agent Client Protocol server using JSON-RPC over stdin/stdout. A dedicated Sotto provider adapter is a plausible route. Terminal scraping and repeated one-shot prompts should not be the foundation. The main unresolved work is proving permissions, persisted-session recovery, authentication, and privacy behavior with the released binary. [Commands reference](https://docs.devin.ai/cli/reference/commands)

## Documented integration surface

| Concern | Evidence and implication |
| --- | --- |
| Transport | `devin acp` is expressly intended for subprocess clients. ACP authentication can occur at runtime; documentation also lists `WINDSURF_API_KEY` or credentials saved by `devin auth login`. |
| Session discovery | `devin list --format json` offers machine-readable discovery. `--continue` and `--resume <id>` exist for the standalone CLI; these flags do not prove ACP method support. |
| Models | `devin models list --format json` enumerates account models; `devin acp --model <name>` chooses a default. |
| One-shot fallback | `devin -p` prints a response then exits. It cannot display an untrusted-workspace prompt. This is useful for scripts, but does not establish an interactive Sotto permission channel. |
| Platform | Native Windows installers cover x64 and ARM64; macOS supports script/Homebrew installation. WSL is unnecessary for ordinary Windows operation. Native Windows does not support Devin's optional OS sandbox; that requires WSL. |

Sources: [Commands reference](https://docs.devin.ai/cli/reference/commands), [Quickstart](https://docs.devin.ai/cli), [Sandbox](https://docs.devin.ai/cli/sandbox).

The official Zed guide demonstrates third-party ACP use with browser authentication, model selection, streamed terminal output, and advertised slash commands. It also warns that some richer interactions remain standalone-CLI-only. Therefore “ACP exists” is verified documentation; complete parity with Devin's terminal is not. [Zed integration](https://docs.devin.ai/cli/acp/zed)

The latest stable changelog entry inspected is **v3000.10.31, September 16, 2026**. Earlier entries document ACP persistence/resume fixes, tool-output streaming, standard elicitation for agent questions, and Windows process-tree cancellation fixes. This supports feasibility but also argues for version-pinned compatibility tests. A historical entry says ACP required host-provided credentials instead of local fallback; the current commands page describes local fallback. The precise host/authentication behavior needs a live check. [Stable changelog](https://docs.devin.ai/cli/changelog/stable)

## What ACP supplies, and what must be checked

ACP's `initialize` exchanges protocol version, capabilities, identity, and authentication methods. Sotto should inspect the response, rather than assume every optional feature exists. [Initialization](https://agentclientprotocol.com/protocol/v1/initialization)

The protocol supports `session/new` with an absolute working directory. `session/load` is conditional on `loadSession`; it replays conversation updates before completing. The separate `session/resume` reconnects without replay and requires its own advertised capability. These are protocol facilities, not proof that the installed Devin build implements both. [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)

Prompts stream `session/update` notifications. `session/cancel` asks the agent to stop; pending permission requests must receive a cancelled outcome, and the original prompt should finish with a cancelled stop reason. Late updates may still arrive before completion. [Prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn)

`session/request_permission` carries a tool description and selectable permission options, including once/always approval and rejection. Sotto must translate explicit user decisions, preserve request identity, and fail closed when a request becomes stale or unsupported. ACP permits clients to auto-approve under user settings; Sotto's own authority rules remain the controlling constraint. [Tool calls and permissions](https://agentclientprotocol.com/protocol/v1/tool-calls)

Unverified for Devin: exact capability payloads, model/mode schemas, transcript replay fidelity, restart behavior, concurrent sessions, structured questions, cancellation while awaiting approval, and whether client-side filesystem/terminal capabilities are optional in practice. The documentation alone does not settle these.

## Permissions are the principal compatibility test

Devin Normal mode automatically permits reads and prompts for writes, shell commands, and fetches. Accept Edits, Smart, Bypass, and Autonomous can approve more without a person; Smart delegates decisions to a model. Configuration rules can also grant access. Consequently, merely forwarding ACP prompts does not prove that every action Sotto expects to mediate reaches Sotto. An integration must deliberately select and verify the intended mode and configuration precedence. [Devin permissions](https://docs.devin.ai/cli/reference/permissions)

Devin automatically imports rules, skills, and MCP configuration from several other coding tools; imports are enabled by default and configurable through `read_config_from`. This helps existing projects work, but introduces inherited tools and configuration that need an explicit integration policy. Instructions and imported setup must not become Sotto permission grants. [Configuration import](https://docs.devin.ai/cli/reference/configuration/read-config-from)

## Account, cost, and privacy

Use the user's Devin login where supported; do not route Devin through Sotto's OpenRouter key. The enterprise auth guide documents a persistent token in `credentials.toml` and enterprise ACU billing. Its enterprise-only wording should not be generalized: the current Zed guide explicitly allows free signup. Account entitlement and authentication must be checked with the intended account. [Enterprise authentication](https://docs.devin.ai/cli/enterprise/devin-auth), [Zed authentication](https://docs.devin.ai/cli/acp/zed)

Current public pricing lists Free, Pro at $20/month, and Max at $200/month; paid quotas renew daily/weekly and extra usage is purchased separately. Model availability and consumption vary. These are research-date prices, not a promise of a particular account's CLI allowance. [Pricing](https://devin.ai/pricing)

Local execution does **not** mean local-only processing. Devin's CLI controls documentation describes analytics for model usage, messages, credits, tool counts, and lines changed, with an exception for hybrid deployments. No general telemetry-disable switch was established in the inspected configuration documentation. The complete outbound-host list, retention behavior, and log contents remain unverified. Sotto needs an explicit privacy decision and README/ADR treatment before implementation. [CLI controls](https://docs.devin.ai/cli/enterprise/controls), [Configuration reference](https://docs.devin.ai/cli/reference/configuration/config-file)

Cognition's general security page says customer data may be used for training by default, paid accounts can opt out in Data Controls, and Enterprise data is not trained on without express consent. This broad policy is not a CLI-specific guarantee; verify the chosen account's controls and applicable terms. [Security and data controls](https://docs.devin.ai/admin/security)

## Keep the first scope local

Devin CLI operates on local files and tools; Devin Cloud works in a remote environment. Cloud handoff is a distinct workflow and should be evaluated separately from adding Devin as a local Sotto provider. The official quickstart explicitly distinguishes these products and says CLI lacks Cloud Knowledge, Playbooks, and Secrets. [Product distinction](https://docs.devin.ai/cli), [Cloud handoff](https://docs.devin.ai/cli/handoff)

The next useful experiment is a small ACP compatibility probe on native Windows, followed by Apple silicon macOS: authenticate, create a session in a disposable folder, stream a prompt, reject then approve a harmless edit, answer a question, cancel an active turn, restart, and recover the same session. Capture sanitized protocol shapes and stable events only. That experiment would resolve the largest technical uncertainties before committing to a finished adapter.

## Fit with the current Sotto checkout

The integration is **moderate effort**, conditional on the protocol probe. These are local source findings, not claims about Devin:

- Implement a `DevinAcpHost` behind the existing [AgentHost](../../src/main/agents/host.ts), wrap it with [SottoThreadHost](../../src/main/agents/threads.ts), and register it in [ConfiguredProviderHost](../../src/main/agents/providerSwitch.ts) through [main](../../src/main/index.ts). Existing project folders, worktrees, attention queue, thread panes, and event storage provide the surrounding infrastructure. [ADR-0002](../adr/0002-sotto-owned-thread-identity.md), [ADR-0008](../adr/0008-independent-coordinator-and-thread-providers.md), and [ADR-0016](../adr/0016-sotto-owned-history-on-an-event-store.md) define these boundaries.
- [grokRpc.ts](../../src/main/agents/grokRpc.ts) already demonstrates bounded JSON-RPC over a hidden child process. Reuse narrowly proven transport mechanics; do not copy Grok's credential environment, version checks, or vendor methods. [grok.ts](../../src/main/agents/grok.ts) depends on `_x.ai/session/updates`, `_x.ai/session/close`, model metadata, and question extensions that Devin is not documented to implement.
- Add the provider enum, label, and enabled-provider capacity in [shared/agents.ts](../../src/shared/agents.ts): the array currently has a maximum of three. Update [ProvidersSettings](../../src/renderer/src/agents/ProvidersSettings.tsx), provider marks, and capability-driven controls. Terminal-launch support has a separate command map in [terminalCommands](../../src/shared/terminalCommands/index.ts). Adding Devin as a thread provider does not require making it Sotto's separate reasoning coordinator or a personal-chat provider.
- [control.ts](../../src/main/agents/control.ts) requires both submission and reconciliation for manual sending. A manual-only adapter therefore still needs reliable delivery reconciliation; it cannot work around missing recovery by merely hiding supervision. External native messages must be identified before claiming safe supervision.

The [shared adapter contract](../../tests/integration/adapterContract.ts) is the acceptance bar: stream replies; answer questions and permissions; never approve a skipped request; interrupt; recover the same thread after restart; reconcile a lost acknowledgement without resending; detect native takeover and reject a stale follow-up; start sessions lazily; preserve event-store history; and reap only eligible idle sessions. A process-owned turn may stop on disconnect: the contract accommodates that, but its actual outcome must be reported accurately.

Sotto already permits explicit user-selected native permission modes. The requirement is to preserve the chosen mode and route requests to the user, not silently select Devin Smart or Bypass to make the integration work. [ADR-0004](../adr/0004-authority-in-policy-records.md) remains authoritative. Prove startup with Sotto's truthful client identity and minimal client capabilities; if Devin requires filesystem or terminal delegation, that is additional work and authority review.

## Effort estimate and decision

These are planning estimates for an engineer familiar with Sotto, not measured delivery times:

| Scope | Estimated effort |
| --- | --- |
| Compatibility probe, with an installed and authenticated CLI | 1–2 engineering days |
| Reliable local thread provider, including the probe, adapter, recovery, UI wiring, tests, documentation, and Windows/macOS verification | About 1–2 engineering weeks if the probe passes |
| Cloud handoff, remote working copies, or using Devin as Sotto's reasoning coordinator | Separate scope; not estimated here |

Missing durable message identity/history, required client-side execution, account restrictions, or privacy controls can push the estimate higher or require a product decision. Do not spend the full estimate before testing those uncertainties. Native Windows enterprise accounts that require Devin's OS sandbox may need WSL, which would add path and working-copy integration work. [Sandbox requirements](https://docs.devin.ai/cli/sandbox)

Before implementation, record the provider/privacy decision in an ADR and update README destinations and account behavior. Then implement only capabilities demonstrated by the pinned binary and run the shared contract, CI gates, relevant Electron journeys, and visual checks. Keep cloud handoff and coordinator support outside the initial scope.

Research completion: official documentation and the local architecture were inspected; `Get-Command devin` found no executable on the current PATH. This does not rule out an installation elsewhere. No live compatibility claim is made. Only this research note was added; existing application edits were left untouched, and no implementation tests were needed for this documentation-only change.
