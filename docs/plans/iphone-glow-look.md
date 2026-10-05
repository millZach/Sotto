# iPhone Glow look

## Approved scope

Zach chose Glow from five whole-app studies, asked for Threads to scroll as one sheet like Soft, chose thread version B, kept the question sheet and New thread as drawn, and approved `docs/prototypes/iphone-redesign/glow-refined.html` on `prototype/iphone-glow-redesign` (commit `40803592`) as the new look, to ship as one pull request. [ADR-0050](../adr/0050-the-iphone-takes-the-glow-look.md) records the decisions. The study is the reference for every screen; where SwiftUI and the study disagree, match the study's hierarchy, spacing and behaviour rather than its exact pixels.

The same pull request carries the fixes Zach reported from daily use: a message's font changing part-way (a stray backtick opening a code span across lines), the reply view shrinking and jumping to the top while answering, search that only closes with the keyboard's Search key, and New thread pickers that open only from their text.

## Deliverables and acceptance

- [ ] Design system: theme palettes generated from `src/shared/themes/palettes.ts` into Swift with a unit test that fails when they drift; appearance (Dark, Light, System); one type scale and one spacing scale in Figtree; wash, glass and glow surfaces that honour Reduce Motion and Reduce Transparency; shared buttons, chips, cards and pills.
- [ ] Threads, Computers and Settings tabs scroll as one sheet: wash, heading, +, computer menu, summary and search move with the list; content fades under the status bar. Search closes on a tap outside it or on scroll.
- [ ] Request cards answer in place with Sending, then Answered, before the card leaves; working cards show their live step and elapsed time.
- [ ] Thread page B: slim pinned bar, scrolling title block with branch, changed-line and pull request chips from the worktree's Git status, steps inline in time order with the running one ticking, no Activity tab, one-line top while the keyboard is open, position kept at the bottom when the reply box changes height or a request is answered.
- [ ] Messages render as Markdown blocks with key chords as keys; unit tests cover the block parser, the stray-backtick case and the time ordering of messages and steps.
- [ ] Question and permission sheet restyled as drawn; behaviour unchanged.
- [ ] New thread: whole-box pickers for model, effort, permissions and working copy; New worktree sends `workingCopy`; defaults from Settings apply under ADR-0050's rules.
- [ ] Settings: theme, appearance, five-step text size (migrating Larger text), density, local notifications off by default with iOS permission asked on first use, new-thread defaults, About.
- [ ] UI journeys updated for the new structure; screenshots captured on the small and large simulators in dark, light and another theme, with Reduce Motion and accessibility text.
- [ ] Root gates, the two-axis review, CONTEXT.md, the guide and the README updated where the iPhone's surfaces are described; a verification note with selected screenshots.

## Limits

This Windows machine cannot build iOS. The macOS CI job compiles the app, runs the package tests and runs the UI journeys on two simulators; its screenshots are the visual evidence. Live behaviour on Zach's iPhone comes through TestFlight after merge and is reported separately.
