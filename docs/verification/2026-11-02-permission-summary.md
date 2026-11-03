# A permission card without raw input: verification

November 2, 2026. `fix/permission-summary`, on forge (Omarchy), with the built app under `xvfb-run` and the request payloads from the real provider mappers.

## How it was run

```sh
npm run build
xvfb-run -a npx playwright test tests/e2e/compact-pane-and-request-layout.spec.ts --grep "permission card"
npx vitest run --maxWorkers=2 tests/unit/main/requestInput.test.ts tests/unit/renderer/requests/agentRequestCard.test.tsx
node apps/ios/Scripts/check-strings.mjs
```

The full suite and the iPhone build run in CI on the pull request, not on this machine. Forge has no Mac, so the iPhone's sheet was not seen running here.

## What it shows

`command-dark-820.png` is a Claude command at the 820x560 minimum: **Run a command**, **Claude Code says** with its summary, the command, then **It also asks to run outside the sandbox.** There is no raw input on the card, and the journey asserts that at 1600x1000, 1280x800 and 820x560.

`edit-light-820.png` is a file edit in light: **Edit a file**, its path, then its changed lines marked `-` and `+`.
