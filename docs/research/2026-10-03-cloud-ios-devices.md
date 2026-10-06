# Cloud iOS devices for agent testing

Researched October 3, 2026, for phase 2 of `docs/plans/2026-10-03-test-iphone.md`: a native iOS app, tested by an agent on a device the user watches inside Sotto on Windows. Zach asked for whichever is cheapest and best. Prices come from vendor pages read that day. Where a page did not say something, this note says "not stated".

## Recommendation

- **run.cloud.** It is cheapest per minute by a wide margin and runs iOS simulators. Control is plain HTTP with one bearer key: tap, type, swipe, press a button, take a screenshot and read the accessibility tree. A signed viewer URL works in a plain iframe. It is a young company.
- **Runner-up: Appetize.io.** It is established, with SOC 2 Type 2 and ISO 27001, and has a working iframe embed. It has no REST device control: an agent drives it through its browser JavaScript SDK, Playwright, or a beta CLI.
- **For real iPhones: BrowserStack App Automate,** $199 a month billed annually, through Appium. It needs a signed `.ipa`, which means a paid Apple Developer account.

## The candidates

**run.cloud (Small Scale Labs AB, Sweden).**

- **Price.** $0.02 per active simulator minute. There is $5 of usage without a card. With a card, the first $15 each month is free, about 750 minutes. Billing stops when the session is released or times out.
- **What runs.** iOS simulators: `.app`, `.zip`, `.tar.gz` or `.ipa`, built for the simulator.
- **Control.** `api.run.cloud`, with `Authorization: Bearer <key>`. `POST /run-cloud/ios/{sessionId}/interactions` takes `tap`, `typeText`, `swipe` and `pressButton`, with coordinates normalised from 0 to 1. `GET …/screenshot` returns a PNG and `GET …/accessibility` a node tree. The raw route that creates a session is documented only through the SDK.
- **Viewing.** A time-limited signed viewer URL, shown as an iframe with `embed=1`. Transport and latency are not stated.
- **Privacy.** Simulators run in the EU (Finland, Germany); billing is processed in the US. No analytics or third-party scripts, by the vendor's own statement.
- **Timeouts.** A session ends after 60 seconds idle by default; this can be configured.

**Appetize.io.**

- **Price.** 30 minutes a month free. Starter is $59 a month for 500 minutes, then $0.06 a minute.
- **What runs.** Simulator builds only, a zipped `.app`, on iPhone 8 to iPhone 17 Pro Max, iOS 15.5 to 26.0.
- **Control.** Uploads are REST (`POST /apps`, `X-API-KEY`). Device control goes through the JavaScript SDK inside the embed page, `@appetize/playwright`, or a CLI marked beta.
- **Viewing.** An iframe at `appetize.io/embed/{buildId}`.
- **Privacy.** SOC 2 Type 2, ISO 27001, an EU cloud. Retention is not published.
- **Timeouts.** A session ends after 2 minutes idle by default.

**Limrun.** Simulators with a REST API and a hosted MCP server. The live view is only a React component over WebRTC, not an iframe. Pricing is not published.

**BrowserStack.** Real devices only. App Live (manual) is $39 a month; App Automate is $199 a month annually. It needs a device `.ipa` and drives through Appium. It keeps apps 30 days and logs 60 days.

**Sauce Labs.** Simulators are $149 a month annually, with unlimited minutes. Its agent features need a paid private-device add-on.

**TestMu AI (formerly LambdaTest).** Simulators are $139 a month annually; simulator automation is in beta.

**AWS Device Farm.** Real devices at $0.17 a minute. Requests need SigV4 signing, which is real work with plain `fetch`. Physical-device data is not encrypted at rest.

**Kobiton, Corellium, Argent Cloud, mobilerun.** Each is too expensive or the wrong kind of product for one developer. AgentCloud, a hosted simulator MCP, has shut down.

## Expo and React Native

EAS builds a simulator app with `ios.simulator: true`, and Expo says this needs no Apple Developer account. Such a build runs only on simulator clouds (run.cloud, Appetize, Limrun, the Sauce and TestMu simulators). Real-device clouds need an `.ipa`, and Expo's internal distribution needs a paid Apple Developer account.

## Cost at 20 hours a month (1,200 minutes)

| Service | Monthly |
|---|---|
| run.cloud | about $9 ($24 less the $15 free) |
| Appetize Starter | about $101 |
| TestMu simulators | $139 (annual) |
| Sauce simulators | $149 (annual) |
| BrowserStack App Automate | $199 (annual) |
| AWS Device Farm | about $204 |

## What would make an integration fragile

- **The vendor's age.** run.cloud is young, has deprecated its other products, and documents its session route only through its SDK. Keep the device behind one adapter so the vendor can change.
- **Idle timeouts.** 60 seconds (run.cloud) or 2 minutes (Appetize) is shorter than an agent may think. Sotto would have to set the timeout or keep the session alive.
- **A simulator is not an iPhone.** Push and some hardware need a real device, a re-signed `.ipa` and a paid Apple account.
- **Sotto's own rules.** A new host is an ADR and a README "Privacy and cost" line first. A device key is a second key, which is a product decision. Viewer URLs and keys never reach a log. The renderer has no network, so the viewer is a native view set up from main.

## Sources

All read October 3, 2026: run.cloud (`/pricing`, `/simulators/`, `/privacy`, `docs.run.cloud/platform/simulator-interactions.md`, `…/embed-simulator.md`, `…/accessibility-tree.md`, `…/ios/run-simulator.md`, `…/limits.md`); Appetize (`/pricing`, `/security`, `docs.appetize.io/rest-api.md`, `…/javascript-sdk/automation/device-commands.md`, `…/platform/embedding-apps.md`, `…/ai-agents.md`); `docs.limrun.com/docs`; BrowserStack (`/pricing?product=app-automate`, `/docs/app-automate/appium/upload-app-from-filesystem`); `saucelabs.com/pricing`; `testmuai.com/pricing`; `aws.amazon.com/device-farm/pricing/`; `kobiton.com/pricing`; `argent.swmansion.com/cloud`; `mobilerun.ai/pricing/`; `docs.expo.dev/build-reference/simulators/`; `docs.expo.dev/build/internal-distribution/`.
