# The Phones card and Add host, in the running app

November 10, 2026, on forge (Linux), from `fix/hosts-and-phones-setup-faults`. The built app was started in its test mode under Xvfb, where Tailscale reads as not installed and links are not opened in a real browser. First-run setup was walked, then Settings › Hosts & phones opened.

## What was run, and what it showed

1. **The Phones card** starts with **Install the beta** and **Get the iPhone beta**. Pressing it left "Opened in your browser" on the row.
2. **Let phones connect** was pressed with Tailscale not installed. The switch stayed off, the saved `phoneAccess` setting was still false, and the card said "Phones reach this computer over Tailscale, which is not installed here, so this stayed off. Get Tailscale above, then turn it on." The three steps still read "Checked when you turn this on."
3. **Add host** was opened and **Escape** pressed once: the dialog closed and focus went back to Add host. Opened again, **Down** then **Escape** closed the device list and left the dialog; a second **Escape** closed the dialog.
4. The card was captured at 1280x800, dark and light, and at the 820x560 minimum, where nothing was wider than the window.

- `artifacts/hosts-and-phones-setup-faults/phones-needs-tailscale-1280x800.png`, `phones-needs-tailscale-1280x800-light.png`: the card after the press.
- `artifacts/hosts-and-phones-setup-faults/phones-820x560.png`: the card at the minimum window.

## Not checked here

- Get the iPhone beta opening a real browser, and the row's sentence when none opens. `tests/unit/renderer/phonesSettings.test.tsx` covers both.
- A switch that was already on when Tailscale went away. The same test file covers it: it stays on, with the failed step and Try again.
- The setup card's own switch, in the running app. `tests/unit/renderer/onboardingSteps.test.tsx` covers it.
- Windows and macOS.
