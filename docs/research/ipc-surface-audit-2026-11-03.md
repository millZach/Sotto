# Main–renderer IPC typing audit

Date: 2026-11-03. Source inventory: base `7ce44ce22`, with this change applied.

## Scope and method

Read all seven preload modules, their shared bridge contracts, and the bodies of the 30 main-process handler modules listed below. Scanned all 161 shared TypeScript modules for channel definitions and explicit `any` syntax; 36 modules declare a `*Bridge` interface. Followed handlers that accept `unknown` into their service validators before classifying them. Checked renderer Electron imports, direct IPC access, and casts of `window.sotto`.

Count distinct channel names, not bridge methods: shared main/popup/widget channels count once, every feature-gated bridge counts, and dynamic tool suffixes and template-literal channel constants are expanded. The inventory has **218 request channels** (210 production, eight E2E-only), **44 desktop event channels**, and four visual-guest messages (two incoming, two outgoing), or **266 distinct direction/channel entries**. One channel, `sotto:app:maximized`, is both a request and an event. This is the bridge-reachable surface, not the host socket protocol or provider adapters.

No explicit `any` type occurs in the scanned preload/shared/handler files. `unknown` in the transport adapters is appropriate: the question is whether it becomes a checked value before use. No direct renderer Electron IPC import was found. The gaps below are assertions, shallow checks, and missing result schemas rather than widespread `any`.

Judgment while the user was away: complete the four host-provider reply channels as one family. Existing request validation, sender roles, routing and feature switches remain in place. No product decision or new feature is needed; this enforces ADR-0037's existing limit on what the window receives. No question cards, app launch, full suite or CI watching.

## Gaps ranked by payload risk

