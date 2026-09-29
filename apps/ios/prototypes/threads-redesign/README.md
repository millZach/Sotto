# iPhone thread redesign prototype

Three structurally different directions for the existing Threads screen and a connected conversation, selected with `?variant=A`, `B`, or `C`.

- **A — Focus:** current work and questions lead; recent threads follow.
- **B — Projects:** workspace folders provide the main hierarchy.
- **C — Conversations:** a quiet chronological list with readable previews.

Run `node apps/ios/prototypes/threads-redesign/serve.mjs` from this worktree. Open the URL it prints. No installation required.

The current app is native SwiftUI, with no browser route to host a rendering swap. This HTML study recreates its phone shell, Figtree, Sotto palette, navigation and representative thread states. All data is fictional. Actions affect the prototype only; replies are never sent and permissions are never granted.

Compare variants with the floating arrows or keyboard left/right. Search, filter by computer, expand Settled, open threads, switch Messages/Activity, and draft a simulated reply. Escape closes a sheet or returns to the list. Light/dark and a larger-text preview are included.

Selected direction: **A — Focus**, chosen by Zach on September 29, 2026. The next revision removes the Needs you page, adds Settings, and replaces the search button with a permanent search pill below the heading and computer selector. Questions remain in Threads, which also carries the unanswered-question badge. Tabs are Threads, Computers, Settings. B and C remain available as references on this throwaway branch.

Settings previews appearance and larger text, with changes in memory only. Zach approved the revised prototype with “Looks good,” including the presented search placement and Settings preview. This branch is a review artifact, not a production change or a TestFlight release.

Acceptance: distinct structures; clear working/waiting/question/done/offline states; expandable Settled; usable at 375 and 430 px; keyboard and reduced-motion support; inspect light/dark and the actual click-through flow.

## Inspection — September 29, 2026

Opened the running study in Sotto's browser and visually inspected the three-way comparison, the opened conversation, and a 375 px light-mode view with larger text. Exercised all three variants in Chromium: both working threads, Settled expansion, Messages/Activity, search and empty results, offline-computer filtering, a simulated answer, a local reply, Escape, arrow switching, and URL reload. Checked all three at 375 and 430 px in both themes with larger text and reduced motion: no page-wide horizontal overflow or script errors; status animation stopped with reduced motion.

Saved captures are in `previews/`. These are browser checks of fictional data, not an iOS build or verification of live thread status, networking, VoiceOver, or native Dynamic Type. No production code was changed. Full application CI is outside this throwaway study.

Zach chose A, Focus: “A looks great lets go with that.” This supersedes the earlier recommendation of C. Keep Focus's question-first hierarchy, live cards, and quieter recent history when implementing the selected design.

## Selected Focus revision

Checked the permanent search field, clear action, matching counts, settled search results, question-answer flow, question badge, all three navigation tabs, appearance selection, and larger-text switch in Chromium. Visually inspected revised Threads and Settings at 390 × 844 in dark mode and 375 × 812 in light mode with larger text. No script errors or horizontal overflow appeared in these checks. The new captures use `focus-revised`, `settings-revised`, `focus-light-large`, and `settings-light-large`; earlier captures document the original comparison.

Design verdict: the revised Focus prototype at commit `0d3e5835` is approved. The permanent search pill sits beneath the heading and computer selector; Settings replaces the Needs you page; questions remain in Threads. Appearance and larger text are the Settings controls shown in the approved preview.

Remaining implementation work: translate this design into SwiftUI and validate it natively. Prototype approval records the design decision; it does not itself publish or install a release.
