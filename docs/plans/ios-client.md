# Native iOS client

Owner authorized implementation September 21, 2026: an installed iOS app like T3 Code, private Tailscale access, code-entry pairing B, existing-thread reading/replies/interruption/explicit request answers. TestFlight is planned; signing/account/build-host access is not verified. ADR-0021 records the native boundary before source changes.

## Implementation and acceptance

- [x] Source: standalone apps/ios package, Xcode project/shared scheme, SwiftUI app targeting iOS 17, Foundation HTTP/WebSocket and Security Keychain. No third-party runtime or changes to desktop dependencies.
- [x] Source: pair by entering the private HTTPS host and code read on Forge. Reject non-HTTPS/non-ts.net routes, URL credentials/query/path; preserve default TLS validation; prohibit credential-bearing redirects. Token only in unlocked/device-only Keychain; no provider keys or transcript logs.
- [x] Source: host-scoped thread list/detail, text replies, interrupt, native question choices and explicit permissions. Pairing never grants authority. Unknown request kinds/choices fail closed. No terminal, new-thread, worktree, audio or file controls.
- [x] Source: foreground obtains a new session, full shell and selected detail. Stable submitted command ID; no automatic replay after uncertain delivery. Persist only pending identifiers, not transcript text; drafts remain in memory across backgrounding, clear on termination/Forget. Host retains work independently.
- [ ] Meaningful Swift codec, endpoint, question validation and uncertain-command tests. Run on a Swift-capable machine; Windows currently has neither swift nor xcodebuild.
- [ ] Simulator build/test, signed device build, installation and real iPhone journey. No claimed completion from HTML or static validation. No TestFlight upload without a reviewable signed build.

## Framework comparison

SwiftUI fits this iOS-only scope with native lifecycle/accessibility, Foundation networking and Keychain without a third-party runtime. React Native/Expo matches T3 and would share TypeScript wire models, but brings a JS/native dependency and build boundary; desktop DOM/preload still cannot be reused. Choose SwiftUI here, and test Codable fixtures against the shared host protocol to manage duplicated wire types. Android is outside scope. Local Xcode/macOS is needed for native verification; cloud builds are not selected.

## Design checks

Concept: one quiet thread room on a phone; the proving moment is reading Forge's work and answering its current request explicitly. The selected direction is thread-first navigation (list then full-width transcript); attention-first and split-pane alternatives would compete with the owner's chosen quiet phone flow and are not reopened. Pairing B was already selected, so the prototype validates states instead of asking for another variant vote.

Reference: Sotto's existing Figtree/theme roles and T3's native mobile thread/connection source. Inspect the rendered reference if available; record tool limitations rather than inventing a visual review. Carry a thin navigation strip, open transcript, subdued metadata and one accent action. No marketing, repeated subtitles or decorative cards. New app has no existing native page, so docs/prototypes/ios-thread-prototype.html is the throwaway fixture close to the existing pairing prototype.

- [ ] Review 390x844 and 375x667, light/dark and reduced motion. Body 17px, labels/actions >=14px, secondary >=12px, text contrast >=4.5:1, touch targets >=44px. Native Dynamic Type/VoiceOver need simulator/device checks.
- [ ] Pair form, thread list, transcript, question, permission, uncertain delivery and reconnect states fit without horizontal overflow; composer respects keyboard/safe area. Escape closes prototype sheets; focus order follows reading order.
- [ ] Five first-screen purposes: navigation/title, current work, request if present, composer, send. Connection/delivery feedback and required request choices are essential operational exceptions. No duplicate explanations.
- [ ] Short navigation/reveal motion, immediate under reduced motion. Native navigation uses platform transitions and accessibility settings.
- [x] Render prototype and exercise its fixture journey before writing native views; record exact captures/checks below. Prototype is not phone delivery proof. Keep it uncommitted per parent instruction; no throwaway branch publication authorized.

## Evidence

Prototype inspection completed with Playwright: selected pairing -> thread list -> question journey, 390x844 dark and 375x667 light; 28 viewport/theme/state combinations had no horizontal overflow. The initial transition overflow was fixed by containing the app viewport. Reduced motion computed animation-name:none. Native touch controls have 44pt minimums; actual keyboard, VoiceOver and Dynamic Type remain unverified until native execution.

Rendered reference inspected: [T3 iPhone App Store screenshots](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), including compact thread rows, environment selection sheet and a full-width transcript/composer. Sotto carries that direct list-to-thread navigation with its own Figtree and quiet semantic colors; no T3 branding copied. The prototype's thread view has five primary purposes (navigation, user prompt, agent work, current request, composer); provider label is needed attribution, native choice buttons are required operating controls, and the bottom fixture toolbar is not part of the app. Repeated status subtitles were avoided. Pairing has title, instruction, host field, code field and Pair action; authority feedback is the required operational exception.

Static native checks passed: Info/export plists, shared-scheme XML, project object references, asset JSON and UTF-8 without BOM. Text contrast on native sampled role pairs is >=6.25:1 dark and >=6.27:1 light (Ink/Canvas, Muted/Canvas, Muted/Raised, Ink/Surface, ActionInk/Action, Accent/Canvas). These checks do not compile Swift or establish native layout.

Seventeen XCTest methods are written but NOT RUN: this Windows environment has no swift or xcodebuild. Mac access requested by the parent remains pending. No simulator build, signed archive, TestFlight upload, iPhone install, live native socket journey or native accessibility result is claimed. The Xcode project/scheme and README document those exact remaining steps. Scope remains open until those acceptance checks are possible.

The prototype captures are currently in the Windows temporary directory as sotto-ios-prototype.png and sotto-ios-prototype-light.png; the parent can retain them with the integrated verification artifacts. CUA browser startup failed twice, so Playwright rendered the reference and fixture; screenshots were emitted and visually inspected through the tool image channel. Code/host wire coordinated with #137; Foundation WebSocket uses signed session in Upgrade Authorization and each request, with no query credentials. Source reconciliation matches the host contract: completed means the coordinator call settled, not provider delivery; unknown, unavailable and uncertain outcomes retain the marker. Live reconnect safety still requires native execution.

Independent native review fixed revocation/deletion ordering and host/client marker scoping, stale full-detail responses across push/reconnect/selection, and stale pairing completion changing newer connection state. Added pure snapshot-generation/revision regressions; these remain unrun until a Swift toolchain is available.
