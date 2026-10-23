# Your own model server is a model source

## Status

Accepted October 23, 2026, as an Owl feature (`own-model-servers`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It amends [ADR-0087](0087-opencode-is-a-thread-provider.md): OpenCode runs model sources Sotto declares as well as ones it signs in to. **Number provisional until merge** (docs/agents/domain.md).

Zach asked for local inference for anyone who runs a model: "use whatever model he has or anyone has on their local machines... use Sotto to drive that machine through whatever harness we want... a thread or watcher could even use that model." It began as four DGX Sparks at his brother's house serving DeepSeek V4.1 Flash with SGLang. He chose the general shape on October 23 from a question card and from [the prototype](https://github.com/millZach/Sotto/blob/prototype/local-model-server/docs/prototypes/local-model-server-prototype.html) (layout B, with C's model menu entry). [The plan](../plans/local-inference.md) holds the phases and what OpenCode 2 was checked to do.

## Context

People run models on their own machines with SGLang, vLLM, Ollama, LM Studio, llama.cpp and similar servers, nearly all of which answer the OpenAI API. Sotto drives native clients, and the one that can already run any OpenAI-compatible model is OpenCode 2 ([ADR-0087](0087-opencode-is-a-thread-provider.md)), whose live test already runs a thread against a local server declared in its config. What Sotto lacked was a way to declare one: OpenCode lists models only from its catalog, the sign-ins in Sotto's OpenCode folder and its config, and never asks a custom server what models it has.

What the user calls a harness is, in Sotto's words, the **provider**. The server is a **model source**, as Anthropic or OpenRouter are under OpenCode.

## Decision

1. **A server is a model source, kept apart from any one provider.** Settings › Providers gains **Your own model servers**, a group above the provider tiles: a row per server with its address and models, **Check again** and **Remove**, and **Add a server**. OpenCode's source list in the thread model menu ends with **Your own server…**, which opens the same dialog. OpenCode is the first provider to run them; Codex follows for servers that speak the Responses API, and **Run it with** appears in the dialog only once there is a second provider to choose.
2. **Sotto keeps the record and declares the server to OpenCode.** Main saves each server's name, address and models (context, output, thinking, images) in `own-model-servers.json` under Sotto's user data. Every OpenCode process Sotto starts is given one provider block per server in `OPENCODE_CONFIG_CONTENT`, with OpenCode's OpenAI-compatible package, so nothing is written into Sotto's OpenCode folder and the record is the one truth. Each model declares its reasoning and its input, since OpenCode otherwise gives an undeclared model low, medium and high effort and image input. A change makes OpenCode's processes outdated, as a sign-in does.
3. **OpenCode keeps the key.** A key is optional. One given goes from the dialog to main once and from main to Sotto's OpenCode once, through the same `connect/key` sign-in every model source uses, and Sotto keeps no copy. One key per server: who gets it is up to whoever runs the server.
4. **Plain http only to a private address.** This computer, a home or office network, and the tailnet (100.64.0.0/10, `*.ts.net`) may use http; a public address needs https, so a key and code never cross the internet unencrypted. Sotto never sets up Tailscale Funnel ([ADR-0088](0088-sotto-leans-on-tailscale.md)).
5. **Sotto itself contacts the server only when the user presses Check, Add or Check again.** It reads the model list and what the server says about each model's context and abilities: `max_model_len` from vLLM and SGLang, Ollama's `/api/show`, LM Studio's `/api/v1/models`, llama.cpp's `/props`, TGI's `/info`. A context the server does not report is typed by the user. Nothing runs in the background, so a row shows only what the last check said. During threads only OpenCode talks to the server.
6. **Thinking is on where the server says the model can think**, at the model's default effort, and side calls take the least ([ADR-0026](0026-short-writing-runs-on-the-threads-own-provider.md)). The user can turn it off per model when adding.
7. **A server that goes away fails the turn plainly.** The thread says what happened, that nothing in it was lost, and to check the server, with Try again. Nothing moves to another model on its own, so code never goes where the user did not choose.
8. **The add dialog says once who can read what is sent:** threads on this server send your code and messages to it, so whoever runs it can read them.
9. **Off, nothing of it runs.** With the Owl feature off, main registers no channel, OpenCode is given no server, and Settings and the model menu show none. The saved record stays, so turning the feature on restores it.

Watcher on a server's model, hosts adding their own servers and Codex as a second provider are later phases of the plan and will amend this record. Watcher will run only on a model that passes a readiness check: a working tool call, at least 128K of context and at least 30 tokens a second, a model that fails being shown in Watcher's model menu with the reason and not offered. AI cleanup on a user's server is out of scope; it would supersede part of [ADR-0069](0069-one-model-does-ai-cleanup.md).

## Consequences

A new kind of host appears in the README's privacy section: an address the user typed, contacted by Sotto on a press and by OpenCode during that user's threads.

Sotto does not vouch for a server's model. Tool calls, long prompts and reasoning replay depend on the server and the model, and a model that cannot call tools well will fail threads in ways Sotto can only report.

OpenCode keeps a server's key in its database in Sotto's OpenCode folder, in the clear, as it keeps every model source's key. Remove signs the source out there.

Checking OpenCode for this found that it reads `opencode.json`, `.opencode`, `.claude` and `.agents` from every folder above a thread's project, and lists `~/.opencode` as a config source, so ADR-0087's "the user's own OpenCode folders are never read" holds only for its XDG folders. That is #1425; this decision neither causes nor fixes it.
