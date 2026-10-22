# The Dictate room as a Journal

Checked on Windows on October 21, 2026, for #1293 and ADR-0101, in the built app driven by `tests/e2e/dictate-journal.spec.ts`. The spec seeds a profile with the design captures' Journal (`tests/fixtures/journalProfile.ts`): nine transcripts over the ten days before the instant an end-to-end run counts from (Sunday, July 12, 2026, 12:41 pm in Los Angeles), most with the app they went to, one with none, and ninety days of dictation records behind them. It asserts that no control is clipped or overflows at every size (`pageBoundProblems`) and takes the screenshots below; run with `SOTTO_E2E_EVIDENCE=publish` it writes them here.

## What was looked at

| Screenshot | What it shows |
| --- | --- |
| `artifacts/dictate-journal/journal-dark-1600x1000.png` | Dark at 1600x1000: the dictate bar, search, More and the app chips, Today, Yesterday and Friday with each day's words and pace, and the stats column: today against the usual, speed over 30 days with the dashed usual, the 4-day streak over 13 weeks with today ringed, Where with share bars, and this month's time saved and busiest hour |
| `artifacts/dictate-journal/journal-dark-1280x800.png` | Dark at 1280x800: the room is still wider than 900 pixels beside the sidebar, so the column stays |
| `artifacts/dictate-journal/journal-dark-820x560.png` | Dark at the 820x560 minimum: the column becomes the row of Today's and This month's figures above the feed, the charts step aside, and the bar keeps its button on its own line |
| `artifacts/dictate-journal/journal-light-1600x1000.png`, `journal-light-1280x800.png`, `journal-light-820x560.png` | The same three sizes in the light room |
| `artifacts/dictate-journal/journal-open-row-1280x800.png` | A row opened from the keyboard: the full text, "12 seconds, 26 words at 134 wpm. English, Parakeet model, in Windows Terminal. Kept on this computer only.", Copy and Delete, with the row's focus ring outside it |
| `artifacts/dictate-journal/journal-more-menu-1280x800.png` | The More menu beside the search, open on Clear history |
| `artifacts/dictate-journal/journal-history-off-1280x800.png`, `journal-history-off-820x560.png` | History off, after one more dictation: the bar says "Pasted into Sotto.", today counts 4 dictations, the line says History is off and the older transcripts stay listed |
| `artifacts/dictate-journal/journal-listening-reduced-motion-light-1280x800.png` | Listening with reduced motion in the light room: the timer in the sentence, Stop turned inside out, the wave still |

The spec also checks, in the running app: no page link reaches History; Enter opens a row and Escape closes it with focus back on the row; the More menu opens on Clear history and Escape closes it back to its button; Ctrl+K on Help opens the Dictate room with the search focused, typing narrows the feed and Escape clears it; and the Slack chip shows only Slack's transcripts.

Every colour on the room is a theme role through a `--tt-*` token, and `dictate.css` is on `themeTokens.test.ts`'s list. The text inks it uses (text, text-2, muted and faint on the canvas and surface, accent text on the selected chip) are the pairs that test holds at 4.5:1 in every built-in theme.

## Not checked here

- **macOS and Linux: NOT VERIFIED.** The room is the same React and CSS on every platform; it was looked at on Windows only. On Linux the bar's hint is the compositor-binding sentence, longer than the shortcut chips; a unit test covers its words, not its wrap.
- **A real delivered app.** A test run delivers into Sotto's own window, so every new dictation here is "Pasted into Sotto." The seeded records carry the other apps.
- **Hundreds of transcripts.** The fixture holds nine transcripts and about two hundred records. The feed draws a week at a time and counts each transcript's words once, but it was not timed with an owner's history.
