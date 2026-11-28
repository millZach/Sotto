# Secret requests verification

November 27, 2026, on `feat/browser-parity-and-secret-requests`, from `origin/main` at 9220d0129, on Windows 11 with Node 24.22.1. This is [ADR-0219](../adr/0219-an-agent-asks-for-a-secret-on-a-private-card.md)'s secret request card, behind the `secret-requests` Owl feature. `tests/e2e/secret-requests.spec.ts` launched the built app with `SOTTO_OWL_FEATURES=secret-requests=1` over the fake Claude Code provider and ran with `SOTTO_E2E_EVIDENCE=publish`. The agent's calls go through `window.sottoE2E.secretTool`, the same `sotto_secrets` server a provider reaches, bound to the Workshop thread. Every capture in `artifacts/secret-requests/` was looked at.

## What the spec checks

1. **A secret file for a command.** `request_secret` with `delivery: "file"` shows the card "Sudo password" with **Private**, the agent's reason, one masked **Value**, the note that Sotto writes it to a file only the user can read and deletes it within an hour, and that it stays out of the chat but anything those commands print reaches the agent and its provider, **Save securely** and **Decline**, and when it closes. The value typed from the keyboard and Enter save it; the tool's answer names the file, which holds exactly the value (mode 0600 off Windows). `release_secret` deletes it.
2. **Several values, declined.** A card with **User name** shown as typed, **Password** masked and **Open sign-in page**; **Decline** from the keyboard answers `declined`.
3. **A secret reference typed into the browser.** The card names the site of the login page the test serves, and the agent's note says the value is typed only there. A reference (`secret-ref:` and 32 hex digits) is given, `browser_action` `type` with `secretRef` types it into the focused password field of a page the test serves, the page's title says the typed password was the one saved, and a second use is refused.
4. **The value goes nowhere else.** The canary value typed on the cards is absent from the window's page, every tool answer, main's output, and, once Sotto has quit and deleted its secret files, every file in Sotto's data folder, where the transcript and event store live. `tests/integration/secretRequestsCanary.test.ts` checks the same through every delivery.

## What the captures show

- **One value** (`card-1600x1000-*`, `card-1280x800-*`, `card-820x560-*` in dark and light, `card-1280x800-dark-reduced-motion.png`): the card above the composer, which says "Queued until you answer the card". At 820x560 the note wraps to two lines and the buttons stay on one.
- **Several values** (`fields-1600x1000-*`, `fields-1280x800-*`, `fields-820x560-*`, `fields-1280x800-dark-reduced-motion.png`): User name and Password, the note that Sotto keeps them for the agent's own Sotto tools to use once each and types them only on example.com, the site of the card's sign-in page, and Save securely, Open sign-in page with its outward arrow, and Decline. Needs you lists Workshop with Answer.

The card has no motion of its own, so reduced motion draws it the same.

Devin's approval profile lets `sotto_secrets` through without Devin's own question, as it does Sotto's other tools. That made it version 7, since Sotto refuses a version 6 file it wrote that has changed; `tests/unit/main/devinPolicy.test.ts` checks the list and the file's name.

## After the owner's review

The owner's review asked for six changes here, recorded in the November 27 amendments to ADR-0219 and ADR-0222:

- A reference is bound to the site of its card's sign-in page and typed only there. On another site it is refused, even under the browser grant. If the card named no page, Sotto asks the user every time and shows the page the value would go to; that answer never becomes the thread's grant.
- In a document where the agent ran its own script (`evaluate`), typing is refused before the value is taken, until another document commits in the main frame. Once a secret was typed into a page, `evaluate` stays off there until the page closes (since the second review, below).
- Every check runs before the value is taken, so an action refused for any reason leaves the reference unused. The page is checked again once the value comes back from the engine. If the page changed in the meantime, nothing is typed and the agent is told the reference is used.
- The card says truly where a value goes: the sign-in page's site, or a page the user says yes to. For a file, it says that anything the agent's commands print reaches the agent and its provider. The 32 `threads` catalogs were extracted again.
- While a document holds a typed secret, the agent gets no screenshot, no picture with a snapshot, no recording and no thumbnail of the page.
- A secret is also found in an address as a GET form encodes it. Neither Sotto's browser nor, since the second review, a paired host's Chromium keeps a back-forward cache.

These test files check the changes:

- `tests/integration/secretTypingRules.test.ts` (new, six tests)
- `secretParityCanary.test.ts` and `secretRequestsCanary.test.ts`
- `pageAutomation.test.ts`, `secretRequests.test.ts` and `secretTools.test.ts`
- `hostBrowser.test.ts` and `secretRequestCard.test.tsx`

Their new tests failed on the old code and pass. The spec's staging card now names its login page, which the spec needs, since a card that named none asks every time. The spec passed with the other three browser journeys. The gates are in [the first verification](2026-11-27-browser-parity.md#after-the-owners-review). It then ran again with `SOTTO_E2E_EVIDENCE=publish` to make the card's 14 captures again, and each one was looked at; every capture shows the new note. The captures are described above.

## After the second review

A second, independent review found where a typed secret could still be read back or tested. Looking for more of the same found three more. All are recorded in the November 27 amendments to ADR-0219, ADR-0220 and ADR-0222:

