# Give thread rows context and a resizable sidebar

Zach chose prototype A on September 19, 2026: project folders, title and time first, provider/status beneath, branch and model context at wider widths. Keep every existing symbol; specifically preserve the Lucide Settings gear. The prototype's hand-drawn icons are rejected.

Acceptance checks:
- Desktop Electron, existing Figtree and theme roles. Keep the existing project groups, status rings, controls, sidebar foot and navigation. No new provider calls, permissions or data collection.
- 320px default, 260–480px expanded width capped to preserve 470px for the room. Pointer and keyboard resizing, double-click reset, collapse/restore with saved width. Small rail retains access to threads and existing navigation icons. macOS reserves native traffic-light space.
- Title/time and provider/status remain legible at every width; the existing row-action icons temporarily occupy the bottom detail line on hover or keyboard focus, with the complete facts retained in the accessible description; additional model/working-copy context appears as width allows. Missing branch metadata never invents a branch. Failed/pending worktree state is distinguished from a usable folder.
- Reuse existing icons and data-backed actions: open, open beside, rename, regenerate, settle/restore, search, projects, terminal mode. Do not copy prototype controls or fake thread data into production.
- Inspect dark/light/reduced motion at 1600x1000, 1280x800, 820x560. Text 4.5:1, row titles 14px, metadata 12px; theme tokens only. Essential thread facts and operating labels deliberately exceed the generic five-text-element landing-page limit. No slogans or added explanatory paragraphs.
- Primary interaction: drag the divider and gain contextual information while the room stays usable. Collapse/restore may animate; direct resizing follows the pointer; reduced motion removes transitions.
- Validate unit/integration gates, relevant Electron journeys, and independent standards/spec review. Update README/domain notes, keep screenshots and a verification note, and retain the prototype as a source on its own branch.

Checklist:
- [x] Selection and icon correction recorded
- [x] Implement production rows and shared sidebar sizing
- [x] Verify interaction, visual layout and neighboring navigation
- [x] Complete checks and review; record evidence and deliver

Implementation is isolated in `.worktrees/thread-sidebar` on `feat/thread-sidebar-layout` to preserve unrelated checkout work.

Prototype source: local branch `prototype/thread-sidebar-options`, commit `63d50ce496d72fba5595c7f8a1cb99554336e655`, under `docs/prototypes/`. The chosen layout is A; the production implementation retains Sotto's existing Lucide icons.

Verification: [thread sidebar](../verification/thread-sidebar.md). Two neighboring queue/draft checks fail identically on clean main and are recorded there; no sidebar requirement remains open.
