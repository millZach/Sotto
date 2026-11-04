# The to-do list on the iPhone and the Duo

November 4, 2026. Part four of #2134, ADR-0188 decision 4. Zach's picks came from the prototype kept as the tag `prototype/to-do-iphone-rail`.

## What was proved

Forge can't compile the app, so this PR's macOS job is the first compile, and its journeys are the first run.

- `apps/ios/Tests/SottoCoreTests/ToDoTests.swift`: the hello accepts `to-dos`, a pushed list reads with what a computer leaves out, a press carries only what the host takes, lists join and count, a held row isn't counted, a hold ends with its item or its computer, and a Prototype ready mark keeps the pages it can read.
- `apps/ios/Tests/SottoAppModelTests/ToDoStoreTests.swift`: the model carries presses in every build, opening quiets the badge, a check-off waits and goes through rolling up, Undo sends nothing, a computer going away leaves a waiting check-off unsent, a refusal brings the row back and unrolls the list, and refused words come back after a roll up.
- `FocusJourneyTests.testToDoListStandsInEveryPageAndAChecksOffWithUndo`, on the fixture's iPhones: the icon and its loud count in the Threads heading, the list unrolling, the count going quiet, steps folding, Undo, a check-off going on through rolling up, the Settings heading and a thread's bar. Its captures are `to-do-badge`, `to-do-open`, `to-do-undo` and `to-do-thread-bar`, in the job's artifact.
- `tests/integration/socketToDos.test.ts` proves the host's side from part one.
- `apps/ios/Scripts/check-strings.mjs`: all 23 new strings in all 30 languages. They're my translations, and no native speaker has read them.

## What was not proved

- The Duo. CI's iPhones skip the Duo journeys, so the rail's tile, folded and sideways, and the swap with the sidebar button have compiled at most. Upright can only be proved by hand, as `2026-11-03-iphone-duo-thread-rail.md` says.
- The roll's motion, by eye.
- A real computer's list and a prototype's page opening. The journey's list is the fixture's, and a page opening goes through the computer's own page route.
