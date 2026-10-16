# OpenCode is a thread provider

Accepted October 16, 2026. Zach asked for OpenCode the way T3 Code has it, and chose the shape the same day: an Owl feature (ADR-0072), OpenCode 2 only, a full Threads provider as Muse is (ADR-0079), OpenCode's own data folder shared with the OpenCode he runs himself, and model menu variant C, model source first. The wire facts below were checked live against OpenCode 2.0.31 on the Windows laptop on October 16, 2026, and T3 Code's two OpenCode adapters were read at `e58a4857`; [the research note](../research/2026-10-16-t3-opencode.md) records both.

OpenCode joins Codex, Claude Code, Grok Build, Devin and Muse as a thread provider, id `opencode`, shown as **OpenCode**. Its adapter speaks OpenCode 2's HTTP server, not its ACP mode: one `opencode serve --hostname=127.0.0.1 --port=0` per thread session (ADR-0038), reached on the port it prints with HTTP Basic and a password Sotto makes for that process alone, with live work read from the server's event stream. Several servers share one OpenCode data folder once its database exists, so the first server on a folder that has none starts alone. A server is stopped with its process tree, because stopping the server alone leaves a running tool's processes behind on Windows.

## OpenCode 2, not 1

OpenCode ships two lines. The 1.x line (`opencode-ai`, `opencode.ai/install`, scoop's `opencode`, the tap's `opencode`, the desktop app) and the 2.x line (`@opencode/cli`, `opencode.ai/v2/install`, Homebrew core, the tap's `opencode-v2`, scoop's `versions/opencode2`, Arch's `extra`) have different servers, and T3 Code keeps an adapter for each. Sotto supports 2 only. The floor is 2.0.31, the version checked; a 1.x client, or a 2.x older than the floor, is refused at connect with the version it reported and where 2 comes from. OpenCode 2 prints its version as `opencode v2.0.31`.

## The gate

OpenCode is an Owl feature (`opencode` in `src/shared/owlFeatures.ts`), held off stable the way Muse is: a stand-in host that connects nothing and refuses work in words, provider lists that ask the gate before showing an OpenCode tile or row, and saved records left whole so returning to Owl restores the provider. Muse's gate checks are hand-written at each site; OpenCode's work first turns them into one gate per provider that both use, so a third held provider is one entry rather than another two dozen sites.

## Sign-in and the data folder

OpenCode keeps its own sign-ins, one per model source, and Sotto stores no key for it. Sotto's OpenCode servers use the user's own OpenCode data folder, so a thread runs on the same sign-ins, settings and skills as the OpenCode the user runs, and its session is listed there too. The environment its processes get is the shared allow-list without other providers' keys. Two consequences follow, and Zach accepted both:

- Permissions OpenCode saved itself still apply. When the user has told OpenCode to always allow an action in a project, a Sotto thread in that project is not asked about it, the way Muse's own policy decides what asks under **Ask for approval** (ADR-0079). Sotto never creates such a grant: it answers OpenCode only with its one-time allow or its reject.
- OpenCode does not lock a session to one process. Sotto drives a thread's session only from that thread's own server, but the user's own OpenCode can still send to the same session, as a Claude Code session can be taken over in the CLI.

Sotto's servers run with `share` set to `disabled`, so a thread is never published as an OpenCode share link, and with OpenCode's own update check off, so a thread's server neither checks for nor installs a new client.

## Finding and updating the client

Settings gives OpenCode the same connection, version, model and update controls as the other providers (ADR-0042). Sotto finds `opencode` as it finds every client (ADR-0036), plus `~/.opencode/bin`, where the v2 install script puts it. An npm install is checked against `@opencode/cli` on `registry.npmjs.org`, which the README already names; Update runs `opencode upgrade`, which picks the method its install came from. A copy a package manager owns stays that manager's to update. Sotto never moves an install between the 1.x and 2.x packages.

## Permissions

A thread's mode becomes the session's rule set, sent when the session is created and changed on the live session: **Ask for approval** asks for every action OpenCode's own agent rules do not already decide, **Auto-accept edits** allows edits, and **Full access** allows everything. OpenCode has no mode of its own that matches **Automatic**, so it is not offered. A permission OpenCode asks for arrives with the files and diff it would change and is shown as a request card; the user answers every one (ADR-0004) with allow once or reject, and a reject reaches the model as a failed tool call, so the turn goes on. Disconnecting sends no decision.

## Questions

OpenCode's question tool arrives as a form. A form Sotto can draw, with text, number, yes-or-no and choice fields, is shown as a question card and answered with the user's words; one it cannot draw, such as a field shown only for another field's answer, is cancelled with a sentence saying so, and the model is told.

## Models and the model menu

Every model OpenCode lists is offered under its model source, the service it runs on: OpenCode Zen's free models, and each service the user signed in to in OpenCode. The model menu opens on OpenCode's model sources and then shows the chosen source's models, as Zach picked from the [prototype](https://github.com/millZach/Sotto/blob/da06200653ea228993b00a44757da509d669cd56/docs/prototypes/opencode-model-menu-prototype.html) (variant C); typing searches every source at once. The chip shows the OpenCode mark and names the source, so an OpenCode thread on an Anthropic model never reads as a Claude Code thread. A model's variants are its effort levels in Sotto's order, and its image input decides whether images can be attached. OpenCode's mark is adapted from T3 Code's (MIT).

## What an OpenCode thread can do in this first version

Streaming replies with reasoning, tools, file changes and commands as thread activity; steering a running turn and queueing behind it; stopping; images; effort per turn; model and permission changes on the live session; resume after Sotto restarts (ADR-0076), where a turn whose server died reads as stopped rather than running forever. One OpenCode execution can carry several prompts, so the adapter follows each prompt by its own message, not by the execution.

Sotto's tools reach an OpenCode thread as a remote MCP server added to that thread's own server, with the thread's bearer token, so its browser, visuals and thread tools work there. Side writing (ADR-0026) uses a session whose rule set denies every tool, which OpenCode turns into a model request with no tools at all. OpenCode Zen's free models refuse such a session, so on a free model side writing returns nothing and the existing opening words, temporary branch or stand-in subject remain. Watcher is refused before its process starts, as on Devin and Muse. OpenCode is outside Usage's numeric history in this version (ADR-0078); a thread keeps its own per-turn token readout. There is no terminal-mode entry yet.

## Hosts and phones

The headless host runs the same adapter under the same gate, so a paired host offers OpenCode where the host machine has OpenCode 2 installed and signed in. The iPhone and Android clients name the provider and may open threads on it; host protocol version 1 already carries provider IDs, so no protocol change is needed.

## Privacy

Sotto contacts no new host. An OpenCode thread goes to its model source under OpenCode's sign-in for it, as every thread goes to its provider: OpenCode Zen's models run on `opencode.ai`. OpenCode's own update check is off in Sotto's servers; Sotto's update check for an npm install reads `registry.npmjs.org`.
