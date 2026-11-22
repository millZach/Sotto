# How T3 Code runs Google Antigravity, and what `agy` does live

November 20, 2026. Read for Zach's request to add Antigravity as a Sotto thread provider "the way T3 Code does it". The source is `pingdotgg/t3code` at [`236e90e`](https://github.com/pingdotgg/t3code/commit/236e90e695055a914413f07eb94188a3a65eed6f), read without running it. **Observed** means read in code or a checked-in fixture, **Documented** in T3's guides, **Live** checked against Google's `agy` 1.5.12 on forge as the sandbox user `neon` on November 20, 2026. Links below are shortened to `t3:` plus a path at that commit.

## Launch

- **Observed.** One `agy` process per session, ACP over stdio: `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`, cwd the workspace. The profile is `<stateDir>/providers/antigravity/<sha256(instanceId)>`, so T3's Antigravity never shares the user's own `~/.gemini`. (`t3:apps/server/src/provider/antigravityAuthSupport.ts#L179-L195`, `#L546-L572`)
- **Observed.** Binary: an explicit **Binary path**, then T3's managed download, then `agy` on `PATH`; the name must be `agy` or `antigravity` (`.exe`, `.cmd`, `.bat` on Windows). The managed download reads Google's platform manifest and checks SHA-512 before use. (`t3:apps/server/src/provider/AntigravityInstallation.ts#L167-L205`, `#L562-L671`, `#L952-L1052`)
- **Observed.** The environment is built whole (`extendEnv: false`) with every Google credential variable removed (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, project and location variables, `BROWSER` and others), then `GEMINI_HOME=<profile>`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`, a `BROWSER` helper that only reports the URL, and, for a personal Google account, `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` so the CLI keeps its sign-in in the profile rather than the system keyring. (`t3:…/antigravityAuthSupport.ts#L62-L82`, `#L202-L244`; keyring note in `t3:docs/internals/providers.md#L39-L47`)
- **Observed.** Version floor: below 1.5.0 refused, 1.5.0 to 2 supported, 1.5.12 recommended, read from `initialize.agentInfo.version`. (`t3:apps/server/src/provider/model-manifest.json#L89-L97`)
- **Observed.** T3 does not spawn `agy` for a background health check: the CLI unpacks about 1 GB on each launch. Sign-in reads as unknown until a session starts. (`t3:apps/server/src/provider/Drivers/AntigravityDriver.ts#L520-L557`)
- **Live.** `agy acp --app-data-dir` takes only a relative name ("must not be absolute"); `--gemini-dir` takes the absolute folder. `agy acp` also takes `--dangerously-skip-permissions`, `--disable-telemetry`, `--sandbox` and `--login`.

## The protocol

- **Live.** `initialize` answers protocol 1, `loadSession`, session `resume`, `load`, `list`, `close` and `additionalDirectories`, images and embedded context, `auth.logout`, and `_meta.antigravity.systemPrompt.append: true`. Its auth methods are `oauth-personal` (Log in with Google), `oauth-business` (Gemini Enterprise), `gemini-api-key` and `agent-platform` (Vertex AI with application default credentials). `session/new` before sign-in answers `-32000 Authentication required`.
- **Observed.** T3 sends `authenticate({methodId})`, then `session/new` with `cwd` and MCP servers, or `session/resume` with the saved session ID. It never uses `session/load` for Antigravity, to avoid replaying history and tool calls. Prompts are `session/prompt`; Stop is `session/cancel`. (`t3:packages/provider-acp/src/server/AcpSessionRuntime.ts#L2412-L2495`)
- **Observed.** Model and thinking are `session/set_config_option`: the `model` select, and an option in category `thought_level` (commonly `thinking_level`) per model. Mode is the `mode` config option, or `session/set_mode` for older answers. (`…/AcpSessionRuntime.ts#L2921-L2971`; `t3:apps/server/src/provider/acp/AntigravityAcpSupport.ts#L209-L284`)
- **Observed.** T3's own instructions go in `_meta.antigravity.systemPrompt.append` on session start when the agent advertises it. (`…/AntigravityAcpSupport.ts#L84-L101`)
- **Observed.** Steering: on CLI 1.5 or later T3 sends a new `session/prompt` into the running session; cancelling and restarting killed subagents. Commands and scheduled wakes can outlive a turn and send a reply or a permission request with no prompt open. (`t3:apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L237-L250`)
- **Observed.** The CLI can report an upstream failure as chat text followed by `end_turn`; T3 reads the last step of the conversation's SQLite file (`antigravity-acp/conversations/<sessionId>.db`) to tell a failed turn, a quota refusal and a broken Claude thinking signature apart. (`t3:apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L128-L266`)
- **Observed.** Subagents arrive as ordinary tool calls; T3 finds children by reading `brain/<id>/.system_generated/…` and the SQLite file. Edits send old and new snippets, which T3 places on lines by matching the file before the edit. (`…/AntigravityChildWork.ts`, `…/AntigravityEditLocation.ts#L128-L225`)

