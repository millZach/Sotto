# TalkType design review

Date: 2026-07-15  
Scope: Task 14 deterministic desktop design review and accepted-finding fix pass  
Status: Complete; final independent reviewer recheck approved at commit `8fb207a741af5428aa2a60050f1156ecf7c0343c`.

## Review set and method

The review covered both themes, normal and reduced motion, keyboard focus, and 100%, 125%, 150%, and 200% device-scale equivalents. The authoritative matrix contains 112 unique tuples: 102 live app-review captures plus the 10 established Task 12 widget baselines. Dense-scale coverage includes onboarding model selection, Home, populated History, full Settings, full Help, and the live widget. The capture verifier rejects missing or duplicate tuples, paths outside the approved artifact roots, geometry/hash mismatches, non-transparent widget edges, and manifest/source inconsistencies.

Evidence:

- Before contact sheets: `artifacts/design/app-review/contact-sheets/before/`
- After contact sheets: `artifacts/design/app-review/contact-sheets/after/`
- Authoritative captures: `artifacts/design/app-review/baseline/`
- Structured evidence manifest: `artifacts/design/app-review/manifest.json`
- Established widget baselines: `artifacts/design/baseline/`

## Strengths observed

- The core visual language is coherent across the management window and widget: restrained neutral surfaces, indigo interaction color, teal success, and coral error.
- Information hierarchy is clear, with a dominant recording action, useful status/footer context, and well-grouped Settings sections.
- Light/dark parity is strong and the product remains recognizably TalkType rather than imitating WhisperFlow's visual identity.
- Privacy and offline behavior are explained in plain language at the moments where they matter.
- The widget states are compact and glanceable, and the existing reduced-motion token strategy provides a sound accessibility foundation.

## Severity-ranked findings and dispositions

All High and Medium findings were accepted.

| Severity | Finding and evidence | Accepted disposition | Result |
| --- | --- | --- | --- |
| High | Toggle rows could let the track and multi-line copy compete or collide at dense scale, especially in full Settings. Component: `Toggle`; captures: pre-fix 150%/200% Settings sheets. | Give the switch and copy explicit grid columns and a dedicated copy region with independent wrapping. | Resolved. Full Settings remains bounded at every scale in both themes. |
| High | Shortcut copy exposed Electron's canonical `CommandOrControl+…` syntax instead of the Windows-friendly `Ctrl+…` form. Components: shortcut editor, `ShortcutKey`, live widget. | Introduce one shared accelerator parser/formatter. Display friendly Windows copy while preserving canonical values for registration and IPC conflict handling. | Resolved. Editor, labels, and widget agree; shortcut replacement race/conflict tests remain green. |
| High | The widget's external glow could be clipped by the fixed transparent window, and the listening hint/action copy was too wide for the 420×92 surface. | Move depth inside the pill, format the live shortcut, hide redundant visual action text while retaining accessible names, and prove every child is bounded with exact transparent outer edges. | Resolved. All 10 established widget baselines and added live widget scale captures pass. |
| High | The original capture evidence was incomplete for dense full-page content, focus modalities, normal/reduced motion contrast, and packaged test-only boundary behavior. | Replace the ad-hoc list with an explicit matrix, capture full scroll surfaces, add four focus targets per theme, assert motion media state, strengthen the manifest verifier, and reject all E2E scenarios in packaged builds. | Resolved. Manifest verifies 112 exact tuples and full Help/Settings content is present at 200%. |
| Medium | Home success and error states relied too heavily on copy; the dominant record card did not provide enough semantic visual differentiation. | Add restrained teal/coral border, gradient, and icon tone contracts driven by state. | Resolved in both themes with computed-color assertions. |
| Medium | The Home record-card layout and tall lower cards used excessive vertical space, making supporting content feel pushed away at dense scale. | Use named grid areas for icon/copy/meter/action, preserve responsive reflow, and reduce the lower-card minimum height. | Resolved; lower cards remain materially visible and controls stay bounded through 200%. |
| Medium | Programmatically focusing the onboarding heading could show an inappropriate focus outline while the actual Continue action still required a clear keyboard indicator. | Suppress outline only for the programmatically focused `h1[tabindex=-1]`; retain a 3px `:focus-visible` ring on actionable controls. | Resolved with active-element and computed-style checks. |
| Medium | Normal-motion captures could sample finite CSS transitions mid-frame, producing non-deterministic listening-state screenshots. | Keep `prefers-reduced-motion: no-preference`, wait only for finite transitions to settle, and then capture after two animation frames. | Resolved; update and immediate no-update runs both pass. |
| Low | The generous card treatment could be compressed further for a denser utility aesthetic. | No additional change. The accepted layout fix keeps supporting content visible at 200%, and retaining measured whitespace supports the calm, approachable product character. | Intentionally retained. |

