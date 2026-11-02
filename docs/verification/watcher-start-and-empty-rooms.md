# Watcher's start in one sentence, and empty rooms that say so once

October 30, 2026. The branch `fix/watcher-start-and-empty-rooms` from `main` at d5ec2219b, closing #1822 and #1834 from the desktop UI review (`docs/research/2026-10-29-ui-hillclimb-desktop.md`, findings 4 and 16), as Zach picked them in `look-fixes-prototype.html` on the tag `prototype/ui-hillclimb-desktop`. Checked on forge (Linux, Omarchy) in an owned nested desktop through `scripts/verify-linux-window-minimum.mjs --exec`, with the built app and the design capture profiles. Not checked on Windows or macOS.

## What changed

**Watcher before it starts (#1822).** The room said that the first message starts Watcher three times, in three centred paragraphs, the placeholder and the footnote. It now shows one left-aligned sentence over the composer, "Watcher starts your other threads, briefs them and keeps an eye on them while they work. Your first message starts it.", then **How Watcher works**, which opens Help at a new Watcher topic holding the paragraph about providers, tools and permissions. The placeholder is "Say what to start or check." The footnote keeps the model and the account, "On Sonnet 4.5, with your own Claude Code account.": its old opening, "Your first message starts Watcher", repeated the sentence word for word, so it took the mock-up's shorter words. "Start Watcher" stays as the room's heading for assistive technology and is no longer drawn. The night scene is not touched.

**Empty rooms (#1834).**

- **Dictate.** Until the records hold dictation on two different days, however long ago, the stats column is one sentence under **Your numbers**: "Words, speed, streak and where your words went show here once you have dictated on two days."
- **Usage.** While no computer has recorded anything (the range is empty, and so is one read without dates), one card, **No usage yet**, says what will show there, and the views and filters stay hidden until there is data. The gauges of limits already read stay above it.
- **Threads.** An empty project folder shows its name alone, with no "No open threads." and no "0"; the room still says "No threads yet." once.

## How it was run

```sh
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/empty-rooms.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/watcher-night-scene.spec.ts -g "the first entry and a conversation|reduced motion"
```

`empty-rooms.spec.ts` (5 passed) opens each room in dark, in light and in dark with reduced motion, at 1600x1000, 1280x800 and 820x560, and holds each to the design captures' clipping check:

- the Dictate room with no records, whose column must be the heading and the sentence and nothing else;
- Usage on a fresh profile, which must show No usage yet and neither the views nor the date range;
- the Threads page on the `design-threads-empty` fixture, whose projects must show no "No open threads.", no "No threads yet." and no count, while the room says "No threads yet.";
- Watcher's room before it starts, seeded as the night scene's spec seeds it: the sentence and How Watcher works, left-aligned, and the new placeholder; a press on How Watcher works must open Help with focus on the Watcher topic's title;
- Help, whose Watcher topic must hold the moved paragraph.

`watcher-night-scene.spec.ts`'s first entry in dark and light at three sizes, and its reduced-motion test, passed unchanged (3 passed): the scene holds still and the owl stays perched behind the new first entry.

## What the captures show

- `artifacts/watcher-start-and-empty-rooms/watcher-dark-1600x1000.png`: Watcher before it starts, dark, the sentence and How Watcher works left-aligned over the composer, the night scene behind as before, and the shorter footnote.
- `artifacts/watcher-start-and-empty-rooms/watcher-light-820x560.png`: the same in light at the minimum window.
- `artifacts/watcher-start-and-empty-rooms/watcher-dark-reduced-motion-1280x800.png`: the same with reduced motion.
- `artifacts/watcher-start-and-empty-rooms/watcher-help-dark-820x560.png`: Help after How Watcher works, at its Watcher topic.
- `artifacts/watcher-start-and-empty-rooms/help-light-1600x1000.png`: Help's Watcher topic in light.
- `artifacts/watcher-start-and-empty-rooms/dictate-dark-1600x1000.png`: the Dictate room with nothing dictated, the column one sentence under Your numbers.
- `artifacts/watcher-start-and-empty-rooms/dictate-light-820x560.png`: the same at 820x560, where the sentence runs across the room above the Journal.
- `artifacts/watcher-start-and-empty-rooms/usage-light-1280x800.png` and `artifacts/watcher-start-and-empty-rooms/usage-dark-820x560.png`: Usage with nothing recorded.
- `artifacts/watcher-start-and-empty-rooms/threads-dark-1600x1000.png` and `artifacts/watcher-start-and-empty-rooms/threads-light-820x560.png`: three empty projects by name, and "No threads yet." once in the room.

## Limits

- **Your numbers** uses the stats column's heading, which `main` still draws in capitals; #1872 removes that transform for every Dictate heading. The captures here were made from this branch alone, so they show "YOUR NUMBERS". The word is written in sentence case.
- `watcher.spec.ts`'s first-entry test was not run to its end on Linux: it reads the window controls' place, which the Linux window does not draw. Its footnote words are updated, and the quiet composer's shield is found where Owl draws it, at the pill's start (ADR-0161), which that test had not followed.
- Usage on a computer with history to import shows No usage yet only until the first batch is written; the line that says Usage is still reading that history shows beside it. Before the first read lands, the page draws its views and filters as it always has, then puts them away if nothing was ever recorded.
