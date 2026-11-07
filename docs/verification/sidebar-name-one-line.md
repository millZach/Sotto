# A sidebar thread's name on one line

Checked on Windows on November 7, 2026, in the built app over the review evidence fixture, with
`node scripts/capture-review-evidence.mjs <out> --states sidebar-name-one-line`. Zach asked for a thread's name in the
Threads sidebar to take one line, never two: a working row named "Disk cleanup: find intermediate image/video files on
forge and…" took two lines for its name and a third for Working and its time. ADR-0135 has the dated line.

## What was done

The fixture's working thread "Plan the split" was renamed to "Disk cleanup: find intermediate image/video files on forge
and list what is safe to delete". The sidebar was set to its narrowest (260 px) and widest (480 px) with Home and End on
its divider, and captured at 1600x1000 in dark and light, then over the thread at the 820x560 minimum. The same state was
captured from `main`'s sidebar stylesheet and row for the before image.

At every width the name takes one line, cut at a word's end with an ellipsis ("Disk cleanup: find…" at 260 px, "…on forge
and…" at 480 px), with the ring level with it and Working and its time on the second line. Resting rows keep their one
line. The row's tooltip and its spoken name are still the whole name.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/sidebar-name-one-line/before-after-narrowest-dark.png` | Before and after, dark, sidebar at its narrowest |
| `artifacts/sidebar-name-one-line/after-narrowest-light-1600.png` | After, light, narrowest |
| `artifacts/sidebar-name-one-line/after-widest-dark-1600.png` | After, dark, widest |
| `artifacts/sidebar-name-one-line/after-widest-light-1600.png` | After, light, widest |
| `artifacts/sidebar-name-one-line/after-over-dark-820.png` | After, dark, over the thread at the minimum window |
| `artifacts/sidebar-name-one-line/after-over-light-820.png` | After, light, over the thread at the minimum window |

Over the thread at the minimum window the sidebar takes one width whatever was chosen, so one capture covers both ends.
Nothing moves in this change, so reduced motion changes nothing.

## Not checked here

macOS and Linux. `tests/e2e/thread-sidebar-resize.spec.ts` fails at line 84 on this branch and on `main`'s source alike:
it expects a Done row to show its provider mark, which a resting row hides since November 5.
