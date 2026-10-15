# Update all updates a host before Sotto restarts, in steps

October 14, 2026, on the Windows laptop, in the built app on the Owl track (ADR-0077, October 14 amendments). The
journeys start the app with an Owl version (`tests/e2e/support/releaseTrack.ts`) and stand an update in for Sotto's own
with `SOTTO_E2E_APP_UPDATE`: a check offers it, a download counts up to it and keeps nothing, and installing is refused
(`src/main/updates/e2eUpdater.ts`). forge is a real headless host over the scripted SSH, installed as this run's Owl
version, and a stand-in releases page publishes the host that the waiting update brings, for this machine.

`SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/update-all.spec.ts --grep-invert "lists what is behind"` runs
both journeys below; the first journey in the spec, clients only, runs as before.

After the code review (Sol), the same journeys ran again on the review fixes: forge's launch now reports its system
(`win32-x64` on this laptop), and only that system's archive is asked about; the second journey presses Update all
while the releases page is still holding its answer about forge. Captures of the card's offer, running and restart
states came out the same as before, differing only in the sidebar's thread rows, so those files were kept; the checking
state is new.

## With forge's clients behind

- Before Sotto checked, no host update was offered: forge ran this computer's own version.
- After the check, the card listed the press's steps in order: **Download Sotto Owl**, forge's three clients, **Update
  forge's host**, then **Restart Sotto** reading "Last. Sotto asks before it restarts." The head carried Sotto's
  versions once, `0.1.37-owl.20261012.1 → 0.1.37-owl.20261012.2`. The host's sentence ("Restarts forge's host, so its
  threads are unavailable for a few seconds.") appeared once, in its step; the only note below the list was "Threads
  keep working while clients update." The stand-in releases page had been asked for the host archive and its checksum,
  for forge's own system, before forge was listed. `artifacts/update-all-hosts-together/offer-clients-dark-1280x800.png`,
  `offer-clients-light-1280x800.png`, `offer-clients-dark-1600x1000.png` and, at the minimum,
  `offer-clients-dark-820x560.png`.
- One press, with Grok Build held at its second step: the host step read "Updates once forge's clients have." and the
  head counted the done steps out of the 6 shown, the restart among them. `running-clients-dark-1280x800.png`,
  `running-clients-light-1280x800.png`, `running-clients-dark-820x560.png`.
- Released, forge's host downloaded, installed and restarted into `0.1.37-owl.20261012.2` while this computer still ran
  `0.1.37-owl.20261012.1`. Every step read done, the restart step read "Installs 0.1.37-owl.20261012.2.", and
  **Restart now** named that version. forge's restart forgot what its update line had run; the client steps stayed
  done. `restart-clients-dark-1280x800.png`, `restart-clients-light-1280x800.png`, `restart-clients-dark-1600x1000.png`,
  `restart-clients-dark-820x560.png`.
- forge stayed connected on the newer version, with no error on its row, and nothing on the page said to update Sotto
  on this computer.

## With every client current, pressed before forge's check ended

- forge's clients were updated first from its own update line, so only Sotto and forge's host were behind. In the first
  run, after the check, the steps were **Download Sotto Owl**, **Update forge's host** and **Restart Sotto**, with no
  note below. `offer-host-dark-1280x800.png`, `offer-host-light-1280x800.png`, `offer-host-dark-1600x1000.png`,
  `offer-host-dark-820x560.png`.
- In the review run the releases page held its answer to Sotto's HEAD request about forge's archive. The host step read
  **Update forge's host**, "Checking the releases page for its update…", named "Update forge's host, checking for its
  update", with a spinner and no versions line; the button was named "Update all: Sotto and forge". Only
  `Sotto-host-0.1.37-owl.20261012.2-win32-x64.tar.gz` had been asked for. `offer-host-checking-dark-1280x800.png`,
  `offer-host-checking-light-1280x800.png`, `offer-host-checking-dark-820x560.png`.
- Update all, pressed then: Sotto's download ran and finished, forge's step stayed checking, the head read "Updating" and
  "1 of 3 done", and there was no **Restart now**. `running-host-checking-dark-1280x800.png`,
  `running-host-checking-light-1280x800.png`.
- The answer let go, forge joined the press with no second press: the releases page held each answer back, and the host
  step showed its download under way, `running-host-dark-1280x800.png`, `running-host-light-1280x800.png`,
  `running-host-dark-820x560.png`.
