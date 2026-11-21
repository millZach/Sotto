# Plan: Antigravity as a thread provider

November 20, 2026. Zach asked: "add antigravity as a provider for Sotto. Please have it reference how T3 code does it and match that as close as possible." The facts are in [the research note](../research/2026-11-20-antigravity-in-t3code.md). This plan says how T3 Code's way maps onto how Sotto adds a provider (Cursor, ADR-0128, is the nearest: ACP, one process per thread, the client's own sign-in, a model list read from the account). Where T3 and Sotto's rules part, the question card asks Zach; nothing here is decided until he answers.

## What matches T3 directly

- **Provider ID `antigravity`, shown as Antigravity.** One `agy acp` process per thread over stdio (ADR-0038), like Grok Build, Devin and Cursor. `initialize` with protocol 1, `session/new`, `session/prompt`, `session/cancel`, `session/update` and `session/request_permission`.
- **Sotto's own Antigravity folder, as T3's profile.** Every process runs with `--gemini-dir <userData>/antigravity/gemini --app-data-dir antigravity-acp`, `GEMINI_HOME` set to the same folder, `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`, and every Google credential variable removed from the shared environment allow-list. The user's own `~/.gemini` is never read or written, and a thread's model or permission choices never change the user's own `agy`. As in T3, a personal Google sign-in also gets `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` so `agy` keeps the sign-in in that folder rather than the system keyring.
- **Finding the client.** `agy` (or `antigravity`) by Sotto's CLI lookup (ADR-0036), plus `~/.local/bin` and `%LOCALAPPDATA%` install folders; on Windows the `.exe` directly, no shell. Floor 1.5.0, read from `initialize.agentInfo.version`, the way T3 reads it; 1.5.12 is the version checked live.
- **No background spawn.** `agy` unpacks about 1 GB a launch, so Connect checks the client without starting a session; signed in reads as known once a session or the sign-in check has run, as in T3.
- **Sign-in with a Google account.** `agy acp --login` with the folder flags prints an `accounts.google.com` page and waits for the code from the page Google lands on. That is Sotto's existing paste-code sign-in (ADR-0200, the shape Claude Code uses): main opens the page only when it is `https:` on `accounts.google.com`, the user pastes the code or the whole address, and main hands it to `agy` on stdin and keeps nothing. Then a session starts to check it and read the models. Sign out sends ACP `logout` and stops the provider's processes.
- **Models from the account.** Read from the session's `model` config option, never a shipped list, with each model's `thought_level` choices as its effort levels in Sotto's order (ADR-0044). Set with `session/set_config_option` before the prompt that needs them and read back.
- **Resume with `session/resume`**, never `session/load`, so a restart replays no tool calls; the session ID is kept like the other ACP adapters'.
- **Sotto's instructions in `_meta.antigravity.systemPrompt.append`**, which `agy` advertises, so Watcher's prompt and the thread instructions go where T3 puts its own, not into the user's words.
- **Steering** by a second `session/prompt` into the running session, as T3 does on 1.5 and later.
- **Turn outcome.** The prompt's `stopReason` ends the turn; a turn that ends `end_turn` after `agy` wrote an upstream error as text is read as failed from the conversation file's last step, as T3 reads it, read-only.
- **Questions.** A permission request whose tool-call ID starts `interaction_` is a question card answered with the chosen option's ID.
- **Short text** (ADR-0026): a fresh session in a scratch folder with no tool servers, the thread's model at its least effort, one prompt; any tool call, permission request or write cancels it and writes no side text, as T3's helper does. The scratch session's files are removed afterwards.
- **Tests.** A fake `agy` (`tests/fixtures/fakeAntigravityAgent.mjs`) passes `tests/integration/adapterContract.ts`, with unit tests for the version check, model catalog, permission answers, the sign-in code check and the environment. A live suite gated by `SOTTO_ANTIGRAVITY_LIVE` never runs in CI.

## Zach's answers (November 20, 2026, question cards)

