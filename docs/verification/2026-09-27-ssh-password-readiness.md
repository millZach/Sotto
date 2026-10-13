# SSH password notification readiness (#422)

The password-reuse fixture now awaits the launcher's real `onPrompt` notification
before checking its kind and exact text and answering it. Connection settlement is
observed immediately: failure rejects the pending notification, and cleanup after
an earlier assertion cannot leave the connection rejection unhandled. Successful
connection without the expected prompt also fails explicitly.

The one-prompt, three authenticated operations, no-secret-in-events and stale-answer
refusal assertions are unchanged. There is no production, timeout or retry change.

## Original failure and controlled comparison

The #384 full run at `d1c80482` reported 5,844 passed, 140 skipped, one SSH fixture
failure and one unhandled cancellation in 963.79 seconds. Its initial bare
`vi.waitFor` received no prompt within that API's separate one-second default.
Cleanup then cancelled the still-pending connection promise. The involved SSH
source and fixture files were identical to main. That historical run did not
retain detailed child timestamps, so its precise scheduling cause is not claimed.

A temporary diagnostic pauses the real first child before importing the existing
fake SSH program. It releases the child only when the original predicate exhausts
its existing deadline, then uses the unchanged password/helper/forwarding sequence.
An initial trace observed the poll failure at 1,079.69 ms, actual password at
1,491.70 ms and all original authentication assertions completed by 2,323.23 ms.

The final comparison injected the same boundary into copies of the complete
original and repaired `sshLauncher.test.ts`, without changing their password
assertions. Original: one failed, 26 skipped. Repaired: one passed, 26 skipped.
In the repaired run the original counterfactual poll ended at 1,076.21 ms and the
real password arrived at 1,471.16 ms. No arbitrary delay or production change was
needed. The copied tests were moved to ignored `.probe.txt` artifacts afterward;
the ordinary test runs without the diagnostic child gate.

## Verification

At implementation `067aa295`, all 64 focused tests pass with two skipped across the
complete SSH launcher, launch-script, SSH configuration and suggestions files.
Typecheck, lint and notices pass (174 components). Independent review and the full
two-worker gate are pending. This test-only change has no rendered surface or new
Electron journey.

The tests use owned temporary folders, fake SSH programs and synthetic credentials.
`SOTTO_PERF_DATA` points to a verified-absent owned path. No host, personal profile
or paid provider is contacted. Controlled timing receipts are retained below;
intermediate diagnostics remain ignored.

- [Original held-child trace](../../artifacts/review-422/original-startup.json)
- [Repaired notification trace](../../artifacts/review-422/fixed-startup.json)
