# Thread and worker-role speed

Drake asked for Fast and Ultra fast in Watcher's worker roles and both composers, then authorized a local Owl install before review and merge. After trying `.5`, he asked for a quieter pill shared with Watcher, still effort dots that also set speed, mode-colored permissions and branch controls in the pane header. This amends ADR-0143, ADR-0091 and ADR-0161.

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

## Quiet pill refinement for Owl .6

The quiet composer removes the machine/workspace/branch footer and the delegation Stop note. The existing branch and workspace controls move beside the folder in the pane header. The full composer remains available with the Owl switch off. Watcher uses the same pill and keeps its model, effort and speed shared with Orchestrating.

Effort dots are 20% larger and closer together, with no running bounce or suggested-ring animation. Each names its effort and speed. Pressing the selected dot or Option/Alt+Up/Down cycles the catalog's speeds. Fast is purple; Ultrafast adds a brighter purple and soft glow. The permissions shield follows the selected mode; Full access has a slow gold sheen, disabled by reduced motion.

The refinement passed typecheck, lint, 17 speed-control assertions, four interface-catalog assertions and 111 theme-token assertions. The theme check caught a capsule radius on the small Stop; its corners now use the standard six pixels. The structural delegation passed 150 assertions in five individually run files (`branchToolbar`, `threadDelegation`, `threadPaneMenu`, `threadWorkingCopy`, `watcherView`). The final headless captures include thread and Watcher pills at Standard, Fast, Ultrafast, running, queued and Full access, in both themes and all three window sizes. Computed styles confirm 5.4 px dots on 9 px centers, no dot or ring animation, and a 4.8-second gold sheen that becomes `none` with reduced motion. A small visible Stop keeps the dot tooltips reachable, as the brief permits.

Selected refinement captures: [dark thread pill](../../artifacts/agent-speed/quiet-thread-dark.png), [light thread pill at minimum size](../../artifacts/agent-speed/quiet-thread-light.png), [dark Watcher pill](../../artifacts/agent-speed/quiet-watcher-dark.png), and [light Watcher pill at minimum size](../../artifacts/agent-speed/quiet-watcher-light.png). The Watcher sheets also show its first-message dots at each speed. New Watcher is a named glyph in the quiet pill. The temporary rendering harness was removed.

The final Watcher checks passed 54 assertions in `watcherView` and 17 in `watcherNew`, including first-message speed cycling with worker roles both on and off, preserving speed through effort changes, and the named New Watcher glyph. Final typecheck and lint were clean.


Owl **0.1.41-owl.20261029.6** was then built and installed before Muse review from main `fd5267ccadac07b54e0ccb79b9d93fb1ab74c53e` plus speed branch `2d944ef40a762c7fa3b017219c0fded0cae4b4da`, combined as `2ef654cd231b27ebe23b7d4f26cf07ac3087c640` on the throwaway `chore/local-owl-speed-6` branch. Main already includes the focused-pane hairline fix. The copied `.3` finish/swap recipe ran in `/tmp/sotto-owl-0.1.41-owl.20261029.6-swap/` with the new build path and version.

The detached swap quit `com.sotto.desktop` normally in two seconds, installed `.6` and relaunched it; no termination signal was needed. Packaged resources and deep, strict code signing passed. The installed `app.asar` matches the build (SHA-256 `801f068e9657ad1b7c2336b069396fe5cb7768fcce25e927871f75aa52ee9b80`). The previous `.5` bundle remains at `/tmp/sotto-owl-0.1.41-owl.20261029.6-swap/old-Sotto.app` for rollback.
