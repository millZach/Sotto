# iPhone: Add to prompt on words from a reply

October 28, 2026, on an iPhone 18 Pro simulator (iOS 27.0) with the `--ui-watcher` fixture, through `FocusJourneyTests.testWordsSelectedInAReplyAreAddedToThePrompt`.

- With **Why?** in Watcher's box, a double tap on **Started** in Watcher's reply selected that word, and the menu over it read **Add to prompt**, **Copy**, **Look Up** (`artifacts/iphone-reply-quote/menu.png`).
- **Add to prompt** left the box reading `Why?`, a blank line, `From your earlier reply:`, `> Started`, with the keyboard up and the caret on the line after the quote (`artifacts/iphone-reply-quote/added.png`).
- In the fixture's iPhone thread, the same steps on the agent's last reply wrote the quote into the empty reply box and focused it.
