# The to-do list on the iPhone and the Duo

November 4, 2026. Part four of #2134, ADR-0188 decision 4. Zach's picks came from the prototype kept as the tag `prototype/to-do-iphone-rail`.

## What was proved

Forge can't compile the app, so this PR's macOS job is the first compile, and its journeys are the first run.

Run 41880135669 on the small iPhone gave the first pictures: [the loud count](../../artifacts/to-do-list/iphone-badge.png) and [the open list](../../artifacts/to-do-list/iphone-open.png). The journey stopped there. Without being an element of its own, the sheet's identifier replaced every control's inside it, and its modal trait landed on each of them. The steps and the words of It didn't work now stay with their row when the list becomes too long and scrolls: the sheet used to hold two sets of rows, each with its own state.

- `apps/ios/Tests/SottoCoreTests/ToDoTests.swift`: the hello accepts `to-dos`, a pushed list reads with what a computer leaves out, a press carries only what the host takes, lists join and count, a held row isn't counted, a hold ends with its item or its computer, and a Prototype ready mark keeps the pages it can read.
- `apps/ios/Tests/SottoAppModelTests/ToDoStoreTests.swift`: the model carries presses in every build, opening quiets the badge, a check-off waits and goes through rolling up, Undo sends nothing, a computer going away leaves a waiting check-off unsent, a refusal brings the row back and unrolls the list, and refused words come back after a roll up.
- `FocusJourneyTests.testToDoListStandsInEveryPageAndAChecksOffWithUndo`, on the fixture's iPhones: the icon and its loud count in the Threads heading, the list unrolling, the count going quiet, steps folding, Undo, a check-off going on through rolling up, the Settings heading and a thread's bar. Its captures are `to-do-badge`, `to-do-open`, `to-do-undo` and `to-do-thread-bar`, in the job's artifact.
- `tests/integration/socketToDos.test.ts` proves the host's side from part one.
- `apps/ios/Scripts/check-strings.mjs`: all 23 new strings in all 30 languages. They're my translations, and no native speaker has read them.

Run 41895334740 (job 126803529190) took `testToDoListStandsInEveryPageAndAChecksOffWithUndo` to its end on the small iPhone at `b07d80783`: the count, unrolling, the steps, a check-off, Undo, "It didn't work" and its Cancel, rolling up to the quiet count, and the icon in Settings and in a thread's bar. Its pictures showed two things no assertion reads. In a thread's bar the system's pill cut the count in half, and the roll hung 12 points under the paper with the page showing between. The next commit moves both; only a later run's pictures can show them right.

## What was not proved

- The Duo. CI's iPhones skip the Duo journeys, so the rail's tile, folded and sideways, and the swap with the sidebar button have compiled at most. Upright can only be proved by hand, as `2026-11-03-iphone-duo-thread-rail.md` says.
- The roll's motion, by eye.
- A real computer's list and a prototype's page opening. The journey's list is the fixture's, and a page opening goes through the computer's own page route.
