# Your own model servers

Zach asked for local inference in Sotto, for anyone who runs a model: "use whatever model he has or anyone has on their local machines... use Sotto to drive that machine through whatever harness we want... a thread or watcher could even use that model." It began as four DGX Sparks at his brother's house serving DeepSeek V4.1 Flash with SGLang, and became the general case: any user points Sotto at a model server they run (SGLang, vLLM, Ollama, LM Studio, llama.cpp, TGI or any OpenAI-compatible endpoint), on this computer, on their network or across their tailnet, and picks which provider drives it.

In Sotto's words the "harness" is the **provider** (the native client: OpenCode, Codex), and the server is a **model source**, as Anthropic or OpenRouter are under OpenCode today. ADR-0124 records the decision; [the prototype](https://github.com/millZach/Sotto/blob/prototype/local-model-server/docs/prototypes/local-model-server-prototype.html) is tagged `prototype/local-model-server`.

## Zach's picks, October 23, 2026

- **OpenCode first, Codex next.** A general ACP route (oh-my-pi and others) only if those two fall short.
- **A new Owl feature**, `own-model-servers`. OpenCode itself went to stable on October 22, so its switch no longer hides new work.
- **OpenCode keeps the key**, pasted once through its own `connect/key`, the way it keeps every model source's key (ADR-0087). Sotto keeps no copy. The key is optional.
- **Watcher in phase 3**, after threads work, with a readiness check. A model that fails it is shown in Watcher's model menu with the reason and cannot be picked. The bar is the stricter one: a working tool call, at least 128K of context and at least 30 tokens a second.
- **Plain http only on private addresses**: this computer, a home or office network and the tailnet (100.64.0.0/10, `*.ts.net`). A public address needs https. Never Funnel (ADR-0088).
- **Sotto contacts the server only when the user presses Check or Add.** During threads only OpenCode talks to it. Nothing runs in the background.
- **A server that goes away mid-turn fails the turn plainly**, with Try again. Nothing moves to another model on its own.
- **Thinking on where supported**, at the model's default effort; side calls use the least. Changeable per model when adding.
- **Privacy said once**: one line in the add dialog that threads on the server send your code and messages to it, so whoever runs it can read them, and the README's privacy section names your own servers.
- **One optional key per server.** Who gets a key is up to whoever runs the server.
- **Hosts later** (phase 4). **AI cleanup on your own server: not now**, a separate ADR later.
- **Layout B with C's shortcut.** A **Your own model servers** group on Settings › Providers, above the provider tiles, with servers kept apart from any one provider. Its **Add a server** dialog checks the server; **Run it with** appears only once a second provider can run servers, so phase 1 shows no "not yet" choices. OpenCode's source list in the model menu ends with **Your own server…**, which opens the same dialog.

## What OpenCode 2 does (checked October 23 against 2.1.4 and its source; 2.0.31's source is the same for all of this)

- A custom source is a config provider block: `package: '@opencode/ai/providers/openai-compatible'`, `settings.baseURL`, and a `models` record. OpenCode never reads the server's `/v1/models` for it; every model must be declared, with `limit.context`, `limit.output` and `capabilities`.
- A model that declares no reasoning gets low, medium and high effort variants by default, and one that declares nothing gets image input. Sotto always declares both: `capabilities.reasoning: { supported: false }` with thinking off, `{ supported: true, effort: ['low', 'medium', 'high'] }` with it on (OpenCode sends `reasoning_effort`), and `input: ['text']` unless the server says the model takes images.
- `OPENCODE_CONFIG_CONTENT` deep-merges with the folder's `opencode.json`. Sotto already sets it on every OpenCode process; the servers go there, built from Sotto's own record at each start, so nothing is written into Sotto's OpenCode folder and the record stays the one truth.
- `POST /api/integration/{id}/connect/key` works for a provider declared only in config. The stored credential wins over `settings.apiKey`. OpenCode keeps it in its database in Sotto's OpenCode folder, as it keeps every other key. A server with no key still needs `settings.apiKey` for the provider to list its models; Sotto gives a fixed placeholder, never a secret.
- Errors: a refused key is `provider.auth` with status 401 and no retry; an unreachable server is `provider.transport` after about 89 s of retries; a server that never answers times out after 300 s as `provider.transport`. `response.body` is the server's raw text and never reaches a log.
- Found on the way, not part of this work: OpenCode loads `opencode.json`, `.opencode`, `.claude` and `.agents` from every folder above a thread's project, and lists `~/.opencode` as a config source. ADR-0087 says the user's own OpenCode folders are never read; that holds for the XDG folders only. That is #1425.

