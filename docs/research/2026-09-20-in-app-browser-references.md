# In-app browser references for Sotto

Researched 2026-09-20. Scope: official documentation for five adjacent development products. These are documented capabilities, not a hands-on performance or reliability ranking. The suggested Sotto directions are design inferences, not implementation decisions.

## References worth studying

| Product | Documented pattern | Why it is useful for Sotto |
| --- | --- | --- |
| VS Code | Agent-created tabs use isolated, ephemeral sessions. User-created tabs must be shared explicitly; sharing has a visible indicator and can be revoked. Agents can inspect accessible elements, capture screenshots, interact, read console errors, and use focused Playwright code. | A clear contract for which thread can see or control which page; feedback tied to actual browser state. |
| Cursor | Browser actions appear in chat, with the page available in a pane or separate window. Screenshots, console output and network inspection feed the agent. Sessions persist by workspace. Development-server awareness reduces duplicate launches and guessed ports. | Make the browser part of the agent's work rather than a disconnected preview; treat server discovery and diagnostic context as product features. |
| Windsurf / Devin Desktop | The old Windsurf previews URL currently redirects to Devin Desktop. Previews send selected elements and console errors into the agent's pending prompt. The same workflow serves local, remote and ACP agents. | Provider-independent selection and feedback is especially relevant to Sotto's multiple adapters. |
| Replit | A live browser and cursor expose the agent's testing. Users can take over when it gets stuck; finished runs have a replay with section navigation. Background tests live in their task's view. | Let users see what was checked and intervene without losing task context. |
| Lovable | Browser testing targets the current project preview and version. A Details view shows steps, screenshots, URLs and results. Viewport defaults to the user's preview size. | Keep the result the agent checks aligned with what the user is looking at, and make the check inspectable. |

