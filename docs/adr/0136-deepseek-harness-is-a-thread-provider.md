# DeepSeek Harness is a thread provider

Accepted October 24, 2026. The user asked that a model on their own server be drivable by DeepSeek Harness as well as OpenCode, and chose the shape the same day: an Owl feature (ADR-0072), your own model servers only, and three permission modes mapped onto the harness's sandbox. The wire facts below were checked live against `@deepseek-ai/dsh` 0.2.1-rc.2 on the Apple silicon Mac on October 24, 2026, with prompt runs on the user's Spark cluster; [the probe note](../research/2026-10-24-deepseek-harness-acp-probe.md) records the runs. It amends ADR-0124: OpenCode is no longer the only provider to run your own model servers. **Number provisional until merge** (docs/agents/domain.md).

DeepSeek Harness joins Codex, Claude Code, Grok Build, Devin, Muse, OpenCode and Cursor as a thread provider, id `deepseek`, shown as **DeepSeek Harness** — never "DeepSeek" alone, which stays the maker's name for its models. Its adapter speaks ACP over `dsh --profile acp` on stdio, as Grok Build's, Devin's and Cursor's do: one process per thread (ADR-0038) spawned in the thread's folder, `initialize` with protocol 1, then `session/new` or `session/resume`, `session/prompt`, `session/cancel`, `session/update` notifications and `session/request_permission` requests. Resume replays nothing, which suits Sotto's event store (ADR-0016): history is Sotto's, and a resumed provider session only continues the conversation. `session/load`, fork and deletion do not exist on this surface.

## The gate

DeepSeek Harness is an Owl feature (`deepseek` in `src/shared/owlFeatures.ts`) and one entry in `HELD_PROVIDER_ENTRIES`, held off stable the way Muse, OpenCode and Cursor were: a stand-in host that connects nothing and refuses work in words, provider lists that ask the gate before showing a DeepSeek Harness row, and saved records left whole so returning to Owl restores the provider.

## Finding and updating the client

Sotto finds `dsh` by its CLI lookup (ADR-0036). The floor is 0.2.1-rc.2, the version checked here, read from `dsh --version` because the ACP handshake's agent version is a hardcoded `0.0.1`; an older client is refused at connect with the version it reported. Updates follow ADR-0042: a copy npm owns is checked against `@deepseek-ai/dsh` on `registry.npmjs.org`, which the README already names, and updated by Sotto's npm runner; any other copy shows the command to run by hand. The line is a release candidate that warns of compatibility-breaking changes, so the floor moves only after the adapter contract and the live check pass against a newer client.

## Sotto's DeepSeek Harness folder

Every `dsh` process Sotto starts runs with `DSH_HOME` set to a folder of Sotto's own under Sotto's user data, made on first use. The user's own `~/.dsh` — its accounts, profiles and sessions from the desktop app or their own runs — is never read or written, as Sotto's OpenCode and Cursor folders are kept apart (ADR-0087, ADR-0128). A thread's provider sessions, the profile the launcher scaffolds and the patch overlay Sotto generates all live there. The environment is the shared allow-list without other providers' keys, plus one placeholder key variable per model server route (Models, below).

## Models: your own servers only

A DeepSeek Harness thread runs only on the user's own model servers (ADR-0124). Main's record stays the one truth, apart from any one provider. Each process is started with a `--patch` overlay main generates from that record at spawn, declaring one `dsh-llm-pi-ai` route per **keyless** server under the server's own ID: `openai-completions` at the server's address, each model with its context and output, thinking as the effort levels `dsh` offers, and the DeepSeek thinking format. The same overlay sets the ACP entry's provider and model, and disables the base profile's DeepSeek cloud adapters, so a process cannot reach `api.deepseek.com` in this version at all. A change to the record that changes the overlay makes DeepSeek Harness processes outdated beside OpenCode's (ADR-0124), and idle threads move to fresh processes that resume their provider sessions; a change that leaves it the same, such as a keyed server's, restarts nothing.

The catalog is built from the record, grouped by server in the model menu the way OpenCode groups by model source, the server being what a turn runs on here; the chip reads "Spark Cluster / DeepSeek V4.1 Flash" with the DeepSeek Harness mark, so a thread is never mistaken for another provider's. A thread's model and effort are set with `session/set_config_option` before the prompt that needs them and read back from the complete option state the harness returns. Images are not offered in this version: neither route checked advertised them over ACP.

