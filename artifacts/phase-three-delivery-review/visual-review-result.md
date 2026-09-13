# Phase 3 delivery visual delta review: independent Opus 5 critic

- **Build reviewed:** the one named in `delivery-visual-ready.json`.
  - Source `387cbb8643239c9eb7cf5a8675bd0f1b52006855`.
  - Worktree `.worktrees/phase3-final`; its `git rev-parse HEAD` is that same commit.
  - `out/build-provenance.json`: sourceCommit `387cbb8…`, buildSha256 `757f1b82d038e93a973eadac4c734936ed936a5b229323187426a064156f1d49`, buildInputsRevision `cb5b581f…`, 84 artifacts. This matches the ready file.
  - I ran only `.worktrees/phase3-final/out/main/index.js`. I did not rebuild, and I did not touch main `out`.
- **Method:**
  - Real Electron app with owned `sotto-e2e-delivery-review-*` profiles (removed afterwards) and the `success` E2E fixture providers.
  - E2E isolated clipboard. No microphone, no paid or native providers, no source edits, no remote actions, no subagents, no full suite.
  - Page screenshots only. No native browser view was involved, so desktopCapturer was not needed.
  - The display is at 150% scaling, so the PNGs are 1.5× the CSS size.
- **Scripts and logs** (in `.worktrees/phase3-orchestration/`):
  - `delivery-visual-review-themes.mjs` / `.log`
  - `delivery-visual-review-recovery.mjs` with `-thread.log`, `-personal.log` and `-held.log`
  - `delivery-visual-review-focus.mjs` / `.log`
- **Captures:** `artifacts/phase-three-delivery-review/` (17 PNGs). I opened and read every capture cited below.
- **References:**
  - The user's two attachments: the rejected accent picker and the T3 Appearance page, with separate Ocean rings.
  - The prior report `artifacts/phase-three-final-review/visual-review-result.md`.
  - `docs/verification/phase-3-final-visual-fixes.md` and `phase-3-draft-recovery-ui.md`.
  - The ready file's root verification: 29 Electron journeys, including branding. I did not rerun branding.

## Scenarios and sizes inspected

