# Thread and worker-role speed

Drake asked for Fast and Ultra fast in Watcher's worker roles and both composers, then authorized a local Owl install before review and merge. This amends ADR-0143, ADR-0091 and ADR-0161.

## Live Codex catalog

On this Mac on October 29, 2026, codex-cli 0.166.0 was probed in order with `initialize`, `account/read` (`refreshToken: true`), `configRequirements/read` and `model/list`. No turn was started. The account reported `chatgpt`, plan `promax`, and `supportsIndependentSpeedModes: true`.

GPT-6.1 Sol and GPT-6 Astra each advertised:

- `priority`, named **Fast**, described as “2x speed, increased usage”.
- `ultrafast`, named **Ultrafast**, described as “The fastest available responses for latency-sensitive work.”

GPT-6.1 Terra, GPT-6 Sol, GPT-6 Luna and the three GPT-5.6 models advertised Fast only. A second fresh app-server with `features.fast_mode=true` and `features.ultrafast_mode=true` reported the same catalog. A final fresh app-server also advertised both tiers before `account/read`, matching Sotto's existing catalog-first connection order. The UI follows the catalog rather than inferring entitlement from the plan.

Protocol references checked: [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server) and current Context7 extracts of `openai/codex`'s `ModelServiceTier` and thread settings protocol. Standard uses the existing explicit `default` sentinel; Ultra fast uses `ultrafast` on the thread, never per turn.

Claude native agent definitions have no per-agent speed field in the [Agent SDK type](https://code.claude.com/docs/en/agent-sdk/typescript). Roles on Claude models with speed choices therefore use `delegate`, which starts the worker with its own flag layer. Codex role files set their own service tier; Standard is written only where the model offers speed tiers.

## Verification

The checks were windowless. Full CI gates and integration suites run on GitHub.

- `npm run typecheck` and `npm run lint`: clean on Node 24.22.1.
- Individually run unit files: 134 assertions passed across `workspaceFastMode`, `remoteCommands`, `threadOptionsFastMode`, shared `workerRoles` and `subagentRoleTable`, main `subagentRoles` and `workerRoleTools`, `agentSettingsLightPath`, renderer `threadFastMode`, `workerRolesSettings`, `workerRolesOrchestrating`, `unusedNewThread` and `pendingSettings`, and `interfaceCatalogs`.
- `npm run i18n:extract`: generated catalogs committed. The Codex, Claude and role integration cases were extended for GitHub CI; they were not run locally.
- A delegated renderer check expanded to 27 unit files: 526 passed and one skills retry assertion failed (`threadQueueSkills.test.tsx:597`, missing **Try again**). Its individual rerun passed all 38 assertions. No skills behavior was changed.

Headless captures render the real React composer and `WorkerRolesSettings`, with the app's stylesheets, Figtree and theme tokens. Both dark and light were inspected at pane widths corresponding to 1600×1000, 1280×800 and 820×560 windows; the contact sheets add an outer evidence margin and stack the states vertically. No application window or end-to-end suite was started. Standard, Fast and Ultrafast appear in the full composer and quiet pill, and the role speed menu is shown open. No controls clip at the minimum pane size. Selected evidence:

- [Dark composer](../../artifacts/agent-speed/composer-dark.png), [light composer at minimum size](../../artifacts/agent-speed/composer-light.png).
- [Dark worker roles](../../artifacts/agent-speed/roles-dark.png), [light worker roles at minimum size](../../artifacts/agent-speed/roles-light.png).

The coordinator also compares an older client's Fast-off command against the effective speed, so an Ultrafast thread cannot confirm Standard prematurely. When a command carries both fields, the named speed alone is dispatched.

## Local Owl install

Drake's revised build instruction was completed before the review and PR. Owl **0.1.41-owl.20261029.5** was built from the following commits on the throwaway `chore/local-owl-speed-5` branch:

- Main: `e0f88cba5a57fa5072305d7d791c89df550e4246`.
- Speed: `42add48944b188bc7630326488277008b49dc0ee`.
- PR #1806's focused-pane hairline fix: `dee8531c2939a22dd919801f79759531bf34c311`.
- Combined build: `c9f2fdec07ea5b278d5d110362969d75867c9098`.

The `finish.zsh` and `swap.zsh` recipe was copied from the `.3` swap directory into `/tmp/sotto-owl-0.1.41-owl.20261029.5-swap/`, with the build path and version changed. The detached swap quit `com.sotto.desktop`, installed and relaunched the app. It quit normally in two seconds; no termination signal was needed. The script retains SIGTERM after 60 seconds and never uses SIGKILL.

The installed bundle reports `.5` and passes `codesign --verify --deep --strict`. Its `app.asar` matches the built bundle (SHA-256 `22cdba8ff40410c4afae239f0c7cda1c3b6a43f36bfbb70f5e7246dd63f4c21c`). The previous `.4` bundle remains at `/tmp/sotto-owl-0.1.41-owl.20261029.5-swap/old-Sotto.app` for rollback. The install and relaunch were authorized separately from the headless UI checks; no app-launched test journey was run.
