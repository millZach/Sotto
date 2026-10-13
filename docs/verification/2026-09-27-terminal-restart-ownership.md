# Terminal restart ownership

Issue #387. The restart implementation and shared folder preparation were reviewed
at `6915633f`; integration `2a03b2e2` includes the Closed listing/output work from
issue #384 at `d1c80482` and main `dcd5db86`.

Restart reserves the terminal before awaiting its launcher. Close and disposal
invalidate the reserved generation, so a late launcher or spawner cannot publish
or retain an orphan PTY. Failed launcher lookup releases the reservation for a
retry. Initial checkout preparation remains shared across Close and Reopen; only
the current generation adopts the prepared folder and starts its process.

## Causal regressions

Deterministic held launcher and spawner tests cover overlapping restart/reopen,
Close, disposal, failure and retry. Each admitted PTY remains owned and is killed
exactly once. A held checkout followed by Close and Reopen originally settled the
reopen before its folder existed. The repaired path waits for both checkout and
working-directory preparation, then creates exactly one PTY in the correct folder.

Integrating #384 exposed a second catch boundary: a reopen refused at the active
limit was changed from Closed/exited to unavailable. A desired-behavior assertion
failed before the outer catch was repaired. A busy refusal now preserves the
entire Closed metadata record while releasing the restart reservation. Distinct
Closed rows racing for the last active slot still admit only one process.

## Verification

- At `2a03b2e2`, all 33 focused main, IPC and renderer terminal tests pass across
  three files. Typecheck, lint and notices pass (174 components).
- Build passes. The real Electron `terminal-closed-output.spec.ts` journey passes
  with one worker: one test in 9.3 seconds. It closes a real ConPTY terminal,
  checks released output and its disabled Closed row, exposes the existing Reopen
  button by hovering, checks its hit target, focuses and clicks normally, then
  types a shell command whose response cannot match the echoed input.
- The same terminal ID, command and working folder return with fresh output.
  Light/dark, reduced motion and all three required sizes are covered by the
  inherited journey. The fresh minimum light [reopened terminal capture](../../artifacts/review-387/reopened.png)
  was inspected: the command response and live prompt are visible. The new
  geometry receipt is `artifacts/review-387/reopen-hit.json`.
- All profiles, project folders and processes are owned temporary test data.
  No live provider is used. Historical #384 captures were restored after copying
  the new evidence into this issue's folder; no design baseline was regenerated.
- Root and independent native reviews reported no findings on the shared-folder
  correction. Root review of the dependency integration also reported no findings;
  independent final integration review and the full two-worker suite are pending.

The PR waits for #384 to reach main, so its final diff owns only restart lifecycle
behavior. Full gates and final integrated CI remain required before merge.
