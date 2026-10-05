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

## Review correction: steering an active turn

PR review identified that steering recorded a new prompt without checking changed config. Two new tests went red before the correction: stale MCP config refused a steering call, and a scripted refresh rejection was ignored while steering still sent. The correction calls the same refresh preflight inside steering's existing dispatch lock, before input preparation and origin persistence. The existing validation after awaits refuses steering if the active turn ended meanwhile. A held-refresh regression also verifies that refusal and the following send's availability.

The installed-version [MCP runtime source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/session/mcp_runtime.rs) refreshes dirty MCP state before waiting for an MCP server or preparing its call. This supports refresh before a steering prompt in the current turn; it does not replay an already executing tool call.

The parent reviewer also verified installed 0.160.0 in one active model turn. Its first `sky.list_apps` failed against the deliberately missing pipe. While the agent waited in a harmless 40-second shell command, the reviewer changed the isolated config, called reload, and sent `turn/steer` with the original turn ID. That same turn subsequently called Computer Use successfully (`CU_OK`). The probe exited 0 without a new turn, app-server restart or desktop input.

Upstream [runtime publication](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-mcp/src/runtime.rs) retains existing bindings and passes previous connections into reconciliation. The [connection manager](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-mcp/src/connection_manager.rs) reuses matching connection identities and clients. An unrelated global config edit therefore does not blindly cancel unchanged in-flight MCP clients.

Validation on the review correction:

- Typecheck, lint, build and notices verification passed (174 components).
- `npx vitest run tests/integration/nativeSteering.test.ts tests/integration/codexConfigRefresh.test.ts tests/integration/codexSessionProcesses.test.ts --maxWorkers=2`: 23 tests passed across three files.
- `npx playwright test tests/e2e/queued-steering.spec.ts`: one test passed in the built Electron app, steering from the keyboard without consuming the newer draft.

The full local suite totals above belong to the initial PR revision. A second full local run was stopped at the parent's direction to avoid duplicating CI; it is not claimed as a pass. The latest revision's full CI gate must pass before merge.
