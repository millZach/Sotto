# Rebuild the Tools panel around a rail of surfaces

Branch: `feat/tools-rail`. Issue: #235. Mock-up: `docs/prototypes/tools-panel-prototype.html` on branch
`prototype/tools-panel`, commit 430543a1. The mock-up is not on `main`; the commit keeps it.

## What was asked

The owner found the Tools panel did not look like the rest of Sotto: three rows of chrome (a context row, a tab
row and a subheader per surface) before any content, five generic icon-and-word tabs, and surfaces that each laid
out differently.

## What was chosen

The mock-up offered three structurally different directions:

- **A, The rail.** The surfaces on a strip at the panel's outer edge, one line of chrome above the work, the
  working copy as a footer.
- **B, The stack.** No tabs: five live summary rows, one of them expanded.
- **C, The bench.** One header line of words, the list beside the detail on every surface, controls in a bottom
  bar.

The owner chose **A** on September 22, 2026, and wrote the pick into #235. This supersedes the Sidecar
composition in `docs/plans/sidecar-implementation.md` and `docs/verification/tools-sidecar.md`.

## Decisions the pick did not settle

These were decided while building A. None contradicts ADR-0011; they are recorded here rather than in a new ADR
because they are the rail's own geometry and tone, not a rule for the rest of the app.

- **The rail is 58px, its tiles 50px, its words 12px.** The mock-up's words are 10.5px; 12px is the floor
  `phase-three-ui` holds every label in the panel to, and "Changes" and "Terminal" still fit.
- **Wide means 640px of content**, the panel minus the rail. Files and Changes stack the list above the detail
  below that and sit side by side from it. With the app's default of 56% of the workspace, that is stacked at
  1280 and 820 and side by side at 1600.
- **The panel takes the sidebar's tone (`--tt-sidebar`)**, as the mock-up does, instead of the Sidecar's
  `--tt-surface`. The open tile uses `--tt-selected`, and the mark and the dots use `--tt-activity`. A pressed
  Pin or Restore at the rail's foot takes the same selected tone as the tiles.
- **Pin, expand and close sit at the rail's foot**, as #235 says, where the mock-up draws them above the tiles.
- **Keyboard order is the rail (its tiles, then its foot), then the surface's line of chrome, then the work, then
  the footer.** #235 asks for "rail, then chrome, then content", and the foot is part of the rail. Opening lands on
  the open tile. The rail is drawn on the right but read first, the way a tab list comes before its panel.
- **A dot marks a surface with something live, and never the open one**, whose line of chrome already says what
  is live. Terminal never gets a dot: a shell is always running. Away from Changes, its dot follows the working
  copy's dirty mark, which main reads after each turn; on Changes and for a thread with no working-copy record,
  it follows the last count Changes read.
- **The working folder's copy and reveal live in the footer**, not on the Files line as the mock-up draws them, so
  they stay reachable from every surface. The footer names the project, then the branch in mono when it is known,
  then the kind of folder.
- **Each surface keeps its actions on its one line.** A worded action (Comment on page, Share with agent, Git
  actions, Checkpoints, Pull request) shows only its icon below 640px of content and keeps its name. Close sits on
  the open page or shell tab, the way a tab closes, so the line's end never reads as a window button; there is a
  20px gap before the window's own controls. A fact beside a title (the branch on Changes) shows as at least six
  characters or not at all.
- **The corner browser preview stands inside the rail** while Tools is open, rather than over its tiles.

## Evidence

`docs/verification/tools-rail.md`, with its captures in `artifacts/tools-rail/`.