| Priority | Gap and evidence | Disposition |
| --- | --- | --- |
| 1 | Host-provider replies carry sign-in codes, provider errors and model-source sign-in state. Three methods asserted unchecked promises; OpenCode erased its action/reply pairing with `as ZodType<unknown>` and `as never`. Main forwarded the replies without an output schema. [src/preload/index.ts:598](../../src/preload/index.ts#L598), [src/main/hosts/ipc.ts:35](../../src/main/hosts/ipc.ts#L35). | **Fixed** for all four channels below. Reject extra sign-in page/key fields before the reply leaves main and reject malformed wire replies in preload. |
| 2 | Agent commands carry prompts, attachments and answers. `validatedRoutedCommand` validates an ID-normalized copy but returns the original; main repeats that normalization check then asserts `payload as AgentCommand`. Schema transforms/defaults therefore do not produce the forwarded value. [src/preload/index.ts:348](../../src/preload/index.ts#L348), [src/main/agents/ipc.ts:150](../../src/main/agents/ipc.ts#L150), [src/shared/clientIdentity.ts:35](../../src/shared/clientIdentity.ts#L35). | Remains. Requests are schema-checked, so this is not evidence of arbitrary unchecked command execution. A follow-up must preserve remote IDs while forwarding a schema-derived representation; blindly returning the normalized parse would change routing. |
| 3 | Agent state/detail and popup thread events carry agent/user history through `trustedState`, which checks only object presence and a key before asserting the complete type. [src/preload/index.ts:271](../../src/preload/index.ts#L271), [src/preload/index.ts:379](../../src/preload/index.ts#L379), [src/preload/index.ts:392](../../src/preload/index.ts#L392), [src/preload/index.ts:802](../../src/preload/index.ts#L802). `hostClientBridge` also reconstructs a bridge through reflection and asserts `as T` ([src/preload/hostClientBridge.ts:54](../../src/preload/hostClientBridge.ts#L54)). | Remains. The state path deliberately avoids revalidating whole histories on every update. Any change needs a bounded envelope/delta check and the existing copy/work budgets, not a full-state parse on each notification. Watcher has its own structural guard, [src/preload/watcherRoomForwarding.ts:19](../../src/preload/watcherRoomForwarding.ts#L19). |
| 4 | Nine other preload replies still use promise assertions: `hosts:get`, `hosts:command`, `hosts:devices`, `hosts:tailscale`, `hosts:tailscale-connect`, `hosts:tailscale-download`, `phones:get`, `phones:command`, `local-apps:get`. Their snapshots include connection/pairing state. [src/preload/index.ts:595](../../src/preload/index.ts#L595), [src/preload/index.ts:607](../../src/preload/index.ts#L607). The `hosts:changed`, `phones:changed` and `local-apps:changed` events use key-only guards too. | Remains as a coherent snapshot family. Main authorizes senders and validates command requests; interfaces alone do not validate replies. `tailscale-download` has no useful result payload. |
| 5 | Twelve renderer structural recasts bypass the declared `SottoBridge` shape, mostly redundant optional bridge lookups and platform reads. [src/renderer/src/tools/ToolsPanel.tsx:84](../../src/renderer/src/tools/ToolsPanel.tsx#L84), [src/renderer/src/tools/ToolsPanel.tsx:243](../../src/renderer/src/tools/ToolsPanel.tsx#L243), [src/renderer/src/tools/webLinks.tsx:29](../../src/renderer/src/tools/webLinks.tsx#L29), [src/renderer/src/tools/webLinks.tsx:74](../../src/renderer/src/tools/webLinks.tsx#L74), [src/renderer/src/tools/terminalStore.ts:491](../../src/renderer/src/tools/terminalStore.ts#L491), [src/renderer/src/agents/FilePicker.tsx:47](../../src/renderer/src/agents/FilePicker.tsx#L47), [src/renderer/src/agents/AttachmentViewer.tsx:98](../../src/renderer/src/agents/AttachmentViewer.tsx#L98), [src/renderer/src/agents/MarkupEditor.tsx:127](../../src/renderer/src/agents/MarkupEditor.tsx#L127), [src/renderer/src/agents/MessageContent.tsx:102](../../src/renderer/src/agents/MessageContent.tsx#L102). | Remains; lower risk than content-bearing IPC. These do not expose Electron or add privileged methods. Use the global bridge type directly in a focused cleanup. |
| 6 | Generic invoke/register helpers accept `channel: string`, and themes has three redundant return assertions despite parsing both directions. [src/preload/index.ts:246](../../src/preload/index.ts#L246), [src/main/ipc/registerIpc.ts:561](../../src/main/ipc/registerIpc.ts#L561), [src/preload/themes.ts:24](../../src/preload/themes.ts#L24). | Remains. Most individual call sites pair shared constants with schemas correctly; there is no global channel-to-payload type map. A new framework/map is outside this focused fix. |

## What this change types

- `hosts:provider-action` and `hosts:update-clients`: shared strict result schema, with `HostProviderActionResult` inferred from it. Main and preload parse their respective boundary values instead of asserting a promise. [src/shared/hostProviders.ts:131](../../src/shared/hostProviders.ts#L131).
- `hosts:sign-in`: derive the strict renderer view by omitting `url` from the existing host sign-in schema; preserve device codes, optional display fields and nullable cancellation. [src/shared/hostProviders.ts:118](../../src/shared/hostProviders.ts#L118). This turns ADR-0037's existing page-address restriction into an executable contract.
- `hosts:opencode-sign-in`: a mapped schema lookup keeps the action-specific answer type without suppressions or casts; main validates that answer before interface-word translation. The existing per-action schemas and feature gate are reused. [src/shared/hostProviders.ts:231](../../src/shared/hostProviders.ts#L231), [src/preload/index.ts:602](../../src/preload/index.ts#L602), [src/main/hosts/ipc.ts:52](../../src/main/hosts/ipc.ts#L52).
- Narrow the handler dependency to the methods it uses, so its fixture no longer impersonates the whole `DesktopHosts` class with a double cast. No new dependency, transport abstraction, schema constructed inside a handler, or UI string.

## Checked boundaries that are not gaps

The main registration helper authorizes sender roles and checks arity/schema before operation calls ([src/main/ipc/registerIpc.ts:568](../../src/main/ipc/registerIpc.ts#L568)). Tool/file/theme/cloud handlers use `unknown` transport inputs deliberately; validation occurs in their service entry points. Examples: [src/main/tools/common.ts:13](../../src/main/tools/common.ts#L13), [src/main/tools/terminal.ts:100](../../src/main/tools/terminal.ts#L100), [src/main/tools/browser.ts:137](../../src/main/tools/browser.ts#L137), [src/main/tools/gitChanges.ts:85](../../src/main/tools/gitChanges.ts#L85), [src/main/files/service.ts:99](../../src/main/files/service.ts#L99), [src/main/tools/cloudIphone/service.ts:269](../../src/main/tools/cloudIphone/service.ts#L269). Their preload calls parse replies. Continue, thread moves, own-server and local OpenCode handlers likewise delegate request validation and check outgoing answers. An `unknown` tuple is not, on its own, an unvalidated request.

Channel strings are shared constants or finite suffix lists. The inventory below includes schema-checked calls as well as the remaining gaps; it is not a claim that every channel needs editing. Void-only popup requests discard replies; visual-guest messages use the existing bounded readers and host-directed notifications.

## Verification

- `npm ci --ignore-scripts` completed before checks.
- Current Zod parsing/strict-object behavior and Vitest async-mock assertions checked with Context7 against their upstream documentation.
- `GOMAXPROCS=2 npm run typecheck`: all four projects passed, with no new suppressions. Compiler concurrency was limited while other local checks were running.
- `npm run lint`: passed.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/main/hostProviderIpc.test.ts tests/unit/main/hostsOpenCodeIpc.test.ts tests/unit/preload/hostOpenCodeBridge.test.ts --maxWorkers=2`: **3 files, 10 tests passed**. This Mac uses Node 25.8.2; the first run failed in shared teardown because its experimental `localStorage` has no `clear`. Disabling that API for the command avoids the environment issue; no setup change.
- Cases cover handler-to-preload round trips, device codes and null cancellation, malformed/extra requests, unauthorized windows, malformed/extra reply fields, action-specific OpenCode answers, feature gating and handler cleanup. The diff was reviewed against AGENTS.md and the requested scope. No new suppression. Full suite, Playwright and app launch were not run as instructed.

## Shared bridge contract modules

- [src/shared/agents.ts](../../src/shared/agents.ts)
- [src/shared/browser.ts](../../src/shared/browser.ts)
- [src/shared/checkQueue.ts](../../src/shared/checkQueue.ts)
- [src/shared/checkpoints.ts](../../src/shared/checkpoints.ts)
- [src/shared/cloudIphone.ts](../../src/shared/cloudIphone.ts)
- [src/shared/continueThread.ts](../../src/shared/continueThread.ts)
- [src/shared/contracts.ts](../../src/shared/contracts.ts)
- [src/shared/council.ts](../../src/shared/council.ts)
- [src/shared/cursorSignIn.ts](../../src/shared/cursorSignIn.ts)
- [src/shared/delegation.ts](../../src/shared/delegation.ts)
- [src/shared/desktopNotifications.ts](../../src/shared/desktopNotifications.ts)
- [src/shared/e2e.ts](../../src/shared/e2e.ts)
- [src/shared/files.ts](../../src/shared/files.ts)
- [src/shared/gitChanges.ts](../../src/shared/gitChanges.ts)
- [src/shared/glassWindow.ts](../../src/shared/glassWindow.ts)
- [src/shared/hosts.ts](../../src/shared/hosts.ts)
- [src/shared/interfaceLanguageBridge.ts](../../src/shared/interfaceLanguageBridge.ts)
- [src/shared/localApps.ts](../../src/shared/localApps.ts)
- [src/shared/mainActivity.ts](../../src/shared/mainActivity.ts)
- [src/shared/mainCheckout.ts](../../src/shared/mainCheckout.ts)
- [src/shared/memory.ts](../../src/shared/memory.ts)
- [src/shared/nextPrompt.ts](../../src/shared/nextPrompt.ts)
- [src/shared/omarchySetup.ts](../../src/shared/omarchySetup.ts)
- [src/shared/opencodeSignIn.ts](../../src/shared/opencodeSignIn.ts)
- [src/shared/ownModelServers.ts](../../src/shared/ownModelServers.ts)
- [src/shared/ownServerCleanup.ts](../../src/shared/ownServerCleanup.ts)
- [src/shared/phones.ts](../../src/shared/phones.ts)
- [src/shared/popup.ts](../../src/shared/popup.ts)
- [src/shared/requestDrafts.ts](../../src/shared/requestDrafts.ts)
- [src/shared/subagents.ts](../../src/shared/subagents.ts)
- [src/shared/terminal.ts](../../src/shared/terminal.ts)
- [src/shared/themes/bridge.ts](../../src/shared/themes/bridge.ts)
- [src/shared/threadMoves.ts](../../src/shared/threadMoves.ts)
- [src/shared/usageDashboard.ts](../../src/shared/usageDashboard.ts)
- [src/shared/visualPages.ts](../../src/shared/visualPages.ts)
- [src/shared/watcherRoom.ts](../../src/shared/watcherRoom.ts)

Channel constants also live in [channels.ts](../../src/shared/channels.ts); the fixed reply family is defined in [hostProviders.ts](../../src/shared/hostProviders.ts).

## Handler bodies read

- [src/main/agents/checkQueueIpc.ts](../../src/main/agents/checkQueueIpc.ts)
- [src/main/agents/continueThreadIpc.ts](../../src/main/agents/continueThreadIpc.ts)
- [src/main/agents/cursorSignInIpc.ts](../../src/main/agents/cursorSignInIpc.ts)
- [src/main/agents/delegationIpc.ts](../../src/main/agents/delegationIpc.ts)
- [src/main/agents/ipc.ts](../../src/main/agents/ipc.ts)
- [src/main/agents/mainCheckoutIpc.ts](../../src/main/agents/mainCheckoutIpc.ts)
- [src/main/agents/nextPromptIpc.ts](../../src/main/agents/nextPromptIpc.ts)
- [src/main/agents/opencodeSignInIpc.ts](../../src/main/agents/opencodeSignInIpc.ts)
- [src/main/agents/requestDraftIpc.ts](../../src/main/agents/requestDraftIpc.ts)
- [src/main/agents/subagentIpc.ts](../../src/main/agents/subagentIpc.ts)
- [src/main/agents/threadMovesIpc.ts](../../src/main/agents/threadMovesIpc.ts)
- [src/main/agents/usageIpc.ts](../../src/main/agents/usageIpc.ts)
- [src/main/agents/visualSandbox.ts](../../src/main/agents/visualSandbox.ts)
- [src/main/council/councilIpc.ts](../../src/main/council/councilIpc.ts)
- [src/main/files/ipc.ts](../../src/main/files/ipc.ts)
- [src/main/hosts/ipc.ts](../../src/main/hosts/ipc.ts)
- [src/main/index.ts](../../src/main/index.ts)
- [src/main/ipc/registerIpc.ts](../../src/main/ipc/registerIpc.ts)
- [src/main/llm/ownServerCleanupIpc.ts](../../src/main/llm/ownServerCleanupIpc.ts)
- [src/main/memory/ipc.ts](../../src/main/memory/ipc.ts)
- [src/main/notifications/notificationIpc.ts](../../src/main/notifications/notificationIpc.ts)
- [src/main/omarchy/ipc.ts](../../src/main/omarchy/ipc.ts)
- [src/main/ownModelServers/ipc.ts](../../src/main/ownModelServers/ipc.ts)
- [src/main/performance/mainActivityIpc.ts](../../src/main/performance/mainActivityIpc.ts)
- [src/main/phones/ipc.ts](../../src/main/phones/ipc.ts)
- [src/main/popup/popupIpc.ts](../../src/main/popup/popupIpc.ts)
- [src/main/themes/ipc.ts](../../src/main/themes/ipc.ts)
- [src/main/tools/cloudIphoneIpc.ts](../../src/main/tools/cloudIphoneIpc.ts)
- [src/main/tools/ipc.ts](../../src/main/tools/ipc.ts)
- [src/main/windows/glassWindowIpc.ts](../../src/main/windows/glassWindowIpc.ts)

## Complete bridge inventory

Preload references point to the boundary call or subscription; follow its imported shared schema/type to the contract. Duplicate uses of the same direction/channel are retained as multiple references on one row.

### Request channels

| Channel | Preload call site |
| --- | --- |
| `hosts:command` | [src/preload/index.ts:595](../../src/preload/index.ts#L595) |
| `hosts:devices` | [src/preload/index.ts:596](../../src/preload/index.ts#L596) |
| `hosts:get` | [src/preload/index.ts:595](../../src/preload/index.ts#L595) |
| `hosts:opencode-sign-in` | [src/preload/index.ts:605](../../src/preload/index.ts#L605) |
| `hosts:provider-action` | [src/preload/index.ts:598](../../src/preload/index.ts#L598) |
| `hosts:sign-in` | [src/preload/index.ts:600](../../src/preload/index.ts#L600) |
| `hosts:tailscale` | [src/preload/index.ts:596](../../src/preload/index.ts#L596) |
| `hosts:tailscale-connect` | [src/preload/index.ts:597](../../src/preload/index.ts#L597) |
| `hosts:tailscale-download` | [src/preload/index.ts:597](../../src/preload/index.ts#L597) |
| `hosts:update-clients` | [src/preload/index.ts:599](../../src/preload/index.ts#L599) |
| `local-apps:get` | [src/preload/index.ts:608](../../src/preload/index.ts#L608) |
| `memory:command` | [src/preload/index.ts:636](../../src/preload/index.ts#L636) |
| `memory:get` | [src/preload/index.ts:635](../../src/preload/index.ts#L635) |
| `omarchy-setup:command` | [src/preload/index.ts:614](../../src/preload/index.ts#L614) |
| `omarchy-setup:get` | [src/preload/index.ts:613](../../src/preload/index.ts#L613) |
| `phones:command` | [src/preload/index.ts:607](../../src/preload/index.ts#L607) |
| `phones:get` | [src/preload/index.ts:607](../../src/preload/index.ts#L607) |
| `request-draft:check` | [src/preload/index.ts:647](../../src/preload/index.ts#L647) |
| `request-draft:discard` | [src/preload/index.ts:643](../../src/preload/index.ts#L643) |
| `request-draft:get` | [src/preload/index.ts:644](../../src/preload/index.ts#L644) |
| `request-draft:list` | [src/preload/index.ts:642](../../src/preload/index.ts#L642) |
| `request-draft:save` | [src/preload/index.ts:646](../../src/preload/index.ts#L646) |
| `request-draft:status` | [src/preload/index.ts:645](../../src/preload/index.ts#L645) |
| `sotto:agents:activity-body` | [src/preload/index.ts:375](../../src/preload/index.ts#L375) |
| `sotto:agents:attachment-content` | [src/preload/index.ts:365](../../src/preload/index.ts#L365) |
| `sotto:agents:attachment-preview` | [src/preload/index.ts:357](../../src/preload/index.ts#L357) |
| `sotto:agents:choose-project-directory` | [src/preload/index.ts:366](../../src/preload/index.ts#L366) |
| `sotto:agents:command` | [src/preload/index.ts:384](../../src/preload/index.ts#L384), [src/preload/index.ts:385](../../src/preload/index.ts#L385), [src/preload/index.ts:830](../../src/preload/index.ts#L830) |
| `sotto:agents:get` | [src/preload/index.ts:355](../../src/preload/index.ts#L355), [src/preload/index.ts:824](../../src/preload/index.ts#L824), [src/preload/index.ts:910](../../src/preload/index.ts#L910) |
| `sotto:agents:git-changed-files` | [src/preload/index.ts:369](../../src/preload/index.ts#L369) |
| `sotto:agents:git-pull-request` | [src/preload/index.ts:370](../../src/preload/index.ts#L370) |
| `sotto:agents:git-refs` | [src/preload/index.ts:368](../../src/preload/index.ts#L368) |
| `sotto:agents:host-folders` | [src/preload/index.ts:371](../../src/preload/index.ts#L371) |
| `sotto:agents:stage-attachment` | [src/preload/index.ts:363](../../src/preload/index.ts#L363) |
| `sotto:agents:start-handover` | [src/preload/index.ts:373](../../src/preload/index.ts#L373) |
| `sotto:agents:thread-detail-get` | [src/preload/index.ts:372](../../src/preload/index.ts#L372), [src/preload/index.ts:825](../../src/preload/index.ts#L825) |
| `sotto:agents:thread-media` | [src/preload/index.ts:360](../../src/preload/index.ts#L360) |
| `sotto:agents:thread-prompts` | [src/preload/index.ts:377](../../src/preload/index.ts#L377) |
| `sotto:agents:working-copy-options` | [src/preload/index.ts:367](../../src/preload/index.ts#L367) |
| `sotto:app:hide` | [src/preload/index.ts:727](../../src/preload/index.ts#L727) |
| `sotto:app:maximized` | [src/preload/index.ts:731](../../src/preload/index.ts#L731) |
| `sotto:app:minimize` | [src/preload/index.ts:729](../../src/preload/index.ts#L729) |
| `sotto:app:quit` | [src/preload/index.ts:735](../../src/preload/index.ts#L735) |
| `sotto:app:reload` | [src/preload/index.ts:728](../../src/preload/index.ts#L728) |
| `sotto:app:show` | [src/preload/index.ts:723](../../src/preload/index.ts#L723) |
| `sotto:app:toggle-maximize` | [src/preload/index.ts:730](../../src/preload/index.ts#L730) |
| `sotto:browser:answerAction` | [src/preload/tools.ts:58](../../src/preload/tools.ts#L58) |
| `sotto:browser:back` | [src/preload/tools.ts:66](../../src/preload/tools.ts#L66) |
| `sotto:browser:capture` | [src/preload/tools.ts:61](../../src/preload/tools.ts#L61) |
| `sotto:browser:close` | [src/preload/tools.ts:69](../../src/preload/tools.ts#L69) |
| `sotto:browser:controlTask` | [src/preload/tools.ts:57](../../src/preload/tools.ts#L57) |
| `sotto:browser:create` | [src/preload/tools.ts:64](../../src/preload/tools.ts#L64) |
| `sotto:browser:forward` | [src/preload/tools.ts:67](../../src/preload/tools.ts#L67) |
| `sotto:browser:list` | [src/preload/tools.ts:63](../../src/preload/tools.ts#L63) |
| `sotto:browser:mount` | [src/preload/tools.ts:70](../../src/preload/tools.ts#L70) |
| `sotto:browser:navigate` | [src/preload/tools.ts:65](../../src/preload/tools.ts#L65) |
| `sotto:browser:openLink` | [src/preload/tools.ts:71](../../src/preload/tools.ts#L71) |
| `sotto:browser:point` | [src/preload/tools.ts:62](../../src/preload/tools.ts#L62) |
| `sotto:browser:reload` | [src/preload/tools.ts:68](../../src/preload/tools.ts#L68) |
| `sotto:browser:share` | [src/preload/tools.ts:56](../../src/preload/tools.ts#L56) |
| `sotto:browser:stopGrant` | [src/preload/tools.ts:59](../../src/preload/tools.ts#L59) |
| `sotto:browser:tasks` | [src/preload/tools.ts:55](../../src/preload/tools.ts#L55) |
| `sotto:browser:viewport` | [src/preload/tools.ts:60](../../src/preload/tools.ts#L60) |
| `sotto:checks:read` | [src/preload/index.ts:477](../../src/preload/index.ts#L477) |
| `sotto:cloud-iphone:answer` | [src/preload/cloudIphone.ts:25](../../src/preload/cloudIphone.ts#L25) |
| `sotto:cloud-iphone:end` | [src/preload/cloudIphone.ts:26](../../src/preload/cloudIphone.ts#L26) |
| `sotto:cloud-iphone:mount` | [src/preload/cloudIphone.ts:27](../../src/preload/cloudIphone.ts#L27) |
| `sotto:cloud-iphone:sessions` | [src/preload/cloudIphone.ts:24](../../src/preload/cloudIphone.ts#L24) |
| `sotto:cloud-iphone:setKey` | [src/preload/cloudIphone.ts:23](../../src/preload/cloudIphone.ts#L23) |
| `sotto:cloud-iphone:status` | [src/preload/cloudIphone.ts:22](../../src/preload/cloudIphone.ts#L22) |
| `sotto:continue:read` | [src/preload/index.ts:577](../../src/preload/index.ts#L577) |
| `sotto:continue:start` | [src/preload/index.ts:578](../../src/preload/index.ts#L578) |
| `sotto:council:command` | [src/preload/index.ts:572](../../src/preload/index.ts#L572) |
| `sotto:council:estimate` | [src/preload/index.ts:571](../../src/preload/index.ts#L571) |
| `sotto:council:read` | [src/preload/index.ts:570](../../src/preload/index.ts#L570) |
| `sotto:cursor:sign-in-cancel` | [src/preload/index.ts:515](../../src/preload/index.ts#L515) |
| `sotto:cursor:sign-in-read` | [src/preload/index.ts:513](../../src/preload/index.ts#L513) |
| `sotto:cursor:sign-in-reopen` | [src/preload/index.ts:514](../../src/preload/index.ts#L514) |
| `sotto:cursor:sign-in-start` | [src/preload/index.ts:512](../../src/preload/index.ts#L512) |
| `sotto:cursor:sign-out` | [src/preload/index.ts:516](../../src/preload/index.ts#L516) |
| `sotto:delegations:brief` | [src/preload/index.ts:492](../../src/preload/index.ts#L492) |
| `sotto:delegations:check-reply` | [src/preload/index.ts:494](../../src/preload/index.ts#L494) |
| `sotto:delegations:read` | [src/preload/index.ts:491](../../src/preload/index.ts#L491) |
| `sotto:dictation-keys:record` | [src/preload/index.ts:675](../../src/preload/index.ts#L675) |
| `sotto:dictation-keys:record-cancel` | [src/preload/index.ts:676](../../src/preload/index.ts#L676) |
| `sotto:dictation-records:get` | [src/preload/index.ts:667](../../src/preload/index.ts#L667) |
| `sotto:dictation-records:list` | [src/preload/index.ts:666](../../src/preload/index.ts#L666) |
| `sotto:dictation-shortcuts:replace` | [src/preload/index.ts:673](../../src/preload/index.ts#L673) |
| `sotto:dictation-shortcuts:suspend` | [src/preload/index.ts:674](../../src/preload/index.ts#L674) |
| `sotto:dictation:request` | [src/preload/index.ts:685](../../src/preload/index.ts#L685), [src/preload/index.ts:776](../../src/preload/index.ts#L776), [src/preload/index.ts:778](../../src/preload/index.ts#L778), [src/preload/index.ts:780](../../src/preload/index.ts#L780), [src/preload/index.ts:782](../../src/preload/index.ts#L782), [src/preload/index.ts:784](../../src/preload/index.ts#L784) |
| `sotto:e2e:agents` | [src/preload/index.ts:909](../../src/preload/index.ts#L909), [src/preload/index.ts:912](../../src/preload/index.ts#L912) |
| `sotto:e2e:browser-agent` | [src/preload/index.ts:902](../../src/preload/index.ts#L902) |
| `sotto:e2e:delegation-tool` | [src/preload/index.ts:906](../../src/preload/index.ts#L906) |
| `sotto:e2e:host-setup-tool` | [src/preload/index.ts:903](../../src/preload/index.ts#L903) |
| `sotto:e2e:media-tool` | [src/preload/index.ts:905](../../src/preload/index.ts#L905) |
| `sotto:e2e:snapshot` | [src/preload/index.ts:916](../../src/preload/index.ts#L916) |
| `sotto:e2e:trigger-shortcut` | [src/preload/index.ts:917](../../src/preload/index.ts#L917) |
| `sotto:e2e:visual-tool` | [src/preload/index.ts:904](../../src/preload/index.ts#L904) |
| `sotto:external-link:open` | [src/preload/index.ts:724](../../src/preload/index.ts#L724), [src/preload/index.ts:832](../../src/preload/index.ts#L832) |
| `sotto:files:copy-path` | [src/preload/index.ts:630](../../src/preload/index.ts#L630) |
| `sotto:files:list` | [src/preload/index.ts:628](../../src/preload/index.ts#L628) |
| `sotto:files:preview` | [src/preload/index.ts:629](../../src/preload/index.ts#L629) |
| `sotto:files:reveal` | [src/preload/index.ts:631](../../src/preload/index.ts#L631) |
| `sotto:files:reveal-link` | [src/preload/index.ts:632](../../src/preload/index.ts#L632) |
| `sotto:git-changes:checkpoints` | [src/preload/tools.ts:75](../../src/preload/tools.ts#L75) |
| `sotto:git-changes:copyPath` | [src/preload/tools.ts:81](../../src/preload/tools.ts#L81) |
| `sotto:git-changes:inspectCheckpoint` | [src/preload/tools.ts:76](../../src/preload/tools.ts#L76) |
| `sotto:git-changes:list` | [src/preload/tools.ts:79](../../src/preload/tools.ts#L79) |
| `sotto:git-changes:recoverCheckpoint` | [src/preload/tools.ts:78](../../src/preload/tools.ts#L78) |
| `sotto:git-changes:reveal` | [src/preload/tools.ts:82](../../src/preload/tools.ts#L82) |
| `sotto:git-changes:revertCheckpoint` | [src/preload/tools.ts:77](../../src/preload/tools.ts#L77) |
| `sotto:git-changes:review` | [src/preload/tools.ts:80](../../src/preload/tools.ts#L80) |
| `sotto:git-changes:watch` | [src/preload/tools.ts:83](../../src/preload/tools.ts#L83) |
| `sotto:glass-window:set` | [src/preload/index.ts:539](../../src/preload/index.ts#L539) |
| `sotto:history:add` | [src/preload/index.ts:662](../../src/preload/index.ts#L662) |
| `sotto:history:clear` | [src/preload/index.ts:665](../../src/preload/index.ts#L665) |
| `sotto:history:delete` | [src/preload/index.ts:664](../../src/preload/index.ts#L664) |
| `sotto:history:list` | [src/preload/index.ts:661](../../src/preload/index.ts#L661) |
| `sotto:history:search` | [src/preload/index.ts:663](../../src/preload/index.ts#L663) |
| `sotto:hotkey:get` | [src/preload/index.ts:669](../../src/preload/index.ts#L669) |
| `sotto:hotkey:replace` | [src/preload/index.ts:671](../../src/preload/index.ts#L671) |
| `sotto:interface-language:get` | [src/preload/index.ts:743](../../src/preload/index.ts#L743) |
| `sotto:key-listener:permission` | [src/preload/index.ts:680](../../src/preload/index.ts#L680) |
| `sotto:key-listener:permission-request` | [src/preload/index.ts:681](../../src/preload/index.ts#L681) |
| `sotto:main-activity:command` | [src/preload/index.ts:533](../../src/preload/index.ts#L533) |
| `sotto:main-activity:read` | [src/preload/index.ts:532](../../src/preload/index.ts#L532) |
| `sotto:main-checkout:changes` | [src/preload/index.ts:544](../../src/preload/index.ts#L544) |
| `sotto:main-checkout:command` | [src/preload/index.ts:545](../../src/preload/index.ts#L545) |
| `sotto:main-checkout:read` | [src/preload/index.ts:543](../../src/preload/index.ts#L543) |
| `sotto:microphone:ensure-access` | [src/preload/index.ts:710](../../src/preload/index.ts#L710) |
| `sotto:next-prompt:read` | [src/preload/index.ts:555](../../src/preload/index.ts#L555) |
| `sotto:next-prompt:watcher-first` | [src/preload/index.ts:557](../../src/preload/index.ts#L557) |
| `sotto:next-prompt:watcher-first-cancel` | [src/preload/index.ts:559](../../src/preload/index.ts#L559) |
| `sotto:notification:test` | [src/preload/index.ts:551](../../src/preload/index.ts#L551) |
| `sotto:opencode:sign-in-browser` | [src/preload/index.ts:502](../../src/preload/index.ts#L502) |
| `sotto:opencode:sign-in-cancel` | [src/preload/index.ts:507](../../src/preload/index.ts#L507) |
| `sotto:opencode:sign-in-external` | [src/preload/index.ts:503](../../src/preload/index.ts#L503) |
| `sotto:opencode:sign-in-finish` | [src/preload/index.ts:505](../../src/preload/index.ts#L505) |
| `sotto:opencode:sign-in-key` | [src/preload/index.ts:501](../../src/preload/index.ts#L501) |
| `sotto:opencode:sign-in-reopen` | [src/preload/index.ts:506](../../src/preload/index.ts#L506) |
| `sotto:opencode:sign-in-wait` | [src/preload/index.ts:504](../../src/preload/index.ts#L504) |
| `sotto:opencode:sign-out` | [src/preload/index.ts:508](../../src/preload/index.ts#L508) |
| `sotto:opencode:sources` | [src/preload/index.ts:500](../../src/preload/index.ts#L500) |
| `sotto:openrouter:check-key` | [src/preload/index.ts:707](../../src/preload/index.ts#L707) |
| `sotto:openrouter:list-models` | [src/preload/index.ts:708](../../src/preload/index.ts#L708) |
| `sotto:openrouter:list-speech-models` | [src/preload/index.ts:709](../../src/preload/index.ts#L709) |
| `sotto:output:copy-image` | [src/preload/index.ts:693](../../src/preload/index.ts#L693) |
| `sotto:output:deliver` | [src/preload/index.ts:691](../../src/preload/index.ts#L691) |
| `sotto:own-server-cleanup:measure` | [src/preload/index.ts:528](../../src/preload/index.ts#L528) |
| `sotto:own-server-cleanup:measured` | [src/preload/index.ts:529](../../src/preload/index.ts#L529) |
| `sotto:own-servers:add` | [src/preload/index.ts:523](../../src/preload/index.ts#L523) |
| `sotto:own-servers:check` | [src/preload/index.ts:522](../../src/preload/index.ts#L522) |
| `sotto:own-servers:check-saved` | [src/preload/index.ts:524](../../src/preload/index.ts#L524) |
| `sotto:own-servers:list` | [src/preload/index.ts:521](../../src/preload/index.ts#L521) |
| `sotto:own-servers:remove` | [src/preload/index.ts:525](../../src/preload/index.ts#L525) |
| `sotto:popup:fit` | [src/preload/index.ts:834](../../src/preload/index.ts#L834) |
| `sotto:popup:hide` | [src/preload/index.ts:833](../../src/preload/index.ts#L833) |
| `sotto:popup:open` | [src/preload/index.ts:835](../../src/preload/index.ts#L835) |
| `sotto:popup:shortcut-replace` | [src/preload/index.ts:565](../../src/preload/index.ts#L565) |
| `sotto:popup:shortcut-state` | [src/preload/index.ts:563](../../src/preload/index.ts#L563) |
| `sotto:question-page:open` | [src/preload/index.ts:725](../../src/preload/index.ts#L725) |
| `sotto:recovery-notice:dismiss-paste-permission` | [src/preload/index.ts:654](../../src/preload/index.ts#L654) |
| `sotto:recovery-notice:list` | [src/preload/index.ts:652](../../src/preload/index.ts#L652) |
| `sotto:settings:get` | [src/preload/index.ts:656](../../src/preload/index.ts#L656), [src/preload/index.ts:822](../../src/preload/index.ts#L822) |
| `sotto:settings:reset` | [src/preload/index.ts:658](../../src/preload/index.ts#L658) |
| `sotto:settings:update` | [src/preload/index.ts:657](../../src/preload/index.ts#L657) |
| `sotto:speech-model:choose` | [src/preload/index.ts:705](../../src/preload/index.ts#L705) |
| `sotto:speech-model:download` | [src/preload/index.ts:703](../../src/preload/index.ts#L703) |
| `sotto:speech-model:get-status` | [src/preload/index.ts:702](../../src/preload/index.ts#L702) |
| `sotto:speech-model:list` | [src/preload/index.ts:704](../../src/preload/index.ts#L704) |
| `sotto:startup:get` | [src/preload/index.ts:720](../../src/preload/index.ts#L720) |
| `sotto:startup:set` | [src/preload/index.ts:721](../../src/preload/index.ts#L721) |
| `sotto:subagents:assignments` | [src/preload/index.ts:620](../../src/preload/index.ts#L620) |
| `sotto:subagents:page` | [src/preload/index.ts:619](../../src/preload/index.ts#L619) |
| `sotto:system-settings:open` | [src/preload/index.ts:726](../../src/preload/index.ts#L726) |
| `sotto:terminal:close` | [src/preload/tools.ts:48](../../src/preload/tools.ts#L48) |
| `sotto:terminal:create` | [src/preload/tools.ts:43](../../src/preload/tools.ts#L43) |
| `sotto:terminal:focus` | [src/preload/tools.ts:51](../../src/preload/tools.ts#L51) |
| `sotto:terminal:interrupt` | [src/preload/tools.ts:47](../../src/preload/tools.ts#L47) |
| `sotto:terminal:list` | [src/preload/tools.ts:42](../../src/preload/tools.ts#L42) |
| `sotto:terminal:pasteImage` | [src/preload/tools.ts:50](../../src/preload/tools.ts#L50) |
| `sotto:terminal:read` | [src/preload/tools.ts:44](../../src/preload/tools.ts#L44) |
| `sotto:terminal:reopen` | [src/preload/tools.ts:49](../../src/preload/tools.ts#L49) |
| `sotto:terminal:resize` | [src/preload/tools.ts:46](../../src/preload/tools.ts#L46) |
| `sotto:terminal:write` | [src/preload/tools.ts:45](../../src/preload/tools.ts#L45) |
| `sotto:thread-move:answer` | [src/preload/index.ts:486](../../src/preload/index.ts#L486) |
| `sotto:thread-move:prepare` | [src/preload/index.ts:483](../../src/preload/index.ts#L483) |
| `sotto:thread-move:read` | [src/preload/index.ts:485](../../src/preload/index.ts#L485) |
| `sotto:thread-move:start` | [src/preload/index.ts:484](../../src/preload/index.ts#L484) |
| `sotto:transcript:polish` | [src/preload/index.ts:696](../../src/preload/index.ts#L696) |
| `sotto:transcription:cancel` | [src/preload/index.ts:701](../../src/preload/index.ts#L701) |
| `sotto:transcription:transcribe` | [src/preload/index.ts:699](../../src/preload/index.ts#L699) |
| `sotto:update:check` | [src/preload/index.ts:713](../../src/preload/index.ts#L713) |
| `sotto:update:download` | [src/preload/index.ts:714](../../src/preload/index.ts#L714) |
| `sotto:update:get-status` | [src/preload/index.ts:712](../../src/preload/index.ts#L712) |
| `sotto:update:install` | [src/preload/index.ts:715](../../src/preload/index.ts#L715) |
| `sotto:usage:clear` | [src/preload/index.ts:473](../../src/preload/index.ts#L473) |
| `sotto:usage:read` | [src/preload/index.ts:471](../../src/preload/index.ts#L471) |
| `sotto:usage:refresh` | [src/preload/index.ts:472](../../src/preload/index.ts#L472) |
| `sotto:visuals:open-page` | [src/preload/index.ts:625](../../src/preload/index.ts#L625) |
| `sotto:watcher:continue-handover` | [src/preload/index.ts:590](../../src/preload/index.ts#L590) |
| `sotto:watcher:dismiss-handover` | [src/preload/index.ts:591](../../src/preload/index.ts#L591) |
| `sotto:watcher:get` | [src/preload/index.ts:582](../../src/preload/index.ts#L582), [src/preload/index.ts:821](../../src/preload/index.ts#L821) |
| `sotto:watcher:open` | [src/preload/index.ts:583](../../src/preload/index.ts#L583) |
| `sotto:watcher:prepare-stop-all` | [src/preload/index.ts:584](../../src/preload/index.ts#L584) |
| `sotto:watcher:read-handover` | [src/preload/index.ts:589](../../src/preload/index.ts#L589) |
| `sotto:watcher:read-machines` | [src/preload/index.ts:593](../../src/preload/index.ts#L593) |
| `sotto:watcher:set-permission` | [src/preload/index.ts:586](../../src/preload/index.ts#L586) |
| `sotto:watcher:start-new` | [src/preload/index.ts:592](../../src/preload/index.ts#L592) |
| `sotto:watcher:stop-all` | [src/preload/index.ts:585](../../src/preload/index.ts#L585) |
| `sotto:watcher:unwatch-thread` | [src/preload/index.ts:588](../../src/preload/index.ts#L588) |
| `sotto:watcher:watch-thread` | [src/preload/index.ts:587](../../src/preload/index.ts#L587) |
| `sotto:widget:drag` | [src/preload/index.ts:793](../../src/preload/index.ts#L793) |
| `sotto:widget:presentation` | [src/preload/index.ts:786](../../src/preload/index.ts#L786) |
| `sotto:widget:publish` | [src/preload/index.ts:689](../../src/preload/index.ts#L689) |
| `themes:export` | [src/preload/themes.ts:27](../../src/preload/themes.ts#L27) |
| `themes:installOpenVsx` | [src/preload/themes.ts:29](../../src/preload/themes.ts#L29) |
| `themes:searchOpenVsx` | [src/preload/themes.ts:28](../../src/preload/themes.ts#L28) |

### Event channels (44 desktop, two visual guest)

| Channel | Preload call site |
| --- | --- |
| `hosts:changed` | [src/preload/index.ts:595](../../src/preload/index.ts#L595) |
| `local-apps:changed` | [src/preload/index.ts:608](../../src/preload/index.ts#L608) |
| `memory:changed` | [src/preload/index.ts:637](../../src/preload/index.ts#L637) |
| `omarchy-setup:changed` | [src/preload/index.ts:616](../../src/preload/index.ts#L616) |
| `omarchy-setup:focus` | [src/preload/index.ts:615](../../src/preload/index.ts#L615) |
| `phones:changed` | [src/preload/index.ts:607](../../src/preload/index.ts#L607) |
| `request-draft:changed` | [src/preload/index.ts:641](../../src/preload/index.ts#L641) |
| `sotto-visual:step` | [src/preload/visual.ts:71](../../src/preload/visual.ts#L71) |
| `sotto-visual:theme` | [src/preload/visual.ts:76](../../src/preload/visual.ts#L76) |
| `sotto:agents:state` | [src/preload/index.ts:392](../../src/preload/index.ts#L392) |
| `sotto:agents:thread-detail` | [src/preload/index.ts:379](../../src/preload/index.ts#L379), [src/preload/index.ts:826](../../src/preload/index.ts#L826) |
| `sotto:app:maximized` | [src/preload/index.ts:732](../../src/preload/index.ts#L732) |
| `sotto:app:window-hidden` | [src/preload/index.ts:733](../../src/preload/index.ts#L733) |
| `sotto:app:window-visible` | [src/preload/index.ts:463](../../src/preload/index.ts#L463) |
| `sotto:browser:event` | [src/preload/tools.ts:72](../../src/preload/tools.ts#L72) |
| `sotto:checks:changed` | [src/preload/index.ts:478](../../src/preload/index.ts#L478) |
| `sotto:cloud-iphone:event` | [src/preload/cloudIphone.ts:34](../../src/preload/cloudIphone.ts#L34) |
| `sotto:council:changed` | [src/preload/index.ts:573](../../src/preload/index.ts#L573) |
| `sotto:delegations:changed` | [src/preload/index.ts:495](../../src/preload/index.ts#L495) |
| `sotto:dictation-keys:held` | [src/preload/index.ts:677](../../src/preload/index.ts#L677) |
| `sotto:dictation-keys:taken` | [src/preload/index.ts:679](../../src/preload/index.ts#L679) |
| `sotto:dictation:command` | [src/preload/index.ts:432](../../src/preload/index.ts#L432) |
| `sotto:git-changes:changed` | [src/preload/tools.ts:84](../../src/preload/tools.ts#L84) |
| `sotto:glass-window:changed` | [src/preload/index.ts:540](../../src/preload/index.ts#L540) |
| `sotto:interface-language:changed` | [src/preload/index.ts:744](../../src/preload/index.ts#L744) |
| `sotto:key-listener:permission-changed` | [src/preload/index.ts:682](../../src/preload/index.ts#L682) |
| `sotto:main-activity:changed` | [src/preload/index.ts:534](../../src/preload/index.ts#L534) |
| `sotto:main-checkout:changed` | [src/preload/index.ts:546](../../src/preload/index.ts#L546) |
| `sotto:next-prompt:changed` | [src/preload/index.ts:556](../../src/preload/index.ts#L556) |
| `sotto:notification:opened` | [src/preload/index.ts:552](../../src/preload/index.ts#L552) |
| `sotto:popup:opened` | [src/preload/index.ts:566](../../src/preload/index.ts#L566) |
| `sotto:popup:shortcut-state-changed` | [src/preload/index.ts:564](../../src/preload/index.ts#L564) |
| `sotto:popup:shown` | [src/preload/index.ts:817](../../src/preload/index.ts#L817) |
| `sotto:popup:thread` | [src/preload/index.ts:827](../../src/preload/index.ts#L827) |
| `sotto:recovery-notice:event` | [src/preload/index.ts:444](../../src/preload/index.ts#L444) |
| `sotto:settings:changed` | [src/preload/index.ts:438](../../src/preload/index.ts#L438), [src/preload/index.ts:823](../../src/preload/index.ts#L823) |
| `sotto:settings:open-requested` | [src/preload/index.ts:718](../../src/preload/index.ts#L718) |
| `sotto:speech-model:status` | [src/preload/index.ts:450](../../src/preload/index.ts#L450) |
| `sotto:subagents:changed` | [src/preload/index.ts:621](../../src/preload/index.ts#L621) |
| `sotto:terminal:event` | [src/preload/tools.ts:52](../../src/preload/tools.ts#L52) |
| `sotto:thread-move:changed` | [src/preload/index.ts:487](../../src/preload/index.ts#L487) |
| `sotto:update:check-requested` | [src/preload/index.ts:717](../../src/preload/index.ts#L717) |
| `sotto:update:status` | [src/preload/index.ts:456](../../src/preload/index.ts#L456) |
| `sotto:watcher:changed` | [src/preload/watcherRoomForwarding.ts:25](../../src/preload/watcherRoomForwarding.ts#L25) |
| `sotto:widget:state` | [src/preload/index.ts:756](../../src/preload/index.ts#L756) |
| `sotto:widget:visibility` | [src/preload/index.ts:762](../../src/preload/index.ts#L762) |

### Visual guest outgoing messages

| Channel | Preload call site |
| --- | --- |
| `sotto-visual:escape` | [src/preload/visual.ts:88](../../src/preload/visual.ts#L88) |
| `sotto-visual:height` | [src/preload/visual.ts:97](../../src/preload/visual.ts#L97) |