| Journey | Sizes / schemes | Observed |
|---|---|---|
| Fresh profile (only `onboardingComplete`) → Settings → Appearance top | 1600×1000 dark; 1280×860 light | **Defaults:** Tide for both halves, contrast 100, glass 80, no custom themes.<br>**Three mode previews:** System (diagonal light/dark split), Light and Dark. The chosen tile has the accent ring and `aria-pressed`. This matches the T3 reference's three wireframe tiles.<br>**Description:** one sentence ("Choose light, dark or system, then a theme for each. The floating widget always follows the Windows light or dark setting.").<br>Create theme / Add theme sit beside the "Themes" heading. [01](../../artifacts/phase-three-delivery-review/01-fresh-appearance-top-1600-dark.png) [04](../../artifacts/phase-three-delivery-review/04-fresh-appearance-top-1280-light.png) |
| Gallery | 1600 dark, 1280 light, 820×560 system (OS dark) | **Names:** exactly **Sotto, Rose, Fern, Tide, Copper, Dusk**, one line each at 14px. Each tooltip is the name. Nothing clipped.<br>**Circles:** every two-circle card has a 10px gap. With both Tide halves chosen there are 4 markers (ring and sun or moon badge per circle), each inside its own circle and clear of the other. Measured at all three sizes.<br>**Visual:** rendered like the T3 Ocean card, with two separate rings. The chosen card has a tinted fill. [02](../../artifacts/phase-three-delivery-review/02-fresh-gallery-1600-dark.png) [03](../../artifacts/phase-three-delivery-review/03-tide-both-halves-card-1600-dark.png) |
| Custom long name, keyboard | 820×560 dark, then 1280×860 dark | **Creation:** Enter on "Duplicate Dusk" opens the editor with the name field focused. I entered the 48-character maximum "Extraordinarily Luminous Midnight Harbour Review" and chose Create theme. The toast says "…created. It’s now your dark theme." The mark and chrome switch to the new palette. [05](../../artifacts/phase-three-delivery-review/05-duplicate-dusk-long-name-editor-820x560-dark.png)<br>**Card:** the name wraps to 2 lines with nothing clipped. The tooltip and aria-label carry the full name, and the name does not overlap the actions.<br>**Keyboard:** Tab from the title reaches Duplicate → Edit → Export → Remove. The actions become visible and the Remove focus ring is clear. Shift+Tab×2 then Enter on Edit opens "Edit theme" with the full name. Clicking the title makes it the dark theme. [06](../../artifacts/phase-three-delivery-review/06-long-name-card-keyboard-remove-820x560-dark.png) [07](../../artifacts/phase-three-delivery-review/07-gallery-long-custom-1280-dark.png)<br>**Focus after close:** see Finding 1. |
| Thread saved answer after a full restart, native question absent | 1280×860 dark and light; 820×560 dark and light (head and actions) | **Before restart:** filled Other "A quiet shore", both checks and Travel notes, then **edited the notes again** to a longer revision. There was no recovery card while the live card showed, and 0 answer calls. Then the app process closed.<br>**After restart and connect:** no live card. "Claude no longer shows this question. This answer was not sent." Answers show the **latest** revision.<br>**Remount:** leaving for Settings and returning keeps the latest text.<br>**Card contents:** 0 inputs in the card, no "Send answers" button anywhere, and only **Copy answer** and **Discard**.<br>**Text sizes:** title 15px, sentence 14px, questions 14px muted, answers 15px at full ink, buttons 14px. No horizontal clipping or overflow at 820. The long answer wraps cleanly.<br>**Composer:** visible and untouched. "Newer composer text", normal placeholder, enabled. [thread 1280 dark](../../artifacts/phase-three-delivery-review/thread-saved-answer-1280-dark.png) [820 light](../../artifacts/phase-three-delivery-review/thread-saved-answer-820-light.png) [820 light actions](../../artifacts/phase-three-delivery-review/thread-saved-answer-820-light-actions.png) |
| Copy | 820×560 dark | "Copied" appears beside Discard and clears after about 2.5s. The clipboard holds question/answer pairs with the **latest** notes and not the superseded text. [copied](../../artifacts/phase-three-delivery-review/thread-copied-820-dark.png) |
| Discard confirmation, by keyboard | thread 1280 light; personal 1280 dark | **Opening:** Enter on Discard shows "Discard this answer? It can’t be restored." with Keep focused (visible ring) and "Discard answer" in the danger color.<br>**Escape:** returns focus to Discard.<br>**Discarding:** Enter, Tab, Enter removes the card, and focus moves to the transcript log. The owner's drafts on disk become empty. The composer text is unchanged and the answer IPC was called 0 times. [thread](../../artifacts/phase-three-delivery-review/thread-discard-confirm-1280-light.png) [personal](../../artifacts/phase-three-delivery-review/personal-discard-confirm-1280-dark.png) |
| Personal chat, same journey | 1280 light and dark; 820×560 dark and light | Same results with "Codex no longer shows this question." The composer keeps "Reply to Codex" and "Newer composer text" and is not in answer mode. Copy, discard, composer and 0 answer calls all pass. [1280 light](../../artifacts/phase-three-delivery-review/personal-saved-answer-1280-light.png) [820 dark](../../artifacts/phase-three-delivery-review/personal-saved-answer-820-dark.png) [820 dark actions](../../artifacts/phase-three-delivery-review/personal-saved-answer-820-dark-actions.png) |
| Held thread answer across a restart | 820×560 dark | **Before restart:** Send answers was held on the IPC (1 call) and the draft has `held=true`.<br>**After restart and connect:** "Unconfirmed answer" with a warning-coloured left rule and "Claude no longer shows this question. The answer may have arrived, so Sotto won’t send it again."<br>**Discard:** the confirmation says "Discard Sotto’s copy? This doesn’t cancel or resend the answer." Keep returns focus to Discard.<br>**Copy:** shows "Copied".<br>**Afterwards:** still `held=true`, **0 answer calls after restart (no replay)**, composer untouched. [held](../../artifacts/phase-three-delivery-review/held-discard-confirm-820x560-dark.png) |
| Native form context and compact layout | root captures only | Read `phase-three-final-visual-fixes/form-and-permission-grid-1280x800-dark.png` and `permission-compact-820x560-light.png`.<br>**Grid:** the form's `mcpServer/elicitation/request` explanation shows once.<br>**Compact tabs:** at 820 there are tabs, and the permission instruction appears once as the placeholder. Deny/Allow are reachable. |

