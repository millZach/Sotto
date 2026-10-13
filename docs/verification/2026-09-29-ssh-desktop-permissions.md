# SSH desktops can change remote permissions after setup

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

## Acceptance checks

- [x] Setting up a desktop through authenticated SSH establishes its client-specific permission to answer, without another prompt or command.
- [x] An existing desktop pairing with no policy gets the same permission on its next connection, using the host-confirmed client ID even when the saved connection has none.
- [x] A permissive new thread can be created immediately; all four permission modes can be selected over the real socket.
- [x] Concurrent setup creates one policy record. Revoked, expired and always-confirm records stay unchanged on reconnect.
- [x] Phone/code pairing gets no automatic authority, including when the device calls itself Sotto desktop.
- [x] Missing or unreadable policy stores refuse setup without replacement.
- [x] The Electron SSH setup-to-remote-composer journey works; the existing controls fit the minimum-size light view and the dark view.
- [x] The final complete unit/integration gate has finished.

## Decision and implementation

Zach chose: “It should just grant this without asking user.” The September 29 amendment in [ADR-0025](../adr/0025-headless-host-and-client-identity.md#september-29-amendment-an-ssh-desktop-can-answer-at-setup) and [ADR-0004](../adr/0004-authority-in-policy-records.md) records this change from the initial explicit-grant requirement. Users still choose thread permissions and answer requests themselves.

After the socket authenticates this desktop, `DesktopHosts` sends its confirmed client ID through the existing SSH connection. The fixed launch script checks the live host ID and pairing, then inserts a client-scoped `remote-answer` policy only if no such record has ever existed. The atomic insert handles concurrent connections. Its source is `user`, with a note identifying authenticated SSH setup. The running host reads that policy through its existing authority checks. No host protocol change, new host archive, renderer network, runtime dependency or new control is needed.

The throwaway demonstration is on `prototype/ssh-desktop-permissions`, commit `e00787f5`, at `docs/prototypes/ssh-desktop-permissions.prototype.html`. It models new/existing setup, retained revocation and phone pairing, preserving the current composer. It was driven and visually inspected; the accepted decision is in the ADRs, and the prototype stays out of the implementation branch.

## Forge

The existing Forge host advertised Sotto 0.1.26. This desktop was paired but had zero matching permission records and could not answer. The new launch-script operation ran through the existing authenticated SSH route against that host. Afterwards there was exactly one matching allow record, and the permission check returned true. The host stayed running; its installation and threads were not changed.

This repaired the missing host permission for the installed desktop. At the time of this September 29 check, the automatic setup implementation was only a local branch and had not been installed or released. No model turn was sent, and native provider mode changes on Forge were not separately exercised. The real remote permission path is covered below using scripted providers.

## Validation

- `npx vitest run tests/integration/launchScript.test.ts tests/integration/sshLauncher.test.ts tests/integration/hostProviderJob.test.ts tests/integration/hostSetupTools.test.ts --maxWorkers=2`: 64 passed, 2 skipped.
- `npx vitest run tests/integration/desktopHostDrafts.test.ts tests/integration/desktopHosts.test.ts tests/integration/desktopHostConnections.test.ts tests/integration/desktopHostBoot.test.ts tests/integration/desktopHostUpdates.test.ts tests/integration/desktopHostAdmin.test.ts --maxWorkers=2`: 50 passed.
- `npm run typecheck`: passed after the final Electron test changes.
- `npm run lint`: passed after the final Electron test changes.
- `npm run notices:verify`: 174 components verified.
- `npm run build`: passed.
- `npx playwright test tests/e2e/pending-settings.spec.ts tests/e2e/hosts.spec.ts tests/e2e/host-identity.spec.ts`: 3 passed.
- `npx playwright test tests/e2e/host-agent-setup.spec.ts tests/e2e/host-setup.spec.ts`: 3 passed before extending the remote composer check.
- `npx playwright test tests/e2e/host-agent-setup.spec.ts --grep "Add host follows"`: the extended journey passed.
- `npm test -- --maxWorkers=2`: 476 files passed, 39 skipped; 6,319 tests passed, 152 skipped.

The extended Electron journey uses the real desktop launcher, the actual launch script over scripted SSH, and a real headless host with scripted providers. After setup it creates a remote thread with Full access and changes it to Auto from its own composer, checking the saved mode and absence of either error notice. The scripted provider is labelled Claude Test in the captures; no live-provider compatibility claim comes from this fixture.

Visually inspected captures are `artifacts/pending-settings/ssh-desktop-dark-1280.png` and `artifacts/pending-settings/ssh-desktop-light-820.png`. The permission-picker journey separately checks light/dark at 1600x1000, 1280x800 and 820x560, keyboard focus, reduced motion, refused changes and uncertain answers. No production appearance was changed, so no design baseline was replaced.

## Review

Independent code-review skill passes by `gpt-6.1-sol` at high reasoning reviewed the committed and working-tree diff against `65e944a7`.

Standards: no code violations or actionable baseline smells. One documentation finding identified the initial verification note's stale instruction to grant Forge permission separately; it now links this follow-up and describes the earlier check in the past tense.

Spec: no findings. Automatic setup precedes routing, uses authenticated identity, preserves policy history and leaves code/phone pairing unchanged. Definite refusals remain distinct from connection uncertainty. The reviewers did not rerun tests; the execution results above are this session's evidence.

## September 30 validation against current main

Before opening the PR, the branch merged `77d24f8d` (Release 0.1.27) without conflicts. Independent Standards and Spec reviews of the resulting diff against that commit found no remaining issues. The host client update routing added on main remains intact.

- `npm run typecheck`, `npm run lint`: passed.
- `npm run notices:verify`: 174 components verified.
- `npm test -- --maxWorkers=2`: 480 files passed, 39 skipped; 6,376 tests passed, 153 skipped.
- `npm run build`: passed.
- `npx playwright test tests/e2e/pending-settings.spec.ts tests/e2e/hosts.spec.ts tests/e2e/host-identity.spec.ts tests/e2e/host-agent-setup.spec.ts tests/e2e/host-setup.spec.ts --workers=1`: all 6 passed.

The current-main remote composer capture at the minimum-size light view was visually inspected again. No design baseline was regenerated. These are local results; GitHub's checks must pass before merge.

The first PR Linux run passed the socket contract and archive verification but exposed the native sshd test's old count of four SSH operations. Desktop policy setup correctly adds a fifth. The test now accounts for it and probes authenticated `mayAnswer` through the real forward after setup, reconnect and host restart, while retaining its assertions that the host key and passphrase are asked once per connection. The targeted Windows run passed 57 tests with 3 skipped; the native sshd journey requires the PR's Linux runner. Independent Standards and Spec reviews of this follow-up found no issues.
