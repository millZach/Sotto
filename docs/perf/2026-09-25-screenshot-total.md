# Refusing screenshots over the total before reading them - September 25, 2026

Issue #315. The composer's screenshot input checked each file against the 10 MB limit before reading it, but checked the 20 MB total only after every file had been read and base64-encoded and the whole set had been through the attachment schema. A drop that was always going to be refused still read and encoded all of it first.

`ScreenshotInput` now checks each file's type and size, then adds the dropped files' sizes to the decoded sizes of the screenshots already attached, before it makes a `FileReader`. Over 20 MB, it shows the same message as before: "Screenshots must total 20 MB or less. Remove an image or choose smaller files." Nothing is read and the input never shows "Adding screenshots...". The schema check after reading is unchanged and still decides; the early check only refuses what the schema would refuse anyway, because a file's `size` is the number of bytes its data URL decodes to.

The type and 10 MB checks moved out of the read so they run first, for every file, before the total. The order of the checks is the same as before, so a single file over 10 MB still gets the per-image message rather than the total one. What changed is that no file is read until all of them pass.

## Measurements

`tests/perf/screenshotTotal.perf.test.tsx` renders the input in jsdom, drops files on it and times the wait from the drop to the refusal appearing. It counts the `FileReader`s made and the base64 characters they return. Each case is one warm run and then the median of five. Three runs of the file on each side, the before column against `origin/main`'s copy of `ScreenshotInput.tsx`, on the development machine (Windows 11, Node v24.14.1), with other agents' work running on it.

| Case | Before: median ms | Before: readers, MB encoded | After: median ms | After: readers, MB encoded |
| --- | ---: | ---: | ---: | ---: |
| Three 8 MB screenshots dropped at once | 58-65 | 3, 32 | 12-14 | 0, 0 |
| One 6 MB screenshot dropped beside two 8 MB ones already attached | 121-229 | 1, 8 | 9-11 | 0, 0 |
| Floor: nine tiny screenshots, refused by count on both versions | 11-12 | 0, 0 | 12-13 | 0, 0 |

The floor case is refused before any read on both versions, so its 11 to 13 ms is the harness itself: the React commit and Testing Library's query. After the change the two over-the-total cases cost the same as the floor. The second case was the slower one before, most likely because the schema ran its base64 pattern and size checks over all 22 MB of data URLs, the two attached and the one just read, before it could refuse.

## What the numbers are not

They are jsdom timings. jsdom's `FileReader` encodes on the main thread with Node's `Buffer`, and Chromium reads the file off the main thread, so the before column is not the wait a user would see in the app. The counts do not depend on the machine and are the part to compare between commits: before, a refused 24 MB drop allocated 32 MB of data URL strings and ran the schema over them; after, it allocates none. No timing was taken in the running app.

## Re-run

The benchmark reads real multi-megabyte files, so it is skipped unless asked for:

```sh
SOTTO_PERF_SCREENSHOTS=1 npx vitest run tests/perf/screenshotTotal.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

For the before column, check out `src/renderer/src/agents/ScreenshotInput.tsx` from this change's parent commit and run it again. The unit tests in `tests/unit/renderer/screenshotInput.test.tsx` pin the behaviour by count: a drop over the total, and one that crosses it with what is already attached, both refuse with no `FileReader` made, and a drop of exactly 20 MB is still read.
