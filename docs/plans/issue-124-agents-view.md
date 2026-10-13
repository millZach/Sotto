# Issue 124: Agents in Tools

## State

Design agreement confirmed in conversation on September 20, 2026. Production implementation and local verification are complete. See [implementation evidence](../verification/issue-124-agents.md) for gate results and limits. B (roomier) approved by Zach on September 20, 2026.

## Agreed outcome

- Tools gets an Agents tab for its selected or pinned thread, including finished agents.
- Each row shows a brief provider task title, reported model (otherwise “Model not reported”), status and elapsed time when known. Expand to read the task and returned result; no full child transcript or child controls.
- Children nest under their reported parent. Siblings remain in spawn order. A reused agent keeps its row, shows its new assignment, and retains earlier assignments/results in details.
- A small activity-colored dot sits at the upper-left of the outside Tools expander icon while agents work. No header count and no automatic opening/tab switch. The dot follows Tools' actual target, including pins.
- Agent and assignment history survives independently of the 2,000-record general activity limit and obeys Keep local history.
- Restart/disconnection shows “Last seen working”, stops the live clock, and removes the dot until current activity is confirmed. A parent reply ending does not complete its children.
- Titles use reported labels/descriptions or the prompt's first line, without another model call. Results preview provider-returned text.

## Performance acceptance for implementation

Synthetic coverage: three threads, 5,000 saved assignments total, 20 active agents and 600 updates. These are chosen workloads, not measured results.

- CI asserts bounded archive reads, incremental writes/publications, stable unaffected rows, no unrelated pane rerenders, lossless results and no hidden/disconnected display timers.
- Compare small versus large archives using work counts, not CI wall-clock ratios. Retained history must not enter every snapshot or rewrite on each progress event.
- Local before/after responsiveness, startup and memory measurements; existing opt-in 100 ms queue-feedback and 250 ms heartbeat gates. Set any new opening-time budget only after a baseline.

## Mock-up acceptance

Target: Windows desktop (project explicitly desktop-only), reviewed at 1600×1000, 1280×800 and 820×560. Standalone HTML with fixture data; no application/provider data or bridge.

Concept: a quiet roster beside the conversation, proven when a user sees who is working and opens a returned result without losing the parent thread.

Three concepts considered: compact rows prioritizing a quick scan; roomier assignment rows prioritizing task context; split roster/detail prioritizing sustained result reading. Build the first two; split detail consumes too much of the minimum Tools width. Both variants were reviewed; Zach selected the roomier assignment rows.

- Preserve existing Tools navigation, panel placement and expander behavior. Carry T3's stable rows, task-first hierarchy, restrained status and model metadata; retain Sotto's branding.
- Figtree, theme-derived --tt-* colors, 14 px controls/titles, at least 12 px secondary text; text contrast at least 4.5:1. No new raster art: the subject is operational text and state.
- One workspace, no card grid. Mock-up controls are outside the app frame. The five-text-element marketing budget is inapplicable to the operational roster: each row's title, model, state and timing is independently requested information. Avoid duplicate headings or explanatory copy inside the app.
- Motion: opening a detail reveals its content over a short 140 ms fade; quiet static activity dot; reduced motion disables animation. No decorative loops or timers needed for fixture data.
- Exercise variants, themes, details/history, nesting, empty/finished/disconnected states, pin, tab selection, Tools close/reopen, Escape and keyboard focus. Check narrow layout and no overflow.
- A visual mock-up cannot prove app performance, provider mappings, persistence or production accessibility. Keep those implementation gates explicit.

## Verification

Mock-up built and reviewed in both variants, light/dark, and all three desktop sizes. No horizontal overflow; sampled text contrast at least 5.63:1. Details, prior assignments, Escape, keyboard tabs, pin, preserved tab selection, status fixtures and reduced motion passed. Independent visual critic found no material gaps. See docs/verification/issue-124-agents-mockup.md. Zach selected B (roomier) on September 20, 2026. Implement its task previews, row spacing and separators while preserving every agreed behavior and performance gate.

## Implementation checklist

- [x] Provider observations and independent retained history
- [x] Paged preload bridge and small thread counts
- [x] Approved roomier view, dot, pin observation and keyboard paths
- [x] Archive-size regression checks, privacy/restart tests
- [x] Electron journey and rendered review
- [x] Full CI gate runs, focused failure resolution and local timing measurements
- [x] Independent standards/spec review and fixes
