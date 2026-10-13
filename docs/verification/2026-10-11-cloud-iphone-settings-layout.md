# Settings > Cloud iPhone laid out like the other Settings pages

October 11, 2026, on Windows 11, from `tests/e2e/cloud-iphone.spec.ts` against the built app, after the fake run.cloud session that spec runs (ADR-0047). No real run.cloud key or minutes were used.

## What changed

Settings > Cloud iPhone was the one Settings page in boxed cards. It opened with a line repeating its own subtitle, put its key buttons at the left under the field, and showed this month's minutes as two loose lines over a meter that barely showed. Zach compared three layouts that follow the other pages, beside today's, and picked A: the rows grouped under small headings, as Settings → Git groups its own. He kept the rewording the layouts showed.

- **run.cloud** holds the key. Its note says what the old intro line and card text said: agents test native iOS builds on a run.cloud simulator, each session asks first, and the build goes to run.cloud in the EU and is deleted when the session ends. The key's buttons sit at the right under the field, as Verify key does on Cleanup. A saved key reads "Key saved", as Cleanup's does.
- **Spending** holds the monthly cap, this month's minutes as a row with the meter where a control goes, and the idle minutes. Its note gives the price.
- **Recent sessions** lists each session on one line: the thread, the day and the minutes.

The group heading is now one component, `SettingsGroup`, which Git uses too, so the two pages cannot drift apart. Git looks the same as before.

## What was shown

- The three headings are run.cloud, Spending and Recent sessions, in that order. The key field says "Key saved" and the session from the run is listed.
- At 1600x1000, 1280x800 and 820x560, in light and dark, nothing overflows the form or the window and no control is cut off, at the top of the page and scrolled to the bottom.
- Every heading, note, label, description, minutes line and session line meets 4.5:1 on its surface, in light and dark and at every size.
- Before any session, with the key typed on the page: "No sessions yet.", run.cloud's refusal of a wrong key and "Key saved." each meet 4.5:1 in light and dark. The refused key is not saved.
- With Reduced motion on, the page arrives without its slide and nothing on it animates, and it still fits. With Reduced motion following the system, it arrives as every Settings page does.
- From the key field, Tab goes to Remove key, then the monthly cap, then the idle minutes. Replace key stays disabled, and out of the path, until a new key is typed.
- The meter reads its value as words, such as "1 of 750 minutes".
- `tests/e2e/git-settings.spec.ts` still passes. Both specs now measure layout and contrast through `tests/e2e/support/settingsChecks.ts`, and Git's reads only its own panel.

## Captures

In `artifacts/cloud-iphone/`, added by hand as that folder's others are:

- `settings-1600x1000-dark.png`, `settings-1280x800-dark.png` and `settings-1280x800-light.png`: the page after the session.
- `settings-820x560-dark.png`: the minimum window, at the top.
- `settings-820x560-light-bottom.png`: the minimum window, scrolled to the bottom.

`settings-dark.png` and `settings-light.png` there are the October 3 layout, which `2026-10-03-cloud-iphone.md` cites.

## Not shown here

- The three variants Zach compared are kept on the tag `prototype/cloud-iphone-settings-layout`.
