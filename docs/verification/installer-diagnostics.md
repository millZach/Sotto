# Installer diagnostics and Codex rollout discovery

Verified on Windows on October 1, 2026 for PR [#667](https://github.com/millZach/Sotto/pull/667), after the requested rework of S-104 and S-105.

Both installer presentations retain the error after an unquoted private path, keep stack locations and closing brackets, leave `~/` paths readable, and redact `file:///` paths. Existing quoted-account, mixed-path and rename cases remain covered. Path continuation checks keep account suffixes private when parentheses or Unix colons occur within folders; download URLs survive both quoted and unquoted paths. Ambiguous unquoted leaf names follow the requested diagnostic-delimiter rules.

The Codex session log watcher resets missing-file discovery on either send method. A controlled-clock test advances the missing-file backoff to one minute, sends a prompt, and observes an immediate search followed by the initial two-second retry. A held directory lookup separately proves that an older miss cannot overwrite a send's reset. Guarded reads and own-client receipt suppression remain covered.

## Automated checks

- Formatter and watcher regression files: 58 passed. Each newly found failure was observed before its fix.
- Formatter, watcher, client-update and newest-turn suites: 122 passed, 1 existing skip.
- `npm run typecheck`, `npm run lint`, `npm run notices:verify`: passed; 174 notices verified.
- `npm run build` and `npx playwright test tests/e2e/host-client-updates.spec.ts --workers=1`: 1 passed.
- Independent Standards and Spec reviews, each using gpt-6.1-sol at high reasoning: clear after correcting their findings. These included Unix punctuation, Windows parentheses, complete download URLs, quoted-path diagnostic URLs and a send during an in-flight lookup.

The full local test gate and latest Windows CI result are recorded in the PR body. The earlier full run was stopped when independent review produced further fixes; it is not counted as a pass.

## Running application

The Electron journey runs the built desktop and a real headless host over scripted SSH, with provider and installer effects supplied by the fixture. Its failing installer output includes the supplied Windows account path and Unix mise path. The fixture applies the production formatters at its installer boundary, then the real host, coordinator, preload and renderer carry the result. This verifies the displayed diagnostics and update journey; it does not exercise a live installer or paid provider turn.

The journey checks error text and absence of `John Smith`, retries the failed update, and checks keyboard dismissal and restored focus. It captures light and dark at 1600×1000, 1280×800 and the 820×560 minimum, asserting no horizontal overflow. The retained minimum-size images were inspected with the installer output scrolled to its diagnostic tail:

- [Dark installer details](../../artifacts/review-667/installer-details-820x560-dark.png): the private paths are ellipses, while `exit status 1` and the Windows file-access error remain readable.
- [Light installer details](../../artifacts/review-667/installer-details-820x560-light.png): the same error text remains readable with the light theme.

No design baselines were regenerated. macOS and live-provider execution were not verified in this rework. S-058 and the write-coalescing portion of S-083 were already fixed on main; usage retention limits remain open in #555.
