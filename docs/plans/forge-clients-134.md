# Forge host and clients — #134

First parallel batch authorized September 20, 2026: #135 headless runtime, #136 host identity, #139 pairing prototypes, #141 phone contract research. The phone target is an iOS app connecting to Forge, similar to T3 Code, as corrected by the owner on September 21, 2026. Three subagents own #135, #136 and #141; the parent owns #139 and integration.

## Deliverables and state

- [ ] #135: Local implementation and Windows verification complete: Electron-free Node startup, shared runtime, encrypted credentials, shared fake-provider contracts and drained shutdown. Native Linux/Forge acceptance is blocked by Forge being offline. An additional desktop Chats journey exposes an unchanged title-bar overlap; it is recorded in the verification note.
- [x] #136: durable host identity, atomic/idempotent migration, collision-safe client identity and regression coverage.
- [x] #139: local mock-ups, captures and selected copy ready. Owner selected B (read a pairing code from Forge and enter it on the client) on September 21, 2026. No issue has been closed or production pairing UI shipped.
- [x] #141: cited source research, version/capability proposal and concrete phone follow-ups.
- [x] Integrated typecheck, lint, two-worker tests (4,271 passed), notices and build.
- [ ] Desktop journeys: 17 passed; an additional provider-chat journey fails on a title-bar control overlap. The same failure was reproduced on the isolated starting commit; it predates this batch and remains outside its host/client scope.

#137 depends on #135; #138 depends on #137; #140 requires the headless runtime and socket contract; #142 needs SSH connectivity and the pairing decision. Start dependent implementation only after its contract is ready. No issue is closed merely because local work exists. Publishing a release and merging PR #133 are outside this batch.

## Decisions and gaps

The proposed headless-host ADR is on open PR #133, not this checkout. Its 0017 number is occupied by Devin. Record host decisions as ADR-0023 (written as 0022; renumbered September 22 when main's Devin permission-mode decision took 0022) without overwriting Devin or main's two 0020 decisions or claiming PR #133 merged. The current production dependency allow-list is zod and node-pty; the older map's zod-only statement predates ADR-0018.

The owner selected variant B on September 21, 2026: read a pairing code from Forge and enter it on the client. Build the desktop Settings > Hosts dialog from B. Keep A as an archived alternative and C as the iOS design fixture for the same code-entry pattern. QR scanning is an optional later convenience, not a requirement of this selection. The phone is an installed iOS app, following T3 Code as a reference. The earlier Safari/browser assumption is superseded. The framework remains an implementation decision. Plan for TestFlight delivery using the owner's reported Apple developer account; enrollment, signing and build access remain unverified. HTML previews are design fixtures only; acceptance requires the iOS app on a real iPhone.

On September 21 the owner changed the desktop pick to variant A after comparing with T3 Code: SSH has already authenticated the laptop, so the desktop reads its own pairing code over the tunnel and pairs itself. Variant B stays the phone's flow, where nothing else proves who is asking. In the same review the owner asked for two more T3 behaviours before merge: a host that Sotto started over SSH keeps running when the connection drops and stops only on an explicit Disconnect or Forget, and a dropped connection reconnects on its own with capped backoff.

## Pairing design acceptance

Question: where should the user confirm the identity of a client connecting to Forge? This is Settings → Hosts; the decisive moment is the explicit Pair button followed by the named client appearing on the host.

Reference: existing Settings Providers capture (`artifacts/design/app-review/baseline/settings-providers.png`), ADR-0011 and live Settings source. Carry Figtree, one quiet room, a left Settings column, thin rules and a cyan action/focus color from theme roles. No replacement branding or decorative imagery.

Concept A: an inline confirmation inside the Forge host row after authenticated SSH. Concept B: a focused dialog asking for a code read from the host. Concept C: an iOS app pairing screen with the same host-code flow for iPhone, represented by an HTML design fixture. A and B are desktop alternatives; C explores phone admission. The iOS connection transport and app framework require their own implementation decisions.