## Sign-in

- **Observed and Live.** A Google account signs in with the same argv plus `--login`, with `DISPLAY` and `WAYLAND_DISPLAY` removed. It prints an `accounts.google.com` page whose redirect is `https://antigravity.google/oauth-callback`, then waits for "the authorization code, or the full URL of the page you land on" on stdin. After it exits, T3 starts a session to check the sign-in and read the models. (`t3:…/AntigravityDriver.ts#L402-L473`, `…/antigravityAuthSupport.ts#L575-L644`)
- **Observed.** Gemini Enterprise signs in through ACP with a GCP project and location and a loopback callback. A Gemini API key and Agent Platform (Vertex AI) connect with a key T3 stores, or project, location and application default credentials. Sign out stops the provider's processes and sends ACP `logout`. (`t3:apps/server/src/provider/AntigravityAuth.ts#L491-L536`, `#L580-L625`)
- **Documented.** T3's UI: a **Sign-in method** select (Google account, Gemini Enterprise, Gemini API key, Agent Platform), **API key**, **GCP project**, **GCP location**, **Binary path**. Google sign-in reads **Starting Google sign-in.**, then a field **Code from the Antigravity page** with **Connect**; done reads **Signed in.** with **Change account** and **Sign out**. (`t3:packages/contracts/src/settings.ts#L867-L941`, `t3:apps/web/src/components/settings/ProviderAuthenticationSection.tsx`)

## Models

- **Observed.** The list is read from the account's session (`configOptions` model select), never shipped as a fallback. Duplicate names get `(<id>)`. T3's manifest names Gemini 4 Carbon, Gemini 4 Argon, Gemini 3.8, 3.7 and 3.6 Flash at High, Medium and Low, Gemini 3.1 Pro High and Low, and declares `gemini-3.8-flash-high` its default; Claude and GPT models appear when the account is entitled to them. (`t3:apps/server/src/provider/AntigravityProvider.ts#L78-L122`, `…/model-manifest.json#L951-L995`)
- **Observed.** The picker groups by provider instance and shows the account's names flat; thinking is a column beside it from the model's `thought_level` choices.

## Permissions

- **Observed.** T3 offers Supervised, Auto-accept edits, Auto (only when the session advertises `auto`) and Full access. `agy` refuses `auto_edit` and `yolo` as ACP modes, so every mode but Auto runs as `default` and **T3 answers permission requests itself** by policy: Auto-accept edits allows edits, Full access allows everything eligible. Fixed-choice questions (tool-call IDs starting `interaction_`) always reach the user. Answers use the agent's own option IDs: allow once, allow for this thread, deny. (`…/AntigravityAcpSupport.ts#L154-L206`, `t3:packages/provider-acp/src/server/clientPolicy.ts#L143-L199`, `…/AntigravityProtocol.ts#L61-L177`)

## Usage and limits

- **Observed.** Token counts come from each prompt's `result.usage` and from reading the CLI's conversation SQLite files under T3's profiles and the user's own `~/.gemini/antigravity*` folders. Account limits come from POSTing the CLI's OAuth token to `cloudcode-pa.googleapis.com` and `daily-cloudcode-pa.googleapis.com` (`/v1internal:retrieveUserQuotaSummary`), shown as Gemini 5-hour and weekly windows and a shared Claude and GPT window. (`t3:apps/server/src/provider/antigravityUsageLimits.ts#L24-L35`, `#L250-L483`; `t3:apps/server/src/provider/Drivers/antigravityUsageReader.ts`)

## Short text and skills

- **Observed.** Titles and other short text run in a fresh session in a scratch folder with no MCP servers, `default` mode, the thread's model and thinking, one prompt; any tool call, permission request or file write fails the call, with a 180-second deadline, and the scratch session's files are removed. (`t3:apps/server/src/textGeneration/AntigravityTextGeneration.ts#L27-L354`)
- **Observed.** Skills come from the project's `.gemini/skills`, `.agents/skills`, `.agent/skills` and the user's `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills`. (`t3:apps/server/src/provider/Drivers/AntigravitySkills.ts`)

## Limits T3 documents

Antigravity cannot rewind, so Edit from here starts a fresh session with the conversation handed over. Auto runs as Supervised on an account without native Auto. Full access can still raise requests and questions. Updating from before 1.5 can need a fresh sign-in, and Gemini Enterprise still shares the system keyring. (`t3:docs/user/providers-antigravity.md`, `t3:docs/user/permission-modes.md#L27-L59`)

## On forge

`agy` 1.5.12 is installed for the sandbox user `neon` at `/home/neon/.local/bin/agy`. Its settings point it at a Gemini API model for the model gauntlet, with the key supplied by that harness, and it has no Google sign-in. A live Sotto thread needs a Google sign-in on whichever machine runs it.
