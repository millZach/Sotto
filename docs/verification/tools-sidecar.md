# Sidecar tools verification

**Superseded, 2026-09-22.** The Tools panel was rebuilt around the rail the owner picked in #235: the surfaces moved from the tab row onto a strip at the panel's outer edge, the context row became the working-copy footer, and pin, expand and close moved to the rail's foot. `tests/e2e/tools-sidecar.spec.ts` now proves that composition, and `docs/verification/tools-rail.md` is its record. The behaviour promised below (overlay below a readable pane width, Escape, pinning, expand, keyboard resize and the 950-pixel rule) carries over; the header, tab and class names it describes do not.

Selected reference: prototype A, Sidecar, in the sibling `tools-redesigns` worktree. The accepted composition keeps the conversation alongside a generous right dock, with compact project context, four labeled tool tabs, quieter browser chrome and room for the actual working content.

## Scope and method

`tests/e2e/tools-sidecar.spec.ts` launches the built application in Electron with disposable provider fixtures and an owned temporary profile. The browser, PTY, files and Git services are production implementations. No user working copy or terminal is used.

Run from the Sidecar worktree:

```powershell
npm run build
npx playwright test tests/e2e/tools-sidecar.spec.ts --workers=1
```

The existing dependency junction is sufficient; no native package rebuild or package installation is part of this check. Build output remains in this worktree. The main checkout's dev watcher and binaries are not changed.

## Acceptance

- Browser, Terminal, Files and Changes contain real populated working states at 1280 × 800, 1600 × 1000 and 820 × 560, in light and dark appearances.
- A local responsive page is interactive in the native browser; its bounds match the renderer viewport and it cannot access the app bridge or Node require.
- Native content leaves the host while another tool is visible or the dock is closed, then returns with the retained page.
- A real PTY command runs in the owned thread folder and output survives tool switches, resize, theme changes and dock close/reopen.
- File preview and Git diff selection remain intact while switching tools.
- Expansion, restoration, pin/unpin and close/reopen remain reachable.
- Screenshots include native browser pixels using Electron's window capture, rather than an empty renderer placeholder.
- No renderer page errors or horizontal document overflow.

## Results

Passed on Windows on 2026-09-13 against the final Sidecar build:

- `npm run build` passed. Existing lucide module-directive warnings are unchanged.
- `npx playwright test tests/e2e/tools-sidecar.spec.ts --workers=1`: **1 passed**, 21.9 seconds. This single journey covers all four populated tools at all three sizes and both appearances, plus split diff, native expansion/restoration, keyboard resize, pin/unpin, closed-rail reopening and retained terminal output.
- Reduced motion was checked after closing and reopening the terminal: the actual sheet has `animation-name: none` and zero running animations.
- Browser bounds matched the actual viewport in every captured state. The native page's button changed its content, and both `window.sotto` and `require` were undefined inside it.
- At 820 pixels the project sidebar hides while Tools is open, leaving the conversation alongside the dock. Closing restores the project sidebar; reopening hides it again.
- No renderer page errors and no horizontal document overflow.

Evidence is in `artifacts/tools-sidecar/`: **24** tool/size/appearance images plus **4** expanded, split and collapsed images. Native browser screenshots include the actual composed window. `layout.json` records the 24 measured dock and native viewport bounds. Earlier failure captures were removed after the passing final run.

## Rendered review

Both the implementation owner and verification agent inspected the rendered screenshots. The 820-pixel browser, terminal, file preview and diff retain reachable tabs and operating controls beside readable conversation/composer content. File and diff navigation stack above their content at the minimum size; the selected file remains visible. At 1280 and 1600 they use side-by-side navigation and content. Native webpages scroll within their own viewport. Long split-diff lines wrap; expanding the dock gives that optional view more room. No material visual gap remains in the inspected states.

The header uses two factual context elements (project and working copy), four tool labels, and five operating actions (pin, focus, close, copy path, reveal); Files additionally exposes refresh. There is no extra headline or explanatory block. Selected filename, file size, read-only state and working status provide essential context. Redundant raw diff file headers were removed. Page content inside the native browser belongs to the website rather than Sotto's interface copy.

## Practical limits

This verifies the Windows desktop implementation using fixture coding providers, a real local webpage and owned working files. It does not exercise a live external provider account, external authenticated websites, or macOS. The test uses Electron's supported capture APIs; it does not change the user's existing app instance or install/package a release.
