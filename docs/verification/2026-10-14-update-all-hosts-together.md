# Update all updates a host before Sotto restarts, in steps

October 14, 2026, on the Windows laptop, in the built app on the Owl track (ADR-0077, October 14 amendments). The
journeys start the app with an Owl version (`tests/e2e/support/releaseTrack.ts`) and stand an update in for Sotto's own
with `SOTTO_E2E_APP_UPDATE`: a check offers it, a download counts up to it and keeps nothing, and installing is refused
(`src/main/updates/e2eUpdater.ts`). forge is a real headless host over the scripted SSH, installed as this run's Owl
version, and a stand-in releases page publishes the host that the waiting update brings, for this machine.

`SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/update-all.spec.ts --grep-invert "lists what is behind"` runs
both journeys below; the first journey in the spec, clients only, runs as before.

## With forge's clients behind

- Before Sotto checked, no host update was offered: forge ran this computer's own version.
- After the check, the card listed the press's steps in order: **Download Sotto Owl**, forge's three clients, **Update
  forge's host**, then **Restart Sotto** reading "Last. Sotto asks before it restarts." The head carried Sotto's
  versions once, `0.1.37-owl.20261012.1 → 0.1.37-owl.20261012.2`. The host's sentence ("Restarts forge's host, so its
  threads are unavailable for a few seconds.") appeared once, in its step; the only note below the list was "Threads
  keep working while clients update." The stand-in releases page had been asked for the host archive and its checksum
  before forge was listed. `artifacts/update-all-hosts-together/offer-clients-dark-1280x800.png`,
  `offer-clients-light-1280x800.png`, `offer-clients-dark-1600x1000.png` and, at the minimum,
  `offer-clients-dark-820x560.png`.
- One press, with Grok Build held at its second step: the host step read "Updates once forge's clients have." and the
  head counted steps done out of 6, the restart included. `running-clients-dark-1280x800.png`,
  `running-clients-light-1280x800.png`, `running-clients-dark-820x560.png`.
- Released, forge's host downloaded, installed and restarted into `0.1.37-owl.20261012.2` while this computer still ran
  `0.1.37-owl.20261012.1`. Every step read done, the restart step read "Installs 0.1.37-owl.20261012.2.", and
  **Restart now** named that version. forge's restart forgot what its update line had run; the client steps stayed
  done. `restart-clients-dark-1280x800.png`, `restart-clients-light-1280x800.png`, `restart-clients-dark-1600x1000.png`,
  `restart-clients-dark-820x560.png`.
- forge stayed connected on the newer version, with no error on its row, and nothing on the page said to update Sotto
  on this computer.

## With every client current

- forge's clients were updated first from its own update line, so after the check the steps were **Download Sotto
  Owl**, **Update forge's host** and **Restart Sotto**, with no note below. `offer-host-dark-1280x800.png`,
  `offer-host-light-1280x800.png`, `offer-host-dark-1600x1000.png`, `offer-host-dark-820x560.png`.
- One press: the releases page held each answer back, and the host step showed its download under way,
  `running-host-dark-1280x800.png`, `running-host-light-1280x800.png`, `running-host-dark-820x560.png`.
- Then the restart was ready, `restart-host-dark-1280x800.png`, `restart-host-light-1280x800.png`, `restart-host-dark-1600x1000.png`,
  `restart-host-dark-820x560.png`. **Later** folded the card into **Restart to finish**, with focus on it, and forge
  stayed connected on the newer version.

At every size the card sat wholly inside the window; at 820x560 the list scrolls inside the card. Every run has reduced
motion on, so the spinner and progress bar are still.

## What the tests cover besides

- `tests/unit/main/hostUpdate.test.ts`: the waiting version is offered once its archive and checksum are published; a
  release without a host archive, or an archive without a checksum, leaves the host aimed at the running version; a
  page that did not answer is asked again on the next phase change; an update under way keeps its version; a host
  already on the waiting version is not taken down when the update goes away; once a host's download names its
  system, only that system's archive is asked about; a waiting version not later than the running one asks nothing.
- `tests/integration/desktopHostUpdates.test.ts`: over real headless hosts, the host is updated to the waiting version,
  reconnects on it ahead of this computer, takes a draft, and reconnects again after a drop, as Later leaves it.
- `tests/integration/socketHostCompatibility.test.ts`: a host already on the waiting version is told to wait for
  Sotto's restart rather than to update this computer.
- `tests/unit/renderer/updateAll.test.ts` and `updateAllCard.test.tsx`: the order of the steps and their words, the
  restart step's threads sentence, the step count, the host's versions shown only when they are not Sotto's, the
  ordered list and each step's name with its state.

## Not checked here

- A real GitHub release: the HEAD request against `github.com` and its redirect were exercised only through the
  stand-in page, which answers 200 rather than 302.
- Restart now itself: the stand-in updater refuses to install, so the restart into the new version is not run.
- macOS and Linux have no pending version and no change; they were not run.