- Then the restart was ready, `restart-host-dark-1280x800.png`, `restart-host-light-1280x800.png`, `restart-host-dark-1600x1000.png`,
  `restart-host-dark-820x560.png`. **Later** folded the card into **Restart to finish**, with focus on it, and forge
  stayed connected on the newer version.

At every size the card sat wholly inside the window; at 820x560 the list scrolls inside the card. Every run has reduced
motion on, so the spinner and progress bar are still.

## What the tests cover besides

- `tests/unit/main/hostUpdate.test.ts`: the waiting version is offered once its archive and checksum are published; a
  release without a host archive, or an archive without a checksum, leaves the host aimed at the running version; a
  page that did not answer is asked again on the next phase change; an update under way keeps its version; a host
  already on the waiting version is not taken down when the update goes away; only the host's own system's archive is
  asked about, so a Linux-only release never qualifies a Mac host; a host whose system Sotto has not heard is asked
  nothing and left for after the restart; a host is named as checking from the moment it is asked about until the
  page answers; a waiting version not later than the running one asks nothing.
- `tests/integration/launchScript.test.ts`, `sshLauncher.test.ts`, `desktopHostsTailnet.test.ts` and
  `tests/unit/main/tailnetStore.test.ts`: the launch reports its system, the SSH connection and an admin connection
  carry it, and the tailnet entry keeps it, so a host reached over its tailnet after a relaunch, with no launch, still
  has it.
- `tests/integration/desktopHostUpdates.test.ts`: over real headless hosts, the host is updated to the waiting version,
  reconnects on it ahead of this computer, takes a draft, and reconnects again after a drop, as Later leaves it.
- `tests/integration/socketHostCompatibility.test.ts`: a host already on the waiting version is told to wait for
  Sotto's restart rather than to update this computer.
- `tests/unit/renderer/updateAll.test.ts` and `updateAllCard.test.tsx`: the order of the steps and their words, the
  restart step's threads sentence, the step count (every step shown, a download finished before the press among them),
  the host's versions shown only when they are not Sotto's, versions carried as a pair, the ordered list and each
  step's name with its state, a host being checked covered by one press and joining once its check ends, and the
  restart held back until then.

## After Sotto Bug Bot's review

October 15, 2026. The fixes for the seven findings are proved by unit and integration tests; the two journeys above and
`tests/e2e/host-update.spec.ts` ran again on them in the built app and passed, with no change to the card's captures.

- `tests/unit/main/hostUpdate.test.ts`: when the waiting version goes away, a host update still downloading it stops
  (its download is aborted, nothing more runs) and the host is offered this computer's version again; one already
  unpacking finishes and its step says "forge was already installing X when this computer stopped updating to it, so it
  finished. Nothing was lost."; Update pressed while the releases page is still being asked fetches nothing until the
  page answers, then downloads, installs and restarts once, on the waiting version, and Cancel update stops it while it
  waits; `restartHold` names the hosts being updated; a quit aborts a download but not an update the host is unpacking;
  a redirect counts as published only when its `Location` is `https://release-assets.githubusercontent.com/...`.
- `tests/unit/main/updateService.test.ts`: Restart now restarts nothing while a host update holds it, keeps the
  download and carries the hold's sentence as its problem, and restarts once the hold is gone.
- `tests/unit/main/hostReleaseVersion.test.ts`: a waiting Owl build maps to the stable release it is built on when
  Usage and Muse are off (`0.1.25-owl.20261015.1` to `0.1.25`), not to the version this computer runs.
- `tests/integration/socketHostCompatibility.test.ts`: with both sides on Owl and nothing waiting, a host on
  `0.1.24-owl.20261015.1` is newer than this computer on `0.1.24-owl.20261014.1`, and its refusal asks for Sotto on this
  computer to be updated rather than for the host to be put back; an earlier Owl build is still older.
- `tests/unit/renderer/updateAll.test.ts`: a host Sotto did not start, still being checked, has no step and no longer
  holds the restart back; a finished host step shows its note.

## Not checked here

- A real GitHub release: the HEAD request against `github.com` and its redirect were exercised only through the
  stand-in page, which answers 200 rather than 302. Which redirects count is a unit test (`publishedAnswer`).
- Restart now itself: the stand-in updater refuses to install, so the restart into the new version is not run. Main's
  hold on it during a host update, and a quit during one, are unit tests only.
- macOS and Linux have no pending version and no change; they were not run.
- A host reached only over its tailnet before this build: the integration test covers the system kept with the
  tailnet entry, but not a real host on forge's tailnet.
