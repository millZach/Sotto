# Remote permission choices retain the host's refusal

This records the initial refusal-routing fix. Zach later chose automatic permission setup for SSH desktops. The [follow-up verification](2026-09-29-ssh-desktop-permissions.md) supersedes the separate desktop-grant requirement below and records the policy established on Forge.

## Acceptance checks

- [x] A remote permission refusal reaches the chip with its reason instead of the generic connection error and unknown-provider-answer notice.
- [x] A refused choice retains the previous mode and the draft.
- [x] Ask for approval remains usable without a remote-answer policy.
- [x] All four runtime modes can be selected after an explicit remote-answer grant.
- [x] A disconnected, unavailable or incompatible host still uses the uncertain-command path.
- [x] The existing notice fits light and dark appearances at 1600x1000, 1280x800 and 820x560; keyboard and reduced-motion checks pass.

## Cause and scope

The host socket refuses a permissive mode before dispatch when the originating client has no remote-answer policy. `SocketHostService` throws a typed `HostConnectionError` with the host's refusal. The desktop router previously let that refusal become an IPC rejection. The renderer then returned no command result, showing both the generic connection error and an unknown provider answer. The router now returns a remote `forbidden` response through its state error, the same path as a coordinator refusal. Uncertain errors still reject, and nothing resends or grants authority.

The fix is in a local branch and its built test app. It is not in the installed desktop, and no release was requested.

Read-only checks of Forge confirmed it was reachable and advertised Sotto 0.1.26. Its saved desktop pairing matched this computer, and its policy store had no remote-answer records. No credential, prompt, transcript or protocol body was captured. Forge's policy, threads and host installation were not changed. The live provider's settings were not changed.

The socket regression initially failed with the actual policy refusal escaping the router. After the fix it exercises all refused permissive modes, the permission-chip store, the asking mode, and all four modes after an explicit test-host grant. This uses the real socket, coordinator and policy store with scripted providers; it proves routing and authority, not live-provider operation on Forge.

## Prototype

The throwaway state demonstration is on `prototype/remote-permission-feedback`, commit `bf4c91b5`, at `docs/prototypes/remote-permission-feedback.html`. It shows the existing chip and notice, a refused change, a separate explicit grant and a lost connection. The implementation preserves the existing UI and host-command setup. An optional question about a future setup control had no answer during this fix; no new permission-grant control was assumed.

## Validation

- `npx vitest run tests/integration/remoteThreadPermissions.test.ts tests/unit/main/desktopHostRouter.test.ts --maxWorkers=2`: 26 passed.
- `npm test -- --maxWorkers=2`: 476 files passed, 39 skipped; 6,310 tests passed, 152 skipped.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run notices:verify`: 174 components verified.
- `npm run build`: passed.
- `npx playwright test tests/e2e/pending-settings.spec.ts tests/e2e/host-identity.spec.ts --workers=1`: 2 passed.

The Electron journey injects the socket refusal sentence through the scripted provider's existing rejection seam. It verifies that the real chip displays the reason, drops its pending mark, retains the previous mode, and shows neither misleading connection message. The real socket-to-router-to-chip-store test covers the transport half independently. The existing journey also checks keyboard focus, retries, lost answers and reduced motion.

Captures in `artifacts/pending-settings/remote-policy-refused-dark-820.png` and `artifacts/pending-settings/remote-policy-refused-light-1600.png` show the refusal in the built Electron app. All six size/appearance captures were generated under the ignored `artifacts/pending-settings-run/`; the two retained images were visually inspected.

## Review

Standards: authority still comes only from the host policy; provider IDs remain inside adapters; no network, dependency, style, theme or shortcut was added to the renderer. The router translates only a definite pre-dispatch refusal. No payload logging or automatic retry was added.

Spec: the reported missing permission answer is reproduced at the real desktop routing seam and prevented by the fix. At this initial check, Forge needed an explicit answers grant before this desktop could choose a permissive mode. The subsequent SSH setup amendment establishes that grant automatically; the follow-up note records its verification.