## Phases

| # | What | Size |
|---|---|---|
| 1 | Your own model servers as OpenCode model sources on this computer, behind `own-model-servers`. Check, Add, Check again, Remove; the model menu shortcut; ADR-0124, README, CONTEXT, guide. | medium |
| 2 | Plain words in a thread when the server is asleep, unreachable, refuses the key, lacks the model or gets a prompt too long for it, with Try again. | small to medium |
| 3 | Watcher on your own model: OpenCode gets Watcher's note channel (an instruction entry), compaction (`POST /api/session/:id/compact`) and a context reading from step tokens; the readiness check (tool call, 128K, 30 tokens a second); Watcher's compaction point scaled to the model's limit. | medium to large |
| 4 | Hosts: a connected host's OpenCode gets the same group, over the `opencode-sign-in` host feature. | medium |
| 5 | Codex as a second provider, per thread through `thread/start`'s `modelProvider` and `config.model_providers`, for servers that speak the Responses API. Run it with appears. | medium |
| 6 | A general ACP provider, only if needed. | large |

## Phase 1 in detail

**Shared** (`src/shared/ownModelServers.ts`): the record, the check's answer, the address rule, the IPC channels and the words. A server is `{ id, name, address, keyed, models: [{ id, name, context, output, thinking, images }] }`; `id` is Sotto's (`own-` and a short random suffix), used as the OpenCode provider ID, so it never meets a built-in one (`ollama`, `lmstudio`, `vllm`). The address is the server's OpenAI base, ending in `/v1` unless the user gave another path. Private means loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `fc00::/7`, `fe80::/10`, a single-label name, or a name under `.local`, `.lan`, `.home.arpa`, `.internal` or `.ts.net`.

**Main** (`src/main/ownModelServers/`):
- **The record**: an `AtomicJsonStore` at `<userData>/own-model-servers.json`, owned by main. Start over leaves it, as it leaves keys and history: it resets `settings.json` only, and removing the record would leave keys in OpenCode with nothing to sign them out.
- **Check**: on press only. `GET <address>/models` with the key as a Bearer token if given, 10 s each request. Then each model's context from what that server says: `max_model_len` in the list (vLLM, SGLang); `POST /api/show` `model_info["<arch>.context_length"]` and `capabilities` (Ollama); `GET /api/v1/models` `max_context_length`, `capabilities.trained_for_tool_use`, `capabilities.reasoning` (LM Studio); `GET /props` `default_generation_settings.n_ctx` and `chat_template_caps` (llama.cpp); `GET /info` `max_input_tokens` (TGI); `GET /model_info` `reasoning_parser` (SGLang). A context nobody reports is left for the user to type. Outcomes: reachable with models; no answer (refused, name not found, timed out); key refused (401, 403); no models; not OpenAI-compatible (404, not JSON, wrong shape); address not allowed (public over http).
- **Add**: validates again, writes the record, makes OpenCode's processes outdated (the rule a sign-in change uses), then, with a key, signs the new source in through OpenCode's `connect/key` on a sign-in server that has the new provider. If that fails, the record is taken out again and nothing is kept. **Remove** signs the source out (`DELETE /api/credential/{id}`), takes the record out and makes the processes outdated. **Check again** re-runs the check for a saved server and may update its models.
- **OpenCode**: `opencodeEnvironment` puts each saved server's provider block into `OPENCODE_CONFIG_CONTENT` while the Owl answer is on. The adapter's catalog then lists the server as a model source with its models.
- **Logs**: stable event names only, never an address, name, model, key or server answer.
- **IPC**: registered only while `own-model-servers` is on, and only for the main window, the way `registerOpenCodeSignInIpc` is.

**Renderer**: the Providers group and its dialog (layout B, one step in phase 1), and **Your own server…** at the end of OpenCode's source list in the model menu, opening the same dialog. Every error says what happened, whether anything was lost and what to do next, in the prototype's words. Light and dark, the 820x560 minimum, keyboard, Escape.

**Tests**: unit tests of the address rule, each server's context discovery and each check outcome against a fake server, the provider block, and the dialog; an integration test that a saved server reaches a real OpenCode process's catalog through `OPENCODE_CONFIG_CONTENT`, gated with the existing OpenCode live suite where it needs the real client.
