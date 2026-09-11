# Existing Claude and Grok accounts for Sotto reasoning

Checked September 9, 2026. The initial documentation-only investigation is superseded by the live native-client proofs below. Both subscription routes are implemented. Sotto does not read, copy, or print provider credentials, change the user's native configuration, or change extra-usage/overage settings.

| Route | Verified local state | Native integration |
| --- | --- | --- |
| Claude Code | Version 2.1.267; native auth status reports Claude subscription sign-in. Public account details only are exposed to Sotto. | Unmodified CLI with safe mode, no tools, JSON output. [CLI integration](https://code.claude.com/docs/en/headless), [current subscription billing notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). |
| Grok Build | Official `@xai-official/grok` native binary 1.0.5. Native cached-token authentication, model discovery, and live JSON reasoning succeeded. | Native ACP over subprocess stdio. Sotto discovers the current catalog and selects the model and effort through the native protocol. [Headless and ACP](https://docs.x.ai/build/cli/headless-scripting), [subscription usage](https://docs.x.ai/grok/faq#how-do-supergroks-weekly-usage-limits-work). |

## Grok: earlier blocker resolved

The installed native binary supports `GROK_AUTH_PATH`: Grok itself reads its existing login file while `GROK_HOME` points to a new Sotto-owned temporary directory. The prior assumption that auth and configuration could not be separated was incorrect. Native `GROK_DISABLE_API_KEY_AUTH=1` was verified through `grok inspect --json`: the API-key authentication policy is disabled, and ACP initialization advertises cached-token/browser authentication without an API-key method. Sotto authenticates only with `cached_token`; it never starts an interactive login or retries through an API route.

Sotto removes inherited provider keys, routing/config overlays, injected runtimes, and alternate inline auth from the child environment. Only the path to the native auth file is passed. Model configuration starts in the temporary home, so the user's per-model API overrides are not copied. The native client retains responsibility for its credentials. The public settings documentation explains `GROK_HOME` and model/API precedence; the auth-path behavior was additionally verified directly against installed 1.0.5. [Settings](https://docs.x.ai/build/settings/reference), [authentication precedence](https://docs.x.ai/build/enterprise#authentication).

Actual discovery returned:

| Native model | Available efforts | Native default effort |
| --- | --- | --- |
| Grok 4.6 (`grok-4.6`, native account default) | xhigh, high, medium, low | high |
| Grok 4.5 (`grok-4.5`) | high, medium, low | high |

These are a dated observation, not a baked-in allowlist. The adapter accepts the full reported catalog. A blank Sotto model uses the current native default; custom identifiers outside the subscription catalog are not sent.

The live alternate-model check caught a native quirk: `grok agent --model` does not determine `session/new`'s current model. The final adapter uses `session/set_model` with `_meta.reasoningEffort`, validates the native `model.Ok` response, and requires the matching `_x.ai/session_notification` / `model_changed` model and effort before submitting the prompt. It does not assume that `session/set_mode` or the startup model flag selected the requested effort/model.

The production class completed harmless JSON inference using both the native default Grok 4.6 and explicit Grok 4.5 with low effort. The explicit alternate-model result was `{"sotto_grok_45_low":"verified"}` in approximately 9.5 seconds. Subsequent runs with the native deny policy also returned the requested JSON. No model keys were entered or API fallback used.

## Grok execution boundary

An empty `--tools` value is **not** a reliable Grok deny-all. Authoritative headless `system.tools` metadata still listed terminal, file, scheduler, and other tools. A nonempty allowlist followed by its matching denylist reduced the inventory, but `search_tool` and `use_tool` remained. Sotto therefore does not base containment on an empty schema list.

The final ACP adapter uses a named text-only agent profile with no discovered skills, no AGENTS.md injection, no inherited MCP servers, `dontAsk`, and no configured profile hooks. It writes a deny-any permission rule into **only its temporary Grok home's** `requirements.toml`, passes the CLI wildcard deny, rejects every incoming ACP filesystem/terminal/permission request, and stops on any tool call. Native defaults can still advertise schemas; the product boundary is denial of execution.

Live execution checks used an explicitly owned temporary canary file:

- Raw native headless execution, with the deny-any rule and wildcard deny, attempted `run_terminal_command`. The native tool result reported an error and permission denial. The canary file did not exist afterward. This probe had no Sotto tool-event interception.
- The ACP route attempted the same class of command. With the early tool-event stop suppressed only in the probe, it reached `session/request_permission`; the production permission handler rejected it. The canary file did not exist afterward.
- The production model/effort path continued to complete ordinary JSON reasoning with the deny policy enabled.

Grok imports Claude plugin settings independently of some compatibility flags. Sotto writes the native `claude_compat.imported` marker only into its temporary config to suppress that fallback; it does not import or edit the user's Claude settings. Native source defines this marker's behavior and the agent profile's defaults. [Native import gate](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/claude_import.rs), [native agent definition](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/src/config.rs).

## Validation and limits

The focused Grok suite runs real subprocess fixtures while replacing only the external client. It covers native default/model/effort discovery, exact selection acknowledgements, sign-out without fallback, wrong/unavailable choices, private output handling, size/time bounds, permission/tool rejection, and temporary session cleanup. Run `npx vitest run tests/unit/main/subscriptionGrok.test.ts`. The live checks used the production class bundled by the existing esbuild dependency into an owned temporary directory, then called `status()` and `complete(system, input, 'grok-4.5', 'low')`.

Launches use an absolute native executable, argument arrays, no shell, hidden windows, bounded output, a 20-second status deadline and a 180-second completion deadline. Sotto waits for native process close before deleting the temporary session, with a bounded force-kill escalation. The user's native login and configuration remain outside that cleanup tree.

These live results were obtained on Windows with native Grok 1.0.5. macOS execution has not been live-tested in this session. Existing provider quotas and account settings still apply. Sotto neither enables extra usage nor sells or intermediates provider usage. Each user signs in through their own installed native client. [Grok account and permission controls](https://docs.x.ai/build/enterprise), [Claude unmodified-client integration conditions](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products).
