# OpenCode is a thread provider

Accepted October 16, 2026. Zach asked for OpenCode the way T3 Code has it, and chose the shape the same day: an Owl feature (ADR-0072), OpenCode 2 only, a full Threads provider as Muse is (ADR-0079), OpenCode's own data folder shared with the OpenCode he runs himself, and model menu variant C, model source first. The wire facts below were checked live against OpenCode 2.0.31 on the Windows laptop on October 16, 2026, and T3 Code's two OpenCode adapters were read at `e58a4857`; [the research note](../research/2026-10-16-t3-opencode.md) records both.

OpenCode joins Codex, Claude Code, Grok Build, Devin and Muse as a thread provider, id `opencode`, shown as **OpenCode**. Its adapter speaks OpenCode 2's HTTP server, not its ACP mode: one `opencode serve --hostname=127.0.0.1 --port=0` per thread (ADR-0038), reached on the port it prints with HTTP Basic and a password Sotto makes for that process alone, with live work read from the server's event stream. Several servers share one OpenCode data folder once its database exists, so the first server on a folder that has none starts alone. A server is stopped with its process tree, because stopping the server alone leaves a running tool's processes behind on Windows.

## OpenCode 2, not 1

OpenCode ships two lines. The 1.x line (`opencode-ai`, `opencode.ai/install`, scoop's `opencode`, the tap's `opencode`, the desktop app) and the 2.x line (`@opencode/cli`, `opencode.ai/v2/install`, Homebrew core, the tap's `opencode-v2`, scoop's `versions/opencode2`, Arch's `extra`) have different servers, and T3 Code keeps an adapter for each. Sotto supports 2 only. The verified version is 2.0.31; a 1.x client, or a 2.x older than it, is refused at connect with the version it reported and where OpenCode 2 comes from. OpenCode 2 prints its version as `opencode v2.0.31`.

## The gate

OpenCode is an Owl feature (`opencode` in `src/shared/owlFeatures.ts`), held off stable the way Muse is: a stand-in host that connects nothing and refuses work in words, provider lists that ask the gate before showing an OpenCode tile or row, and saved records left whole so returning to Owl restores the provider. Muse's gate checks are hand-written at each site; OpenCode's work first turns them into one gate per provider that both use, so a third held provider is one entry rather than another two dozen sites.

## Sign-in and the data folder

OpenCode keeps its own sign-ins, one per model source, and Sotto stores no key for it. Sotto's OpenCode servers use the user's own OpenCode data folder, so a thread runs on the same sign-ins, settings and skills as the OpenCode the user runs, and its provider session is listed there too. The environment its processes get is the shared allow-list without other providers' keys.

Zach was offered a separate data folder for Sotto, described as keeping his saved OpenCode permissions out and his own OpenCode away from Sotto's threads at the cost of signing in again, and chose to share his. So:

- Permissions OpenCode saved itself still apply. When the user has told OpenCode to always allow an action in a project, a Sotto thread in that project is not asked about it, the way Muse's own policy decides what asks under **Ask for approval** (ADR-0079). Sotto never creates such a grant: it answers OpenCode only with its one-time allow or its reject.
- OpenCode does not lock a provider session to one process. Sotto drives a thread's provider session only from that thread's own server, but the user's own OpenCode can still send to it, as a Claude Code provider session can be taken over in the CLI.

Sotto's servers run with `share` set to `disabled`, so a thread is never published as an OpenCode share link, and with OpenCode's own update check off, so a thread's server neither checks for nor installs a new client.

## Finding and updating the client

Settings gives OpenCode the same connection, version, model and update controls as the other providers. Sotto finds `opencode` by its CLI lookup (ADR-0036), plus `~/.opencode/bin`, where the v2 install script puts it. Updates follow ADR-0042: the channel that installed the client updates it. An npm install is checked against `@opencode/cli` on `registry.npmjs.org`, which the README already names, and updated by Sotto's npm runner. A copy npm does not own, such as the v2 install script's, updates itself with `opencode upgrade`. A copy Homebrew, scoop or pacman owns shows the command to run by hand. Sotto never moves an install between the 1.x and 2.x packages.

## Permissions

A thread's permission mode becomes its provider session's rule set, sent when the provider session is created and changed while it lives: **Ask for approval** asks for every action OpenCode's own agent rules do not already decide, **Auto-accept edits** allows edits, and **Full access** allows everything. OpenCode has no mode of its own that matches **Automatic**, so it is not offered. A permission OpenCode asks for arrives with the files and diff it would change and is shown as a request card. The user answers every one (ADR-0004) with allow once or reject, and a reject reaches the model as a failed tool call, so the turn goes on. Disconnecting sends no decision.

## Questions

OpenCode's question tool arrives as a form. A form Sotto can draw, with text, number, yes-or-no and choice fields, is shown as a question card and answered with the user's words. One it cannot draw, such as a field shown only for another field's answer, is cancelled with a sentence saying so, and the model is told.

## Models and the model menu

Every model OpenCode lists is offered under its **model source**: where it runs, which is OpenCode Zen for the free models and otherwise a company the user signed in to inside OpenCode, such as Anthropic, OpenAI or OpenRouter. The model menu opens on OpenCode's model sources and then shows the chosen source's models, as Zach picked from the [prototype](https://github.com/millZach/Sotto/blob/da06200653ea228993b00a44757da509d669cd56/docs/prototypes/opencode-model-menu-prototype.html) (variant C); typing searches every source at once. The chip shows the OpenCode mark and names the source, so an OpenCode thread on an Anthropic model never reads as a Claude Code thread. A model's variants are its effort levels in Sotto's order, and its image input decides whether images can be attached. OpenCode's mark is adapted from T3 Code's (MIT).

## What an OpenCode thread can do in this first version

Streaming replies with reasoning, tools, file changes and commands as thread activity; steering a running turn and queueing behind it; stopping; images; effort per turn; model and permission changes on the live provider session; resume after Sotto restarts (ADR-0076), where a turn whose server died reads as stopped rather than running forever. One OpenCode execution can carry several prompts, so the adapter follows each prompt by its own message, not by the execution.

**Sotto's tools.** They reach an OpenCode thread as a remote MCP server added to that thread's own server, with the thread's bearer token, so its browser, visuals and thread tools work there. The rule set allows that server's tools and no other thread's, as Claude Code's launch allows Sotto's tools by name and Grok Build's own one-time allow admits them. OpenCode asks nothing about them, and Sotto's own rules decide what each tool may do (ADR-0020).

**Side calls.** A side call (ADR-0026) uses OpenCode's stateless generation route on the thread's own server, with the thread's model. It creates no provider session, so nothing appears in the user's OpenCode session list, and it is one generation, not a turn with tools. It was only tried against OpenCode Zen, whose free models refuse it, so ticket #1106 checks on a signed-in model source that it lists nothing and offers the model no tools. Where it is refused or cannot be shown to keep both promises, OpenCode writes no side text, and the first-message title, temporary branch or stand-in subject stays, as on Devin.

**Not yet.** Watcher is refused before its process starts, as on Devin. OpenCode is outside Usage's numeric history in this version (ADR-0078); a thread keeps its own per-turn token readout. There is no terminal-mode entry.

## Hosts and phones

The headless host runs the same adapter under the same gate, so a paired host offers OpenCode where the host machine has OpenCode 2 installed and signed in. The iPhone and Android clients name the provider and may open threads on it; host protocol version 1 already carries provider IDs, so no protocol change is needed.

## Privacy

Sotto itself contacts no new host for OpenCode: its update check reads `registry.npmjs.org`, which the README already names, and Sotto's servers turn OpenCode's own update check off. OpenCode's client talks to the model sources it is signed in to, as every provider's client talks to its provider: OpenCode Zen's models run on `opencode.ai`. The README says so in the change that adds the provider (#1103), and names `opencode.ai` among the makers a host may download a client from in the change that installs and updates it (#1104).
