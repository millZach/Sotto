# Keep workspace test thread names stable

October 9, 2026. The expanded composer merge gate found three `thread-workspace.spec.ts` timeouts. Traces show generated first-message titles invalidating later Docs/Workshop navigation. The same three tests fail on clean main `1312da73d` (three failed, one passed, 97.64 seconds); its detached checkout installed dependencies without links and was removed after copying the traces. Full proof and invocation details are in [the composer merge note](2026-10-09-voice-control-composer-merge.md).

A local test helper gives both threads distinct user titles before reload, then the three journeys navigate by those names. This lets their original draft, queue, selected-skill, send-count and manual-permission assertions run. Renaming to an unchanged title was ineffective because the coordinator skips that host call; the corrected distinct titles set the user source. No production behavior or deadlines changed.

Red: three timeouts, one pass on the branch and pinned main. Green: all four cases pass in 13.93 seconds. Final typecheck passes in 32.50 seconds, lint in 17.46 seconds; design pages pass in 22.69 seconds and all 144 manifest tuples verify. The test-only correction is a separate follow-up to the Tiptap merge, pushed with it after the fast gates.
