# How agents reach Sotto's browser and their own tools

An audit of three reports from Zach, compared with T3 Code, and a plan to fix them. Audited on `origin/main` at `02e9185a`; T3 Code read at `pingdotgg/t3code@e5a46d6c`. Line numbers are from those commits.

1. The browser shows in threads other than the one that opened it.
2. Every time an agent opens the browser it asks for permission.
3. Codex can use Computer Use in T3 Code but not in Sotto.

## What T3 Code does

T3 Code gives agents tools in two ways, and keeps them apart.

**Its own tools go through one MCP server.** T3 runs an authenticated HTTP MCP server, `t3-code`, in its own process (`apps/server/src/mcp/McpHttpServer.ts`). Its browser toolkit has fourteen `preview_*` tools (`toolkits/preview/tools.ts`). Codex gets the server through two `-c mcp_servers.t3-code.*` launch overrides, with the bearer token in the child's environment (`CodexAdapter.ts:2300-2312`). Claude gets it through `mcpServers` (`ClaudeAdapter.ts:4955-4965`). This is the same shape as Sotto's `sotto_browser` endpoint (ADR-0020), so the transport is not where the two apps differ.

**The browser belongs to the thread.** Each token is scoped to a thread (`McpInvocationContext.ts:12-20`). When an agent opens a page, the renderer finds or creates that thread's tab and opens a floating mini player for that thread (`PreviewAutomationHosts.tsx:435-545`). The mini player store is keyed by thread (`previewMiniPlayerStore.ts:33`), so moving to another thread shows that thread's browser or none. Whether the mini player pops up on its own is a user setting, `browserAutoShowFloatingPreview` (`browserDefaults.ts:37,55`). This is the side panel Zach remembers seeing appear while an agent worked.

**Codex's own tools are left alone.** T3 does nothing to turn Computer Use on. It passes the user's own `CODEX_HOME` and environment through, advertises `experimentalApi`, and draws Computer Use calls with their own titles and icon (`CodexAdapter.ts:389-417`, `:683-730`). When Codex asks "Allow ChatGPT to use <app>?" (an MCP elicitation) or sends `item/permissions/requestApproval`, T3 shows it to the user with Approve, Always allow this session and Always allow (`CodexSessionRuntime.ts:365-445`, `:2283-2340`).

**Approvals follow a runtime mode, and full access is T3's default.** Full access allows everything on Claude (`ClaudeAdapter.ts:4704-4711`) and maps to `never` / `danger-full-access` on Codex (`CodexSessionRuntime.ts:515-548`). T3 does not pre-approve its own `preview_*` tools; outside full access, each call is a request to the user.

## 1. The browser follows you into other threads

