# Create a thread while another draft is saved

September 19, 2026. Branch: `fix/new-thread-saved-draft`.

## Failure and cause

The Threads page refused New thread with "Send or clear your draft before creating another thread."
The visible manual composer was empty. Read-only inspection of the installed app's saved state
confirmed a nonempty coordinator draft bound to a different thread, with no pending outbox action.
No prompt text or attachment contents were printed or copied into this report.

The `create-thread` handler applied the coordinator's draft guard to manual creation too.
Its completion path also cleared and retargeted the coordinator draft even for `managed: false`.
The beta hides the coordinator surface, making the error especially difficult to resolve.

Manual creation now leaves the coordinator draft alone. Managed creation retains the guard and
its existing draft setup. No assignment, prompt submission, or permission answer is added by
opening a manual thread.

## Reproduction and verification

- Before the fix, `npx vitest run tests/unit/main/threadNavigationDelivery.test.ts -t 'creates a manual thread'`
  failed with the exact warning instead of creating the thread.
- The regression covers text with an attachment, an image-only draft, and a pending question's answer.
  It checks the original thread and request bindings, attachments, saved revisions, assignments,
  restart persistence, and that creation is the only provider action.
- Explicit and legacy managed creation still refuse to replace an unfinished draft.
- `npm run build` and `npx playwright test tests/e2e/thread-creation.spec.ts --workers=1` passed both tests.
  The new test uses a separate Electron profile with voice disabled, a saved draft on Workshop,
  and an empty visible composer on Docs. It presses New thread in Sotto test, creates the thread,
  and sends a fresh prompt while confirming the Workshop draft remains unchanged.
- Visually inspected [the created thread after sending](../../artifacts/new-thread-saved-draft/created-and-sent.png).
  The new pane and composer are usable and the draft warning is absent. Existing creation,
  model options, screenshots, and managed-send behavior also passed the neighboring Electron test.
- Typecheck, lint, and third-party notices verification passed.
- `npm test -- --maxWorkers=2`: 3,755 passed, 28 skipped, two failed. The failures are existing
  data-dependent performance benchmarks: `longTranscript.perf.test.tsx` requires at least one
  message in `workspace.json`, and `statePipeline.perf.test.ts` reads a last message that is absent.
  Both reproduced with the unchanged `HEAD` coordinator code (the fixed file was restored afterward).
  These benchmarks still expect transcript text in a workspace snapshot, while current history
  lives in the event store. The full suite is therefore not green on this local profile.
- Independent standards and behavior review found no issues. Its suggested explicit assertion
  that the answer fixture is bound to `question-a` was added; all three draft regression cases
  passed again afterward.

## Delivery boundary

The local source and development build contain the fix. The installed app was inspected read-only;
its profile, executable, and running session were not changed. Electron tests use fixture providers
and do not establish live provider compatibility. This change does not alter provider protocols or layout.
