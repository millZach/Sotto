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
result. The spec captures 12 states, 72 screenshots in all; twelve are kept in `artifacts/host-boot-start/`. (The
first run of this note had 11 states, 66 screenshots, and said 72.)

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
4. **The More menu** reads Stop starting at boot…, then a line, then Stop host, Rename and Edit connection, then a
   line, then Forget (`menu-1280x800-dark.png`).
5. **Stop host** says "forge's host stops now and starts again when forge restarts or when you switch it on."
   (`stop-host-1280x800-light.png`).
6. **Stop starting at boot…** says what goes and that the host restarts once outside the unit
   (`stop-boot-consent-1280x800-dark.png`). With a thread on forge running, the press asks the busy-host question
   first: "1 thread on forge is working. Stopping start at boot restarts forge's host, which stops it.", with
   **Cancel**, **Stop 1 thread now** and **Wait until they finish**; nothing was sent to systemd yet
   (`stop-boot-busy-820x560-light.png`). **Stop 1 thread now** stopped the turn, then `systemctl disable --now
   sotto-host` ran, the unit file went, and the host came back outside the unit (`stop-boot-done-1280x800-dark.png`).
7. **Start at boot…** from the menu lists linger as on and the one restart (`start-boot-consent-1280x800-light.png`);
   Cancel sent nothing. With linger turned off on forge and polkit refusing again, forge was switched off and on, and
   the modal then said linger comes first, with the command to run if forge asks for an administrator
   (`start-boot-linger-consent-820x560-dark.png`). That is the modal's longest state: at 820×560 the dialog stays
   inside the window and scrolls, and its **Start at boot** button scrolls into view inside it. The press changed
   nothing and said so, with the linger, unit and restart lines and **Start at boot** focused
   (`start-boot-linger-1280x800-dark.png`); once allowed, Enter installed it.
8. **Forget** says it removes start at boot from forge (`forget-1280x800-dark.png`), and it ran `systemctl disable
   --now sotto-host` after the revoke; the unit file went, and no notice was left.

The spec passed five times in a row once the first draft's locator was fixed. One earlier run failed at Add host with
the launch script's `descriptor-invalid` before any start at boot press. Review found the cause: the host wrote
`host-listener.json` in place, and the launch script, which reads it every 100 ms while it waits for a host, could read
it empty between the truncate and the write. The host now writes it beside itself and renames it into place, and the
launch script reads a descriptor that does not parse a few more times, 25 ms apart, before it calls it invalid. With
the review's fixes in, the spec passed again beside `host-forget.spec.ts`.

## Not shown here

These have jsdom tests in `tests/unit/renderer/hostBootStart.test.tsx` and `tests/integration/desktopHosts.test.ts`
and were not captured. Each is drawn with the same notice, check list and button components as a captured state. The
modal ones are shorter than the linger consent checked at 820×560, and the notices on the page wrap their commands
rather than run off it, as the captured Forget notice of `host-forget` does.

- The busy-host question on Start at boot's own modal and on Add host's card. The spec reaches the question through
  Stop starting at boot only (`stop-boot-busy-820x560-light.png`): getting a working thread before Add host's card
  connects is not something the scripted host can do.
- The consent modal for a host Sotto did not start ("No restart"), and the update panel's words for a host that starts
  at boot. The scripted ssh always reports a host it started, and the update panel needs a host older than this build,
  which this spec's host is not.
- A host that cannot start at boot, Tailscale's approval inside the modal, a failure left on a host's row after its
  modal closed, and Forget's notice when it could not remove the unit, alone or beside the revoke's command.
- A real Linux host, linger and a reboot: item 8 of the plan, on forge.
