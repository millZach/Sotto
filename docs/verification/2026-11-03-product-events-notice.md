# The product events notice, switch and endpoint

ADR-0179. Run on forge on November 3, 2026, in the built app under `xvfb-run`, with `tests/e2e/product-events-notice.spec.ts`. Screenshots are in `artifacts/product-events/`.

## A real run, with the payload on the Worker

The app is not packaged here, so its environment named the real endpoint: `SOTTO_PROOF_ENDPOINT=https://events.saysotto.com`. Its Claude and OpenAI accounts were made-up files, so no real account's hash went. The journey pressed **Got it**, then opened Usage, and read back from D1 until all three kinds of event were there. These are the rows the Worker stored, read back from D1, in full and as the Worker rebuilt them. `received_at` is when the Worker took each batch.

```text
2026-11-03T18:42:10.168Z forward_due=0
{"uuid":"825d9cab-7f8c-485b-aca3-958cde06c4b1","event":"app.started","distinct_id":"875a7dfa8ff4fa8d02720d7923407d06b56e9bf7ec1372c5080906446169e1f4","timestamp":"2026-11-03T18:41:39.348Z","properties":{"pairedHosts":0,"appVersion":"0.1.42","channel":"stable","surface":"desktop","platform":"linux","arch":"x64","$process_person_profile":false,"$geoip_disable":true}}
{"uuid":"24c2ad53-766e-4c2a-a579-c695759715ec","event":"install.owner_observed","distinct_id":"875a7dfa8ff4fa8d02720d7923407d06b56e9bf7ec1372c5080906446169e1f4","timestamp":"2026-11-03T18:42:09.352Z","properties":{"ownerSource":"openai","ownerId":"40a12eef39ae4239ad623d3590284371780b6b59b520c2866f70dde70f0ec3cb","appVersion":"0.1.42","channel":"stable","surface":"desktop","platform":"linux","arch":"x64","$process_person_profile":false,"$geoip_disable":true}}
{"uuid":"3ddd4a26-044b-4e8b-b7db-4b9c4a0a0699","event":"install.owner_observed","distinct_id":"875a7dfa8ff4fa8d02720d7923407d06b56e9bf7ec1372c5080906446169e1f4","timestamp":"2026-11-03T18:42:09.352Z","properties":{"ownerSource":"claude","ownerId":"6b0eca34490f5efdd60466776001641340df4a9b1c627e069593b46c2eb5f392","appVersion":"0.1.42","channel":"stable","surface":"desktop","platform":"linux","arch":"x64","$process_person_profile":false,"$geoip_disable":true}}

2026-11-03T18:42:39.907Z forward_due=0
{"uuid":"c6b55fbf-f738-4c1e-a3be-295d0147568a","event":"feature.used","distinct_id":"875a7dfa8ff4fa8d02720d7923407d06b56e9bf7ec1372c5080906446169e1f4","timestamp":"2026-11-03T18:42:10.351Z","properties":{"feature":"usage","appVersion":"0.1.42","channel":"stable","surface":"desktop","platform":"linux","arch":"x64","$process_person_profile":false,"$geoip_disable":true}}
```

`forward_due=0` is the Worker with no PostHog key: nothing went further. I deleted these four rows afterwards, and the table read 0.

## What the journeys check

With a local server standing in for the Worker, all four pass:

- **Before a press:** the notice shows, the switch reads on, no install ID file exists and the server has heard nothing. See every event opens over the notice and Escape closes only the list.
- **After Got it:** the install ID appears and `app.started`, both `install.owner_observed` and `feature.used` arrive. Neither made-up account ID is anywhere in what was sent, and no property's name looks like a prompt, path, branch, repo, title, thread, session or email.
- **Off:** the switch off in Settings deletes the install ID and nothing more arrives.
- **Answers across starts:** Escape, from wherever focus is, asks again at the next start. Turn off says so, stays off at the next start with no notice, and the server hears nothing at all across the three starts.
- **Environment:** with `DO_NOT_TRACK=1`, no notice, and the row reads off, cannot be pressed and says why.
- **Fit:** the notice and the list stay inside the window at 1600x1000, 1280x800 and 820x560 in light and dark. Citrine and Graphite are captured at 820x560, and Tab goes Got it, Turn off, See every event.

`productEventsWords.test.ts` fails if the docs page or the dialog misses an event or field, if the hashed-and-linked sentence goes from the notice, the row, the README, the guide or the page, or if "no analytics", "no telemetry" or the like comes back.

## What this did not prove

- A packaged build was not run. `released` and the host's define were checked by building the host both ways and reading the output: `released: true` from `package-host`'s path, `released: false` otherwise. The desktop's comes from `app.isPackaged`.
- No real provider ran a turn here, so `thread.started` and `turn.completed` are not in the rows above. `docs/verification/2026-11-02-product-events-threads.md` has them from a real host and a fake provider.
- Forwarding to PostHog: the Worker still has no key, and has one only once this release is out.
- Run by hand on Linux only, under `xvfb-run`. The journeys run on Windows in CI, in Checks and desktop (Windows). macOS was not run.
- Screenshots were read for the light and dark notice, the list and the row at the sizes above, by eye rather than against a baseline. Contrast comes from the theme tokens and was not measured separately.
