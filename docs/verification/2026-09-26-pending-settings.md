# A thread setting shows the moment it is pressed (#319)

Checked on September 26, 2026, on Windows, in the built app driven by `tests/e2e/pending-settings.spec.ts`
(`npm run build`, then `npx playwright test tests/e2e/pending-settings.spec.ts`: 1 passed). The provider is the e2e
fixture host. The spec holds its thread settings changes at the provider, lets them through or has the next one refused
through the e2e bridge's `settings` event, so each state stays on screen long enough to be looked at. The captures it
cites are in `artifacts/pending-settings/`; every capture the run takes lands in the ignored `artifacts/pending-settings-run/`.
The design is variant A of the mock-up, recorded in `docs/plans/2026-09-26-pending-settings.md`.

## Pending

- Pressing **Full access** on a thread in **Ask for approval** turned the chip to Full access at once, with a dashed
  outline in the activity colour and a small dot, while the saved mode was still Ask for approval. The caption beside
  the chips read "Claude still asks for approval until it confirms." (the fixture's provider is called Claude), and the
  chip's accessible description read "Switching to Full access. Ask for approval stays in force until Claude confirms."
- No "Saving..." showed, and the model, effort and permissions chips all stayed enabled. Focus stayed on the chip.
- `pending-dark-1280.png` and `pending-light-820.png`: dark at 1280x800 and light at the 820x560 minimum, where the
  caption takes a line of its own under the chips. At 1600x1000, 1280x800 and 820x560, in dark and light, every chip,
  the caption and any alert sat inside the window, the caption was not clipped, and nothing scrolled sideways.
- The dot's animation ran with motion allowed and stopped under reduced motion, whether set in Sotto's Appearance
  setting or by the system; the dashed outline stayed. `pending-reduced-motion.png`.

## Confirmed

- Letting the change through left the chip on Full access with a solid edge and no dot, the caption empty, and Full
  access saved.

## Refused

- A plain refusal of **Allow edits** put the chip back on Full access with no pending mark, and the alert under the
  chips read "Claude did not switch to Allow edits. The thread stays on Full access; nothing else changed." with
  **Try again**. The pane's own error line did not repeat it. `refused-dark-1280.png`, and `refused-light-820.png` at
  the minimum, where the sentence wraps and Try again takes its own line.
- **Try again** sent Allow edits again, which went through; the alert went and focus moved to the permissions chip.
- A refusal that says more, standing in for #317's lost answer, showed in its own words after the lead and without
  "nothing else changed": "Claude did not switch to Auto. Claude Code did not confirm the settings change, so Sotto
  stopped this thread's session, and "npm test" stopped with it. ..." `refused-lost-answer-dark-1280.png`.

## Keyboard

- Enter on the permissions chip opened its list, Escape closed it and handed focus back to the chip, and nothing was
  saved. After a choice, focus was on the chip.

## Not checked here

- The ordering of a prompt sent while a change is pending is proven in `tests/unit/renderer/agentCommandLanes.test.tsx`
  through the chip over a real coordinator, not in the running app.
- Model and effort in the running app: their pressed value shows without a mark, which the unit tests cover.
- A real provider. The fixture stands in for the provider's answer; `docs/perf/2026-09-26-settings-press-to-paint.md`
  times the real Claude and Codex adapters over their fake clients.
- macOS.
- `npm run design:capture` was not run: the chips' settled look did not change. The pending mark and the alert appear
  only while a change is pending or refused, which no design capture holds.
