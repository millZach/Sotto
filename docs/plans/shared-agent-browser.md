# Shared agent browser implementation

Status: implementation in progress on feat/agent-browser. User authorized implementation with subagents on 2026-09-21. Selected design: variant A on local prototype/browser-corner-preview (8db0c284); see browser-corner-preview-prototype.md and ../research/2026-09-20-in-app-browser-references.md. Baseline: d0fbf3e8f5babc3eacf24039df6c11b4cdafdb4f.

## Deliverables and acceptance

- [x] Browser stays in Tools; corner page thumbnail shows real browser activity, current action and owning thread. Click opens the same page/state in Tools without changing the active conversation. Pause and dismiss differ; completed/failed evidence can reopen.
- [x] Native providers discover one Sotto browser tool contract with thread-bound access. Exercise real fixture tool calls, and clearly distinguish fixture versus live-provider verification.
- [x] Open the intended HTTP(S) app/page, inspect elements, interact, scroll, capture screenshots, inspect bounded console/network errors, set exact viewport dimensions. No replacement browser process or guessing another thread's server.
- [x] User can share/revoke observation; browser interaction requests require one-time user answers. Reject cross-thread access, stale approvals, paused actions, revoked pages and attempts to approve through agent tools.
- [x] Select an element/region and add a comment/screenshot to that thread's draft; never auto-send. Browser feedback works regardless of provider, with existing image capability limits made explicit.
- [x] Verification records actual steps, screenshot evidence, viewport, outcomes and unchecked cases; never infer a pass from a page merely loading. Failed/revoked/closed states remain understandable.
- [x] Keep page data, raw diagnostics and access tokens out of operational logs. No new production dependency. ADR0020 records transport, privacy and the verified Devin compatibility limitation.
- [x] Update README, CONTEXT, agent-control docs, verification notes. Keep throwaway variants on prototype branch.
- [x] Typecheck, lint, two-worker unit/integration suite, notices, relevant real Electron Playwright journeys; independent standards and spec review and fixes.

## Design checks (tastify)

Desktop app only. Preserve Sotto's Figtree, quiet theme-token surfaces and the approved A page-first composition. Preview copy purposes: owner, current action, open, pause/resume and dismiss; status/permission/evidence text only when needed. No blanket verified badge. New controls at least 14px, secondary labels at least 12px, text contrast 4.5:1.

Observe first use, running/paused/finished/failed, pending permission, selection draft, revoke and pinned Tools interactions. Inspect 1600x1000, 1280x800 and 820x560 in light/dark and reduced motion; no clipped controls. Keyboard focus follows the visual path; Escape exits selection/expanded surfaces; opening Tools returns focus predictably. Native pages must step aside only where necessary for app controls and permission surfaces.

## Ownership

- Root: main/preload/IPC integration, docs, full verification and independent reviews.
- browser_host: shared schema, BrowserService/CDP helpers, host unit checks.
- browser_providers: provider tools and transport, adapter-bound identity, native protocol tests.
- browser_ui: renderer/store/preview/selection drafts and renderer checks.

## Current state and gaps

Host, renderer, preload and provider adapters are integrated. Native tool discovery passed for Codex, Claude Code and Grok; the pinned Devin ACP client ignored its supplied MCP server, so Devin browser tools remain unavailable. The review corrections landed, and the real Electron journey and the full gates passed on September 21; see ../verification/2026-09-21-agent-browser.md. Remaining outside this branch: Apple silicon verification and a live model-driven journey.