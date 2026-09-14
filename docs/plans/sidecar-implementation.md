# Sidecar implementation

Selected by Zach: prototype A, Sidecar. A working tool dock beside the conversation; opening Browser proves it by giving the real page most of the available surface.

Alternatives already reviewed: right dock (selected), bottom Workbench, main-canvas Studio. Target: Windows desktop, 1600x1000, 1280x800, 820x560; pointer/keyboard and reduced motion.

Acceptance:
- Match selected A screenshots in sibling tools-redesigns worktree: generous ~56% dock, one project/branch context row above labeled Browser/Terminal/Files/Changes tabs. Long paths move to accessible descriptions/tooltips and copy/reveal actions. Pinned ownership remains explicit.
- Retain real services, sessions, per-thread state, focus return, pinning and existing recoverable errors. Collapsed rail reopens directly on a tool; focus expansion uses the workspace and restores prior width.
- Typography uses Sotto fonts/themes, controls >=14px, metadata >=12px, code >=13px. Compact launch rail has 12px labels. Existing thread chat is out of styling scope.
- Content leads: page/code/terminal own remaining height. No invented slogans or explanatory panel headings. Essential context, control labels, selected filenames, code and operational status are necessary content; don't repeat thread title or full path in stacked header rows.
- Keep existing ~160ms dock entrance; native browser bounds must settle to actual viewport. Reduced motion removes animation; resize controls support keyboard.
- Review four populated tools in actual Electron, normal/minimum desktop widths, light/dark, focus/restore/reopen and native browser placement. Run relevant tools unit tests and typecheck. Record visual findings in docs/verification/tools-sidecar.md.

Implementation state: isolated feat/tools-sidecar worktree; surface builder and independent Electron verifier alongside root panel/state integration. No prototype code or mock data enters production. No release/push requested for this selection. At windows below 950px, opening Tools hides project navigation so conversation and dock remain side by side; closing restores the mounted sidebar.


Completion: selected composition implemented with real tools; final native Electron journey passed all four tools at three sizes and both appearances, focus/restore/rail reopen/pin, keyboard resize, sidebar restoration, native placement and reduced-motion checks. 48 focused unit tests passed across ToolsPanel and four surface suites; full TypeScript and scoped ESLint passed. Root inspected final integrated images and independent surface review found no material blockers. See docs/verification/tools-sidecar.md for observations, copy count, responsive tradeoffs and 28 screenshots. Saved on feat/tools-sidecar, not merged, pushed or packaged for installation.