Sources for each row: [VS Code browser tools](https://code.visualstudio.com/docs/agents/run/browser-tools), [Cursor Browser](https://cursor.com/docs/agent/tools/browser), [Devin Desktop Previews](https://docs.devin.ai/desktop/previews), [Replit App Testing](https://docs.replit.com/features/agent/app-testing), [Lovable browser testing](https://docs.lovable.dev/features/browser-testing).

## Details that matter

**VS Code: feedback and browser fundamentals.** Its toolbar attaches selected elements with HTML/CSS and optional screenshots, associates comments with multiple elements, captures viewport or area screenshots, and attaches console output. Full-page capture is experimental. Tabs can live beside the editor or in a separate window. Storage can be global, workspace-scoped or ephemeral. Localhost links open in the integrated browser by default. These are useful interaction references, not a recommendation to reproduce all of VS Code's controls. [Integrated browser](https://code.visualstudio.com/docs/debugtest/integrated-browser)

**Cursor: observability with bounded context.** Browser logs can be selectively read from files rather than repeatedly fed wholesale into model context. Network traffic inspection is documented as available in the Agent panel, with layout support forthcoming. Tool approval is separate from browser existence. Its origin allowlist is explicitly best-effort: redirects, link navigation and script navigation have exceptions. Sotto should not treat a navigation allowlist as a complete action or data boundary. [Browser](https://cursor.com/docs/agent/tools/browser)

**Replit: separate ordinary preview from testing evidence.** Preview offers device-size presets, Devtools, back/forward, an address/path field and external opening. Its Devtools expose console, elements, network and resources. [Preview](https://docs.replit.com/features/editor/preview) App Testing currently documents Full Stack JavaScript and Streamlit support; its stronger reliability and quality claims are vendor claims, not benchmark evidence. [App Testing](https://docs.replit.com/features/agent/app-testing)

**Lovable: useful limits to surface.** Its documentation says subtle design/color judgments are unreliable, canvas tools are unsupported, and drag/drop, clipboard and custom uploads may be unreliable. It also distinguishes backend-supported authenticated testing from external authentication providers. This supports reporting individual tested journeys and explicit gaps rather than a blanket "verified" badge. [Browser testing](https://docs.lovable.dev/features/browser-testing)

## Visual references

- [VS Code integrated browser screenshot](https://code.visualstudio.com/assets/docs/debugtest/integrated-browser/integrated-browser.png)
- [VS Code Share with Agent screenshot](https://code.visualstudio.com/assets/docs/debugtest/integrated-browser/share-with-agent.png)
- [Replit Preview screenshot and toolbar reference](https://docs.replit.com/features/editor/preview)
- [Replit takeover and replay screenshots](https://docs.replit.com/features/agent/app-testing#take-over)
- [Lovable browser-testing example](https://docs.lovable.dev/features/browser-testing#example-manually-trigger-browser-testing)

These are first-party reference images/pages, not captures from locally exercised product installations. The web reader could open the VS Code image URLs; Replit/Lovable image CDN clicks failed, so their source pages are linked instead.

## Current Sotto baseline

The parallel source audit found that Sotto already uses a real Electron `WebContentsView`, with HTTP(S) navigation and workspace-isolated, in-memory sessions. It allows up to 32 pages globally. New-window requests, downloads and device permissions are blocked. These restrictions are plausible causes for particular browsing flows failing, but no affected user journey was reproduced. [Browser service](../../src/main/tools/browser.ts)

The current bridge covers listing, creating, navigating, history, reloading, closing, mounting and opening links. The audit found no agent-facing screenshot, element inspection, interaction, console or network integration on that bridge. This is the clearest capability gap relative to these references. [Browser bridge](../../src/shared/browser.ts) The native page is detached when surrounding menus/dialogs need to cover it. [Browser surface](../../src/renderer/src/tools/BrowserSurface.tsx)

The parent agent inspected the committed [1280x800 dark browser capture](../../artifacts/tools-sidecar/browser-1280x800-dark.png): workspace heading, tool selector, page tabs and navigation occupy four chrome rows. Sotto already has an expanded tools-panel action; improving space should start with reducing repeated chrome and refining that existing expanded view. [Tools panel](../../src/renderer/src/tools/ToolsPanel.tsx)

Live inspection was blocked because the computer-use runtime failed to start while applying deny-read ACLs. These findings describe source behavior and a committed capture, not a usability test of the running app.

## Brainstorming directions for Sotto

The following are proposals to discuss after inspecting Sotto's current browser and existing permission rules.

1. **A shared result beside the conversation.** Opening a preview should leave a usable result in the thread, with its address, page title and server status. Expand or detach it when screen space is tight. The page should remain discoverable after the agent finishes.
2. **Point and ask.** A user selects an element or region and adds a comment. Sotto attaches a compact screenshot plus relevant page/element context to the current draft; the user controls submission. Voice could naturally refer to the selected thing without needing guessed coordinates.
3. **Show and check are different actions.** Showing a local prototype or generated report should be straightforward. Checking a flow adds observation and interaction tools under the thread's policy. Merely displaying a page should not silently grant broad access to authenticated browsing.
4. **An inspectable verification run.** An agent identifies the actual running server, opens the intended app/version, reads accessible state, follows a specified journey, examines screenshots and relevant errors, then repeats after fixes. The result states what passed, failed or was not checked and links to evidence. Begin with selected screenshots and a small step log; full video can wait until it earns its storage and privacy cost.
5. **Stable viewport and theme checks.** Provide a few useful size presets and precise dimensions. Distinguish the browser viewport from the surrounding Sotto window size. Record viewport and relevant theme state with evidence.
6. **One browser contract across providers.** Sotto owns tab IDs, thread association, lifecycle and policy decisions; adapters expose the same capabilities to their agents. Reuse existing tabs deliberately and refuse ambiguous targeting. Avoid each provider launching a hidden, disconnected browser by default.
7. **Clear human control.** Make the controlling thread visible. Let the user pause automation, interact, and resume it. Browser sharing and action authority must remain separate, following Sotto policy records rather than an agent's own approval statement.

Suggested first discussion: what currently hurts most (browsing reliability, cramped presentation, sending context, or agents failing to inspect the result), whether pages should persist per thread or per project, and how often authenticated external sites matter compared with local app previews.

## Boundaries and open questions

- This study establishes capabilities and promising patterns, not that all five products have excellent everyday reliability.
- A browser can validate web content, but cannot by itself verify Sotto's native window, tray, floating widget or Electron permission surfaces. Those still need appropriate app-level checks.
- Provider tool availability and permissions need verification against Sotto's actual adapters before choosing a protocol.
- Saving browser logs, DOM, requests or recordings needs a scoped retention design: pages can contain prompts, transcripts, credentials and personal data. Copying another product's file-log behavior verbatim would not establish compliance with Sotto's privacy rules.
- Implementation, new approval behavior and UI choices remain undecided. This note does not authorize a build or publish.
