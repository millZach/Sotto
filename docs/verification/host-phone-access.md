# Phones on a host verification

October 4, 2026, on `feat/host-phone-access` from `main` at fac1b62d. The owner could not add forge, a host with no
monitor, on the iPhone: the iPhone said to turn on phone access in Settings > Phones on forge. They picked variant B,
"Dialog from the row", from `docs/prototypes/host-phone-access-prototype.html`. The decision is ADR-0050.

## In the built app

`tests/e2e/host-phones.spec.ts` runs the built app against a scripted ssh that runs the real launch script and a real
headless host (`tests/fixtures/e2eSshHost.ts`). The host's Tailscale is a stand-in read from a file, so the run touches
no machine's Tailscale. From the keyboard where the journey allows it:

1. Add forge. Once it connects, its row reads **Phones off**, read through the tunnel with the token the launch handed
   back. No SSH command ran beyond the launch and the forward.
2. **Phones…** opens **Phones on forge** with focus on **Let phones reach forge** (`off-1280x800-dark.png`).
3. With Tailscale missing on forge, Space turns it on. The first step fails: "Tailscale isn't installed on forge.
   Nothing was changed, and Sotto won't install it." The row reads **Phones need you** (`no-tailscale-1600x1000-dark.png`).
4. With Tailscale running there, **Try again** sets up Serve on forge, and the address reads
   `https://forge.tail5728ca.ts.net:8443`.
5. **Pair a phone** shows the code with focus on it. Escape withdraws it and leaves the dialog open. A second code
   (`code-820x560-light.png`) is redeemed on forge's own phone listener, the port in its `phone-access.json`, the way
   the iPhone does through Serve. The dialog says "Zach's iPhone is paired with forge." and lists it, and the row reads
   **Phones on, 1 paired** (`paired-1280x800-dark.png`, `paired-820x560-dark.png`).
6. **Can answer** turns on for it on forge. Escape closes the dialog and focus goes back to **Phones…**. Turning the
   switch off brings the row back to **Phones off**.

Each step was captured at 1600x1000, 1280x800 and 820x560, dark and light, with nothing scrolling sideways. At the
minimum size the dialog scrolls inside itself and Done stays in view. The five captures cited are in
`artifacts/host-phone-access/`.

The first run of this spec found a real fault: the dialog listed the desktop's own pairing, **Sotto desktop**, as a
phone, with **Remove**, which would have unpaired this computer from forge. Phone access on a host now lists only the
clients that paired through it (`phone-clients.json`), and refuses to remove or grant anything to any other.

## Below the app

- `tests/integration/hostPhoneAccess.test.ts`: a real headless host turned on from its administrative routes. It runs
  no Tailscale until turned on, then serves a loopback port of its own, which answers health with `forge` and has no
  administrative routes. A phone pairs there and a desktop paired by the host's own code is not listed. The host takes
  Serve away when it stops, puts it back on the same port when it starts, and starts with it off once turned off. It
  hands back Tailscale's consent page rather than opening one.
- `tests/integration/desktopHosts.test.ts`: the desktop's host manager reads a connected host's phone access through
  its tunnel and turns it on there.
- `tests/integration/sshLauncher.test.ts`: the real launch script hands back the token, which is never on a command
  line, and a launch without one says phone access cannot be reached.
- `tests/unit/main/hostPhones.test.ts`: one read on connect, reads every two seconds only while the dialog says it is
  open, a lapsed watch stops, a refused token is read again once, only Tailscale's own page is opened, and a host of
  another kind is refused.
- `tests/unit/main/phoneAccess.test.ts`, `tests/unit/main/tailscale.test.ts`: the shared pairing store, Tailscale's
  "Access denied" on Linux, and the consent page handed back.
- `tests/unit/renderer/hostPhonesDialog.test.tsx`: the row's words, every failure's sentence, Escape on the code,
  Remove asking in place, and a disconnected host shown as it last answered.

## Not checked here

- A real Linux host refusing Serve to a non-operator account. The "Access denied" wording is matched from Tailscale's
  CLI and tested against a recorded message, not a live machine.
- The iPhone copy changes in `apps/ios` are text only. Only the macOS CI job compiles them.
- A real iPhone pairing with a real host through Tailscale Serve. The spec redeems the code on the same listener Serve
  carries, but not through Serve.
