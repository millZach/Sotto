# Phase 3 Open VSX corrections

Scope: corrections to isolated snapshot `b8c4a54` on `work/phase3-theme-network-fixes`. Root must apply the correction patch after the theme module commit; do not integrate the snapshot wholesale. No UI, settings, dependencies, external settings, model calls, push, or subagents.

## Acceptance checklist

- [x] Exact official HTTPS storage redirect works; disallowed hosts, credentials, ports and checksum mismatch reject.
- [x] Search checks bounded manifest color contributions, identity and license; icon-only extensions are omitted. Malformed search envelopes report an error.
- [x] All workbench keys consumed by the importer survive sanitization, with direct-import palette parity.
- [x] Manifest publisher/name/version/license must match fresh API metadata; API identity cannot rebind the selection.
- [x] EOCD comment/signature, disk fields, counts, directory extent and entry bounds checked for supported ZIP formats.
- [x] JSONC string literals preserved; bad contributions and over-limit collections fail atomically.
- [x] Compatible offline fixture metadata and redirect handling.
- [x] Focused tests, lint, node and web typechecks.
- [x] Fresh default-client live search/install and shared-library schema validation of both halves.
- [x] Local standards/spec review and correction-only commit (exact hash in orchestration handoff).

## Reference and implementation

Inspected pinned T3 Code `apps/web/src/openVsxThemes.ts` at `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3` (MIT, T3 Tools Inc.), particularly search manifest validation, EOCD handling, packaged identity/license checks and atomic contribution failure. Corrected the inaccurate `apps/server` source comment. Existing attribution is retained.

Public exports and UI-consumed shapes are unchanged. The additional manifest URL is private to the client's detail method; search reads the API-provided allowlisted URL. Primary API redirects remain confined to the primary host; file requests can use the three exact approved HTTPS hosts. Checksums are verified before in-memory ZIP parsing. No extension code executes and no archive entries are extracted to disk.

Search validates manifest contributions without fetching a VSIX. Unlike T3's HEAD preflight, package size is enforced on the actual bounded download; this work does not add a search-time HEAD request. Installation re-reads details and checks the downloaded manifest against them. License comparison follows T3's trimmed, case-insensitive manifest comparison against an approved advertised SPDX identifier.

Supported ZIP input is single-disk, non-ZIP64, unencrypted stored/deflated data with an exact central directory extent. Entry header/data extents stay before the directory, duplicate names reject, and declared whole-archive expansion and ratio budgets are checked. Referenced paths stay under `extension/`; unused unsafe names are not extracted. This is a bounded reader, not a complete ZIP-standard implementation or exhaustive archive certification. CRCs are valid in fixtures; the client authenticates the complete network package using its published SHA-256, without an added per-entry CRC implementation.

## Validation

Initial focused red run: 36 failures, 19 passes across 55 cases. First green run: 55/55. The initial fixture install exposed a pre-existing redirect loop: its path-only redirect matched the redirected blob URL before the blob response handler. The compatible fixture fix orders that response first.

Both `tsconfig.node.json` and `tsconfig.web.json` typechecks passed on this snapshot. Focused ESLint passed. No full suite or UI inspection was run; root owns integration and final full-suite verification. No dependencies were installed through the shared `node_modules` junction.

Final focused run: **66/66 passed**, including additional streamed-manifest cancellation, invalid/untrusted advertised manifests, missing checksum, exactly 40 successful contributions and invalid comma syntax. `git diff --check` passed. Commands from this worktree:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/themeOpenVsxCorrections.test.ts --reporter=default --reporter=json --outputFile.json=../phase3-orchestration/themes-network-fixed-tests.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
node node_modules/eslint/bin/eslint.js src/main/themes/openVsx.ts src/main/themes/openVsxFixture.ts src/shared/themes/vscodeImport.ts tests/unit/themeOpenVsxCorrections.test.ts
git diff --check
```

## Actual live install

One fresh run, **2026-09-13 20:18:13.179–20:18:16.303 UTC**, Node **v24.14.1**. The esbuild probe instantiated `new OpenVsxClient()` without an injected fetch or any diagnostic download bypass. Passive Node `diagnostics_channel` subscriptions recorded request headers/statuses without modifying responses. The probe had a 120-second overall watchdog in addition to the client's per-request timeouts and byte limits. It made 36 total HTTP requests (one search plus bounded details/manifests and the selected install), with no manual retries.

Search returned **5** schema-valid color-theme extensions. The live `PKief.material-icon-theme` manifest was read through its Eclipse content redirect and its icon-only extension was absent from results. Installation selected the same public **`GitHub.github-vscode-theme` 6.3.5**. Manifest, checksum and VSIX endpoints redirected from `open-vsx.org` to exact **`openvsx.eclipsecontent.org`**, then returned HTTP 200. The VSIX response declared **91,023 bytes**; the normal client verified its published SHA-256 before parsing. This probe does not separately capture the checksum body or package bytes.

`openVsxSearchResultSchema`, `openVsxInstallResultSchema` and **`customThemesSchema`** all accepted the actual returned data. The library schema validates every base/variant color, including canonical values and complete role sets; the probe additionally enumerated both modes and all 57 roles in every half:

| Imported theme | Validated modes |
| --- | --- |
| GitHub Default | Light + dark |
| GitHub High Contrast | Light + dark |
| GitHub Colorblind (Beta) | Light + dark |
| GitHub Dark Dimmed | Dark |
| GitHub | Light + dark |

Five definitions, **nine complete palette halves**. The live source hashes were rechecked after review and matched; no implementation source changed after the live probe.

Evidence is in the explicitly requested orchestration handoff directory, with unique `themes-network-fixed-*` names: `themes-network-fixed-live.json` contains the full parsed library, request trace, source hashes and schema results; `themes-network-fixed-probe.ts` and `.mjs` contain the reproducible probe; `themes-network-fixed-bundle-meta.json` records the actual bundled modules; `themes-network-fixed-tests.json` contains all 66 passing test results.

```powershell
node node_modules/esbuild/bin/esbuild ../phase3-orchestration/themes-network-fixed-probe.ts --bundle --platform=node --format=esm --outfile=../phase3-orchestration/themes-network-fixed-probe.mjs --metafile=../phase3-orchestration/themes-network-fixed-bundle-meta.json
node ../phase3-orchestration/themes-network-fixed-probe.mjs
```

## Review and remaining limits

Standards review: no unresolved findings against the provided AGENTS instructions, `CLAUDE.md`, `CONTEXT.md` or the code-review smell baseline. Spec review: all eight reported behavior gaps have focused coverage and the real default-client install passes. Review was performed locally; the user's explicit no-subagent instruction overrides the skill's parallel reviewers. The implement skill's full-suite step is assigned to root by the user's instructions.

No exported API shape changed and no integration-notes addition was necessary. Only the importer whitelist changed in shared theme code. The saved evidence concerns this backend snapshot, not App/settings integration or an Electron UI run. Both typecheck targets passed here, so there are no baseline type errors to report for this revision. Root still owns applying the correction patch after the theme module commit, integration review and final full-suite validation.
