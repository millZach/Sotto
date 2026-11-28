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
- In a document where the agent ran its own script (`evaluate`), typing is refused before the value is taken, until another document commits in the main frame. The same holds for a page whose address held the value.
- Every check runs before the value is taken, so an action refused for any reason leaves the reference unused. The page is checked again once the value comes back from the engine. If the page changed in the meantime, nothing is typed and the agent is told the reference is used.
- The card says truly where a value goes: the sign-in page's site, or a page the user says yes to. For a file, it says that anything the agent's commands print reaches the agent and its provider. The 32 `threads` catalogs were extracted again.
- While a document holds a typed secret, the agent gets no screenshot, no picture with a snapshot, no recording and no thumbnail of the page.
- A secret is also found in an address as a GET form encodes it. Sotto's browser keeps no back-forward cache, and a document the cache restores on a paired host's Chromium is treated as the same document.

These test files check the changes:

- `tests/integration/secretTypingRules.test.ts` (new, six tests)
- `secretParityCanary.test.ts` and `secretRequestsCanary.test.ts`
- `pageAutomation.test.ts`, `secretRequests.test.ts` and `secretTools.test.ts`
- `hostBrowser.test.ts` and `secretRequestCard.test.tsx`

Their new tests failed on the old code and pass. The spec's staging card now names its login page, which the spec needs, since a card that named none asks every time. The spec passed with the other three browser journeys. The gates are in [the first verification](2026-11-27-browser-parity.md#after-the-owners-review). It then ran again with `SOTTO_E2E_EVIDENCE=publish` to make the card's 14 captures again, and each one was looked at; every capture shows the new note. The captures are described above.

## Not checked here

- A phone, the popup and Watcher showing the card with Decline only: unit tests cover the request's words and Decline.
- macOS and Linux file modes in the running app; unit tests check 0700 and 0600 off Windows and `icacls` on Windows.
- A screen reader's reading of the card.
