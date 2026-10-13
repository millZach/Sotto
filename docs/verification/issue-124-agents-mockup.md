# Agents view mock-up

September 20, 2026. Visual exploration only; no provider adapters or application UI were changed. The approved behavior and production performance gates are in [the plan](../plans/issue-124-agents-view.md). Zach approved B (roomier) on September 20, 2026.

## Deliverable

- `docs/prototypes/agents-view-prototype.html`: interactive fixture-based mock-up with A (compact) and B (roomier).
- `docs/prototypes/agents-view-prototype.mjs`: allow-listed localhost-only preview server, port 4324. Run `node docs/prototypes/agents-view-prototype.mjs`.
- Start at `http://127.0.0.1:4324/?variant=roomy`. The controls above the app switch variant, appearance and fixture state; they are not proposed app controls.

The mock-up imports Sotto's actual theme tokens and local Figtree font. It does not connect to providers, read application history or send requests to external hosts.

## Reference and composition

Inspected the existing Sotto Tools capture at `artifacts/tools-sidecar/files-1280x800-dark.png`, current Tools source, ADR-0011 and T3's `AgentsPanel.tsx`. A public T3 issue screenshot was inspected but shows the conversation, not a populated Agents panel; the T3 row comparison is source-derived, not a claim of visual parity with its running panel.

A keeps the title, model, status and elapsed time in a flat two-line row. B adds a one-line task preview and separators. Both preserve nested children, spawn order, details and prior assignments. A was recommended for density; Zach selected B for implementation. The dot sits at the upper-left of the outside Tools button. It disappears in finished, disconnected and empty fixtures. No count was added to the thread header.

## Observed verification

`artifacts/agents-view/verify.cjs` exercised both variants in light and dark at 1600×1000, 1280×800 and 820×560. Results and measured contrast samples are in `artifacts/agents-view/verification.json`.

- Twelve layout combinations: no horizontal overflow in the page, Tools, tabs or roster. Actual panel widths: 600, 512 and 394 px. Figtree loaded in all combinations.
- Details and previous-assignment disclosure opened. Escape closed the focused agent's detail.
- Closing/reopening Tools preserved the Files tab. End moved keyboard selection to Agents. Pin toggled and named its target.
- Finished, disconnected and empty fixtures removed the working dot. Disconnected rows said “Last seen working”; reported model gaps said “Model not reported”.
- Reduced motion disabled detail animation. Fixtures use static times; production clock lifecycle and performance are not proven here.
- Measured text contrast across visible titles, models, statuses, elapsed times, details, tabs and footer: minimum 5.63:1 in the sampled light/dark views.
- No browser script errors. The local runner passed focused ESLint after importing URL explicitly.

Primary visual review inspected compact and roomy dark at 1280, compact dark at 1600, roomy light at 820, expanded light details at 820, and disconnected dark. A separate critic inspected the two 1280 variants and narrow expanded light view and found no material visual gaps. Parent/child indentation, model labels and the indicator remained clear. B needs more vertical scrolling at minimum size, which is the intended comparison.

Representative captures:

- `artifacts/agents-view/compact-dark-1280.png`
- `artifacts/agents-view/roomy-dark-1280.png`
- `artifacts/agents-view/compact-dark-1600.png`
- `artifacts/agents-view/roomy-light-820.png`
- `artifacts/agents-view/compact-details-dark.png`
- `artifacts/agents-view/details-reduced-light-820.png`
- `artifacts/agents-view/closed-dot-dark.png`
- `artifacts/agents-view/disconnected-dark.png`
- `artifacts/agents-view/finished-dark.png`
- `artifacts/agents-view/empty-dark.png`

## Tastify checks and limits

Desktop target was already set by the product brief. Composition uses the existing conversation/Tools split; task rows are the focal content inside Agents. No decorative imagery, dashboard cards or ornamental animation were added. The brief requires the roster's operational information rather than marketing copy: five visible agent rows each have title, model, elapsed time and status (20 essential fields), plus one reused-agent run marker, the earlier-agent disclosure and aggregate state feedback. B adds five task previews; all details remain available in A. The application shell and external mock-up controls are contextual scaffolding, not a proposed restyle. No separate Agents heading repeats the selected tab. Footer totals summarize the roster rather than repeating individual task text.

The 140 ms detail reveal was exercised; reduced motion shows the final state immediately. No infinite animation was added. Text uses 14–15 px task titles and controls, 12–13 px metadata, and 14 px details. Independent contrast and normal-size screenshot review support readability at the reviewed sizes.

This HTML preview does not establish production persistence, genuine provider lifecycle handling, pinned-thread observation, incremental rendering, bounded archive access or app performance. Those remain implementation acceptance gates, including the explicitly agreed regression workload. No full application suite or live provider test was run for this visual-only task.
