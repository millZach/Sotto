# A thread setting shows the moment it is pressed (#319)

Checked on September 26, 2026, on Windows, in the built app driven by `tests/e2e/pending-settings.spec.ts`
(`npm run build`, then `npx playwright test tests/e2e/pending-settings.spec.ts`: 1 passed). The provider is the e2e
fixture host. Through the e2e bridge the spec holds its thread settings changes at the provider and lets them through
(`settings` with `hold` and `release`), has the next one refused outright (`refuse`) or refused with a reason
(`reject`), or has it answered with no result and an error, as a lost answer is (`settings-unconfirmed`), keeping the
change for the thread's next start, which `apply` stands for. The captures it cites are in `artifacts/pending-settings/`;
every capture the run takes lands in the ignored `artifacts/pending-settings-run/`. The design is variant A of the
mock-up, recorded in `docs/plans/2026-09-26-pending-settings.md`.

The fixture's model names its provider "Claude" and its threads carry no provider, so the running app says "Claude"
here where a real Claude Code thread says "Claude Code". Giving the shared fixture a provider would change what every
other spec and design capture over it shows, so it was left.

## Pending

- Pressing **Full access** on a thread in **Ask for approval** turned the chip to Full access at once, with a dashed
  outline in the activity colour and a small dot, while the saved mode was still Ask for approval. The caption beside
  the chips read "Claude still asks for approval until it confirms.", and the chip is described by that caption.
- No "Saving..." showed, and the model, effort and permissions chips all stayed enabled. Focus stayed on the chip.
- `pending-dark-1280.png` and `pending-light-820.png`: dark at 1280x800 and light at the 820x560 minimum, where the
  caption takes a line of its own under the chips. At 1600x1000, 1280x800 and 820x560, in dark and light, every chip,
  the caption and the send button sat inside the window, the caption was not clipped, and nothing scrolled sideways.
- The dot's animation ran with motion allowed and stopped under reduced motion, whether set in Sotto's Appearance
  setting or by the system; the dashed outline stayed. `pending-reduced-motion.png`.

## Confirmed

- Letting the change through left the chip on Full access with a solid edge and no dot, the caption empty, and Full
  access saved.

## Refused

- A plain refusal of **Full access** put the chip back on Ask for approval with no pending mark, and the line under the
  composer's row read "Claude did not switch to Full access. The thread stays on Ask for approval; nothing else
  changed." with **Try again**. The pane's own error line did not repeat it.
- The attach button, the three chips and the send button sat at the same place in the composer with the line as
  without it, measured at every size in dark and light; the composer grows by the line's height under them.
  `refused-dark-1280.png`, and `refused-light-820.png` at the minimum, where the sentence wraps and Try again takes its
  own line.
- **Try again** sent Full access again, which went through; the line went and focus moved to the permissions chip.
- A refusal with a reason of its own showed that reason after the lead, with no claim that nothing else changed:
  "Claude did not switch to Allow edits. Wait for this Claude turn to finish before changing settings."

## Unconfirmed

- A press on **Auto** answered with no result and #317's lost-answer error kept the chip on Auto with the dashed edge
  and dot. The line under the row read "Claude has not confirmed Auto. Claude Code did not confirm the settings change,
  so Sotto stopped this thread's session, and "npm test" stopped with it. The session starts again with the new
  settings the next time you use the thread. Ask Claude to start it again if you still need it." It offered nothing to
  press, the caption was empty, and the chip was described by that line.
- The saved mode was still Full access, main's state listed the change as unconfirmed, and all three chips were
  fixed, since main takes no other action on the thread until it knows. `unconfirmed-dark-1280.png` and
  `unconfirmed-light-820.png`; nothing clipped at any size.
- Starting the thread on the kept change (`apply`) showed Auto on the thread, main let the change go, and the chip read
  normally, enabled, with the line gone.

## Keyboard

- Enter on the permissions chip opened its list, Escape closed it and handed focus back to the chip, and nothing was
  saved. After a choice, focus was on the chip.

## Not checked here

- The ordering of a prompt sent while a change is pending is proven in `tests/unit/renderer/agentCommandLanes.test.tsx`
  through the chip over a real coordinator, not in the running app. The chips fixed while a prompt is on its way, a
  refusal kept while another chip is pressed, a press back to the value in force keeping its mark while the save before
  it is in flight, and a change main lets go without the thread showing it are unit tests
  (`tests/unit/renderer/threadOptions.test.tsx`, `tests/unit/renderer/pendingSettings.test.ts`).
- The managed composer (Manage), which places the same line under its own footer, in the running app.
- Model and effort in the running app: their pressed value shows without a mark, which the unit tests cover.
- A real provider. `docs/perf/2026-09-26-settings-press-to-paint.md` times the real Claude and Codex adapters over
  their fake clients.
- macOS.
- `npm run design:capture` was not run: the chips' settled look did not change. The pending mark and the lines under
  the row appear only while a change is pending, refused or unconfirmed, which no design capture holds.
