# Secret requests verification

November 27, 2026, on `feat/browser-parity-and-secret-requests`, from `origin/main` at 9220d0129, on Windows 11 with Node 24.22.1. This is [ADR-0219](../adr/0219-an-agent-asks-for-a-secret-on-a-private-card.md)'s secret request card, behind the `secret-requests` Owl feature. `tests/e2e/secret-requests.spec.ts` launched the built app with `SOTTO_OWL_FEATURES=secret-requests=1` over the fake Claude Code provider and ran with `SOTTO_E2E_EVIDENCE=publish`. The agent's calls go through `window.sottoE2E.secretTool`, the same `sotto_secrets` server a provider reaches, bound to the Workshop thread. Every capture in `artifacts/secret-requests/` was looked at.

## What the spec checks

1. **A secret file for a command.** `request_secret` with `delivery: "file"` shows the card "Sudo password" with **Private**, the agent's reason, one masked **Value**, the note that Sotto writes it to a file only the user can read and deletes it within an hour, **Save securely** and **Decline**, and when it closes. The value typed from the keyboard and Enter save it; the tool's answer names the file, which holds exactly the value (mode 0600 off Windows). `release_secret` deletes it.
2. **Several values, declined.** A card with **User name** shown as typed, **Password** masked and **Open sign-in page**; **Decline** from the keyboard answers `declined`.
3. **A secret reference typed into the browser.** A reference (`secret-ref:` and 32 hex digits) is given, `browser_action` `type` with `secretRef` types it into the focused password field of a page the test serves, the page's title says the typed password was the one saved, and a second use is refused.
4. **The value goes nowhere else.** The canary value typed on the cards is absent from the window's page, every tool answer, main's output, and, once Sotto has quit and deleted its secret files, every file in Sotto's data folder, where the transcript and event store live. `tests/integration/secretRequestsCanary.test.ts` checks the same through every delivery.

## What the captures show

- **One value** (`card-1600x1000-*`, `card-1280x800-*`, `card-820x560-*` in dark and light, `card-1280x800-dark-reduced-motion.png`): the card above the composer, which says "Queued until you answer the card". At 820x560 the note wraps to two lines and the buttons stay on one.
- **Several values** (`fields-1600x1000-*`, `fields-1280x800-*`, `fields-820x560-*`, `fields-1280x800-dark-reduced-motion.png`): User name and Password, the note that Sotto keeps them for the agent's own Sotto tools to use once each, and Save securely, Open sign-in page with its outward arrow, and Decline. Needs you lists Workshop with Answer.

The card has no motion of its own, so reduced motion draws it the same.

## Not checked here

- A phone, the popup and Watcher showing the card with Decline only: unit tests cover the request's words and Decline.
- macOS and Linux file modes in the running app; unit tests check 0700 and 0600 off Windows and `icacls` on Windows.
- A screen reader's reading of the card.
