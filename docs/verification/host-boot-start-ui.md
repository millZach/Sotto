# Start at boot in Settings > Hosts

October 6, 2026. Issue #778, item 7 of `docs/plans/host-tailnet-connection.md`, on `feat/host-boot-start-ui` from
`feat/host-boot-start` at 9ee0c750 (#760, since merged). The design is variant C with A's controls in
`docs/prototypes/host-tailnet-prototype.html`; the decision is ADR-0054 and its October 6 amendment.

## How it was run

`tests/e2e/host-boot-start.spec.ts` runs the built app against a scripted ssh (`tests/fixtures/fakeSsh.mjs` in `run`
mode) that pipes the real launch script to a real headless host on this machine, with fake `systemctl --user` and
`loginctl` first on the path (`tests/fixtures/fakeSystemd.ts`). The fakes keep a state file and record every call, so
the spec reads what the launch script asked systemd for and whether the unit file was written. No real systemd, linger
or reboot is involved: that is item 8, the check on forge.

The fake host runs as this machine's account, so the linger command the launch script writes names that account, not
`zach`. The captures mask that one command with a grey bar; the spec checks its text is `sudo loginctl enable-linger`
and one word. Everything else on screen is as the app drew it.

Each state was captured at 1600×1000, 1280×800 and 820×560, in dark and light, with reduced motion on, and the spec
checks that the dialog or menu sits wholly inside the window and the page does not scroll sideways at every size. The
keyboard path is part of the spec: the More menu opens with Enter on its button, focus moves to the question's
**Wait until they finish** when it appears and to **Start at boot** on the linger result, and Escape closes a
result. Eleven of the 72 captures are kept in `artifacts/host-boot-start/`.

## What it showed

1. **Add host's connected card offers it.** forge, added as `zach@forge`, does not linger. The card says Sotto adds a
   systemd user unit for zach, turns on linger first, and restarts the host once, and offers **Start forge's host at
   boot** (`card-offer-1280x800-dark.png`).
2. **Linger refused, from the card.** With polkit refusing, the press ran `loginctl enable-linger` and nothing else: no
   `systemctl enable`, no unit file, the host still running. The card says nothing changed, why, and shows the command
   with **Copy** and the press again (`card-linger-1280x800-light.png`).
3. **Installed.** With linger allowed, the same press ran `systemctl enable sotto-host` and `start sotto-host`; the
   host Sotto started stopped and the unit's host took over, and this computer connected again. The card says so
   (`card-done-820x560-dark.png`).
4. **The More menu** reads Stop starting at boot…, then a line, then Stop host, Rename, Edit connection and Forget
   (`menu-1280x800-dark.png`).
5. **Stop host** says "forge's host stops now and starts again when forge restarts or when you switch it on."
   (`stop-host-1280x800-light.png`).
6. **Stop starting at boot…** says what goes and that the host restarts once outside the unit
   (`stop-boot-consent-1280x800-dark.png`). With a thread on forge running, the press asks the busy-host question
   first: "1 thread on forge is working. Stopping start at boot restarts forge's host, which stops it.", with
   **Cancel**, **Stop 1 thread now** and **Wait until they finish**; nothing was sent to systemd yet
   (`stop-boot-busy-820x560-light.png`). **Stop 1 thread now** stopped the turn, then `systemctl disable --now
   sotto-host` ran, the unit file went, and the host came back outside the unit (`stop-boot-done-1280x800-dark.png`).
7. **Start at boot…** from the menu lists linger as on and the one restart (`start-boot-consent-1280x800-light.png`).
   With linger turned off on forge meanwhile and polkit refusing again, the modal says nothing changed, with the
   linger, unit and restart lines and **Start at boot** focused (`start-boot-linger-1280x800-dark.png`); once allowed,
   Enter installed it.
8. **Forget** says it removes start at boot from forge (`forget-1280x800-dark.png`), and it ran `systemctl disable
   --now sotto-host` after the revoke; the unit file went, and no notice was left.

The spec passed five times in a row once the first draft's locator was fixed. One earlier run failed at Add host with
the launch script's `descriptor-invalid` before any start at boot press; it did not recur.

## Not shown here

- The busy-host question on Start at boot's own modal and on the card, Tailscale's approval inside the modal, a
  host that cannot start at boot, and Forget's notice when it could not remove the unit are covered by
  `tests/unit/renderer/hostBootStart.test.tsx` and `tests/integration/desktopHosts.test.ts`, not captured.
- A real Linux host, linger and a reboot: item 8 of the plan, on forge.
