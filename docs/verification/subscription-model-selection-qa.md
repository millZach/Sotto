# Subscription model and reasoning selection

September 9, 2026. Follow-up to the subscription reasoning implementation.

User acceptance: Sotto must offer all models available through the selected subscription, with that model's supported reasoning levels. Grok must be a working native subscription route. A handpicked subset is not sufficient.

- [x] Reproduce the missing model/default/effort behavior with a failing UI regression.
- [x] Carry model and effort through settings, persistence, and the configured reasoner.
- [x] Discover the complete current Claude and Codex native model catalogs.
- [x] Implement and exercise native Grok subscription reasoning.
- [x] Verify selection dispatch and account boundaries with native clients.
- [x] Pass relevant unit, Electron, type, lint, and build checks.
- [x] Inspect the final model/effort controls with Computer Use and leave the verified app running.

Initial regression: `npx vitest run tests/unit/renderer/agentView.test.tsx -t 'every advertised model'` failed because the native default was discarded and no reasoning-effort control existed. The implementation also filtered Codex to one model, hardcoded two Claude aliases, and left Grok as an unavailable placeholder.

The shared model metadata now includes supported reasoning levels and native defaults. Changing a model resets the old effort so it cannot silently carry an incompatible choice to another model. Both command interpretation and supervision receive the saved selection.

Claude discovery now uses the native stream-JSON initialize response. On this machine it returned five picker entries: Default, Opus (1M context), Fable, Sonnet, and Haiku, including per-model supported effort metadata. A native `opus[1m]` request at `low` effort returned the expected JSON in 4.8 seconds. No default effort is guessed when the client does not report one. Twenty-six Claude subprocess tests passed.

Codex discovery follows every `model/list` page and returned six native models, with GPT-6 Astra as its reported default. The model/version allowlist has been removed. Ephemeral app-server threads have no execution environments; configured MCP/hook features are disabled and action/permission callbacks are denied. Twenty-three unit tests passed. The native no-spend contract passed with both GPT-5.6 Sol/low and GPT-5.5/medium against a loopback inference fixture, checking no action tools, no fixture hooks/MCP execution, and unchanged fixture API-auth bytes. A real ChatGPT subscription request using GPT-5.5/medium returned valid JSON in 4.20 seconds.

Grok investigation found a usable native configuration: its `GROK_AUTH_PATH` points the unmodified client at its existing login while an owned temporary `GROK_HOME` separates session configuration from personal settings. Sotto does not read or copy the authentication file. Native cached-token authentication and session discovery returned Grok 4.6 and 4.5 and their supported effort levels. Live Grok 4.6/low and alternate Grok 4.5/low requests returned the expected JSON (9.6 and 9.54 seconds).

The alternate-model test caught Grok ignoring its startup model flag for ACP sessions. The final adapter uses native `session/set_model` with reasoning-effort metadata, requires an exact acknowledgment and matching model/effort notification, and only then submits a prompt. Grok also retains tool schemas despite an empty tools list. A native deny-any policy in the temporary Grok home, backed by command-line denial and `dontAsk`, was tested directly: a requested terminal write to an owned temporary canary file was denied by Grok, and the file was absent. This test did not depend on Sotto stopping the process after a tool notification. Sotto additionally declines ACP action/permission requests and rejects tool-bearing responses.

The three shared/controller/renderer suites passed 69 tests. One preceding run encountered a Windows temporary-directory cleanup `ENOTEMPTY` in an existing crash-recovery test; the exact test and the combined suites passed on rerun. No assertion about model selection failed after the fix.

The updated settings UI passed all 18 agent Electron tests, including model and effort selection/save for each native subscription, prompt and question routing, recovery, and minimum-window layout. The captured settings screen was visually inspected. Six focused suites passed 130 tests; whole-repository typecheck and lint passed.

Computer Use in the normal desktop profile confirmed the complete native lists: six ChatGPT models (including GPT-6 Astra through Ultra effort), five Claude choices (including Fable and its effort levels), and Grok 4.6/4.5. Selecting Grok 4.5 showed High/Medium/Low only. A duplicated Claude default label was corrected during visual inspection. The first final save/restart check was interrupted by the user's physical Escape key; the unsaved Grok choice was not applied.

The subsequent voice/routing follow-up preserved the user's saved ChatGPT / GPT-5.6 Luna / Low selection. Computer Use confirmed that saving the new natural voice did not change it, and a restart of the normal-profile production build retained the voice, subscription model/effort, selected thread, three assignments and three queue items. Local T3 reconnected. On the final build, 178 focused unit tests and all 19 agent Electron tests passed, as did whole-repository typecheck, lint and build. The native Grok requests above prove its model/effort route; a live multi-turn Grok supervision session in Sotto was not exercised.
