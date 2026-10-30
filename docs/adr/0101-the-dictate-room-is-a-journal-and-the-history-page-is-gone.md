# The Dictate room is a Journal, and the History page is gone

Accepted by Zach on October 21, 2026 (#1293). He picked variant C, "Journal", from the prototype kept at the tag `prototype/dictate-room-stats` (`docs/prototypes/dictate-room-stats-prototype.html`, `?variant=C`), after Wispr Flow's home and Insights pages, and asked for the History page to be removed. It builds on [ADR-0100](0100-each-dictation-keeps-a-record-of-its-numbers-and-app.md), whose dictation records the stats are counted from, and amends what ADR-0100 calls "History": transcripts are listed in the Dictate room now, not on a page of their own.

## Context

The Dictate room was the wave, one sentence, one button and the last transcript. There was little reason to look at it, and every other transcript was a page link away, on History. The prototype offered three answers to "how much should the Dictate room say about your dictation": A, the quiet room with four figures and the last five transcripts; B, a compact bar over a page of stats with one transcript; and C, every transcript by day with the stats in a column beside it.

## Decision

The Dictate room is the **Journal**:

- **The dictate bar** at the top: the small wave, the one sentence ("Ready when you are.", "Listening." with its timer, "Pasted into Outlook." when the dictation's record has a delivered app, otherwise "Pasted." or "Copied."), Start dictation or Stop, and the shortcut. Errors, a kept recording, a speech model that is not ready, a skipped microphone and the "Your text is still here" recovery keep their behaviour and their words, in the bar and under it.
- **The feed**: every transcript, grouped by day (Today, Yesterday, then the weekday and date), each day headed with its words and pace. It opens on the last seven days and adds the seven before at each **Show the 7 days before**; when nothing that matches falls in the last seven days, it opens on the newest day that has some, so a quiet week never shows an empty feed above a button. Search and the app chips (All, then the five apps that took the most words in the last 30 days) narrow it. **Ctrl+K** (**Cmd+K** on a Mac) opens the Dictate room on the search, as it opened History before.
- **Rows open in place**, as History's did: the full text, its facts (length, words, pace, language, model and app) and Copy and Delete. Escape closes an open row. A collapsed row shows its time, two lines of text and "App · N words · N wpm".
- **Clear history** is in the More menu beside the search, with the confirmation History had; Settings keeps its own Clear history. Both now say that clearing removes the numbers the room counts as well as the transcripts, because ADR-0100 made it do so.
- **The stats column**: today's words and pace against the **usual** (the pace over the last 90 days, today included); speed over the last 30 days against a dashed usual; the streak (days in a row with dictation, counting through yesterday while today has none yet, and the longest run in the last year) over a 13-week calendar; where the words went over the last 30 days (the four apps that took the most, as shares of the words that went to a known app); and this month, the calendar month, with the time saved against the **Typing speed** setting and the busiest hour. Below 900 pixels of room the column becomes a row of the two figure sections above the feed and the charts step aside. Every chart has a text alternative.
- **Stats come from dictation records alone**, so they keep counting with **Keep local history** off and include dictations whose text retention trimmed. A record without an app is left out of Where and the chips; nothing is called "Unknown".
- **History off**: a line above the feed says so and that new dictations keep their numbers only. Older transcripts stay listed, can be copied and deleted, and the stats keep counting.
- **Typing speed** is a new setting under Settings, Dictation, in words per minute: 40 by default, from 10 to 150.

The **History page is removed**: its navigation, its route, its page link in the sidebar foot and in Watcher's floating switch, its link in the strip's footer, its footer status and its stylesheet. The history store and its IPC stay; the Journal reads them.

It is not an Owl feature (ADR-0072). Zach sent it straight to stable.

## Consequences

- There is one place for transcripts. A link that used to say "Open History" goes to the Dictate room, and Help lists Ctrl+K as **Search transcripts**.
- The Journal reads transcripts and records newest first, as main lists them. A week of the feed reads that week, and the stats read the last year of records and stop, so neither grows with years of dictation. The stats are counted again only when the records, the day or the typing speed change; each transcript's words are counted once, kept by id and never with its text.
- "Journal" names the Dictate room's feed. It is not the **checkpoint journal** or the **origin journal**, which are files.
- The design captures that opened History now capture the Journal (`dictate-journal-*`, and `scale-*-journal` for the whole room at each scale). Their window is 1080 pixels wide, so the Dictate captures show the compact row; the wide column is in the verification note's screenshots.

## Amended October 30, 2026: the stats column before two days

From the desktop UI review (#1834), approved as proposed in `look-fixes-prototype.html` on the tag `prototype/ui-hillclimb-desktop`. A new user's stats column was every section with nothing in it: 0 words, an empty calendar, "0 min saved". Until the records hold dictation on two different days, however long ago, the column is one sentence under a small **Your numbers** heading instead: "Words, speed, streak and where your words went show here once you have dictated on two days." On the second day it becomes the column above. Records are newest first, so the check stops at the first record from another day than the newest. Below 900 pixels of room the sentence runs across the room where the row of figures would be.
