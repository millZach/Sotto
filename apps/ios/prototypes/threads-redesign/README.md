# iPhone thread redesign prototype

Three structurally different directions for the existing Threads screen and a connected conversation, selected with `?variant=A`, `B`, or `C`.

- **A — Focus:** current work and questions lead; recent threads follow.
- **B — Projects:** workspace folders provide the main hierarchy.
- **C — Conversations:** a quiet chronological list with readable previews.

Run `node apps/ios/prototypes/threads-redesign/serve.mjs` from this worktree. Open the URL it prints. No installation required.

The current app is native SwiftUI, with no browser route to host a rendering swap. This HTML study recreates its phone shell, Figtree, Sotto palette, navigation and representative thread states. All data is fictional. Actions affect the prototype only; replies are never sent and permissions are never granted.

Compare variants with the floating arrows or keyboard left/right. Search, filter by computer, expand Settled, open threads, switch Messages/Activity, and draft a simulated reply. Escape closes a sheet or returns to the list. Light/dark and a larger-text preview are included.

Scope assumption while clarification is pending: list plus opened conversation. No variant selected yet. This branch is a review artifact, not a production change or a TestFlight release.

Acceptance: distinct structures; clear working/waiting/question/done/offline states; expandable Settled; usable at 375 and 430 px; keyboard and reduced-motion support; inspect light/dark and the actual click-through flow.

## Inspection — September 29, 2026

Opened the running study in Sotto's browser and visually inspected the three-way comparison, the opened conversation, and a 375 px light-mode view with larger text. Exercised all three variants in Chromium: both working threads, Settled expansion, Messages/Activity, search and empty results, offline-computer filtering, a simulated answer, a local reply, Escape, arrow switching, and URL reload. Checked all three at 375 and 430 px in both themes with larger text and reduced motion: no page-wide horizontal overflow or script errors; status animation stopped with reduced motion.

Saved captures are in `previews/`. These are browser checks of fictional data, not an iOS build or verification of live thread status, networking, VoiceOver, or native Dynamic Type. No production code was changed. Full application CI is outside this throwaway study.

Designer recommendation: C, Conversations, gives the clearest view of both running threads with the least visual framing. A emphasizes questions; B makes project navigation familiar. This is a recommendation, not a recorded user choice. The design question remains open until Zach reviews the directions.
