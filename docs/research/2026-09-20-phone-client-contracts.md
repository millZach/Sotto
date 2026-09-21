# Phone client contracts

Research for [#141](https://github.com/millZach/Sotto/issues/141), part of [#134](https://github.com/millZach/Sotto/issues/134), on September 20, 2026, corrected September 21. The owner selected a **native iOS app similar to T3 Code's mobile app**. This supersedes the earlier browser assumption. React Native/Expo is a framework candidate below, not an owner-selected framework. No native app, dependency or distribution service is added by this research.

## Evidence and outcome

Sotto was inspected at `d0fbf3e8f5babc3eacf24039df6c11b4cdafdb4f`, before the parallel host changes for this map. Relative source links below describe that baseline, not a claim that all subsequent edits preserve its limitations. The requested `.claude/tmp/t3code` checkout was absent in this worktree. T3 source was instead read through GitHub's API at the revision already recorded by the September 20 research: [`adcd90858c3bfece59095465d2f49860ba3dcea9`](https://github.com/pingdotgg/t3code/commit/adcd90858c3bfece59095465d2f49860ba3dcea9). No T3 application or phone was run.

Recommend a focused native iOS client connected to the host through an explicit versioned remote contract. Reuse Sotto's Zod schemas and detail arithmetic where their semantics fit. Keep host work running independently of the iOS app. Do not expose the entire current `AgentState` as the permanent phone contract: it combines host facts, global desktop selection, drafts, speech, configuration and account state. The current shell removes messages and activity arrays but retains the other fields. [State and shell](../../src/shared/agents.ts), [coordinator shell](../../src/main/agents/control.ts).

The map's dependency note is stale: production dependencies are currently `zod` **and `node-pty`**, not only `zod`. The parallel implementation records the host decision in [ADR-0020](../adr/0020-headless-host-and-client-identity.md), superseding the proposal's conflicting ADR number without claiming [PR #133](https://github.com/millZach/Sotto/pull/133) merged. A separate mobile package and its runtime dependencies still need a decision. [Dependencies](../../package.json), [terminal decision](../adr/0018-terminals-run-on-node-pty.md).

The existing `credentials` state contains availability booleans, not API keys. Agent configuration likewise contains provider/model choices and paths, not secret values. Excluding this metadata from the first phone projection is a scope decision; this study found no decrypted-key exposure in the existing shell. [Credential state and configuration](../../src/shared/agents.ts), [secure settings](../../src/main/agents/secureSettings.ts).

## What travels when

“Every frame” should mean the current compact state of a subscription when it changes, not an instruction to send every field on each client render frame. Sotto currently coalesces coordinator publication over 16 ms and its IPC publisher over 50 ms. A phone transport needs bounded buffers and its own measured publication policy; these desktop intervals are not a mobile performance promise. [Publishers](../../src/main/agents/control.ts).

The following is a proposed remote projection, not an existing API:

| Data | Initial read and subsequent updates | Reason |
|---|---|---|
| Stable host identity, host label, selected wire version, host instance epoch, capabilities and limits | Handshake; capabilities again when they change | Distinguish two hosts and a restarted process; avoid resending the descriptor with every token |
| Project ID/title and thread Sotto ID/project ID/title/provider ID/model ID | Initial shell, then changed rows | Render the list and route explicit actions; provider ID means the adapter kind, never its native session ID |
| Thread `status`, organization/lifecycle state, relevant timestamps, bounded summary counts, monitoring and subagent counts | Shell updates | Show work and attention without fetching history |
| Pending request ID/kind and attention indicator | Shell updates | Badge a thread; invalidate an open answer form when another client answers |
| Request text, choices, structured questions, permission action context | On opening the thread or attention item; update while open | Full requests can carry substantial text. An answer must reference the exact current request and preserve native choice IDs |
| Provider connection and verified command capabilities | Initial descriptor/catalog; updates on connection or support changes | Separate provider availability from phone availability and permission authority |
| Messages and activity for the visible thread | Initial newest ten turns, then bounded deltas | Preserve Sotto's existing history-window behavior; no history for offscreen threads |
| Older messages, earlier activity or subagent assignments | Explicit paged reads | A longer thread must not enlarge every shell update |
| Attachment metadata | With its message | Render a tile without its bytes |
| Image preview bytes and future attachment upload | Authenticated on demand with explicit size limits | Current previews already have a separate bridge; local paths and desktop-only preview URLs are not client-local resources |
| Models, skill catalogs, usage detail and working-copy display metadata | On opening their controls, with invalidation when changed | Large or rarely used catalogs do not belong in the streaming hot path |
| Command delivery status and follow-up queue status | For the client's pending actions and the open thread | Preserve queued/sending/unconfirmed/not-sent feedback and reconciliation |
| Selection, reading position and unsent phone composer text | Client state; a separately specified draft operation if host persistence is wanted | Selecting on the phone must not navigate the desktop or overwrite its draft |
| Credential-availability flags, speech state, wake settings, local recovery paths and unrelated desktop drafts | Excluded from the first phone shell | They do not enable the chosen phone journey; secret values already stay outside the existing shell |

Existing field evidence: `AgentThread`, `AgentThreadSummary`, `AgentRequest`, `AgentThreadDetail`, `AgentDelivery`, `AgentState`, and `agentShell` in [agents.ts](../../src/shared/agents.ts); on-demand preview in [control.ts](../../src/main/agents/control.ts); initial ten-turn history and privacy semantics in [ADR-0016](../adr/0016-sotto-owned-history-on-an-event-store.md). The present summary includes up to 2,000 characters each of the last user and assistant messages. That is bounded but need not be sent for every phone row if the design does not show it. The table deliberately recommends request summaries instead of today's complete `requests` array in every thread shell.

Always address entities by `(hostId, Sotto thread ID)` or `(hostId, project ID)` in client caches. The selected host owns the working directory; a host path is display data, never a path the phone can open locally. This extends [Sotto-owned identity](../adr/0002-sotto-owned-thread-identity.md) to the map's proposed host identity; it does not introduce provider session IDs into the shared record.

## Reconnect and multiple clients expose real gaps

The baseline `HostService` offers shell/state reads, a shell subscription, one detail read, commands and an event read. It does **not** expose a detail subscription, attachment preview, history-page cursor or subagent page through that interface. Desktop IPC reaches some of those directly. The event stream records message changes/resets and answers; it is not a replay of project metadata, pending requests, activity or all shell changes. Replaying `events(afterSeq)` alone cannot reconstruct the whole phone UI. [Host service](../../src/main/agents/hostService.ts), [IPC](../../src/main/agents/ipc.ts), [event kinds](../../src/shared/threadEvents.ts).

The coordinator has one `viewedThreadIds` collection: `observe-threads` replaces it. Detail targets and the last-published detail bases are shared across listeners, and calling `threadDetail` resets the base for later deltas. A second client cannot safely be treated as another copy of the sole desktop window. Keep each client's subscriptions and resync state separately; take their union, plus assignments/queues, for the host's watched set. Disconnecting or suspending one client releases only its observations. Keep navigation and composer ownership separate from host thread state. [Observation, detail targets and bases](../../src/main/agents/control.ts).

The detail `revision` is a process-local counter derived from message IDs, text lengths, attachment counts, history epoch and activity signatures. It is not the durable event sequence. Same-length content changes can escape this signature, and `earlierAvailable` is not part of the revision. Delta application validates `baseRevision`, but returns objects without preserving `earlierAvailable`; that metadata is currently also available in the thread shell. A public detail-only consumer must not assume the full-read metadata survives a delta. [Revision computation](../../src/main/agents/control.ts), [delta arithmetic](../../src/shared/agentThreadDetail.ts), [detail schema](../../src/shared/agents.ts).

Recommended first wire behavior:

1. Authenticate, negotiate the protocol and obtain a descriptor. A changed host ID never resumes another host's data. A changed process epoch invalidates in-memory detail bases.
2. Subscribe without a read/subscribe gap: return a shell snapshot plus watermark, then ordered updates after it. For a first implementation, refetch the compact shell after every reconnect rather than pretending message events cover shell state.
3. Fetch/subscribe to only the selected thread, with its snapshot watermark and history epoch. Apply a delta only to its exact base. Duplicate updates are harmless; a missing base, reset, cursor invalidation or bounded-backlog overflow triggers a full bounded snapshot.
4. Page older history with opaque cursors and explicit `hasMore`; merge against the thread's own watermark so streamed text cannot be appended twice. Specify how rewinds and Keep local history changes invalidate pages and client caches.
5. Use stable client command IDs and delivery reconciliation. A dropped acknowledgement is not permission to resend an answer or prompt. On simultaneous answers, the host accepts at most one current request answer and returns a clear stale/already-handled result to the other client.

These are follow-up requirements, not proof of delivery semantics in an unimplemented socket. T3 provides a useful concrete comparison: its shell has snapshot and upsert/remove variants with sequences; thread subscriptions accept `afterSequence`, optional completion markers and a window limit. Its history pages have opaque cursors and distinguish the global snapshot sequence from the thread sequence needed to merge a page safely. [T3 shell and subscription contracts](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/contracts/src/orchestration.ts#L843-L1058).

## Versions and advertised capabilities

T3's inspected protocol version is **1**, distinct from its package/server version. Missing protocol metadata denotes legacy version 1. Its client rejects a different protocol number with an update direction; this is exact-version compatibility, not evidence that any new client works with any old major protocol. Feature additions stay optional within the compatible protocol. For example, an absent `threadSettlement` means the client must not send settlement commands. T3 also has deliberately tolerant codecs for selected extensible display metadata. [Version and capabilities](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/contracts/src/environment.ts#L12-L14), [descriptor and optional features](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/contracts/src/environment.ts#L82-L188), [compatibility check](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/client-runtime/src/connection/compatibility.ts), [tolerant codecs](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/contracts/src/baseSchemas.ts#L38-L97).

For Sotto, define protocol v1 separately from the app version. Start with one supported major; several app releases can share it. A future incompatible major needs an explicit support window or parallel decoder, not a version range that the implementation cannot honor. Additive optional fields must have documented defaults. Unknown display-only metadata can be omitted safely; unknown commands, permission choices, required action variants or state-changing events must be refused or force a compatible resync. Do not silently discard a request the user needs to answer. Current `.strict()` detail schemas are useful internal validation but will reject additive fields unless the wire decoder deliberately evolves. [Current schemas](../../src/shared/agents.ts).

A proposed handshake response could have this shape; names are illustrative and require the contract ticket:

```json
{
  "protocolVersion": 1,
  "hostId": "opaque-persisted-id",
  "instanceId": "opaque-process-id",
  "hostVersion": "app-release",
  "capabilities": {
    "threadList": true,
    "threadDetail": true,
    "threadPrompt": true,
    "threadAnswer": false,
    "worktreeManage": false,
    "terminal": false,
    "dictationPaste": false
  },
  "limits": { "maxMessageBytes": 1048576 }
}
```

The byte limit is an example, not a selected or measured limit. The descriptor should advertise actual enforced limits. Capabilities are effective for this connection: host support intersected with provider support, first-client scope and current policy. Also return a stable unavailable reason plus plain-language explanation where a visible action needs one. An absent new capability means unavailable. Provider capability flags alone cannot express phone platform limits. Recompute after provider changes or policy revocation, and enforce each action in the host even if a stale client still shows its button. Pairing is admission; capability display is not authority. The existing coordinator calls `guardClientGrant` for **all answers**, including questions, and consults `Authority.mayGrant`; preserve or explicitly decide that behavior rather than assuming only Allow is guarded. [Provider capabilities](../../src/shared/agents.ts), [answer guard](../../src/main/agents/control.ts), [authority decision](../adr/0004-authority-in-policy-records.md).

## What the first phone can and cannot do

The owner accepted the first-phone scope on September 21: list/open/read existing threads, send text, interrupt supported turns, and explicitly answer current questions or permissions only when that paired client is authorized. Thread creation, terminal and file management follow after that first milestone. Work continues on Forge after the iOS app suspends or terminates.

| Function | First native iOS app behavior |
|---|---|
| Worktree operations | Unavailable. Existing threads still run in their host-owned working copies; show branch/path context if useful. No phone filesystem picker or worktree creation/removal/switch/restore control |
| Terminal | Unavailable. Hide Terminal mode and terminal tools; opening a host terminal remotely is a separate feature, not inherent in thread prompting |
| Dictation paste into another app | Unavailable. The desktop's hotkey, focus restoration and paste bridge are desktop integrations. The iPhone keyboard may produce text, but that is not Sotto dictation; a Sotto phone audio pipeline would need separate scope |
| Desktop window/tray/widget, native reveal/editor actions | Unavailable. No dead desktop controls in the phone shell |
| Speech, wake detection and memory | Respect existing beta gates; do not enable them as a side effect of pairing |
| Answering from a paired phone without grant policy | Read the request; answer control explains that this client cannot answer. Pairing must not silently create authority |

These exclusions are Sotto's initial product scope, not claims that mobile software can never offer a terminal or worktree controls. T3's actual mobile source includes worktree setup and a terminal session hook. [T3 worktree setup](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/features/threads/use-worktree-setup.ts), [T3 terminal session](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/state/use-terminal-session.ts). Sotto's renderer gates and native distinction are recorded in [CONTEXT.md](../../CONTEXT.md), [voice gate](../adr/0012-voice-coordinator-hidden-for-the-beta.md), and [memory gate](../adr/0013-memory-hidden-for-the-beta.md).

## Native iOS runtime and delivery constraints

**Lifecycle.** Apple documents that foreground apps generally move briefly into the background and then suspend; a background task grants limited completion time, not a permanent connection. React Native exposes active/background and iOS inactive transitions through `AppState`. Therefore, treat foreground return as a connection check and possible resync: reauthenticate, fetch the current shell/selected detail, reconcile uncertain commands, and preserve drafts. Do not rely on a continuously running socket or background permission answers. This is a recommended Sotto lifecycle policy, not a measured implementation result. [Apple background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time), [React Native AppState](https://reactnative.dev/docs/appstate).

**Connection and pairing.** The app needs its own authenticated HTTP/socket transport; it cannot use Electron preload or the laptop's `localhost`. Retain a private, certificate-validated TLS route to Forge, with the host listener on loopback behind the selected route. The owner accepted requiring Tailscale on the iPhone on September 21. Tailscale Serve remains the proposed private HTTPS implementation, not a verified deployment. Decide short-lived pairing-code exchange, host identity confirmation, per-device credentials, expiry and host-side revocation with #137/#139. The owner selected variant B on September 21: read a pairing code from Forge and enter it on the client. Use that manual code-entry pattern as the baseline; QR/deep-link conveniences can follow without changing admission or authority semantics. A QR or link should carry a short-lived pairing secret, never the long-lived credential. Native clients are not protected by browser same-origin rules: authenticate every connection/action. Keep Apple transport security enabled; its default URL-loading policy requires secure connections and validates server trust. [Apple transport security](https://developer.apple.com/documentation/security/preventing-insecure-network-connections), [host boundary](../adr/0020-headless-host-and-client-identity.md).

**Token storage.** Store only the phone's host credential in iOS Keychain, never provider keys or plaintext preferences. React Native's security guide identifies Keychain for small secrets and warns that AsyncStorage is unencrypted. If Expo is selected, SecureStore uses Keychain on iOS and exposes accessibility choices. Recommend an explicit unlocked/device-only setting for the initial foreground client; decide biometric prompts separately. Handle missing, locked or invalidated items as recoverable authentication states. SecureStore data may survive uninstall/reinstall, but that behavior is not guaranteed: deleting the app is neither reliable revocation nor a recovery guarantee. Forget must remove local credentials/cache; host revocation must reject retained tokens. [React Native security](https://reactnative.dev/docs/security), [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).

**Build and distribution.** A native iOS client requires an app package, unique bundle identity, signing and a supported device/OS policy. Local Expo iOS builds use Xcode; the iOS simulator runs on macOS. Expo's EAS cloud build is an optional route from Windows, not a requirement or authorized upload of this repository. Apple permits personal-device testing through Xcode with a free account; TestFlight and App Store distribution require Developer Program membership. Plan for TestFlight following the owner's response to the delivery recommendation; the owner reports an Apple developer account. Verify program enrollment, team access and signing before distribution. If Expo is selected, verify Sotto's own native build, because a development build can include native libraries/configuration unavailable in Expo Go. The Apple account is owner-reported; program enrollment, signing profile, build host and device access were not verified here. [Expo build choices](https://docs.expo.dev/develop/development-builds/introduction/), [Expo iOS simulator](https://docs.expo.dev/workflow/ios-simulator/), [Apple program and device testing](https://developer.apple.com/programs/).

The first acceptance target is an installed app on the owner's iPhone. Test lock/unlock, app switching, termination/relaunch, Wi-Fi/cellular changes, route loss, host restart and token revocation alongside the desktop. Check safe areas, keyboard/composer visibility, Dynamic Type, VoiceOver, light/dark and reduced motion. A rendered HTML design prototype is useful design evidence but does not prove native lifecycle, storage or signing. Leave push, background refresh and cloud update services outside the first journey; selecting any requires its own endpoint/privacy and delivery decision. Minimum iOS version, app framework, build/signing access, optional phone pairing conveniences and real-device behavior remain open. TestFlight is the planned delivery path. The base code-entry pairing flow is selected.

## T3 mobile technology and reuse

The pinned mobile app uses **React Native 0.86.3, Expo 57, React 19.2.3**, React Navigation, Effect, native modules and many Expo services. Its scripts build native iOS/Android applications. It shares `@t3tools/client-runtime`, `@t3tools/contracts` and `@t3tools/shared`; the contracts themselves depend on Effect. This is a native app reference, not a drop-in Sotto package. [Mobile package](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/package.json), [contract package](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/contracts/package.json), [shared client package](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/packages/client-runtime/package.json).

The mobile connection catalog stores credentials and remote tokens through its SecureStore wrapper. The wrapper uses SecureStore's default options; this is not evidence of a custom biometric or device-only policy. Pairing helpers accept host/code input and QR payloads, including a `t3code:` link. Its native platform layer listens for network and `AppState` changes, rereads network state on active, and signals either a probe or reconnect; the helper selects reconnect after at least ten seconds in background. That threshold is T3 policy, not an iOS guarantee or a proposed Sotto deadline. The same platform layer explicitly refuses SSH provisioning on mobile. [Credential catalog](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/connection/storage.ts), [catalog persistence](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/connection/catalog-store.ts), [SecureStore wrapper](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/persistence/mobile-secure-storage.ts), [pairing helper](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/features/connection/pairing.ts), [native connection layer](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/connection/platform.ts), [wakeup policy](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/src/connection/app-state-wakeups.ts).

T3 configures separate native variants, URL schemes, iOS bundle identifiers and signing settings, with internal and production/store build profiles. These files establish its configured build workflow, not evidence that this investigation installed a distributed T3 app. Do not copy its team identifiers, endpoints, relay/account integration or update services into Sotto. [Native app configuration](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/app.config.ts), [build profiles](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/apps/mobile/eas.json).

Recommend evaluating React Native/Expo first because the reference uses it and Sotto can share TypeScript wire models; this is an engineering recommendation, not a selected framework. Compare a small native spike with SwiftUI before recording the package/build decision. Reuse Sotto's pure schemas and state arithmetic after removing Electron/Node assumptions; native views do not inherit the desktop DOM/CSS/preload implementation.

The repository license is MIT, with copyright and permission-notice retention required for copies or substantial portions. Reviewed source reuse is possible subject to those terms and third-party/asset obligations. No T3 source was copied by this research. Reuse subscription/versioning and lifecycle ideas first. A selected pure helper may be ported after checking imports and notices; importing T3's Effect-based contracts/runtime or native UI would add dependencies. The issue's dependency-free reuse condition permits ideas or suitable isolated helpers, not importing the entire native stack. Keep Sotto's existing desktop/host production dependency gate intact; decide a separate mobile dependency and release boundary in an ADR. [T3 license](https://github.com/pingdotgg/t3code/blob/adcd90858c3bfece59095465d2f49860ba3dcea9/LICENSE), [Sotto dependency gate](../../scripts/release-external-dependencies.mjs), [Sotto dependencies](../../package.json).

## Recommended follow-up tickets

These bodies are ready to file under #134. They are proposals, not filed issues. Coordinate the first two with #137's socket transport rather than implementing competing protocols. #138 continues to own SSH desktop launch and #140 host packaging; the phone route does not replace them.

### Define protocol v1 and advertise each client's available actions

**Why:** The current IPC state and provider capabilities do not specify independently released clients or phone exclusions.

**Scope:** Add a shared Zod remote descriptor/envelope/projection; distinguish host identity, process epoch, wire version and release version. Document optional defaults, unknown variants, enforced limits, effective capability reasons and native authentication/session requirements. Keep commands strictly validated and authority checked by the host. Coordinate with #135/#136/#137 and the host ADR.

**Acceptance:** Current and previous v1 fixtures decode additive display fields; unsupported majors give a useful update direction; absent features cannot send commands; revoked authority blocks a previously enabled phone answer; no desktop drafts, credentials or provider session IDs appear in the first-phone shell. A fixture records maximum accepted frame behavior. No new runtime dependency.

### Give each client independent subscriptions and recover streams without gaps

**Why:** The baseline watched set and detail bases belong to one window, and message events cannot replay all shell state.

**Scope:** Carry per-client observations through HostService; expose bounded detail subscriptions, snapshots and history pages. Preserve pagination metadata and invalidate bases on epoch/reset/retention changes. Fix revision detection for same-length replacements. Add command IDs/receipts to the remote boundary without replaying uncertain actions.

**Acceptance:** Desktop observes A while phone observes B; closing phone leaves A watched. Snapshot-to-live changes are not lost; duplicate frames do not duplicate text. Missing deltas, restart and backlog overflow resync within bounds. Earlier-message paging during streaming preserves order and `hasMore`. A same-length edit arrives. Two clients answering one request produce one native action; a lost acknowledgement reconciles without resending. Keep local history changes clear affected client caches.

### Pair the native iOS app with the host and store its credential securely

**Why:** The selected phone target is an iOS app; the desktop SSH launcher and Electron credential bridge do not provide its transport or storage.

**Scope:** Implement the chosen pairing UX with short-lived exchange, host identity confirmation, certificate-validated TLS and an authenticated HTTP/socket client through the agreed private phone route. Keep the host on loopback behind that route. Store only per-device host credentials in Keychain with an explicit accessibility policy; define expiry, revocation, Forget and reinstall behavior. Share #137's service and authorization; add required endpoint/privacy documentation before enabling new services.

**Acceptance:** An installed iPhone app pairs with Forge, reconnects, and is rejected after host revocation. Expired/reused pairing codes and invalid tokens fail without leaking secrets in logs or shareable long-lived URLs. A locked/missing Keychain item gives recoverable feedback. Forget clears local credentials and affected cached data; reinstall cannot bypass host revocation. Pairing grants no permission authority. Desktop SSH use still works. Record device/account setup requiring the owner.

### Decide the iOS package, signing and distribution path and produce a device build

**Why:** The owner chose native iOS and reports an Apple developer account. TestFlight is planned, but framework, package boundary and verified signing/build access are still needed.

**Scope:** Compare a small React Native/Expo spike with SwiftUI against shared-contract reuse, native storage/lifecycle and maintenance. Record the selected framework, minimum iOS version, mobile dependencies, bundle identity, build host and signing/distribution path in an ADR. Create the separate app package without relaxing desktop/host dependency gates. Use local macOS/Xcode or an explicitly approved cloud build; use development signing for device checks and prepare the planned TestFlight delivery after verifying enrollment and team access.

**Acceptance:** Reproducible simulator build and signed app installed on the owner's iPhone; document tool versions, native dependency notices, provisioning renewal and installation steps. A release-style build launches without a development server and reaches a test host with the chosen transport. Signing material and host credentials never enter source. Simulator/emulation, Expo Go alone and HTML prototypes do not satisfy device acceptance. No cloud build/update service is enabled implicitly.

### Build and verify the native phone thread journey and foreground recovery

**Why:** A valid socket and installable package are not a usable phone client.

**Scope:** Prototype the phone list, detail, composer and requests with the owner before implementation. Use Sotto themes and plain copy. Read, send text, interrupt, and answer only when allowed. Declare worktree management, terminal and dictation paste unavailable. Keep provider execution independent of app lifetime; preserve drafts with an explicit local retention policy and reconcile pending commands on foreground return.

**Acceptance:** On the owner's installed iOS app and supported desktop client, read the same Forge thread, send and see the reply, and handle a current request explicitly. Recover after switch/lock, termination/relaunch, Wi-Fi/cellular changes, route loss and host restart without duplicate sends or stale permission answers. Check dark/light, reduced motion, VoiceOver, Dynamic Type, keyboard visibility, safe areas, long transcript paging and clear offline state. Record actual iOS/device/app versions and native screenshots; verify retained host work continues while the app is suspended. Push and other background services remain separate scope.

### Add bounded attachment previews after the text journey

**Why:** The existing desktop preview bridge and local paths are not a remotely usable asset contract.

**Scope:** Add authenticated per-message preview reads with content/type/size limits, cache invalidation and history-policy behavior; define upload separately if included. Expose capability flags so older hosts and unsupported providers remain usable.

**Acceptance:** A phone fetches only a requested authorized thread preview; missing/redacted previews have clear feedback; oversized content and cross-host/thread references are rejected; bytes never enter the shell or logs. Existing text-only clients still work. Upload, if shipped, preserves uncertain-delivery behavior and cannot bypass provider image support.