- `wait_for` compared words and the address with the page's own, which told a right first character from a wrong one. It now compares them with the secret masked.
- The mask matched only upper-case escapes, and an address with a stray `%` failed to decode, so `evaluate` stayed on. The mask now finds each character as itself or escaped in either case, once or twice over, and as JSON writes it.
- Back to a cached page gave its document back as new. A paired host's Chromium now starts without the back-forward cache, and a document given back anyway keeps the rules.
- A recording that failed to start blocked typing a secret on that page for good.
- An allowed type that failed after the value was taken did not tell the agent its reference was used. It now does, as an error.
- Found here: a site can write the value back into a later document, so `evaluate` now stays off for the page's life once a secret is typed there. A selector that compares part of an attribute is refused on such a page. While the document holds the secret, `snapshot` and `inspect` leave out what fields hold, so an edit after a "show password" button cannot bring the value out in pieces.

`pageAutomation.test.ts`, `hostBrowser.test.ts`, `secretTypingRules.test.ts` and `secretParityCanary.test.ts` check these. The back-forward cache tests now go A, then B, then back to A. The new tests failed on the old code and pass. The gates are in [the first verification](2026-11-27-browser-parity.md#after-the-second-review).

## After the third review

A third, independent review checked the round above. Looking for more of the same found three more, and a review of this round found six. All are recorded in the November 28 amendments to ADR-0219 and ADR-0222:

- A secret of more than about 5,000 characters, as a private key is, overflowed the regular expression the mask was built from. The error held the value, and every browser tool in the thread failed after it. A secret with a backslash in it took ever longer on a page of backslashes. The value is now found by a search over the text's bytes, read four ways, in time that grows with the text. A failure masks everything and says nothing of the value.
- A PIN that was also the page's port, as 5173, masked the port out of the address, and the agent lost its own page. The page's origin is now left whole, and whether the agent may see a page is decided from the page itself.
- A secret of one or two characters masked those characters in every address. A secret that short is no longer masked; the page's rules still hold.
- After a site's "show password" button, an agent could put the value on the clipboard: Control+A and Control+C, or a double click and a drag. While the document holds the secret those are refused, and no key or typing edits a field that holds it.
- When an allowed type failed after the value was taken, the user saw the agent's words, with a tool's name in them. The agent lost the notice that its reference was used if the page stopped being shared meanwhile. The user now sees plain words, and the agent keeps the notice.
- Found here: page words were cut, or had their spaces closed up, before they were masked, so a secret the cut split, or one with two spaces or a tab, reached the agent in part. They are now masked first, and read past the cut where the page itself cuts them.
- Found here: a failed typing repeated the error's own words, and a debugger or a paired host can put the command, secret and all, in those. Only Sotto's own words are said now.
- Found here: the element the user points at or comments on went into their message to the agent unmasked. It is masked as the agent's own reads are.
- Found in review: the address a picture is taken at went into the user's feedback unmasked. It is masked now.
- Found in review: a selector could compare a whole value, as `[value="4821"]`, and a site that keeps a field's value in an attribute, as React does, answers each guess. On a page a secret was typed into, a selector now compares only an attribute that names an element.
- Found in review: the rules for pictures and for selecting text ended with the document, but a site can show the secret again in a later one. Before a picture, or an action that could select text, Sotto now reads the document for it, and holds those rules while it is there. No recording starts, and no thumbnail is kept, on a page a secret was typed into.
- Found in review: a picked element's markup was masked only once its tags were gone, so a value in an attribute that held a `>`, or one split by tags, as a PIN drawn a digit to a box, came through. The markup is masked whole first, and an element whose tags split the value says none of its words.
- Found in review: the mask missed copies of the value that the page or Chromium makes: its spaces closed up, as a page shows them; a download's name, which Chromium makes safe before Sotto sees it; and what a field kept when its `maxlength` cut the value. Each is masked now.
- Found in review: `inspect` measured its answer before the last mask, which can be longer than the value. It measures it once masked.

`pageAutomation.test.ts`, `documentText.test.ts`, `secretTypingRules.test.ts`, `secretParityCanary.test.ts`, `browserTools.test.ts` and `hostBrowserService.test.ts` check these. The new tests failed on the old code and pass, with three kinds of exception. Two guard the new cut and failed only once their part of the fix was taken out: one has masks shorter than the secret, which would pull a cut counted in the masked text onto a split copy; the other has markup longer than is read. `documentText.test.ts` runs the new page read in a DOM, and three of its four tests fail once the read leaves out fields, shadow roots and frames. The check that no read is tried while a dialog is open fails once that guard is taken out.

Still open, since no rule in Sotto reaches them:

- A page's own Copy button, which copies the field with the agent's click.
- On Linux, Tab into a revealed field, which Chromium selects whole, putting it in the selection another program can read.
- On the test iPhone, a swipe read as a long press, which selects a word.
- The user's own clipboard, which still holds a value they pasted into the card.
- A value the page changes after it is typed, or shows as an image, a canvas or in a frame from another site: the mask and the page read find only text.
- A value the page writes back between Sotto's read and the action it checked, which the next action finds.
- A value the page's text splits with its own spaces, as a PIN in boxes, in a snapshot: only a picked element's markup is checked for that.
- A value of one or two characters, which nothing masks.

The gates are in [the first verification](2026-11-27-browser-parity.md#after-the-third-review).

## Not checked here

- A phone, the popup and Watcher showing the card with Decline only: unit tests cover the request's words and Decline.
- macOS and Linux file modes in the running app; unit tests check 0700 and 0600 off Windows and `icacls` on Windows.
- A screen reader's reading of the card.