## RED/GREEN evidence

Tests were written against public component, style, capture, and packaged-boundary seams before each accepted change.

| Finding | RED evidence | GREEN evidence |
| --- | --- | --- |
| Toggle copy separation | Focused design-system test failed because `.tt-toggle__copy` was absent. | Focused test passed after the dedicated copy region and grid contract were added. |
| Friendly shortcut presentation | Settings test observed `CommandOrControl+Shift+Space` in the input instead of `Ctrl+Shift+Space`. | Settings suite passed 29/29 after friendly display/canonical IPC normalization; widget regression also rejects raw `CommandOrControl` copy. |
| Home semantic tones | Home test failed because the record card had no `data-tone`. | State contract passed after success/error tones were wired to the card. |
| Home dense layout | CSS contract test failed because named grid areas were absent. | Named-area and responsive layout assertions passed. |
| Onboarding focus | Design-system focus contract failed because the programmatic heading suppression rule was absent. | Heading focus is retained without an outline; keyboard-focused Continue has the required 3px ring. |
| Widget containment/glanceability | Visual preview reported `detailFits: false`; the live capture then exposed `CommandOrControl+Shift+Space to finish` at 188×14 inside a 153×14 detail region. | Contained shadow, formatted hint, accessible hidden action labels, logical bounds, raster bounds, and every outer-row/column alpha assertion pass. |
| Complete capture matrix | Release test failed because the matrix module did not exist. | Matrix suite passes 3/3 and the verifier proves 112 unique exact tuples. |
| Full tall surfaces | Initial 200% Help/Settings capture exposed blank content below the viewport. | The harness now expands and restores the real scroll container; the full seven-card Help and five-section Settings surfaces are captured. |
| Deterministic normal motion | First no-update replay failed `home-listening-light.png` with 6,743 changed pixels (351 allowed). | Finite-transition settling preserved normal motion; the next update and no-update runs both passed all 6 suites and all 112 tuples. |
| Packaged E2E rejection | Boundary coverage previously rejected only a subset of scenarios. | Unit contract rejects every scenario from `e2eScenarioSchema.options`; the packaged-resource verifier also fails if an E2E profile is created. |

## Verification results

- `npm test`: 51 files passed; 786 tests passed, 1 skipped.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm run design:capture -- --update`: 6/6 Playwright suites passed; 112 tuples verified.
- `npm run design:verify`: independent no-update replay passed 6/6; 112 tuples verified.
- `npx playwright test tests/e2e/visual-previews.spec.ts --workers=1`: 14/14 passed.
- Electron leak check after browser runs: no Electron processes remained.

## Independent recheck verdict

The original reviewer rechecked the updated Settings, Home, widget, focus, motion, onboarding, scale, and full-surface evidence and reported every original finding resolved with no regression found. A fresh independent final approver then audited the committed review artifacts and representative 200% Help/Settings captures. It confirmed all eight accepted High/Medium findings resolved, strong light/dark parity, a cohesive and recognizably original design, complete bounded 200% surfaces, and no new Critical or High visual issue.

Final verdict: **APPROVED**.