## Material findings

### 1. Low–medium (keyboard accessibility, confirmed in the build): closing the theme editor drops keyboard focus to `<body>`
- **Where:** `src/renderer/src/features/settings/themes/ThemeEditor.tsx:252-259`.
- **What the code intends:** a mount `useEffect` saves `document.activeElement` so focus can go back to it on unmount.
- **Why it fails:** the name input has `autoFocus` (around line 695). React applies that during commit, before passive effects run. So the saved element is the editor's own name `INPUT`, not the button that opened the editor. On close that input is disconnected, `previous.isConnected` is false, and nothing gets focus.
- **Observed** (`delivery-visual-review-focus.log`), four keyboard-only runs:
  - Create theme, then Escape.
  - Duplicate Dusk, then Escape.
  - Duplicate Dusk, then Enter on Close.
  - Duplicate Dusk, then Enter on Cancel.

  Each run logged `focus on open=INPUT; after close=BODY`. Closing the editor opened from the long card's Edit button did the same.
- **Impact:** a keyboard or screen-reader user who opens Create, Duplicate or Edit and then cancels or closes loses their place in the long Settings page. The next Tab starts from the top of the document, not the theme card or button they used. Every other keyboard path I tried returns focus correctly: gallery Tab order, recovery Discard/Keep/Escape, and removal to the transcript.
- **Suggested direction** (root decides): capture the opener before the panel mounts. For example, record it in `openThemeEditor` or in a `useLayoutEffect` or ref initialiser in the session wrapper that runs before the child input's autoFocus. Or restore to the triggering card or button by ID.

No other material defects were found in the bounded delta.
- **Appearance:** the fresh top and gallery match the reference structure: three mode previews, six own names, and separate selected-half rings and badges.
- **Long names:** clamp to two lines with the full tooltip, as intended.
- **Saved-answer recovery:** reads cleanly at 1280 and 820 in both schemes, for thread and personal. It shows and copies the latest revision, and keeps it across a view remount.
- **Discard:** confirmation and focus behave correctly.
- **Held answers:** never replayed.
- **Composer:** the newer composer draft is never touched.
- **Sending authority:** the recovery surface exposes no sending authority. It has no inputs and no Send answer button, and 0 answer IPC calls were made after restart.

Non-material observations, not findings:
- The "Copied" status is 13px muted text.
- In an empty thread, the "What is next for this thread?" hero sits above the card. This is a known limit in the recovery doc.
- At 820×560 the card is taller than the 240px transcript viewport and scrolls above the composer. This is intentional.
- The creation toast briefly covers the footer status.
- Right after Tab, an action's opacity reads 0.17 mid-transition. It is fully visible by the capture.

## Limits
- **Branding** (mark, orb, widget): not rerun. I rely on the two earlier independent verifications and root's final 29-journey pass. The mark changing to the custom palette was seen incidentally in capture 07.
- **Remount:** "latest text" was proven across two revisions saved before restart, plus one Settings round-trip. I did not recreate the specific in-session remount-during-pending-save race that b6030b6 fixes. That rests on root's unit tests.
- **Not run:**
  - The disconnected and changed-question recovery states (covered in root's committed captures and E2E).
  - 1600 for recovery.
  - The native browser, terminal, diff and provider matrix (unchanged).
  - A packaged build (root runs it after this exit).
  - macOS.
  - Display scaling other than 150%.
  - Real Codex or Claude, and the OS clipboard (the E2E isolated clipboard was used).
- **System scheme:** emulated with `prefers-color-scheme`, not a Windows theme switch.
- **Harness fix, not a finding:** my first themes run crashed in my own measurement helper, which assumed two circles on a dark-only custom card. I fixed it and reran the whole script from a fresh profile. The results above are from that clean rerun.

## Apps and UI lease
All owned Electron apps are closed. No `electron.exe` process with `phase3-final` in its command line remains. The owned temp profiles are deleted. **The Windows UI/focus lease is released back to root.**