- Mock-ups are throwaway static fixtures under docs/prototypes as #139 explicitly requests, outside the shipped renderer. One local-only command serves them. Variant URL and floating keyboard switcher expose every option. All state stays in memory.
- Desktop review at 1600×1000, 1280×800 and 820×560. iOS app design fixture at 390×844, 375×667 and an intermediate width. No horizontal overflow; scroll remains available with the keyboard open.
- Use existing --tt-* tokens and bundled Figtree. Body 16px, labels/actions at least 14px, secondary text at least 12px. Text contrast at least 4.5:1. Check light and dark.
- Opening view: one heading, host name, connection state, explanatory sentence and primary action. Necessary navigation, labels, and explicit authority feedback remain visible in their relevant states. Avoid repeating facts.
- Pairing is admission and client attribution. It never answers a permission or creates a policy grant. Say this at confirmation; Forget revokes client access and retains thread history.
- Keyboard order follows reading order; Escape closes dialogs and returns focus. Actions have names and touch targets at least 44px. One short reveal connects confirmation to the paired row; reduced motion makes the transition immediate.
- Capture initial, paired list, expired code/session, and Forget confirmation. Inspect full flow, keyboard and both variants before requesting the owner's final pick.

## Selected variant B copy

Owner choice recorded September 21, 2026, and narrowed to the iOS client the same day (see Decisions and gaps). The client opens Settings > Hosts, chooses Enter pairing code, reads the code on Forge, enters it, and presses Pair this laptop. The iOS fixture uses Pair this iPhone. After admission, show Paired clients with Forget; forgetting access retains the host's threads.

- Dialog: Pair with Forge
- Instruction: Read the pairing code on Forge and enter it here.
- Field: Pairing code
- Authority: Pairing identifies this client. Permission requests still need your answer, and policy records decide whether this client may grant them.
- Expired code: This code has expired. Make a new pairing code on Forge and enter it here.
- Expired session: This client's session has expired. Your threads are still on Forge. Reconnect to continue.

## Phone decisions recorded September 21

- Phone access: private Tailscale connection accepted. Requiring Tailscale on the iPhone is acceptable; no public phone endpoint is requested.
- First phone release: existing-thread reading, replies, interruption and explicit request answers accepted as the first milestone. New-thread creation, terminal and file management follow later. Pairing still grants no authority; the user answers each request under the existing policy model.
- iOS delivery: plan for TestFlight. The owner reports an Apple developer account. Paid program enrollment, App Store Connect team access, signing and build-machine access have not yet been checked. No app has been uploaded or distributed.

Framework, wire protocol details, token storage defaults and minimum supported iOS version can be proposed and recorded by the implementation owner; they do not all require separate owner picks. Notifications and optional QR pairing can be decided after the first phone journey.
## Environment

Default shell, image viewer and node REPL currently fail Windows sandbox ACL initialization (`apply deny-read ACLs`). Reviewed escalated shell commands work. Dependencies installed with `npm ci` in this worktree, without a node_modules junction.

## Implementation batch resumed September 21

User authorized implementation after accepting B, Tailscale, existing-thread scope and the TestFlight plan. Work is shared among the socket, SSH and iOS agents; parent owns desktop integration and verification. SwiftUI/URLSession/Keychain is the selected native implementation, without mobile third-party runtime dependencies; ADR-0023 records the tradeoff. The desktop shows both local and remote threads using host-qualified IDs.

- [x] #137: authenticated loopback WebSocket service, per-client observations, reconnect, native-friendly protocol, child-process shared contract. Local evidence only; no remote peer has connected.
- [x] #138: validated direct SSH spawn, prompts, discover/start/forward and owned-host shutdown, fake-process integration coverage. The real Forge journey in its acceptance is still owed.
- [x] #142: Settings Hosts, pairing B, remote routing and optional local host, desktop journeys. Pick recorded: one window shows every connected host's threads together, with one selected host for new work.
- [x] iOS: native app package, protocol client, Keychain, existing-thread journey, lifecycle recovery and signed-device preparation, as source. No Mac has compiled it; the CI job is the first check. Moved to its own pull request, #225, on September 22 to land after protocol v1 is frozen.
- [x] #140: host archive, checksum/runtime manifest and Linux socket CI gate. The Linux job has not run yet; a Windows smoke is not a Linux release.
- [x] Final gates and standards/spec review on September 21 (`docs/verification/2026-09-20-forge-client-foundations.md`, "September 21 review and gates").
- [ ] Live Forge and native iOS verification. Blocked on Forge being reachable and on a Mac build host.

Forge still reports offline; SSH port 22 timed out on the resumed check. The user was asked for Forge availability and a Mac build host while local work continues. No cloud build or TestFlight upload has been performed. Once Forge is back, the acceptance in #138 and #140 (add the host, connect, pair, see its threads, send, disconnect, reconnect) is the next step, and any of the eight issues closes only on that evidence.