1. **Straight to stable**, not an Owl feature.
2. **All four sign-ins, as T3:** Google account, Gemini Enterprise (GCP project and location), Gemini API key and Agent Platform (Vertex AI: a key, or project and location with application default credentials). The key is a second credential-store slot (`antigravity`), which needs an ADR and the README's "One key" lines changed.
3. **Sotto downloads `agy` itself, as T3:** Google's platform manifest, the expected Google Storage URL and SHA-512 checked, versions kept side by side so a running thread keeps its version, an installed `agy` or a binary path still used when set. Google's download hosts go in the README's privacy list.
4. **Token counts and account limits, as T3:** counts from each turn and from `agy`'s conversation files, and limits from `cloudcode-pa.googleapis.com` with `agy`'s own sign-in token. A new host and a credential read: ADR and README.
5. **T3's four permission modes, Sotto answering:** Ask for approval, Allow edits, Auto (when the account offers it) and Full access, with Sotto answering `agy`'s requests for the thread by its mode as T3 does. This amends ADR-0004, so the ADR says so.
6. **Desktop, paired hosts and phones** in this change, through a `provider-antigravity` host feature.
7. **Watcher and short text both run on Antigravity.**
8. **The live check runs on the laptop:** install `agy` there, Zach signs in once.
9. **Design B, sign in on the row** (from the design drafts, tag `prototype/antigravity-provider`): Cursor's row shape, with a four-way sign-in method choice and numbered steps inline in the opened row, and the model menu grouped by model maker (Google, Anthropic, OpenAI) as Cursor's is.
10. **The mark is Antigravity's official logo** (November 21, 2026, over the three marks drawn for Sotto in tag `prototype/antigravity-mark`): Google's arch from antigravity.google, in one colour as T3 Code draws it, on Google's blue.

## Where T3 and Sotto part (asked on the question cards)

1. **Owl or stable.** AGENTS.md asks Zach before a new feature. Pi, Hermes and Cursor started as Owl features.
2. **Other sign-ins.** T3 also offers Gemini Enterprise, a Gemini API key and Agent Platform (Vertex AI). A key Sotto stores is a second key, which AGENTS.md calls a product decision and an ADR.
3. **Getting `agy`.** T3 downloads and verifies Google's CLI itself (about 1.25 GiB of staging). Sotto's other providers use the client the user installed, with an install guide and the client's own updater. A managed download adds a host to the README's list.
4. **Usage and limits.** T3 reads token counts from `agy`'s conversation files, including the user's own `~/.gemini`, and asks `cloudcode-pa.googleapis.com` for the account's limits with `agy`'s sign-in token. Sotto reads no credentials for limits today, and a new host is an ADR and a README change.
5. **Permission modes.** `agy` has no ACP edit-only or yolo mode, so T3 runs Auto-accept edits and Full access by answering requests itself. Sotto's rule is that the user answers every permission (ADR-0004); `agy acp --dangerously-skip-permissions` gives Full access without Sotto answering anything, and leaves Allow edits with no native way.
6. **Where it runs.** This computer on Windows, macOS and Linux, or also paired hosts and the phones (a `provider-antigravity` host feature, as Cursor has).
7. **Watcher on Antigravity.** Cursor got Watcher from the start; T3 has no equivalent.
8. **The live check.** `agy` is not on the laptop, and forge's `neon` has no Google sign-in. A live thread needs Zach's Google account signed in once on one machine.
9. **How it looks** (the design drafts): the Settings row and its sign-in, and how the model menu groups the account's models.

## Out of scope for the first version, unless Zach asks

Subagent rows read from `agy`'s `brain` folder, edit line placement from snippets, Edit from here (Fork from here works as a handover, like Cursor), compaction, and the API-equivalent cost estimate.

## Touch list

From the Pi and Cursor commits: `src/shared/providerIds.ts` and every `everyProvider` list it makes the type checker name; `src/shared/hostProviders.ts`, `heldProviders.ts`, `owlFeatures.ts` (if Owl), `providerProfile.ts`, `workerRoles.ts`, `council.ts`, `dynamicThreads.ts`, `hostProtocol.ts`; `src/main/agents/antigravity*.ts` (adapter, RPC, models, requests, activity, sign-in); `runtime.ts`, `installedProviders.ts`, `providerClients.ts`, `src/host/providerSignIn.ts`; the renderer's `ProviderMark.tsx`, `ProvidersSettings.tsx`, `permissionPresentation.tsx`, `threadFacts.ts`; locales; `CONTEXT.md`, `README.md`, `docs/guide.md`, a new ADR, and a verification note.
