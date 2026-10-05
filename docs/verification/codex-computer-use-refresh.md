# Codex computer-use configuration refresh

October 5, 2026.

The reported failure followed a Codex desktop restart: the app was running with full access, while an already loaded `node_repl` kept the earlier native pipe. A fresh app-server using Sotto's environment could reach the desktop. This change refreshes the affected thread's MCP configuration before its next prompt without restarting the provider or repeating a UI action.

The regression runs the real adapter over real fixture child processes. The fake captures its initial global config metadata and has an explicit `config/mcpServer/reload` handler. Its stale-config mode refuses `turn/start` until reload updates that captured metadata.

Before the implementation, `npx vitest run tests/integration/codexConfigRefresh.test.ts --maxWorkers=2` failed all three initial cases: no reload preceded the loaded thread's send, a scripted reload rejection did not prevent prompt delivery, and no reload was made for changed config on later turns. With the fix, the expanded suite checks changed and unchanged config, a later turn, pending duplicate sends, both older-client refusal shapes, rejection with the same message retried, disconnect during reload, and a neighboring thread answering a permission and stopping while reload waits.

The parent reviewer independently ran installed Codex 0.160.0 with an isolated config and one ephemeral thread on the same app-server process. The first model turn called `sky.list_apps` against a deliberately missing native pipe and returned the native-pipe failure. After updating only that isolated config to the running desktop's pipe and sending `config/mcpServer/reload`, the next model turn completed Computer Use successfully (`CU_OK`, with a completed MCP tool call). The probe exited 0, changed no UI input or settings, and removed its temporary config and process. This verifies real reload semantics; the adapter fixture tests verify Sotto's automatic detection and request ordering. It is not a claim that the running Sotto installation was updated.

The [installed-version App Server source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/mcp_refresh.rs) uses `load_latest_config_with_session_layers` and includes `refresh_config_preserves_thread_mcp_overrides`. A reload retains the thread's MCP overrides, including Sotto's browser and setup tools.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run notices:verify`: passed, 174 third-party components.
- `npm run build`: passed on the final source.
- `npx vitest run tests/integration/codexConfigRefresh.test.ts tests/integration/codexSessionProcesses.test.ts tests/integration/codexNewestTurn.test.ts --maxWorkers=2`: 31 tests passed across three files.
- `npx playwright test tests/e2e/codex-restored-history.spec.ts tests/e2e/codex-refused-approval.spec.ts`: two tests passed in the built Electron app. The restored-history minimum-size screenshot was visually inspected; the saved conversation and composer were visible without clipping.
- `npm test -- --maxWorkers=2`: passed, 542 files passed and 40 skipped; 7,376 tests passed and 156 skipped. Duration 1,330.79 seconds (22 minutes 11 seconds), within CI's 30-minute job budget despite simultaneous local suites in other worktrees.

The parent reviewer checked the diff separately for repository standards and the requested behavior and found no remaining production defect. No screenshot baseline changes are required: the change adds no UI surface. Metadata intentionally covers only global `config.toml`, and an unsupported older client continues ordinary sends without automatic MCP refresh on that process.
