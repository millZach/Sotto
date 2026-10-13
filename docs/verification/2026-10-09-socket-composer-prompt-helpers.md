# Adapt socket composer journeys to the rich prompt

October 9, 2026. The full suite on pushed `09efdc7dd` reported one failed file: two failures, 8,858 passed and 276 skipped across 768 files (995.16 seconds). `socketComposer.test.tsx` retained textarea `fireEvent.change` and value assertions in two removal-added manual journeys, while the incoming composer uses Tiptap. Both failed with `The given element does not have a value setter`. This is an integration omission on this branch; no clean-main attribution is claimed.

The existing shared `setPromptText` and `promptText` helpers now drive and read those fields. The active-field assertion uses `contenteditable=true`. The held autosave/connection-loss test still checks the latest text survives reconnect with no user send; the successive socket-edit test still proves exactly one send of the selected text while the host's unrelated draft stays intact. No production code, deadlines or test counts changed.

Red: the isolated file repeated two failures and 15 passes (12.98 seconds). Green: all 17 tests pass (17.19 seconds), followed by the recorded typecheck and lint gates below. The correction is its own follow-up and is pushed before rerunning the complete suite and remaining local gates. Memory was checked before every run; all started above 3 GiB.

| Run | Result | Seconds | Free memory, KiB |
| --- | --- | ---: | ---: |
| `npx vitest run tests/integration/socketComposer.test.tsx --maxWorkers=2` | 2 failed / 15 passed: value setter error | 12.98 | 9339768 |
| `npx vitest run tests/integration/socketComposer.test.tsx --maxWorkers=2` | 17 passed | 17.19 | 8776508 |
| `npm run typecheck` | PASS, exit 0 | 30.23 | 8321292 |
| `npm run lint` | PASS, exit 0 | 17.36 | 9554640 |
