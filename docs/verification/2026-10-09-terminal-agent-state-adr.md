# Terminal agent state decision for #882

Verified on Windows 11, October 9, 2026, on `feat/terminal-agent-state-adr`. This branch contains a Proposed ADR, glossary and guide changes, the supplied research note and prototype, verification evidence, and two terminal test fixture corrections required by the gates. It changes no product code. The proposed state reducer, hook transport and phone controls are not implemented or verified as product features.

## Native CLI spike

[ADR-0066's evidence section](../adr/0066-a-terminal-agent-reports-state-through-run-scoped-hooks.md#evidence) records the installed versions, launch flags, event names and payload key shapes, with no prompt or command content. The scripts and listener stayed outside every repository under `%TEMP%/sotto-882-hook-spike`. Claude's one-time hook approval created the scratch marker without an approval keystroke; its interactive run reported PermissionRequest, permission_prompt, Stop and idle_prompt on the supplied UUID. Codex notify delivered its provider session and turn IDs and completion; the approval probe delivered no approval-specific notify event. Its bounded shutdown reported a ConPTY cleanup failure, so neither a successful native denial nor a clean approval-probe exit is claimed. All spike CLI processes were checked as ended. Both protected user settings files retained their before-run SHA-256 hashes; no project settings were written.

The Windows proof does not establish macOS/Linux compatibility, Claude hook denial, structured question answers or the production channel's expiry and two-device races. Those are implementation acceptance checks, not omitted product patches in this decision lane.

Codex's documented native PermissionRequest framework was also probed with run-only inline overrides: no native lifecycle event reached the listener. An absolute scratch profile was rejected before a model call. Notify reported differing session IDs during a single run, including a later completion-only control. The ADR refuses an ambiguous provider-session binding and requires a separate successful run-only native-hook proof before enabling Codex answers. It does not claim that Codex has no native approval hooks.

## Preserved prototype

Opened the committed-path HTML directly in Microsoft Edge with Variant B. Checked its 1280×800 desktop illustration and its 820×560 minimum, the phone illustration, light and dark, with reduced motion. Exercised Agent finishes, View the Done terminal, Can answer off/on and the search bar's Escape path. Seven scripted checks passed, with no page errors; the minimum desktop's 818×558 inner area (820×560 including its border) had no outer scroll overflow. Captures were opened and visually inspected:

- [Variant B, dark](../../artifacts/design/terminal-agent-state-prototype-b-dark.png).
- [Variant B, light at the minimum](../../artifacts/design/terminal-agent-state-prototype-b-light-minimum.png).

These are captures of a historical simulation, not the running app or a native iPhone. The prototype still marks a visible unfocused pane Just finished, simulates keystroke answers, offers persistent native choices and illustrates a Codex phone approval. The ADR explicitly corrects those points. The owner required preserving the artifact byte for byte, so its code was not changed to agree with the new decision. The selected hierarchy and attention edge remain the visual reference; the older mark and example CLI versions are historical too.

The research note and HTML match their supplied sources byte for byte. Both have LF line endings and no UTF-8 BOM. The staged Git blobs were also checked against the supplied bytes before committing.

## Gates

`npm ci` ran before any work in this checkout: exit 0, 830 packages added and 831 audited. No dependencies were linked from another checkout.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass, exit 0; all three TypeScript projects, no diagnostics. |
| `npm run lint` | Pass, exit 0; no diagnostics. |
| `npm test -- --maxWorkers=2` | Pass, exit 0; 624 files passed, 51 skipped (675 total); 9,237 tests passed, 222 skipped (9,459 total), 0 failed. One full run, 1,278.67 seconds. |
| `npm run notices:verify` | Pass, exit 0; 174 notice components verified. |
| `npm run build && npx playwright test tests/e2e/terminal-loading.spec.ts tests/e2e/terminal-display.spec.ts tests/e2e/terminal-closed-output.spec.ts` | Pass, exit 0; main, host, preload and renderer built; 4 tests passed, 0 failed or skipped, one worker, 27.2 seconds for Playwright. |

The first Playwright run passed 3 and failed 1: workspace recovery looked up the bare `workshop` ID after the host router had qualified it. An isolated rerun failed identically. A scratch inspection of the real fixture snapshot confirmed `clientScoped: true`, host-qualified thread/project IDs and no bare workshop. The test now accepts the bare or host-qualified fixture ID, as the neighboring display spec already did.

The next build and Playwright run passed 3 and failed 1: the display assertion required the first PowerShell prompt and command on one raw-output line. Its actual output contained the command, `COLOR_DEPTH=24` and the restored prompt in order, with ConPTY redraw newlines before the command. The corrected regex permits those newlines and still requires all three pieces in order. The final build and all four specs then passed. Both fixes are test-only; the full Vitest suite excludes `tests/e2e/**` and was not repeated.

No design baselines were regenerated: this branch changes no app appearance. The terminal Playwright specs exercise the existing built product, not the proposed hooks. Their generated captures of existing surfaces are not committed as new design evidence.

## Review

Independent Standards and Spec reviews used Sol (`gpt-6.1-sol`) at max reasoning against `git diff 0c34255c6eadb03a52e01fbf908aca6f5da8e51a...HEAD` at decision commit `bb65b79a7`. Standards reported no findings. Spec initially could not read files because its shell returned `setup refresh had errors`; its single retry reviewed the supplied complete diff and referenced documents and reported no findings. That retry did not independently read HEAD, a limitation of its shell access rather than a clean tool run. The terminal test follow-up was reviewed separately on both axes with its diff and source supplied directly; both reported no findings. The lead checked the final evidence note, captures and the ADR's added completion-only control observation against the collected results.

Immediately before the final commits, a fresh `origin/main` fetch still ended at ADR-0064. All open PR ADR file diffs were checked through GitHub's paginated files API: #880 used ADR-0065; #877, #875 and #816 introduced no ADR-0066. The proposed number remains free in both places.
