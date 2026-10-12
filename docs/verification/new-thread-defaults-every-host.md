# New-thread defaults on every host

Verified on Windows, October 11, 2026, on `fix/new-thread-defaults-every-host` based on main at `6adc78c40`. No live
paid provider turn, real remote machine or macOS run was performed; the remote host is the end-to-end stand-in, a real
headless host reached over a scripted ssh.

## Behavior

With a thread or project on a remote host selected, Settings → Agents used to send that host its new-thread defaults,
and the host refused every change with "This action is not allowed from this device." Now the defaults are this
computer's (ADR-0074). The router keeps them on the local host whichever host is selected, and New thread sends the
effort and permission they chose with each new thread, so a thread on forge starts on them too. With a host
connected, Settings → Agents lists one projects folder per computer, and each saves to its own computer. With only
this computer, the page is unchanged.

A host takes the projects directory and the three new-thread defaults from a paired client; a permission default
that lets threads act without asking still needs that client's `remote-answer` policy record. No host, key or
provider protocol was added, and nothing answers a permission.

## Evidence

- Red: `tests/e2e/new-thread-defaults-hosts.spec.ts` against a build of main's source, with a project on the
  stand-in forge selected. Choosing **Auto** in Settings → Agents never reached the configuration (the poll for
  `newThreadRuntimeMode` stayed undefined): the refusal reported.
- Green: the same spec on this branch's build passed. Auto saved with no alert, forge's projects folder saved to
  forge, forge reported that this computer may answer, and a thread opened from the pen on forge's project started on
  `auto`.
- `npx playwright test tests/e2e/new-thread-defaults-hosts.spec.ts tests/e2e/new-thread-defaults.spec.ts
  tests/e2e/agents.spec.ts tests/e2e/settings-index.spec.ts tests/e2e/hosts.spec.ts`: 6 passed on the final build.
- `npm run typecheck`, `npm run lint`: clean. `npm test -- --maxWorkers=2`: 9711 passed, 283 skipped.
  `npm run notices:verify`: 189 components.
- Unit coverage: the router keeps defaults on the local host and names a host's own settings without forwarding its
  ID (`tests/unit/main/desktopHostRouter.test.ts`); the allow-list takes the new fields and gates a granting
  permission default (`tests/unit/host/remoteCommands.test.ts`); null clears the permission default
  (`tests/unit/main/newThreadDefaults.test.ts`); New thread on a remote host sends the defaults, falls back to the
  host's recommended model, and holds a granting permission back where the host does not let this computer answer
  (`tests/unit/renderer/newThreadOnEveryHost.test.tsx`); Settings shows each computer's folder, a disconnected host's
  disabled, and the held-back note only while it applies (`tests/unit/renderer/newThreadDefaultsSettings.test.tsx`).
  A granting permission default is checked again when the host applies it (`tests/unit/main/agentAuthority.test.ts`),
  and a save answers with its own outcome, not the selected host's last error (`desktopHostRouter.test.ts`).

## Rendered review

Captured by the spec at 1600x1000, 1280x800 and 820x560 in dark and light with this computer and forge connected,
published with `SOTTO_E2E_EVIDENCE=publish`:
[dark 1600](../../artifacts/new-thread-defaults-every-host/dark-1600.png),
[light 1280](../../artifacts/new-thread-defaults-every-host/light-1280.png),
[dark 820](../../artifacts/new-thread-defaults-every-host/dark-820.png) and
[light 820](../../artifacts/new-thread-defaults-every-host/light-820.png). Each computer's row has its name and
"Default projects directory" on the left and its folder on the right, as variant b of
[the prototype](../prototypes/new-thread-defaults-every-host-prototype.html) has them. Nothing overflows at the
minimum size. The first captures showed the computer names in the error colour with the field wrapped below: the
saved field's error rule matched every span in the label. It now matches only the alert.

The held-back note is covered by unit tests only: the stand-in forge always lets this computer answer over SSH.

## Design captures

Settings → Agents with one computer is unchanged: run with soft comparisons so every capture in
`design-capture-pages.spec.ts` was compared, `settings-agents.png` matched its baseline. `npm run design:verify`
fails on this machine on `onboarding-step-2-look.png`, `scale-125-onboarding.png`, `theme-hush-dark.png`,
`threads-search.png` and `widget-idle-light.png`, and fails the same way on a build of main's source, so none is this
change's. No baseline was regenerated.

## Pull request review

Two-axis review by Sol (gpt-6.1-sol) at max reasoning, all six findings fixed:

- Spec: a permission default that lets threads act unasked was checked only when the host admitted the command; it
  is now checked again when applied, as a thread's own permission is.
- Spec: a save to one computer answered with the selected host's last error, so Settings could say "Could not save"
  after a save that worked; the router now answers a save with its own outcome.
- Standards: with no default model chosen, a thread on forge started from forge's catalog default, not the model
  Settings shows, and dropped a saved effort its model lacked; New thread now starts from the model Settings shows,
  fits it to the host and maps the effort by position. Creation and Settings' note share that one resolver.
- Standards: the spec's captures go through `evidenceDirectory`, as `docs/ci.md` asks.
- Standards: the prototype's held-back note promised that the next SSH connection would let this computer answer,
  which a revoked policy does not; the line is gone.

On the pull request, Greptile and Sotto Bug Bot raised three things. With no model chosen, the inherited model was
resolved from the selected host's reasoning provider and accounts; the router now resolves it from this computer's.
With no model to offer here, a thread on a remote host could not open; it now starts on that host's recommended
model. Both have tests. The third, that a remote host's own saved effort or permission applies where this
computer's default is unset, is the decision in ADR-0074 point 2, as the iPhone does under ADR-0051; this computer
never writes a host's defaults while it runs a local host.