The first fix (#232, `e11a36d0`) changed only the corner preview, and kept an exception for the pinned thread. The pin that exception relies on is set without the user asking for it and is never cleared.

- **Opening a preview pins the whole Tools panel.** `showBrowserTask` sets `pinnedThreadId` to the task's thread (`src/renderer/src/tools/toolsPanelStore.ts:91-97`). Nothing unpins it: not a focus change, not the task ending, not closing the panel (`setOpen`, `:55`). `showPullRequest` does the same (`:101-105`).
- **The Tools panel is one panel for the window.** It is rendered once (`ThreadsView.tsx:225`, `ThreadWorkspace.tsx:34`) and shows `pinnedThreadId ?? focusedThreadId` (`toolsPanelStore.ts:129-131`). After one click on a preview, every thread shows the first thread's Browser. Its page is a native `WebContentsView` drawn above the whole window (`src/main/tools/browser.ts:33`, `:227-246`).
- **The preview shows for the pinned thread as well as the focused one** (`BrowserTaskPreview.tsx:24`). It sits against the *focused* pane's composer (`:30`), so thread A's preview floats over thread B's composer.
- **The Tools dot lights for the pinned thread in every pane** (`ToolsPanel.tsx:112-115`), against its own comment at `:87-92`. (Suspected; the tests never pin.)
- **The tests guard the bug.** `tests/unit/renderer/tools/browserReview.test.tsx:34-54` asserts the auto-pin and that a pin shows another thread's preview.

Main does know which thread is calling: the endpoint binds a bearer token to one thread (`browserAgentServer.ts:28-44`, `:74`, `:106`). The leak is in the renderer.

**Repro.** An agent in thread A opens a page. Click the corner preview. Focus thread B. Tools still shows A's page, and A's preview floats over B's composer.

## 2. Asking every time

An agent opening a page can meet two separate questions.

**(a) The provider's own tool prompt.** ADR-0020's September 21 amendment tried to switch it off for `sotto_browser` only: `--allowedTools` for each tool on Claude (`claude.ts:82-84`, `:588-591`), `default_tools_approval_mode = "auto"` on Codex (`browserAgentServer.ts:114-123`), and `--allow 'MCPTool(sotto_browser__*)'` on Grok (`grok.ts:56-62`). None of the three was shown to work at the time. Step 0 (`docs/verification/2026-09-25-browser-prompts-and-computer-use.md`) has now checked each with real turns. Claude's flag works in both modes tried. Codex prompts in both modes, because `auto` does not mean "never ask"; `approve` does, and it removed the prompt in both modes. Grok prompts in its default approval-required mode, where its `--allow` rule has no effect. The only choices offered are Allow once and Deny (`claudeRequests.ts:38`, `codexRequests.ts:88`).

**(b) Sotto's browser question in Tools (ADR-0020).** `requestAction` holds `navigate`, `click` and `type` for a one-time answer (`src/main/tools/browser.ts:474-497`). **Allow this thread to open pages** (#232, `browserGrants.ts`) removes the question for opens and navigations, but only after one answer per thread, only until Sotto closes, and never for clicks or typing.

So on Codex and Grok one open asks twice: a native prompt in the thread, then the question in Tools. On Claude it asks once, in Tools. No setting says "always".

## 3. Codex and Computer Use

Sotto does not remove Computer Use. With Sotto's exact arguments, environment and the user's `CODEX_HOME`, `codex app-server` still reports the `computer-use` skill enabled, `computer_use` stable and on, and the `node_repl` and `cua_repl` MCP servers with their tools. Sotto's per-thread `mcp_servers` override merges with the user's servers instead of replacing them. Step 0 ran the call itself (`docs/verification/2026-09-25-browser-prompts-and-computer-use.md`), and it corrected the first reading of the code:

1. **Sotto's sandbox is what breaks it.** In Sotto's default Codex mode (`auto-accept-edits`: `on-request`, `workspace-write`), the Computer Use process dies ("trusted Node process exited unexpectedly", or "windows sandbox failed: apply deny-read ACLs"). In Full access (`never`, `danger-full-access`) it runs. `codex.ts:47-48` sets that policy on the process, and each turn sets the thread's mode again (`codex.ts:41-46`, `:538-541`, `:811-814`, `:986-989`). The user's own Codex config says `never` / `danger-full-access`, and T3 starts threads in Full access, which is why it worked there.
2. **It also needs the Codex desktop app running.** Desktop control goes through the `computer-use` skill, the `node_repl` server in the user's global Codex config (`@oai/sky`), and a helper the Codex desktop app starts, which serves a named pipe. With the app closed, Full access fails with "native pipe is unavailable". With it open, a Sotto Codex thread in Full access listed the open desktop apps. The app is only needed because the global config tells `node_repl` to use its pipe (`SKY_CUA_NATIVE_PIPE=1`): with that set to `0`, Codex's own library starts its own helper, and plain `codex exec` listed the open apps with the Codex app fully closed. (A second server, `cua_repl`, has only its browser surface on. The model picks it if merely asked to "use Computer Use", and that is where "Native computer APIs are disabled" came from.)
3. **Not the cause, still worth fixing.** Codex sent no approval request in any run, so Sotto's handling of them did not stop Computer Use this time. It will fail once one does come: Sotto refuses any non-form elicitation (`codexRequests.ts:126`) and throws on a plain Allow for `item/permissions/requestApproval` (`:120`). T3 relays both. Passing the whole environment through made no difference, so the allow-list in `nativeEnvironment()` (`subscriptionCodex.ts:52-58`) is not the cause either.
4. **Computer Use calls draw as generic MCP calls.** T3 recognises `_meta["codex/toolSurface"].kind === "computerUse"` and gives them titles and an icon. This is presentation, not a cause.

Claude Code and Grok have no matching problem. Claude loads the user's MCP servers, settings and plugins (no `--strict-mcp-config`, no `settingSources` override). Grok's environment forces `GROK_DEFAULT_SELECTED_PERMISSION=reject` and `GROK_REMEMBER_TOOL_APPROVALS=0` (`grokRpc.ts:19-23`), so it never remembers an approval.

## Plan

Each step is its own PR from `main`, in this order. Zach's decisions are recorded at the end. Step 1 waits for his pick among the floating-player prototypes; step 3 waits for the ADR it needs.

### Step 0. Prove which prompts appear (done September 25, 2026)

Two opt-in live tests, run through Sotto's own adapters with real, paid model turns: the `SOTTO_BROWSER_TURN_LIVE` case in `tests/integration/browserProvidersLive.test.ts`, and `tests/integration/codexComputerUseLive.test.ts`. The results are in `docs/verification/2026-09-25-browser-prompts-and-computer-use.md`, and the sections above now follow them. In short: Claude no longer asks before Sotto's browser tools; Codex and Grok (in its default mode) still do; and Codex's full Computer Use works from Sotto when the thread is in Full access and the Codex desktop app is running, and dies in Sotto's default sandbox.

### Step 1. Give each thread its own floating browser (`feat/thread-browser-player`)

Zach picked a T3-style floating player per thread over mending the corner preview. The layout is not settled, so it starts as HTML prototypes with variants, and Zach's pick is recorded here before any code.

Prototype: `docs/prototypes/thread-browser-player-prototype.html` on the `prototype/thread-browser-player` branch (not in `main`), with `?variant=a` (floating player), `b` (pane split) and `c` (strip + stage). Run `node docs/prototypes/composer-selectors-serve.mjs` and open `http://127.0.0.1:4173/docs/prototypes/thread-browser-player-prototype.html?variant=a`. Checked in headless Chromium at 1280x800 (dark) and 820x560 (light) for all three: no script errors, no control outside the window, and a thread's player is never drawn in another thread. **Pick (Zach, September 25, 2026): variant a, the floating player, made smaller and movable anywhere in Sotto.** The prototype now carries that version:

- It starts at 340x250 above the composer and resizes from its bottom-right corner down to 280x200.
- Drag its title bar anywhere in the window, over the sidebar and Tools included. It stays inside the window and below the drag strip, so the strip's controls and the window buttons stay reachable. With the title bar focused, the arrow keys move it (Shift for bigger steps).
- There is one spot for every thread. The page is the thread's, but where the player sits is the user's choice, so switching threads does not move it. Shrink turns it into a pill at the same corner.
- A waiting request shows compactly inside the player ("Wants to type “Olympic” in Search." with Allow once, Allow this thread and Deny) and keeps a strip of the page in view.

Checked in headless Chromium: the default size and spot, dragging, stopping at the window edge, arrow-key moves with focus kept on the title bar, the resize minimum, no player in a thread that has no page, the new thread's player opening in the same spot, the pill's position, and no script errors.

- **Thread-keyed state, one placement.** A player store keyed by Sotto thread ID, like T3's `previewMiniPlayerStore`, holds open, shrunk, hidden or docked. Position and size are one placement for the whole window, kept in the renderer's settings so it survives a restart. It replaces the corner preview. The focused thread's player is drawn and no other.
- **The player floats over the window, not the pane.** It is placed in window coordinates above every surface except the drag strip, and moves back inside when the window shrinks. The native `WebContentsView` follows its rectangle while it is dragged or resized.
- **It opens when the agent opens a page.** When a thread's agent opens a page, that thread's player opens. If the thread is not focused, it waits there until the user goes to it. A setting, **Show the browser when an agent opens a page** (on by default), turns this off, the way T3's `browserAutoShowFloatingPreview` does. It replaces **Show browser previews**, and a saved value carries over.
- **Docked is Tools > Browser.** Docking moves the page into Tools > Browser for that thread; undocking brings it back to the player. Opening Browser never pins Tools. Only the pin control pins.
- **One native view, moved rather than copied.** Main keeps one `WebContentsView` for each page and mounts it in whichever rectangle currently shows it (`browser.ts:227-246`). A player for an unfocused thread draws nothing, so no page is ever drawn over another thread.
- **Fixes that apply whatever the layout.** The Tools dot counts only the pane's own thread (`ToolsPanel.tsx:112-115`). `showBrowserPage` for a thread that is not focused says where the page went. Flip `browserReview.test.tsx:34-54`.
- **Tests.** Unit tests for the store rules. A Playwright spec: an agent in thread A opens a page, the player shows over A; focus B, and neither A's page nor its player is drawn; go back to A and it returns. Keyboard: the player's controls have names, Escape closes it, and focus returns to the composer.
- **Docs.** Amend ADR-0020 (the corner preview and pinning); a new `CONTEXT.md` entry for the player, replacing **Browser preview**; `README.md` and `docs/guide.md`. Design captures at the three window sizes, in light, dark and reduced motion.

### Step 2. Remove the provider's prompt for Sotto's own browser tools (`fix/browser-tools-ask-once`, done September 25, 2026)

ADR-0020 already says (a) was never the gate; this step makes that true for the two clients step 0 caught.

- **Claude: nothing to do.** `--allowedTools` works (step 0).
- **Codex: one word.** `default_tools_approval_mode: 'approve'` in place of `'auto'` in `browserCodexConfig` (`browserAgentServer.ts:120`). Step 0 showed this removes the prompt in the default and approval-required modes. Update `browserProviders.test.ts:45`, `browserAdmissionArguments.test.ts:26` and the comment. It stays scoped to the `sotto_browser` entry Sotto writes for that thread, with no global Codex config changed.
- **Grok: answer its request for Sotto's own server.** The `--allow` rule does nothing in approval-required mode. When Grok asks permission for a `sotto_browser__*` tool (the `use_tool` wrapper `grokRequests.ts:19` already recognises), the adapter allows it without showing a request. Every other Grok request still reaches the user. Before writing that, check whether Grok's ACP `session/new` accepts a scoped allow rule, which would be cleaner. Drop the inert `--allow` flag either way.
- **Is the Grok change answering on the user's behalf?** No, and the ADR-0020 amendment must say why before the branch, as AGENTS.md requires. The prompt only lets the agent reach Sotto's own thread-bound endpoint. Every open, navigation, click and typed entry is still governed by Sotto's own question in Tools, or by the grant step 3 adds.
- Narrow `browserRequests.ts` to what can still reach a user, if anything.
- **Tests.** Fixture tests: Grok's request for `sotto_browser` is answered without a pending request; the same request for any other tool still reaches the user. Re-run `SOTTO_BROWSER_TURN_LIVE=1` and expect "reached the tool without a native prompt" in all six cases.

### Step 3. Let a thread use the browser without asking, by default (`feat/browser-thread-standing-grant`)

Zach picked: the grant covers everything (opening, navigating, clicking and typing), it is per thread, and it is on by default.

- **This changes a rule, so the ADR comes first.** AGENTS.md says the user answers every permission. A grant that exists before the user has said anything is not the user's answer. The change needs a new ADR that supersedes ADR-0020's approval paragraphs and its #232 amendment, a note in ADR-0004, and an edit to AGENTS.md's "The user answers every permission" line naming the browser exception. That ADR is written and accepted before the branch.
- **The shape.** A setting, **Let agents use the browser without asking** (on by default), in `src/shared/settings.ts` plus the patch allow-list in `registerIpc.ts`. While it is on, each thread starts with a browser grant for open, navigate, click and type. `PageOpeningGrants` (`browserGrants.ts`) widens to cover every action, and `requestAction` (`browser.ts:474-497`) checks it for all three held actions, not only `navigate`.
- **The user can still stop it.** Stop for one thread in Tools > Browser and in that thread's player. That thread asks again until the user allows it again or Sotto restarts. The setting turns it off for every thread. A request that is still asking offers **Allow this thread to use the browser** beside Allow once.
- **Kept whatever the setting says.** A page the user opened stays private until they share it. The endpoint still binds one thread. Supervision, memory and a provider's own confirmation still never grant anything. A waiting action whose page has changed still does not run.
- **Say what agents can do.** Settings and the first browser task in a thread say plainly that the agent can click and type in pages it opens. README "Privacy and cost" and `docs/guide.md` too, since pages an agent opens may be signed in.
- **Tests.** The default grant covers clicks and typing; Stop and the setting both return a thread to asking; a user-opened page is never made observable by the grant; the IPC allow-list test covers the new setting.

### Step 4. Let Codex use its own tools (`fix/codex-native-tools`)

Step 0 moved the weight of this step. The default stays `auto-accept-edits` (Zach's decision), so the work is making the Full access route plain and the failure honest.

- **Say why it failed, and what to do.** When a Codex Computer Use call (`node_repl` or `cua_repl`, or a call Codex marks `codex/toolSurface` `computerUse`) fails, the thread says which of the two conditions is missing, in plain words. In a sandboxed mode: "Computer Use can't run in this thread's sandbox. Nothing was changed. Switch the thread to Full access to use it." With the pipe missing: "Computer Use needs the Codex app open. Nothing was changed. Open Codex and ask again." Sotto neither switches the mode nor starts the Codex app itself.
- **Sotto needs the Codex app open, as T3 does (Zach, September 25, 2026).** Sotto leaves Codex's configuration alone and says "Open the Codex app" when the pipe is missing. T3's own logs show it hitting the same error with the app closed. The alternative was writing `mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE = "0"` into each Codex thread's config, so Codex's library starts its own helper. That works with the app closed, but it relies on an internal, undocumented switch, may skip the app's per-app questions, and would need an ADR.
- **First check for something narrower than Full access.** Look for a Codex setting that lets the Computer Use process run under `workspace-write` (a sandbox exemption for one MCP server, or a writable root it needs). If one exists and is scoped to that server, prefer it, and re-run `SOTTO_CODEX_COMPUTER_USE_LIVE=1` to prove it.
- **Relay Codex's app-access questions for when they come.** Map non-form elicitations and `item/permissions/requestApproval` to Sotto permission cards with every choice Codex offers, instead of refusing (`codexRequests.ts:126`) or throwing (`:120`). The user answers each one; Sotto grants nothing itself.
- **Stop overriding the policy at the process level.** Drop `approval_policy` and `sandbox_mode` from `configArguments` (`codex.ts:47-48`), since each thread's runtime mode already sets them on start, resume and every turn. This is tidying, not the fix.
- **Show Computer Use as itself.** Recognise `codex/toolSurface` `computerUse` and `browserUse` in the Codex activity mapping and give them plain titles.
- **Say what it needs.** README and `docs/guide.md`: Codex's Computer Use works in a Sotto thread set to Full access while the Codex desktop app is open. It can then see and operate every app on the computer, so Full access means exactly that.
- **Dropped:** widening `nativeEnvironment()`. Step 0 showed it changes nothing for Computer Use. `PATHEXT` for `cmd`-launched MCP servers is a separate question and needs its own evidence first.
- **Tests.** Fake Codex integration tests: a non-form elicitation reaches the user and returns the chosen action; an allow on `item/permissions/requestApproval` returns the requested permissions; a failed Computer Use call in a sandboxed mode gets the plain message. A live re-run in Full access for the verification note.

## Decisions (Zach, September 25, 2026)

1. **Browser scope:** a T3-style floating player for each thread, shown only in its own thread. The layout is still to be picked from prototypes.
2. **How far the grant reaches:** everything (open, navigate, click and type), per thread.
3. **Default:** on. This is an exception to "the user answers every permission", so it lands through an ADR and an AGENTS.md edit before any code (step 3).
4. **Codex's default runtime mode:** stays `auto-accept-edits`. Step 0 then showed Computer Use needs Full access and the Codex desktop app open (or a narrower Codex setting, if one exists), so step 4 makes that plain in the thread rather than widening the default.
