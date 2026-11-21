# Antigravity as a thread provider: what was checked live

November 20, 2026, on the Windows laptop, for [ADR-0211](../adr/0211-antigravity-is-a-thread-provider-run-as-t3-code-runs-it.md).

## Google's own `agy`

- **Download.** Google's Windows manifest (`antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json`) named 1.5.13 at `storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/windows-x64/cli_windows_x64.exe`, a bare 236 MB `agy.exe` whose SHA-512 matched the manifest's. The Linux manifest names a `.tar.gz` of the same version. `agy --version` printed `1.5.13`.
- **Sign-in.** `agy acp --login --gemini-dir <folder>/antigravity/gemini --app-data-dir antigravity-acp`, with Sotto's environment (`GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`, `SSH_CONNECTION`), printed an `accounts.google.com` page and "Then paste the authorization code, or the full URL of the page you land on". Zach signed in with his Google account and pasted the code back; `agy` exited 0 and wrote its token as a file, `antigravity-oauth-token`, in that folder, so the SSH marker kept it out of the system keyring as T3 says. The user's own `~/.gemini` was not touched.
- **What `agy` answered.** `initialize`: protocol 1, `Antigravity ACP Server` 1.5.13, `loadSession`, session `resume`/`load`/`list`/`close`, images, `_meta.antigravity.systemPrompt.append: true`, and the four auth methods. `authenticate` with `oauth-personal` answered the account's tier. `session/new` answered both the older `models.availableModels` list, with the thinking level in each ID (`gemini-4-neon-high`), and `configOptions`: a `model` select of eleven families (Gemini 4 Neon, Carbon, Argon and Hydrogen, three Orchestrators, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B), a `thought_level` select (low, medium, high, xhigh), and a `mode` select with `default`, `accept-edits`, `auto` and `plan`. The adapter reads the `configOptions`.

## The adapter against it

`SOTTO_ANTIGRAVITY_LIVE=1 npx vitest run tests/integration/antigravityLive.test.ts` passed in 32 seconds, twice, on Gemini 3.8 Flash at low thinking:

- **Models.** Eleven models grouped by maker (Google, Anthropic, OpenAI), each with its own thinking levels, from low to xhigh on Neon and Hydrogen and low to high on Carbon and Argon; all four permission modes offered, Auto included, since the account's sessions offer `agy`'s Auto. Version `1.5.13 / ACP 1`.
- **A reply.** "Reply with exactly the word: pong" answered `pong`.
- **A permission card.** Asked to run `echo sotto-live-check` on Ask for approval, `agy` asked first; the card read `echo sotto-live-check` with **Allow once** and **Reject** only, never Allow always. Allowed once, the reply carried `sotto-live-check`.
- **Short text.** A title written on the side: "Ping Pong Echo".
- **Limits.** Read from Google with `agy`'s own token: Gemini, 5 hours (1% used); Gemini, week (0.3%); Claude & GPT (shared), 5 hours and week (0%), each with its reset time.
- **Resume.** A new adapter over the same folder resumed the session with `session/resume`, which replayed nothing, and answered "What single word did you reply with first?" with `pong`.
- **Steering.** A second prompt sent while `agy` counted to 40 was taken into the running turn, which ended with `steered`.

## Not checked live

Gemini Enterprise, a Gemini API key and Agent Platform (no such account here), a paired host, the phones, and Watcher on a live `agy` (the fake client covers Watcher's tools and instructions in `tests/integration/watcherOnAntigravity.test.ts`).
