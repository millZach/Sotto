# Phone access: Settings > Phones in the built app

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

September 26, 2026, on the Windows 11 development machine, branch `feat/phone-access`. The page follows variant C, "Guided setup", of `docs/prototypes/phone-access-prototype.html` (ADR-0033).

## The running app

`tests/e2e/phones.spec.ts` launches the built app on an end-to-end profile and walks the page through the six states the prototype drew. Tailscale there is the end-to-end stand-in, which reads `e2e-tailscale.json` in the profile and never runs the machine's own CLI. The phone is the test itself: it pairs with `SocketHostService.pair` on the listener's loopback port, the port Tailscale Serve would carry 8443 to, and opens a socket the way the iPhone app does.

```powershell
npm run build
npx playwright test tests/e2e/phones.spec.ts
```

Result: **1 passed**. What it checked, in order:

- The Settings nav reads Dictation, Transcription, Cleanup, Providers, Hosts, **Phones**, Agents, Output, Appearance, Application, Git, and ArrowDown from Hosts lands on Phones.
- **Off.** Every step reads "Checked when you turn this on.", and Show a pairing code is disabled. ([off, dark, 1280](../../artifacts/phone-access/phones-off-1280-dark.png))
- **Tailscale not running.** Turning Let phones connect on fails the first step in plain words, the second waits for Tailscale, and no listener opens. ([tailscale, dark, 1280](../../artifacts/phone-access/phones-tailscale-1280-dark.png))
- **Port taken.** With another app's proxy on 8443, Try again fails the second step with "Another app already uses port 8443 in Tailscale Serve on this computer. Sotto left that setting alone, and nothing was changed." ([port, dark, 1280](../../artifacts/phone-access/phones-port-1280-dark.png); [at the 820x560 minimum](../../artifacts/phone-access/phones-port-820-dark.png))
- **Ready.** With 8443 free, every step is done, the address is `https://laptop-russh2j5.tail5728ca.ts.net:8443` with Copy address, `/v1/health` on the loopback port answers `name: "laptop-russh2j5"`, and `/v1/admin/pairing-code` is refused with 400. ([ready, dark](../../artifacts/phone-access/phones-ready-1280-dark.png); [light](../../artifacts/phone-access/phones-ready-1280-light.png))
- **Code.** Show a pairing code puts focus on the code, which reads "Works once. Expires in 4:5x"; Escape withdraws it and focus returns to Show a pairing code, where Enter shows a new one. ([code, dark, 1280](../../artifacts/phone-access/phones-code-1280-dark.png); [light, at the minimum](../../artifacts/phone-access/phones-code-820-light.png))
- **Paired.** Redeeming the code closes the card and lists "Zach’s iPhone", "Paired Sep 26 · Not connected", Can answer off; once the phone opens a socket the row says Connected, and its hello says it may not answer. ([paired, dark](../../artifacts/phone-access/phones-paired-1280-dark.png); [light](../../artifacts/phone-access/phones-paired-1280-light.png))
- **Can answer and Remove.** Turning Can answer on changes the row's sentence and the phone's next hello says it may answer. Remove asks first, with Keep phone focused ([dialog](../../artifacts/phone-access/phones-remove-1280-light.png)); confirming removes the row and the phone's next connect is refused as unauthenticated.
- **Off again.** Turning the switch off returns every step to waiting, the loopback listener stops answering, and `phone-access.json` records the Serve setting as gone.
- At 1600x1000, 1280x800 and 820x560, in dark and light, for every state, neither the window nor the settings form scrolls sideways. The profile runs with reduced motion on. No page errors.

## Against this machine's real Tailscale, read-only

The parsers were run once against the real CLI on this machine, through the same `TailscaleCli` (found on the PATH, `execFile` with argument arrays) and without changing anything: `tailscale status --json` read as running with a `.ts.net` name, and `tailscale serve status --json` read 443 as taken (T3 Code's setting) and 8443 as free. Sotto's `serve --bg --https=8443` and `serve --https=8443 off` were not run against the real tailnet here; the unit tests pin their exact argument arrays, and the case of a tailnet without Serve is scripted there from the consent-page message the CLI prints.

## Tests

- `tests/unit/main/tailscale.test.ts`: status and Serve status parsing, who holds 8443 (free, Sotto's, anyone else's, Funnel), finding the CLI, the exact `serve` and `off` arguments, and stopping at the consent page.
- `tests/unit/main/phoneAccess.test.ts`: on, off, quit, a failed step changing nothing, another app's setting left alone before and after, a crash's leftover removed at the next start, the remembered port and its fallback, paired phones that cannot be read keeping the listener shut, a failed start removing a crash's leftover setting, the local host off, the name, and one code at a time.
- `tests/integration/phoneAccess.test.ts`: the real socket server over a real host service: health's name, no admin routes, pairing with a shown code, cancelled and replaced codes refused, Can answer writing and revoking the policy record, Remove closing the phone's connection, and off closing every socket.
- `tests/unit/main/phonesIpc.test.ts`, `tests/unit/main/policyStore.test.ts`, `tests/integration/ipcAuthorization.test.ts`, `tests/integration/settingsHistoryIpc.test.ts`, `tests/unit/shared/settings.test.ts`: the main-window-only channels, the shared remote-answer switch, and both new settings on the allow-list.
- `tests/unit/renderer/phonesSettings.test.tsx`: the page in each state, the code's focus and Escape, the announcement when a phone pairs, Can answer, Remove asking first, Go to Hosts, and the name field.
