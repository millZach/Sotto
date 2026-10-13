# The cloud iPhone in the running app

October 3, 2026, on Windows 11 with Electron 43, from `tests/e2e/cloud-iphone.spec.ts` against the built app (ADR-0047). The app talks to `tests/fixtures/fakeRunCloud.mjs`, a local fake of run.cloud's API, through `SOTTO_RUN_CLOUD_API_URL`. No real run.cloud key or minutes were used. The fake Workshop thread is driven through the same `sotto_browser` dispatcher a provider reaches.

## What was shown

- **The key is checked before it is saved.** A key run.cloud refuses comes back not saved. The fake's key is saved, and Settings shows "Saved securely".
- **The request waits in the thread.** When the agent's `iphone_cloud_open` names a simulator build in the thread's folder, a card appears in the thread. It names the build and its size, says the build goes to run.cloud, gives the price and shows this month's minutes against the cap. Nothing had been uploaded at that point: the fake held no asset.
- **Start covers that session.** After **Start cloud iPhone**, the build is uploaded, the simulator starts, and the phone player shows the fake's viewer in its screen as "Cloud iPhone for Workshop". Exactly one viewer view is drawn.
- **Inside the session nothing asks.** The agent's inspect, tap, typing, Enter and screenshot all ran. The screenshot came back as an image. The typed words appear nowhere in the session's steps, which say "Entered text".
- **Tools > iPhone shows the session.** **Show the cloud iPhone in Tools** opens it, with the Cloud iPhone card (Running, the build, the device, this month's minutes, End session, the steps). The test iPhone's empty state steps aside while the session runs.
- **Both stay inside the window** at 1600x1000, 1280x800 and 820x560, in light and dark. The viewer is kept, not reloaded, when the window resizes.
- **Finish releases everything.** `iphone_cloud_finish` takes the viewer off the window, releases the simulator and deletes the upload: the fake holds no asset afterwards and every session is released. Settings > Cloud iPhone then shows one minute used this month and the session under Recent sessions.

## Fixed while proving it

- Resizing the window closed the viewer's page, which for a real session would restart its stream. A hidden or resized viewer is now kept and put back.
- The viewer was drawn at its own size and scrolled inside a small phone. It now fits by page zoom, as the test iPhone does.
- The request card counted down from five minutes. It now shows the time left only in its last minute.
- Tools > iPhone said "No app on the test iPhone" above a running cloud session.
- A size control in the player still said "test iPhone" in cloud mode.

Unit tests cover three more fixes found while reading the code:

- The adapter would have sent the key to any absolute address run.cloud's upload answer named. It now sends the key only to run.cloud's own API.
- **End session** during an upload or start left the simulator running and billed once the start finished. It is now released and its upload deleted.
- A session run.cloud ended on its own side was never noticed. A check each minute now ends it with "run.cloud ended this session".

A code review before this merged found more: a release or deletion failure during teardown was swallowed and forgotten rather than retried; ending could still race a start finishing underneath it; quit did not wait for a session's own release; an ambiguous run.cloud create answer (an ID with no address) could leave a simulator running unseen; the monthly cap was enforced per session rather than for the month as a whole; evicting old ledger entries could lose a month's count; a build could change between asking and uploading; run.cloud's own error text could reach the user unscrubbed; and a thread going away mid-session was never checked. All eleven are fixed and each has its own test in `tests/unit/main/cloudIphoneService.test.ts` or `tests/unit/main/runCloudClient.test.ts`.

## Captures

In `artifacts/cloud-iphone/`, which `.gitignore` keeps out of a run's commit; these are added by hand:

- `request-in-thread.png`: the request card in the Workshop thread at 1280x800, dark.
- `running-1600x1000-dark.png`, `running-1600x1000-light.png`, `running-1280x800-dark.png`, `running-1280x800-light.png`, `running-820x560-dark.png` and `running-820x560-light.png`: the running session in the phone player beside Tools > iPhone.
- `settings-dark.png` and `settings-light.png`: Settings > Cloud iPhone after the session.

## Not shown here

- **A real run.cloud session.** The routes for sessions, uploads and keep-alive come from run.cloud's SDK, not its docs (`docs/research/2026-10-03-run-cloud-api.md`). Some guesses are unconfirmed:
  - the upload checksum's encoding;
  - the swipe body's field names;
  - whether run.cloud's viewer loads in an Electron view without a permission it asks for.

  The first live run with Zach's key settles them.
- **Deny, the lapsed request, the cap and the idle timer.** These are covered by `tests/unit/main/cloudIphoneService.test.ts` and the renderer's unit tests, not by this run.