**Keyed servers are not offered on DeepSeek Harness yet.** A server's key is kept by OpenCode and Sotto holds no copy (ADR-0124), so there is nothing honest to hand a second provider. The model menu and Settings say so where a keyed server would appear. Giving keyed servers to a second provider needs the user to enter the key again for it, under its own decision.

With no keyless server saved, the tile connects nothing and says to add a model server under Your own model servers, and a keyless Add lands while DeepSeek Harness's adapter runs, connected or not, so the first server never waits on OpenCode. A thread whose last keyless server went starts no process and says so. A server that goes away fails the turn the way an OpenCode thread on the same server does (ADR-0124's words, with this provider's name): nothing moves to another model on its own.

## Permissions

A thread's permission mode is its process's sandbox, set by environment at spawn; a mode change starts a fresh process in the new mode and resumes the provider session there, as Cursor's mode changes do.

- **Ask for approval** runs the harness's read-only sandbox with its ask policy. A write or command that would cross the boundary is denied once, the model retries it asking to cross, and that retry is shown as a request card. The permission menu says a first attempt is denied and the model asks to retry.
- **Auto-accept edits** runs the workspace-write sandbox with its ask policy: edits, commands and network inside the sandbox run without asking, and crossing its boundary asks. The menu says so, the way Cursor's menu says what its asking mode cannot ask about (ADR-0128).
- **Full access** runs danger-full-access, which asks about nothing.

**Automatic** is not offered; the harness's own auto-review is not part of its ACP surface. A request carries only the tool call's ID, so the card is built from the tool update that precedes it — the command or file, the boundary it asks to cross, and the model's own justification named as the model's. The user answers every one (ADR-0004) with allow once or reject; the harness offers no allow-always, and disconnecting sends no decision, which leaves the escalated action undone. A reject reaches the model as a refused tool call and the turn goes on.

## What a DeepSeek Harness thread can do in this first version

Replies and reasoning as committed messages (the harness sends no token deltas over ACP), tool calls with their arguments and results as thread activity — every kind arrives as `other`, so the adapter reads the tool's name and arguments — stopping by `session/cancel`, which settles the prompt and ends the running tool, model and effort per turn, queueing behind a running turn, resume after Sotto restarts (ADR-0076) by `session/resume`, and Sotto's tool servers passed as HTTP MCP servers at `session/new` with the thread's Bearer [REDACTED], as on Grok Build, Muse and Cursor. A server that fails to start fails the whole session in the harness, so the adapter asks for the thread's servers only once each is answering, as OpenCode's adapter waits before a send.

**Not yet:** steering a running turn; questions as cards (elicitation is outside the ACP surface, so the model asks in its reply); Sotto compacting the conversation, though `usage_update` says how full it is and the context indicator reads it; short text (ADR-0026), there being no tool-less generation route, so titles and drafts keep their stand-ins as on Devin and Muse; Fork from here natively, so a fork starts from a handover as on Cursor; skills in the composer, there being no command catalog on this surface; Watcher, which is refused before its process starts, as on Devin; and Usage's numeric history, the harness reporting context fullness rather than token counts, so a thread keeps no per-turn token readout and there is no Subscriptions card. Its provider profile says each of these (ADR-0095).

## Hosts and phones

Not in this version. A DeepSeek Harness thread's models come from this computer's own-servers record, and a paired host adding its own servers is a later phase of ADR-0124, so the provider is held on remote hosts the way OpenCode was before its hosts slice: a headless host offers no DeepSeek Harness and a phone sees none of its threads. When hosts gain their own servers, this provider follows with its own `provider-deepseek` host feature, as OpenCode and Cursor did.

## Privacy

Sotto itself contacts no new host: the update check reads `registry.npmjs.org`. A thread's harness talks only to the model server the thread's model names — an address the user typed, already named in the README for your own model servers — because the generated overlay disables the cloud adapters. Prompts, replies, approvals and server answers never reach a log; the adapter logs stable event names only.

## Consequences

- DeepSeek Harness is the eighth provider ID, and the second provider to run the user's own servers, so "which provider runs a server" is now a per-thread model choice rather than a Settings one.
- Ask for approval costs a denied first attempt and a model retry per write, and rests on the model asking to cross; a model that does not ask simply fails the write. The menu says the first part.
- Replies land whole rather than word by word until the harness streams deltas over ACP.
- The client is young and changing; the floor and the live check are the guard, as with Cursor.
