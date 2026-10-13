# A question brings the links from the agent's message before it

October 11, 2026, on Windows 11, from `tests/e2e/question-message-links.spec.ts` against the built app. The provider's effects come from the E2E host, and only the system browser is recorded: `shell.openExternal` is replaced so nothing opens.

## Why

An agent handed Zach a prototype as a link in its message, then asked which variant he wanted. The question card docks over the end of that message, so the link was out of sight, and the card only links an address written into the question itself. On the iPhone the question sheet covers the thread. Zach asked for Sotto to show the message's links on the question rather than rely on every agent repeating them. He chose rows on both clients from the prototypes on the tag `prototype/question-message-links`: on the desktop, A, "Open the link" rows between the question and its choices, as the iPhone already shows a question's own links; on the iPhone, those same rows, with no caption.

## The rule

The links are those in the agent's newest message that is not a visual, each once, in the order written, leaving out any the question already shows as a link. A request has no place in the transcript of its own, but the agent waits on the answer, so its newest message is the one the question follows. Only questions get them, not permissions.

- A row is left out only when the card already shows its address as a link. A question's header is a tag of plain words, and a form's text that only repeats its questions is not shown, so an address only there still gets its row.
- A visual is skipped only where it arrives with its drawing. A host sends visuals without it, to the iPhone and to a desktop reading another computer's threads, and ADR-0056 makes those words alone, a reply like any other, so they count there.

## What was shown

- The agent's message holds a localhost review link and a Markdown link to a GitHub tree, then the agent asks which layout. The card shows two rows, named "Open the link, localhost:8075" and "Open the link, github.com/millZach/Sotto/tree/prototype/cloud-iphone-settings-layout", between the question and its choices.
- At 1600x1000, 1280x800 and 820x560, in light and dark, the rows fit inside the card and the card does not scroll sideways. Each row's two lines meet 4.5:1 on the card.
- From the collapse toggle, Tab goes to the first row, then the second, then the first choice. Enter on a row opened the page in the system browser and picked no choice.
- With the provider disconnected, the choices are disabled and a row still opens its page.
- `tests/e2e/thread-sidebar-question.spec.ts` still passes.

The renderer's unit tests cover which links are taken: the newest agent message only, past a visual, each once, none the question already links, and no address that is not http or https. They also cover a plain question with no choices, and a card with no links showing nothing new.

## The iPhone

`WebLinks.find(in:after:)` in SottoCore adds the newest agent message's links after the request's own, and the sheet passes the thread's messages to it. A row now names the port as the desktop's does, so a localhost link reads "localhost:8075" rather than "localhost". The sheet now watches the thread's history store too, so rows show when the history arrives after the sheet opens. `RequestTextTests` covers the links and the port. None of it was run here: the iPhone client builds only on the macOS CI job. A localhost link can't open on a phone in any case; a tailnet link can.

## Captures

In `artifacts/question-message-links/`:

- `question-links-1600x1000-dark.png`, `question-links-1280x800-dark.png` and `question-links-1280x800-light.png`: the card with its two rows.
- `question-links-820x560-dark.png` and `question-links-820x560-light.png`: the minimum window, scrolled to the rows.
- `question-links-1280x800-dark-disconnected.png`: the choices disabled, after the second row was pressed.

## Known limitation

Codex can ask a question while it keeps working. A message it writes after asking becomes the newest, and the rows follow it, on both clients. Pinning each question to the message it followed would need main to record that message with the request, for every provider. That is a change of its own.

## Not shown here

- Android, whose question sheet shows no link rows at all yet.
- Where a row opens: the system browser, as the question's own links already do, not the Web links setting. The card sits outside the transcript's link router.
