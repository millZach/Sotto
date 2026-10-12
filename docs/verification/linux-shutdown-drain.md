# Linux shutdown drain

October 12, 2026, forge (Omarchy/Hyprland), Node 24.21.0, Electron 43.1.0. Issue [#871](https://github.com/millZach/Sotto/issues/871), starting revision `65bcc0e6297a825d2125f8937a6aaee22c17969b`.

**Verified:** production shutdown registration and drain modules under real Electron, receiving synthetic `PrepareForShutdown` on a private D-Bus inside nested Hyprland. **Not exercised:** an actual system shutdown, reboot or logout, deliberately excluded by the brief. The stand-in local runtime controls its pending write; this proof does not claim a live provider finishes within the window.

## What changed

Linux now retains Electron's shutdown delay inhibitor and explicitly calls `app.quit()`. Electron does not do that itself on Linux. The drain's Linux shutdown cutoff is four seconds, compared with ten for an ordinary quit. Local provider cancellation, accepted-write persistence and cloud iPhone release start before waiting on phone-access cleanup; ordinary quits, Windows and macOS keep their order and behavior.

Linux also re-registers the first shutdown listener through Electron's public API. Electron 43's first `newListener` hook reads shutdown listener count before adding the listener. The production proof acquires the inhibitor with shutdown as the first power-monitor listener, without fixture warm-up. The unit regression reproduces the emitter ordering. [Primary sources and logind limits](../research/linux-shutdown-drain.md).

## Native signal and inhibitor proof

Run from this worktree, after `mise exec node@24.21.0 -- npm ci`:

```sh
mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/linux-shutdown-drain/nested mise exec node@24.21.0 -- node scripts/verify-linux-shutdown-drain.mjs .cache/linux-shutdown-drain/private-bus
```

The reusable script transpiles the production `quitDrain.ts` and `hostQuitDrain.ts` into an isolated Electron entry. Both system and session bus addresses point only at its private daemon. That daemon has no service activation directories; `tests/fixtures/fakeLogind.py` exposes only inert inhibitor and signal methods. It returns Unix pipe descriptors, records EOF when Electron releases them, and never asks the system to perform a power operation. Abstract Unix sockets avoid the worktree path exceeding the Unix socket name limit. Profiles, configuration and JSON event evidence stay under ignored `.cache/` in a fresh run directory.

Five cases passed:

- **Unprevented control:** the native shutdown signal reached Electron, its inhibitor FD was released, and Electron remained alive until the harness stopped it. This confirms no automatic app quit.
- **Held drain:** the production shutdown handler retained the FD while local persistence and phone cleanup were held, then exited with code zero at its four-second cutoff and released the FD.
- **Held phone cleanup, released local write:** local cleanup started first, its controlled write drained when released, and the still-held phone cleanup did not prevent the bounded exit. Repeated notices did not start a second local drain.
- **Settled drain:** releasing the local write with phone cleanup already settled led to a normal quit and inhibitor release without waiting for the cutoff.

- **Shutdown during ordinary quit:** phone cleanup held an already-started ordinary quit; the native shutdown notice still started local persistence immediately and applied the four-second cutoff.

The [retained result](../../artifacts/linux-shutdown-drain/result.json) has Electron version, stable event names, timestamps and exit codes. It contains no transcript, prompt, credential or provider protocol data. Observed held-drain exit was 4,005 ms after the local drain began; the settled case quit in the same millisecond as its write completed. These are observations, not performance guarantees.

Nested Hyprland used `wayland-2`; the live `wayland-1` instance remained untouched. Cleanup confirmed no recorded PID, proof-cgroup process or owned process remained. No desktop input, system shutdown command, host service change or user configuration change was used.

## Regression and application checks

`tests/unit/main/quitDrain.test.ts` covers notice-only Linux initiation, retained events, repeated notices, rejection, normal completion, forced exit, a shutdown arriving during an ordinary quit, unchanged ten-second ordinary quits and Electron's first-listener ordering. Its existing macOS cases retain immediate system quit, ordinary quit and canceled-logout behavior.

`tests/unit/main/hostQuitDrain.test.ts` pins all three platforms: Windows registers no shutdown listener, macOS only marks its notice until the system sends quit, and Linux initiates the drain. It holds phone cleanup to prove local/cloud cleanup starts first only on Linux shutdown, and keeps phone-first ordinary cleanup on all platforms. The runtime shutdown tests check the existing accepted-write and owned-resource drain and hold a worktree sweep to prove Linux preparation stops providers and persists disconnection before releasing that sweep, without closing its stores.

The relevant built-app journey is `tests/e2e/app.spec.ts`'s “quitting retains native windows during the drain and releases the lock for relaunch,” run inside nested Hyprland. The journey passed (one test); its [before-quit capture](../../artifacts/linux-shutdown-drain/before-quit.png) was inspected and shows the unchanged first-run window. The focused shutdown files passed all 32 tests. Standards review: no findings. Spec review: the two escalation/sweep findings above were fixed and re-reviewed with no residual findings. Final full-suite and gate results are recorded in the PR.

The initial suite attempt used a worktree-backed `TMPDIR` directly. Its non-repository fixtures inherited this checkout through Git parent discovery, and Unix socket paths exceeded their length limit. That misconfigured run was stopped. Mapping the same owned cache to `/tmp` inside a process-only mount namespace corrected those failures; the six affected Git/watcher files then passed all 204 tests. The first namespace layout exposed the host root as an unmapped UID, which correctly failed Linux runtime-folder validation. The final layout uses an owned virtual root and read-only host mounts, retaining the normal UID, short paths and trusted ancestry. The full gate uses the normal npm command inside that wrapper, with no actual files on the host's `/tmp` tmpfs:

```sh
mkdir -p .cache/suite-root .cache/suite-tmp
bwrap --bind "$PWD/.cache/suite-root" / \
  --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /home /home \
  --ro-bind /var /var --ro-bind /run /run --ro-bind /sys /sys \
  --proc /proc --dev-bind /dev /dev \
  --symlink usr/bin /bin --symlink usr/bin /sbin --symlink usr/lib /lib --symlink usr/lib /lib64 \
  --bind "$PWD" "$PWD" --bind "$PWD/.cache/suite-tmp" /tmp \
  --setenv TMPDIR /tmp --die-with-parent mise exec node@24.21.0 -- npm test -- --maxWorkers=2
```

One completed full-suite run passed all 9,871 tests (194 skipped) but failed its gate on two deferred Tiptap callbacks after the Threads-view test's document was destroyed. A focused teardown probe reproduced a live editor after the last test. The shared Threads-view fixture now waits for each mounted editor's actual `destroy` event after React cleanup, before releasing the document. All 63 tests across its three users passed with that probe, with no surviving editors. This changes test lifetime only, uses no sleep and suppresses no error. The final full-suite gate result is recorded in the PR.

The next full run had no unhandled teardown errors, but its queued Watcher recovery test failed: live observation had already refunded the failed receipt before the test rewrote it as uncertain. A focused repetition and state probe reproduced that inconsistent fixture state. The recovery variant now holds observation before the failure, verifies that its prompt is still charged, seeds uncertainty and restores real observation before refresh. All original refund, retry and prompt-limit assertions remain. The corrected case passed 20 consecutive repetitions and the whole file passed 57 tests. Production Watcher behavior is unchanged. Both reviewers cleared these necessary gate fixes.

Final gates passed: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2` (784 files and 9,871 tests passed; 55 files and 194 tests skipped; no unhandled errors, exit zero) and `npm run notices:verify` (189 components). The full suite took 550.33 seconds. The final built main/preload inventories also passed the external-dependency allowlist.

## Limit

Logind defaults to five seconds, but the allowance is configurable. Forge's read-only `InhibitDelayMaxUSec` query reported 15,000,000 microseconds. The four-second application cutoff leaves one second inside the default; an earlier system cutoff or an unresponsive main event loop can still interrupt it. Linux preparation bypasses pending worktree and babysitting cleanup to start provider cancellation and accepted-write persistence immediately; stores stay open until the full cleanup finishes. A slow provider stop, an accepted operation or a failed write can still exceed the window. Pending local writes and the newest output can therefore be lost; this is a best-effort drain. Saved history remains and remote work may continue independently. The proof establishes native delivery and FD lifetime, not real shutdown termination or live-provider recovery.
