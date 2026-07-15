# TalkType Desktop Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, package, and verify a polished offline-first Windows dictation app with a global hotkey, non-focusing widget, local Whisper transcription, clipboard/autopaste output, configurable settings, history, and complete light/dark themes.

**Architecture:** Electron owns native windows, tray, shortcuts, local persistence, clipboard, and best-effort Windows paste automation. React renderers own the management UI and floating widget, while Web Audio captures 16 kHz PCM and a dedicated Transformers.js worker performs local Whisper inference from bundled, hash-verified model files. All renderer/native communication crosses a narrow typed preload bridge with schema validation.

**Tech Stack:** Electron 43.1.0, electron-vite 5.0.0, React 19.2.7, TypeScript 6.0.3, Vite 7.3.6, Transformers.js 4.2.0, Zod 4.4.3, Lucide React 1.24.0, Vitest 4.1.10, Playwright 1.61.1, electron-builder 26.15.3.

**Approved specification:** `docs/superpowers/specs/2026-07-11-talktype-desktop-dictation-design.md`

---

## Planned file structure

```text
.
├── build/
│   ├── icon.ico
│   ├── icon.png
│   └── installer-sidebar.bmp
├── docs/
│   ├── qa/adversarial-review.md
│   ├── superpowers/plans/2026-07-11-talktype-desktop-dictation.md
│   ├── superpowers/specs/2026-07-11-talktype-desktop-dictation-design.md
│   └── verification/2026-07-11-talktype-verification.md
├── resources/
│   ├── models/manifest.lock.json
│   ├── models/Xenova/whisper-base/{added_tokens.json,config.json,generation_config.json,merges.txt,normalizer.json,preprocessor_config.json,special_tokens_map.json,tokenizer.json,tokenizer_config.json,vocab.json}
│   ├── models/Xenova/whisper-base/onnx/{decoder_model_merged_quantized.onnx,encoder_model_quantized.onnx}
│   ├── runtime/manifest.lock.json
│   ├── runtime/ort-wasm-simd-threaded.jsep.wasm
│   └── runtime/ort-wasm-simd-threaded.wasm
├── scripts/
│   ├── model-catalog.mjs
│   ├── prepare-model.mjs
│   └── verify-model.mjs
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── app/bootstrap.ts
│   │   ├── hotkeys/hotkeyManager.ts
│   │   ├── ipc/registerIpc.ts
│   │   ├── models/modelManager.ts
│   │   ├── models/modelProtocol.ts
│   │   ├── output/outputService.ts
│   │   ├── output/pasteCommand.ts
│   │   ├── security.ts
│   │   ├── startup/startupService.ts
│   │   ├── storage/atomicJsonStore.ts
│   │   ├── storage/historyRepository.ts
│   │   ├── storage/settingsRepository.ts
│   │   ├── tray/trayController.ts
│   │   └── windows/windowManager.ts
│   ├── preload/index.ts
│   ├── renderer/
│   │   ├── index.html
│   │   ├── widget.html
│   │   ├── public/audio-capture-worklet.js
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── main.tsx
│   │       ├── widget.tsx
│   │       ├── audio/audioMath.ts
│   │       ├── audio/audioRecorder.ts
│   │       ├── audio/soundCues.ts
│   │       ├── components/{AppShell,Button,Card,Field,LevelMeter,Select,ShortcutKey,ToastRegion,Toggle}.tsx
│   │       ├── features/dictation/dictationController.ts
│   │       ├── features/help/HelpView.tsx
│   │       ├── features/history/HistoryView.tsx
│   │       ├── features/home/HomeView.tsx
│   │       ├── features/onboarding/Onboarding.tsx
│   │       ├── features/settings/SettingsView.tsx
│   │       ├── state/AppContext.tsx
│   │       ├── styles/global.css
│   │       ├── styles/tokens.css
│   │       ├── transcription/client.ts
│   │       ├── transcription/messages.ts
│   │       ├── transcription/worker.ts
│   │       └── widget/WidgetApp.tsx
│   └── shared/
│       ├── channels.ts
│       ├── constants.ts
│       ├── contracts.ts
│       ├── dictation.ts
│       ├── history.ts
│       ├── modelCatalog.ts
│       ├── settings.ts
│       └── transcript.ts
├── tests/
│   ├── e2e/app.spec.ts
│   ├── integration/{ipc,transcriptionClient,widgetSync}.test.ts
│   ├── unit/<domain, native-service, audio, and UI unit tests>
│   └── setup.ts
├── electron-builder.yml
├── electron.vite.config.ts
├── eslint.config.mjs
├── package-lock.json
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── tsconfig.web.json
└── vitest.config.ts
```

## Global execution rules

- Every production behavior starts with a focused failing test, and the agent must record the expected RED failure before implementation.
- Tests use real pure functions or real temporary filesystem directories. Electron boundaries are replaced only through explicit adapters.
- Each task ends with its focused tests plus `npm run typecheck` and `npm run lint` passing.
- No test may require a live microphone, OS paste, or remote model request; those have deterministic seams plus separate manual verification.
- Never log transcript text or PCM data.
- Keep `nodeIntegration: false`, `contextIsolation: true`, and permission/navigation deny-by-default behavior intact.
- Commit only the files named by the task and preserve unrelated user work.

### Task 1: Scaffold a secure, testable Electron application

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `electron.vite.config.ts`
- Create: `electron-builder.yml`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `eslint.config.mjs`
- Create: `tests/setup.ts`
- Create: `tests/unit/shared/constants.test.ts`
- Create: `tests/unit/main/security.test.ts`
- Create: `src/shared/constants.ts`
- Create: `src/main/security.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/widget.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/widget.tsx`
- Modify: `.gitignore`

- [x] **Step 1: Install the pinned runtime and development toolchain**

Run:

```powershell
npm init -y
npm install react@19.2.7 react-dom@19.2.7 @huggingface/transformers@4.2.0 zod@4.4.3 lucide-react@1.24.0
npm install --save-dev electron@43.1.0 electron-vite@5.0.0 electron-builder@26.15.3 vite@7.3.6 typescript@6.0.3 vitest@4.1.10 @vitest/coverage-v8 @playwright/test@1.61.1 jsdom@29.1.1 @types/node @types/react @types/react-dom @testing-library/react @testing-library/jest-dom @testing-library/user-event eslint @eslint/js typescript-eslint
```

Expected: dependencies install successfully and `package-lock.json` is created.

- [x] **Step 2: Write failing scaffold security tests**

```ts
// tests/unit/shared/constants.test.ts
import { describe, expect, it } from 'vitest'
import { APP_NAME, DEFAULT_HOTKEY } from '../../../src/shared/constants'

describe('application constants', () => {
  it('uses the approved product name and shortcut', () => {
    expect(APP_NAME).toBe('TalkType')
    expect(DEFAULT_HOTKEY).toBe('CommandOrControl+Shift+Space')
  })
})

// tests/unit/main/security.test.ts
import { describe, expect, it } from 'vitest'
import { secureWebPreferences } from '../../../src/main/security'

describe('secureWebPreferences', () => {
  it('isolates every renderer from Node', () => {
    expect(secureWebPreferences('C:/app/preload.js')).toMatchObject({
      preload: 'C:/app/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
  })
})
```

- [x] **Step 3: Run the tests and observe RED**

Run: `npx vitest run tests/unit/shared/constants.test.ts tests/unit/main/security.test.ts`

Expected: FAIL because `src/shared/constants.ts` and `src/main/security.ts` do not exist.

- [x] **Step 4: Add the minimal secure scaffold**

```ts
// src/shared/constants.ts
export const APP_NAME = 'TalkType'
export const APP_ID = 'com.talktype.desktop'
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

// src/main/security.ts
import type { WebPreferences } from 'electron'

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
}
```

Configure `package.json` with `main: "./out/main/index.js"` and scripts `dev`, `build`, `typecheck`, `lint`, `test`, `test:coverage`, `test:e2e`, `model:prepare`, `model:verify`, `package:dir`, and `package:win`. Configure electron-vite with main, preload, and two renderer HTML inputs. The initial main entry creates a single 1080×720 window using `secureWebPreferences`; both renderer entries mount a valid React root with the TalkType name so `npm run build` is green from this commit. Both HTML entries include a restrictive Content Security Policy allowing only the packaged origin, local model/runtime schemes, the application worker, microphone media, and inline style attributes required for dynamic level bars; scripts and network connections remain local-only.

- [x] **Step 5: Verify GREEN and the baseline build**

Run:

```powershell
npm test -- --run tests/unit/shared/constants.test.ts tests/unit/main/security.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: 2 tests pass; typecheck, lint, main/preload/renderer builds all exit 0.

- [x] **Step 6: Commit**

```powershell
git add package.json package-lock.json electron.vite.config.ts electron-builder.yml tsconfig*.json vitest.config.ts playwright.config.ts eslint.config.mjs tests/setup.ts tests/unit/shared/constants.test.ts tests/unit/main/security.test.ts src/shared/constants.ts src/main/security.ts src/main/index.ts src/preload/index.ts src/renderer .gitignore
git commit -m "build: scaffold secure TalkType desktop app"
```

### Task 2: Define settings, models, history, transcript formatting, and dictation state

**Files:**
- Create: `tests/unit/shared/settings.test.ts`
- Create: `tests/unit/shared/dictation.test.ts`
- Create: `tests/unit/shared/transcript.test.ts`
- Create: `src/shared/settings.ts`
- Create: `src/shared/modelCatalog.ts`
- Create: `src/shared/history.ts`
- Create: `src/shared/dictation.ts`
- Create: `src/shared/transcript.ts`

- [x] **Step 1: Write failing domain tests**

```ts
// tests/unit/shared/settings.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '../../../src/shared/settings'

describe('settings', () => {
  it('recovers invalid fields without discarding valid fields', () => {
    const parsed = parseSettings({ theme: 'dark', pasteDelayMs: -4, autoPaste: false })
    expect(parsed.theme).toBe('dark')
    expect(parsed.pasteDelayMs).toBe(DEFAULT_SETTINGS.pasteDelayMs)
    expect(parsed.autoPaste).toBe(false)
  })
})

// tests/unit/shared/dictation.test.ts
import { describe, expect, it } from 'vitest'
import { initialDictationState, reduceDictation } from '../../../src/shared/dictation'

describe('dictation reducer', () => {
  it('rejects a stale transcription result', () => {
    const requested = reduceDictation(initialDictationState, {
      type: 'REQUESTED',
      sessionId: 'current',
    })
    const listening = reduceDictation(requested, {
      type: 'STARTED',
      sessionId: 'current',
      startedAt: 100,
    })
    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    expect(
      reduceDictation(processing, { type: 'TRANSCRIBED', sessionId: 'stale', text: 'wrong' }),
    ).toBe(processing)
  })
})

// tests/unit/shared/transcript.test.ts
import { describe, expect, it } from 'vitest'
import { formatTranscript } from '../../../src/shared/transcript'

describe('formatTranscript', () => {
  it('normalizes whitespace without changing words or punctuation', () => {
    expect(formatTranscript('  Hello,   world!\nAgain.  ')).toBe('Hello, world! Again.')
  })
})
```

- [x] **Step 2: Run the tests and observe RED**

Run: `npx vitest run tests/unit/shared/settings.test.ts tests/unit/shared/dictation.test.ts tests/unit/shared/transcript.test.ts`

Expected: FAIL because the shared domain modules do not exist.

- [x] **Step 3: Implement the typed domain contracts**

`src/shared/settings.ts` must export `Theme`, `ModelPreset`, `InferencePreference`, `HistoryRetention`, `AppSettings`, `DEFAULT_SETTINGS`, `settingsSchema`, and `parseSettings`. `parseSettings` merges one schema-validated field at a time so a bad persisted field cannot erase valid siblings. Defaults are: system theme, Balanced model, auto language, auto inference, auto-copy true, auto-paste true, 150 ms delay, 60-second recording limit, cues true, startup false, minimized false, history true, 100-entry retention, onboarding incomplete.

`src/shared/modelCatalog.ts` must export an immutable catalog with `fast`, `balanced`, and `accurate`. Fast maps to `Xenova/whisper-tiny` revision `5332fcc35e32a33b86612b9a57a89be7906102b1`; Balanced maps to bundled `Xenova/whisper-base` revision `64da57285918e20ea79ea5c88eed7197933abaa8`; Accurate maps to `Xenova/whisper-small` revision `2d67713f236afa48a18992566e7647f6ca848e13`. All use local `q8`, support multilingual transcription, record Apache-2.0 licensing, and mark only Balanced as bundled.

`src/shared/dictation.ts` must use this discriminated state:

```ts
export type DictationState =
  | { status: 'idle' }
  | { status: 'requesting-permission'; sessionId: string }
  | { status: 'listening'; sessionId: string; startedAt: number; level: number }
  | { status: 'processing'; sessionId: string; startedAt: number }
  | { status: 'success'; sessionId: string; text: string; output: 'pasted' | 'copied' }
  | { status: 'cancelled'; sessionId: string }
  | { status: 'error'; sessionId?: string; code: string; message: string }
```

The reducer accepts `STARTED` only after a matching `REQUESTED` event, accepts only legal transitions, makes stop/cancel idempotent, and ignores mismatched session identifiers. `src/shared/history.ts` defines the exact persisted transcript entry schema. `src/shared/transcript.ts` trims and collapses whitespace and returns an empty string for silence.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run tests/unit/shared`

Expected: all shared-domain tests pass.

- [x] **Step 5: Commit**

```powershell
git add src/shared tests/unit/shared
git commit -m "feat: define TalkType domain and settings contracts"
```

### Task 3: Add resilient local settings and history persistence

**Files:**
- Create: `tests/unit/main/atomicJsonStore.test.ts`
- Create: `tests/unit/main/settingsRepository.test.ts`
- Create: `tests/unit/main/historyRepository.test.ts`
- Create: `src/main/storage/atomicJsonStore.ts`
- Create: `src/main/storage/settingsRepository.ts`
- Create: `src/main/storage/historyRepository.ts`

- [x] **Step 1: Write failing real-filesystem tests**

```ts
// tests/unit/main/historyRepository.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryRepository } from '../../../src/main/storage/historyRepository'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('HistoryRepository', () => {
  it('enforces retention newest-first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-history-'))
    roots.push(root)
    const repository = new HistoryRepository(join(root, 'history.json'))
    await repository.add({ id: '1', text: 'one', createdAt: 1, durationMs: 10, language: 'en', modelPreset: 'balanced' }, { enabled: true, retention: 1 })
    await repository.add({ id: '2', text: 'two', createdAt: 2, durationMs: 10, language: 'en', modelPreset: 'balanced' }, { enabled: true, retention: 1 })
    expect((await repository.list()).map((entry) => entry.id)).toEqual(['2'])
  })
})
```

Add focused tests proving atomic temp-file replacement, corrupt-file recovery to `*.corrupt-<timestamp>-<uuid>`, non-mutating `peek()` behavior for valid, missing, syntax-corrupt, and semantically invalid JSON, field-level settings recovery, disabled-history no-write behavior (including leaving a corrupt file byte-for-byte unchanged with no backup or temporary sibling), case-insensitive search, entry deletion, and clear. Use a deterministic clock and ID seam while exercising the real temporary filesystem to cover concurrent recovering reads, recovery/write invocation order in both directions, occupied backup-name retry, and operation-queue recovery after a rejected write. Add repository tests proving concurrent disjoint settings patches are both persisted, a `get()` invoked after a mutation observes it, and clearing history deletes exact `history.json.corrupt-*` recovery siblings without deleting unrelated files. Prove `HistoryRepository.add()` snapshots and validates its entry plus `enabled` and `retention` options at invocation time, before entering the mutation queue, so caller mutations cannot enable a disabled write, alter transcript content, or change retention; invalid input must reject as a Promise without entering or poisoning that queue.

- [x] **Step 2: Run and observe RED**

Run: `npm.cmd test -- --run tests/unit/main/atomicJsonStore.test.ts tests/unit/main/settingsRepository.test.ts tests/unit/main/historyRepository.test.ts`

Expected: FAIL because the storage modules do not exist.

- [x] **Step 3: Implement the repositories**

`AtomicJsonStore<T>` accepts a path, a `parse(unknown): T` function, a default factory, and optional clock and ID factories. A single rejection-resilient per-store operation queue serializes recovering `read()`, non-mutating `peek()`, `write()`, and `exists()` calls in invocation order while still returning each operation's rejection to its caller. `read()` parses UTF-8 JSON; on syntax or semantic validation failure it exclusively copies the original to a `*.corrupt-<timestamp>-<uuid>` sibling with `COPYFILE_EXCL`, then unlinks the active corrupt file and returns fresh defaults. Backup-name collisions request a new ID and retry with an explicit bound, never replacing already-preserved bytes; concurrent source disappearance is re-read safely, and a non-`ENOENT` unlink failure leaves the exclusive backup intact while propagating the failure. `peek()` uses the same parsing rules but returns fresh defaults for missing or invalid input without renaming, creating, or writing any filesystem entry. `write()` uses bounded `open(..., 'wx', 0o600)` retries to claim a unique sibling temporary file, tracks ownership only after a successful open, syncs and closes it, then renames it over the destination; failure cleanup unlinks only a temporary path claimed by that write.

`SettingsRepository` delegates to `parseSettings` and uses its own rejection-resilient mutation queue for complete save, update read→merge→parse→write, and reset transactions. Public `get()` and `exists()` wait for mutations invoked before them, while queued mutations call the store directly to avoid self-deadlock. `HistoryRepository.add(entry, { enabled, retention })` is async so validation failures are Promise rejections; it validates the entry to a copied value and snapshots both option primitives before enqueueing, then uses only those invocation-time values in the mutation. Disabled adds use `peek()` so even corrupt history remains byte-for-byte untouched; enabled adds sort entries descending by `createdAt` and apply finite retention after add. `HistoryRepository.clear()` keeps its prior active-file behavior and also removes only siblings beginning with the exact `<history-basename>.corrupt-` prefix so recovery files cannot retain transcript text.

The temporary-file rename step is an atomic complete-file replacement, so readers do not observe a partially written JSON document. This design does not claim directory-entry durability across power loss because the parent directory is not synced.

- [x] **Step 4: Verify GREEN and regressions**

Run:

```powershell
npm.cmd test -- --run tests/unit/main/atomicJsonStore.test.ts tests/unit/main/settingsRepository.test.ts tests/unit/main/historyRepository.test.ts
npm.cmd test
```

Expected: storage tests and the full suite pass with no warnings.

- [x] **Step 5: Commit**

```powershell
git add src/main/storage tests/unit/main
git commit -m "fix: serialize storage transactions and recovery"
```

### Task 4: Build secure native windows, tray, shortcut, startup, IPC, and preload services

**Files:**
- Create: `tests/unit/main/windowManager.test.ts`
- Create: `tests/unit/main/hotkeyManager.test.ts`
- Create: `tests/integration/ipc.test.ts`
- Create: `src/shared/channels.ts`
- Create: `src/shared/contracts.ts`
- Create: `src/main/windows/windowManager.ts`
- Create: `src/main/hotkeys/hotkeyManager.ts`
- Create: `src/main/tray/trayController.ts`
- Create: `src/main/startup/startupService.ts`
- Create: `src/main/ipc/registerIpc.ts`
- Create: `src/main/app/bootstrap.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

- [x] **Step 1: Write failing native-boundary tests**

```ts
// tests/unit/main/hotkeyManager.test.ts
import { describe, expect, it, vi } from 'vitest'
import { HotkeyManager } from '../../../src/main/hotkeys/hotkeyManager'

describe('HotkeyManager', () => {
  it('keeps the prior shortcut when replacement registration fails', () => {
    const adapter = { register: vi.fn((key: string) => key === 'Old'), unregister: vi.fn() }
    const manager = new HotkeyManager(adapter, vi.fn())
    expect(manager.replace('Old')).toEqual({ ok: true })
    expect(manager.replace('Taken')).toEqual({ ok: false, reason: 'conflict' })
    expect(manager.current()).toBe('Old')
  })
})
```

Window tests must assert complete BrowserWindow constructor option objects with exact equality, not `toMatchObject` or another permissive subset matcher, and must exercise the real `WindowManager`-to-`BrowserWindow` wiring. The complete main options are 1080×720 with secure preferences; widget options are 420×92, transparent, frameless, always-on-top, skip-taskbar, non-focusable, and `backgroundThrottling: false`; active-display positioning stays inside the work area. Startup/load tests must force renderer-load and readiness/bootstrap rejections, then prove each rejection is caught, produces safe operational diagnostics without sensitive content, and takes a controlled local fallback or quit path instead of becoming an unhandled rejection. Hotkey tests must also prove bare Escape is registered only while listening and removed for every stop, cancel, error, and quit. IPC tests must prove unknown navigation and permissions are denied, settings payloads are parsed, and the preload exposes named methods without a generic `send` function.

- [x] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/main/windowManager.test.ts tests/unit/main/hotkeyManager.test.ts tests/integration/ipc.test.ts`

Expected: FAIL because native service modules and typed channels do not exist.

- [x] **Step 3: Implement adapters and bootstrap**

`src/shared/channels.ts` exports literal channel names. `src/shared/contracts.ts` exports `TalkTypeBridge` with named methods for settings, history, dictation commands/events, widget state, model status, clipboard output, startup, and app controls.

`WindowManager` keeps both BrowserWindow instances alive, intercepts main-window close to hide unless quitting, calls `showInactive()` for the widget, and positions the widget 32 logical pixels above the active display work area. Renderer loading and readiness/bootstrap are awaited or caught; failures emit safe operational diagnostics and explicitly fall back to the bundled local renderer when viable or quit in a controlled way. `HotkeyManager.replace` registers the candidate before unregistering the previous shortcut and restores the old registration on failure. `TrayController` exposes Start/Stop Dictation, Show TalkType, Auto-paste, and Quit. `StartupService` delegates to Electron login item settings. Bootstrap enforces single-instance behavior, registers deny-by-default permission/navigation handlers, wires repositories/services, and unregisters all native resources on quit.

Preload uses `contextBridge.exposeInMainWorld('talktype', bridge)` with per-method `ipcRenderer.invoke` and unsubscribe-returning event listeners. No channel name is accepted from renderer input.

- [x] **Step 4: Verify GREEN**

Run:

```powershell
npx vitest run tests/unit/main/windowManager.test.ts tests/unit/main/hotkeyManager.test.ts tests/integration/ipc.test.ts
npm run typecheck
npm run build
```

Expected: focused tests pass and production bundles compile.

- [x] **Step 5: Commit**

```powershell
git add src/shared/channels.ts src/shared/contracts.ts src/main src/preload tests/unit/main tests/integration/ipc.test.ts
git commit -m "feat: add secure native app lifecycle and bridge"
```

### Task 5: Implement clipboard-first output and safe Windows auto-paste

**Files:**
- Create: `tests/unit/main/pasteCommand.test.ts`
- Create: `tests/unit/main/outputService.test.ts`
- Create: `src/main/output/pasteCommand.ts`
- Create: `src/main/output/outputService.ts`
- Modify: `src/main/ipc/registerIpc.ts`

- [x] **Step 1: Write failing output tests**

```ts
// tests/unit/main/pasteCommand.test.ts
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { buildPasteInvocation } from '../../../src/main/output/pasteCommand'

describe('buildPasteInvocation', () => {
  it('encodes a static command and never accepts transcript text', () => {
    const invocation = buildPasteInvocation()
    expect(invocation.executable).toBe('powershell.exe')
    const encoded = invocation.args.at(-1) ?? ''
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain("[System.Windows.Forms.SendKeys]::SendWait('^v')")
    expect(script).not.toContain('transcript')
  })
})
```

Output-service tests use fakes and prove this order: ignore empty text; write clipboard; hide widget; wait configured delay; invoke static paste; return `pasted`. A spawn failure must return `copied` without clearing the clipboard or rejecting the transcription.

- [x] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/main/pasteCommand.test.ts tests/unit/main/outputService.test.ts`

Expected: FAIL because output modules do not exist.

- [x] **Step 3: Implement clipboard and paste output**

`buildPasteInvocation()` returns `powershell.exe` plus `-NoProfile`, `-NonInteractive`, `-WindowStyle`, `Hidden`, `-EncodedCommand`, and a UTF-16LE Base64 script that loads `System.Windows.Forms` and sends only `^v`. `OutputService` receives injected clipboard, widget, delay, and spawn adapters. It exposes `deliver(text, { autoPaste, pasteDelayMs }): Promise<'pasted' | 'copied' | 'empty'>` and never passes text to the process adapter.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run tests/unit/main/pasteCommand.test.ts tests/unit/main/outputService.test.ts`

Expected: all output tests pass.

- [x] **Step 5: Commit**

```powershell
git add src/main/output src/main/ipc/registerIpc.ts tests/unit/main/pasteCommand.test.ts tests/unit/main/outputService.test.ts
git commit -m "feat: copy and safely paste dictation output"
```

### Task 6: Capture microphone PCM and resample it deterministically

**Files:**
- Create: `tests/unit/renderer/audioMath.test.ts`
- Create: `tests/unit/renderer/audioRecorder.test.ts`
- Create: `tests/unit/renderer/soundCues.test.ts`
- Create: `src/renderer/public/audio-capture-worklet.js`
- Create: `src/renderer/src/audio/audioMath.ts`
- Create: `src/renderer/src/audio/audioRecorder.ts`
- Create: `src/renderer/src/audio/soundCues.ts`

- [x] **Step 1: Write failing audio tests**

```ts
// tests/unit/renderer/audioMath.test.ts
import { describe, expect, it } from 'vitest'
import { calculateRms, resampleMono } from '../../../src/renderer/src/audio/audioMath'

describe('audio math', () => {
  it('resamples one second to exactly 16 kHz', () => {
    const input = Float32Array.from({ length: 48_000 }, (_, index) => index / 48_000)
    const output = resampleMono(input, 48_000, 16_000)
    expect(output).toHaveLength(16_000)
    expect(output[8_000]).toBeCloseTo(0.5, 3)
  })

  it('calculates normalized RMS', () => {
    expect(calculateRms(Float32Array.from([1, -1, 1, -1]))).toBe(1)
  })
})
```

Recorder tests provide fake media tracks and audio nodes and prove selected `deviceId` constraints, level callbacks, one active session, maximum-duration stop, and release of every track/node on stop, cancel, or error. Sound-cue tests use an injected AudioContext and prove cues do nothing when disabled, start uses a short rising two-tone pattern, stop uses a short falling pattern, and all oscillator/gain nodes disconnect.

- [x] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/renderer/audioMath.test.ts tests/unit/renderer/audioRecorder.test.ts tests/unit/renderer/soundCues.test.ts`

Expected: FAIL because audio modules do not exist.

- [x] **Step 3: Implement the worklet recorder**

The worklet copies mono channel chunks into transferable `Float32Array` messages. `AudioRecorder.start` requests `{ audio: { deviceId: selected ? { exact: selected } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }`, creates an AudioContext, loads the worklet, routes through a zero-gain node to keep processing active, and records chunks. `stop` concatenates once, resamples to 16 kHz, and returns `{ samples, sourceSampleRate, durationMs }`. `cancel` returns no audio. All termination paths clear timers and close resources. `SoundCuePlayer` synthesizes the tested 60–90 ms gain-ramped tones locally and never loads an audio asset.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run tests/unit/renderer/audioMath.test.ts tests/unit/renderer/audioRecorder.test.ts tests/unit/renderer/soundCues.test.ts`

Expected: all audio tests pass without jsdom unhandled errors.

- [x] **Step 5: Commit**

```powershell
git add src/renderer/public/audio-capture-worklet.js src/renderer/src/audio tests/unit/renderer
git commit -m "feat: capture and resample microphone audio"
```

### Task 7: Bundle and serve a hash-verified local Whisper model

**Files:**
- Create: `scripts/model-catalog.mjs`
- Create: `scripts/prepare-model.mjs`
- Create: `scripts/verify-model.mjs`
- Create: `tests/unit/scripts/modelCatalog.test.ts`
- Create: `tests/unit/main/modelProtocol.test.ts`
- Create: `tests/unit/main/modelManager.test.ts`
- Create: `src/main/models/modelManager.ts`
- Create: `src/main/models/modelProtocol.ts`
- Create: `resources/models/catalog.lock.json` (generated and committed)
- Create: `resources/models/manifest.lock.json` (generated and committed)
- Create: `resources/runtime/manifest.lock.json` (generated and committed)
- Modify: `.gitignore`
- Modify: `electron-builder.yml`

- [x] **Step 1: Write failing model security tests**

```ts
// tests/unit/main/modelProtocol.test.ts
import { describe, expect, it } from 'vitest'
import { resolveModelRequest } from '../../../src/main/models/modelProtocol'

describe('resolveModelRequest', () => {
  it('serves a manifest-listed asset inside the model root', () => {
    expect(resolveModelRequest('talktype-model://model/Xenova/whisper-base/config.json', 'D:/models', new Set(['Xenova/whisper-base/config.json'])))
      .toBe('D:\\models\\Xenova\\whisper-base\\config.json')
  })

  it('rejects path traversal', () => {
    expect(() => resolveModelRequest('talktype-model://model/../secret.txt', 'D:/models', new Set())).toThrow('MODEL_PATH_DENIED')
  })
})
```

Catalog tests assert all three pinned repositories and revisions, Apache-2.0 licensing, the exact allowlist, and declared quantized byte sizes: Fast encoder 10,124,910 and decoder 30,727,765; Balanced encoder 23,200,850 and decoder 53,707,539; Accurate encoder 92,324,809 and decoder 156,780,950. Model-manager tests prove no network adapter is called before `consent: true`, downloads use pinned URLs, a SHA mismatch deletes the temporary file, successful installation is atomic, progress contains no personal data, Balanced cannot be removed, and optional models can be removed completely.

- [x] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/scripts/modelCatalog.test.ts tests/unit/main/modelProtocol.test.ts tests/unit/main/modelManager.test.ts`

Expected: FAIL because the model scripts and protocol resolver do not exist.

- [x] **Step 3: Implement deterministic model preparation**

`scripts/model-catalog.mjs` exports the three repositories and revisions from Task 2. Every model uses only these remote files: `added_tokens.json`, `config.json`, `generation_config.json`, `merges.txt`, `normalizer.json`, `onnx/decoder_model_merged_quantized.onnx`, `onnx/encoder_model_quantized.onnx`, `preprocessor_config.json`, `special_tokens_map.json`, `tokenizer.json`, `tokenizer_config.json`, and `vocab.json`.

`prepare-model.mjs` produces `catalog.lock.json` containing the pinned URL, byte size, and SHA-256 for every allowlisted file in Fast, Balanced, and Accurate. It downloads only the bundled Balanced files into a temporary sibling, verifies against the catalog lock, atomically renames, and writes the installed `manifest.lock.json`. It also copies only the ONNX Runtime Web WASM files required by Transformers.js into `resources/runtime` and writes their hash manifest. `verify-model.mjs` rejects missing, extra, size-mismatched, or hash-mismatched bundled assets. Binary assets are ignored by Git; all lock manifests are committed. Builder `extraResources` copies `resources/models` and `resources/runtime` outside ASAR.

`ModelManager` receives the shipped catalog lock, packaged model root, user-data model root, and an injected HTTPS downloader. `install(preset, { consent })` rejects bundled, unknown, or non-consented requests before network access; downloads only pinned allowlisted URLs; verifies size and SHA-256 before atomic rename; reports `{ preset, completedBytes, totalBytes }`; and marks a preset installed only after every file passes. `remove(preset)` refuses Balanced and removes an optional preset directory safely. `status()` returns installed/downloading/error state without making a request. IPC exposes disclosure data before the separate consented install call.

- [x] **Step 4: Prepare and verify the real bundled assets**

Run:

```powershell
npm run model:prepare
npm run model:verify
```

Expected: 12 model files and the required runtime files verify; model payload is approximately 81 MB; no request uses an unpinned `main` URL.

- [x] **Step 5: Implement the read-only model protocol**

Register the custom scheme before app readiness as secure, standard, fetch-enabled, and CORS-enabled. At runtime, load the committed manifest, allow only GET requests for manifest-listed paths, normalize separators, reject traversal and query manipulation, and respond through `net.fetch(pathToFileURL(resolved).toString())`. Packaged roots use `process.resourcesPath`; development roots use the repository `resources` directory.

- [x] **Step 6: Verify GREEN**

Run:

```powershell
npx vitest run tests/unit/scripts/modelCatalog.test.ts tests/unit/main/modelProtocol.test.ts tests/unit/main/modelManager.test.ts
npm run model:verify
```

Expected: all model security tests and real-asset verification pass.

- [x] **Step 7: Commit**

```powershell
git add scripts resources/models/catalog.lock.json resources/models/manifest.lock.json resources/runtime/manifest.lock.json src/main/models tests/unit/scripts tests/unit/main/modelProtocol.test.ts tests/unit/main/modelManager.test.ts .gitignore electron-builder.yml
git commit -m "feat: bundle verified local Whisper assets"
```

### Task 8: Run Whisper in a dedicated local-only transcription worker

**Files:**
- Create: `tests/unit/renderer/transcriptionMessages.test.ts`
- Create: `tests/integration/transcriptionClient.test.ts`
- Create: `src/renderer/src/transcription/messages.ts`
- Create: `src/renderer/src/transcription/client.ts`
- Create: `src/renderer/src/transcription/worker.ts`

- [x] **Step 1: Write failing worker-contract tests**

```ts
// tests/unit/renderer/transcriptionMessages.test.ts
import { describe, expect, it } from 'vitest'
import { parseWorkerResponse } from '../../../src/renderer/src/transcription/messages'

describe('worker messages', () => {
  it('accepts a session-bound transcription result', () => {
    expect(parseWorkerResponse({ type: 'result', requestId: 'r1', sessionId: 's1', text: 'hello', language: 'en' })).toEqual({
      type: 'result', requestId: 'r1', sessionId: 's1', text: 'hello', language: 'en',
    })
  })

  it('rejects malformed worker output', () => {
    expect(() => parseWorkerResponse({ type: 'result', text: 4 })).toThrow()
  })
})
```

Client tests use a fake Worker and prove transferable audio dispatch, progress delivery, request correlation, cancellation, stale response rejection, pipeline errors, and worker termination.

- [x] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/renderer/transcriptionMessages.test.ts tests/integration/transcriptionClient.test.ts`

Expected: FAIL because transcription modules do not exist.

- [x] **Step 3: Implement worker schemas and client**

Use Zod discriminated unions for `load`, `transcribe`, `cancel`, `progress`, `ready`, `result`, and `error`. `TranscriptionClient` owns one module Worker, creates request identifiers with `crypto.randomUUID()`, transfers `Float32Array.buffer`, and rejects outstanding promises with typed `WORKER_TERMINATED` errors during disposal.

- [x] **Step 4: Implement local-only Transformers.js inference**

At worker startup set:

```ts
import { env, pipeline } from '@huggingface/transformers'

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = 'talktype-model://model/'
env.backends.onnx.wasm.wasmPaths = 'talktype-runtime://runtime/'
```

Resolve the chosen preset through the immutable model catalog and load its locally installed repository ID with `dtype: 'q8'`; Balanced is the default and must always be available. In Auto mode, try `device: 'webgpu'` only when `navigator.gpu` exists, then retry once with `device: 'wasm'`. Pass the raw 16 kHz `Float32Array` to the automatic-speech-recognition pipeline with `task: 'transcribe'` and the selected language when it is not auto. Normalize library failures into `MODEL_MISSING`, `WEBGPU_FAILED`, `OUT_OF_MEMORY`, `CANCELLED`, or `TRANSCRIPTION_FAILED`; never include audio or transcript content in errors or logs.

- [x] **Step 5: Verify GREEN and a real worker smoke test**

Run:

```powershell
npx vitest run tests/unit/renderer/transcriptionMessages.test.ts tests/integration/transcriptionClient.test.ts
npm run build
npm run model:verify
```

Expected: worker-contract tests pass and the worker bundle resolves only local model/runtime URLs.

- [x] **Step 6: Commit**

```powershell
git add src/renderer/src/transcription tests/unit/renderer/transcriptionMessages.test.ts tests/integration/transcriptionClient.test.ts
git commit -m "feat: transcribe locally in an isolated Whisper worker"
```

### Task 9: Orchestrate dictation, widget synchronization, output, and history

**Files:**
- Create: `tests/unit/renderer/dictationController.test.ts`
- Create: `tests/integration/widgetSync.test.ts`
- Create: `src/renderer/src/features/dictation/dictationController.ts`
- Create: `src/renderer/src/state/AppContext.tsx`
- Modify: `src/main/ipc/registerIpc.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Write failing orchestration tests**

```ts
// tests/unit/renderer/dictationController.test.ts
import { describe, expect, it, vi } from 'vitest'
import { DictationController } from '../../../src/renderer/src/features/dictation/dictationController'

describe('DictationController', () => {
  it('copies a successful result and records metadata', async () => {
    const recorder = { start: vi.fn(), stop: vi.fn().mockResolvedValue({ samples: new Float32Array([0.2]), durationMs: 500 }) }
    const transcriber = { transcribe: vi.fn().mockResolvedValue({ text: '  hello   world  ', language: 'en' }) }
    const bridge = { deliverOutput: vi.fn().mockResolvedValue('pasted'), addHistory: vi.fn(), publishWidgetState: vi.fn() }
    const controller = new DictationController({ recorder, transcriber, bridge, now: () => 1000, createId: () => 'session' })
    await controller.start()
    await controller.stop()
    expect(bridge.deliverOutput).toHaveBeenCalledWith('hello world')
    expect(bridge.addHistory).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world', durationMs: 500 }))
  })
})
```

Add tests for shortcut toggle, repeated stop, global Escape cancellation, start/stop cue settings, cancel during listening, silence preserving clipboard/history, stale result suppression, permission denial recovery, duration-limit stop, paste fallback, and ignoring hotkeys while processing. Widget integration tests prove every reducer state is published to the widget and success distinguishes `pasted` from `copied`.

- [ ] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/renderer/dictationController.test.ts tests/integration/widgetSync.test.ts`

Expected: FAIL because the controller and app context do not exist.

- [ ] **Step 3: Implement the controller and application context**

The controller is the only owner of recorder/transcriber calls. It creates one session ID, dispatches the legal reducer transitions, activates global Escape only while cancellation is legal, plays enabled start/stop cues, publishes serializable widget snapshots, applies `formatTranscript`, calls output before history, and always returns to idle after the configured success/error display time. Empty text produces `NO_SPEECH` without output or history. AppContext loads settings/history on mount, subscribes to shortcut/tray commands, exposes navigation and CRUD actions, and disposes listeners and controller resources on unmount.

- [ ] **Step 4: Wire typed IPC end to end**

Register handlers for settings get/update/reset, history list/add/delete/clear/search, output delivery, widget publishing, model status, startup update, app show/hide/minimize/quit, and dictation command events. Validate every renderer payload in the main process with the shared schemas. Preload must expose the matching named methods and return an unsubscribe function for every event subscription.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
npx vitest run tests/unit/renderer/dictationController.test.ts tests/integration/widgetSync.test.ts tests/integration/ipc.test.ts
npm run typecheck
```

Expected: orchestration and IPC tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/src/features/dictation src/renderer/src/state src/main/ipc src/preload tests/unit/renderer/dictationController.test.ts tests/integration
git commit -m "feat: orchestrate global dictation from capture to output"
```

### Task 10: Create the visual system and first-run onboarding

**Files:**
- Create: `tests/unit/renderer/designSystem.test.tsx`
- Create: `tests/unit/renderer/onboarding.test.tsx`
- Create: `src/renderer/src/styles/tokens.css`
- Create: `src/renderer/src/styles/global.css`
- Create: `src/renderer/src/components/Button.tsx`
- Create: `src/renderer/src/components/Card.tsx`
- Create: `src/renderer/src/components/Field.tsx`
- Create: `src/renderer/src/components/Select.tsx`
- Create: `src/renderer/src/components/Toggle.tsx`
- Create: `src/renderer/src/components/ShortcutKey.tsx`
- Create: `src/renderer/src/components/ToastRegion.tsx`
- Create: `src/renderer/src/components/LevelMeter.tsx`
- Create: `src/renderer/src/features/onboarding/Onboarding.tsx`
- Create: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/main.tsx`

- [ ] **Step 1: Write failing component and onboarding tests**

```tsx
// tests/unit/renderer/onboarding.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Onboarding } from '../../../src/renderer/src/features/onboarding/Onboarding'

describe('Onboarding', () => {
  it('requires microphone and model readiness before completion', async () => {
    const complete = vi.fn()
    render(<Onboarding microphoneState="ready" modelState="ready" onRequestMicrophone={vi.fn()} onComplete={complete} />)
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }))
    expect(complete).toHaveBeenCalledOnce()
  })
})
```

Design-system tests prove buttons have visible focus classes, icon-only controls require accessible labels, toggles expose checked state, fields link labels/descriptions/errors, and reduced motion disables decorative transitions.

- [ ] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/renderer/designSystem.test.tsx tests/unit/renderer/onboarding.test.tsx`

Expected: FAIL because design-system and onboarding components do not exist.

- [ ] **Step 3: Implement tokens and accessible primitives**

Define complete light and dark custom properties for canvas, surface, elevated surface, text, muted text, border, primary, primary hover, cyan activity, success, warning, error, focus ring, shadows, and radii. System theme follows `prefers-color-scheme`; `[data-theme='light']` and `[data-theme='dark']` override it. Use a system font stack, 14–16 px body scale, 44 px minimum interactive height, and a global `:focus-visible` ring. A reduced-motion media query sets transition and animation duration to 1 ms.

- [ ] **Step 4: Implement the four-step onboarding**

Step 1 states that transcription is local, free, accountless, and telemetry-free. Step 2 requests microphone access and shows a live level meter plus Windows recovery instructions. Step 3 verifies the bundled Balanced model and explains optional model-download metadata before exposing Fast/Accurate actions. Step 4 shows the active shortcut and provides a safe paste test field. Back/Continue retain progress; Finish remains disabled until microphone and model are ready; completion persists through settings.

- [ ] **Step 5: Verify GREEN and keyboard flow**

Run:

```powershell
npx vitest run tests/unit/renderer/designSystem.test.tsx tests/unit/renderer/onboarding.test.tsx
npm run typecheck
```

Expected: all onboarding and design-system tests pass without accessibility query failures.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/src/styles src/renderer/src/components src/renderer/src/features/onboarding src/renderer/src/App.tsx src/renderer/src/main.tsx tests/unit/renderer
git commit -m "feat: add polished private first-run onboarding"
```

### Task 11: Build Home, History, Settings, and Help views

**Files:**
- Create: `tests/unit/renderer/homeView.test.tsx`
- Create: `tests/unit/renderer/historyView.test.tsx`
- Create: `tests/unit/renderer/settingsView.test.tsx`
- Create: `src/renderer/src/components/AppShell.tsx`
- Create: `src/renderer/src/features/home/HomeView.tsx`
- Create: `src/renderer/src/features/history/HistoryView.tsx`
- Create: `src/renderer/src/features/settings/SettingsView.tsx`
- Create: `src/renderer/src/features/help/HelpView.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Write failing screen tests**

```tsx
// tests/unit/renderer/historyView.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HistoryView } from '../../../src/renderer/src/features/history/HistoryView'

describe('HistoryView', () => {
  it('searches locally and copies the chosen transcript', async () => {
    const copy = vi.fn()
    render(<HistoryView entries={[{ id: '1', text: 'alpha note', createdAt: 1, durationMs: 10, language: 'en', modelPreset: 'balanced' }, { id: '2', text: 'beta note', createdAt: 2, durationMs: 10, language: 'en', modelPreset: 'balanced' }]} onCopy={copy} onDelete={vi.fn()} onClear={vi.fn()} />)
    await userEvent.type(screen.getByRole('searchbox'), 'alpha')
    expect(screen.getByText('alpha note')).toBeVisible()
    expect(screen.queryByText('beta note')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /copy alpha note/i }))
    expect(copy).toHaveBeenCalledWith('alpha note')
  })
})
```

Home tests cover ready/listening/processing/error status cards and manual start/stop. Settings tests cover immediate theme application, hotkey conflict rollback message, device choice, presets, language, inference, cues, duration, auto-paste, delay bounds, startup/minimized, history retention, destructive confirmations, model disclosure, separate consent before optional installation, progress, hash failure, successful preset selection, and optional-model removal. Help tests assert privacy and paste-fallback guidance.

- [ ] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/renderer/homeView.test.tsx tests/unit/renderer/historyView.test.tsx tests/unit/renderer/settingsView.test.tsx`

Expected: FAIL because application views do not exist.

- [ ] **Step 3: Implement the management experience**

`AppShell` has a draggable custom title area, fixed navigation rail, main landmark, status footer, minimize and close controls, and a compact layout below 820 px. Home contains a dominant record card, model readiness, active shortcut, privacy badge, and five recent entries. History has local search, empty/privacy-disabled states, copy/delete actions, and a confirmation dialog for clear. Settings group Appearance, Capture, Transcription, Output, and Application with plain-language help and save feedback. Help provides microphone, hotkey, offline model, paste, elevated-window, and reset troubleshooting.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npx vitest run tests/unit/renderer/homeView.test.tsx tests/unit/renderer/historyView.test.tsx tests/unit/renderer/settingsView.test.tsx
npm run typecheck
```

Expected: screen tests pass in both forced light and dark theme containers.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/src/components/AppShell.tsx src/renderer/src/features src/renderer/src/App.tsx tests/unit/renderer
git commit -m "feat: add dashboard history settings and help"
```

### Task 12: Build the non-focusing floating widget and theme previews

**Files:**
- Create: `tests/unit/renderer/widgetApp.test.tsx`
- Create: `tests/e2e/visual-previews.spec.ts`
- Create: `src/renderer/src/widget/WidgetApp.tsx`
- Create: `src/renderer/src/widget/widget.css`
- Modify: `src/renderer/src/widget.tsx`

- [ ] **Step 1: Write failing widget-state tests**

```tsx
// tests/unit/renderer/widgetApp.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WidgetApp } from '../../../src/renderer/src/widget/WidgetApp'

describe('WidgetApp', () => {
  it('shows copied fallback distinctly from pasted success', () => {
    const { rerender } = render(<WidgetApp state={{ status: 'success', sessionId: 's', text: 'hello', output: 'copied' }} levels={[0.1, 0.4, 0.2]} />)
    expect(screen.getByText(/copied.*paste manually/i)).toBeVisible()
    rerender(<WidgetApp state={{ status: 'success', sessionId: 's', text: 'hello', output: 'pasted' }} levels={[0.1, 0.4, 0.2]} />)
    expect(screen.getByText(/^pasted$/i)).toBeVisible()
  })
})
```

Add tests for listening timer/instruction, processing stage, no-speech, permission, model, paste, and generic error recovery text; accessible labels; and reduced-motion waveform behavior.

- [ ] **Step 2: Run and observe RED**

Run: `npx vitest run tests/unit/renderer/widgetApp.test.tsx`

Expected: FAIL because WidgetApp does not exist.

- [ ] **Step 3: Implement the widget**

Render a 420×92 pill with a state icon, 12-bar level visualization, status label, timer/progress text, shortcut hint, and mouse-accessible cancel button that does not request focus. Listening uses indigo glow and cyan levels; processing uses a restrained orbit; success uses teal; errors use coral with one recovery sentence. Theme comes from settings snapshots and uses the same tokens as the main renderer. The preview query `?preview=listening|processing|pasted|copied|error&theme=light|dark` supplies deterministic states only when `TALKTYPE_VISUAL_PREVIEW=1` is injected by tests.

- [ ] **Step 4: Verify GREEN and capture deterministic previews**

Run:

```powershell
npx vitest run tests/unit/renderer/widgetApp.test.tsx
npm run build
npx playwright test tests/e2e/visual-previews.spec.ts
```

Expected: widget tests pass and screenshots are written under `artifacts/design/baseline` for all states in light and dark.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/src/widget src/renderer/src/widget.tsx tests/unit/renderer/widgetApp.test.tsx tests/e2e/visual-previews.spec.ts
git commit -m "feat: add global dictation status widget"
```

### Task 13: Add end-to-end workflows, branding, documentation, and Windows packaging

**Files:**
- Create: `tests/e2e/app.spec.ts`
- Create: `tests/fixtures/fakeTranscription.ts`
- Create: `build/icon.png`
- Create: `build/icon.ico`
- Create: `build/installer-sidebar.bmp`
- Create: `README.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `electron-builder.yml`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing end-to-end workflows**

```ts
// tests/e2e/app.spec.ts
import { _electron as electron, expect, test } from '@playwright/test'

test('onboards, dictates, copies, pastes, and records local history', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, TALKTYPE_E2E: '1' } })
  const window = await app.firstWindow()
  await window.getByRole('button', { name: /continue/i }).click()
  await window.getByRole('button', { name: /allow microphone/i }).click()
  await window.getByRole('button', { name: /continue/i }).click()
  await window.getByRole('button', { name: /continue/i }).click()
  await window.getByRole('button', { name: /finish setup/i }).click()
  await window.getByRole('button', { name: /start dictation/i }).click()
  await window.getByRole('button', { name: /stop dictation/i }).click()
  await expect(window.getByText('A deterministic local transcript.')).toBeVisible()
  await window.getByRole('link', { name: /history/i }).click()
  await expect(window.getByText('A deterministic local transcript.')).toBeVisible()
  await app.close()
})
```

Add workflows for history disabled, theme persistence, hotkey-conflict message, microphone denial recovery, silence preserving clipboard, paste failure showing copied fallback, settings reload, window hide-to-tray, and single-instance behavior. E2E mode may inject deterministic recorder/transcriber/native adapters only at the bootstrap boundary; production builds must tree-shake or reject that mode unless `!app.isPackaged`.

- [ ] **Step 2: Run and observe RED**

Run: `npm run build && npx playwright test tests/e2e/app.spec.ts`

Expected: FAIL until the e2e adapters and complete workflow selectors are wired.

- [ ] **Step 3: Complete the deterministic e2e seam and tests**

Use `TALKTYPE_E2E=1` only in development output to supply one-second fake PCM, the exact fixture transcript, in-memory shortcut/clipboard/paste adapters, and a temporary user-data path. Keep all production path behavior unchanged. Add stable `data-testid` only where role/name selection cannot identify a dynamic waveform or native title control.

- [ ] **Step 4: Produce the TalkType brand assets**

Use the imagegen skill to create an original indigo TalkType bitmap icon: a rounded dark/white tile containing a symmetric microphone capsule whose negative-space stem becomes a text caret, plus two cyan audio ticks. Export 1024×1024 PNG, a multi-resolution Windows ICO (16, 24, 32, 48, 64, 128, 256), and a quiet installer sidebar. Verify legibility at 16 px and in both Windows themes. Record the icon-generation provenance in `THIRD_PARTY_NOTICES.md`.

- [ ] **Step 5: Configure packaging and documentation**

Electron Builder must produce x64 NSIS assisted install plus `win-unpacked`, use per-user installation, create Start Menu and optional desktop shortcuts, preserve user data on uninstall by default, include model/runtime extraResources and notices, and set product metadata. README must contain prerequisites, privacy promise, development commands, model preparation, test matrix, packaging, default shortcut, first run, settings, elevated-window paste limitation, troubleshooting, and release artifact paths.

- [ ] **Step 6: Verify GREEN and build both artifacts**

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run package:dir
npm run package:win
```

Expected: all checks pass; `release/win-unpacked/TalkType.exe` and an NSIS `TalkType Setup 0.1.0.exe` exist; `resources/models/Xenova/whisper-base` and runtime WASM files exist inside `win-unpacked/resources`.

- [ ] **Step 7: Commit**

```powershell
git add tests/e2e tests/fixtures build README.md THIRD_PARTY_NOTICES.md electron-builder.yml playwright.config.ts package.json package-lock.json
git commit -m "build: package verified TalkType Windows release"
```

### Task 14: Run the requested design-subagent review and fix every material finding

**Files:**
- Create: `docs/qa/design-review.md`
- Modify: UI/style/component files identified by review
- Modify: focused UI tests identified by review

- [ ] **Step 1: Capture the complete review set**

Run the built app in deterministic preview mode and save light/dark screenshots for onboarding steps, Home in ready/listening/processing/error, populated and empty History, every Settings group, Help, and each widget state. Also capture 100%, 125%, 150%, and 200% Windows scaling equivalents through Playwright viewport/deviceScaleFactor settings.

- [ ] **Step 2: Dispatch a dedicated design subagent**

Give the subagent the approved spec, token CSS, screenshots, and these explicit review dimensions: hierarchy, density, spacing rhythm, typography, light/dark parity, contrast, focus states, clipping, text wrapping, empty/error feedback, motion, widget glanceability, and resemblance risk to WhisperFlow. Require severity-ranked findings with exact screenshot/component references and concrete proposed corrections. Save the returned review to `docs/qa/design-review.md`.

- [ ] **Step 3: Write failing visual or component tests for each accepted finding**

For every functional/accessibility finding, add a role/state assertion that fails before the fix. For clipping or layout findings, add a Playwright screenshot or bounding-box assertion at the failing scale. Record any purely aesthetic low-severity choice that is intentionally not changed with a reason in the review document.

- [ ] **Step 4: Fix critical, high, and accepted medium findings**

Change tokens/components rather than applying page-specific overrides when the issue is systemic. Re-run the focused RED test after each change and preserve both themes and reduced motion.

- [ ] **Step 5: Re-capture and request design recheck**

Re-run the full screenshot matrix and ask the same design subagent to confirm each finding is resolved. Append the recheck verdict and evidence paths to `docs/qa/design-review.md`.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npx playwright test tests/e2e/visual-previews.spec.ts`

Expected: all UI tests pass and the design recheck has no unresolved critical/high issues.

```powershell
git add docs/qa/design-review.md src/renderer tests
git commit -m "fix: resolve TalkType visual design review"
```

### Task 15: Run adversarial QA, fix findings, and prove completion

**Files:**
- Create: `docs/qa/adversarial-review.md`
- Create: `docs/verification/2026-07-11-talktype-verification.md`
- Modify: production/test files required by verified findings

- [ ] **Step 1: Dispatch the requested adversarial QA subagent**

Give the subagent the approved spec, entire repository, built unpacked app, installer path, automated results, and design review. Require a requirement-by-requirement evidence table plus active attacks against: rapid shortcut repetition; cancel/stop races; renderer reload/crash; corrupt settings/history; missing/tampered model; offline startup; microphone denial/removal; silence and maximum duration; WebGPU fallback; clipboard preservation; paste spawn failure; elevated app; hotkey conflict; multiple instances; tray quit; sleep/wake; multi-monitor bounds; path traversal; malformed IPC; remote network attempts; transcript/audio logging; history disabled; scale/theme/reduced motion; installer resources and uninstall behavior.

- [ ] **Step 2: Save and triage the report**

Write severity, reproduction steps, evidence, affected requirement, and proposed regression test for every finding to `docs/qa/adversarial-review.md`. Treat uncertain evidence as not passing. Critical/high findings must be fixed; medium findings are fixed unless they conflict with the approved scope; low findings are documented with disposition.

- [ ] **Step 3: Fix through TDD**

For each accepted defect, first add the smallest failing automated test that reproduces it, run that test to record RED, implement the minimal fix, and run focused plus full suites. Never weaken an assertion to make a failure disappear.

- [ ] **Step 4: Run real Windows manual verification**

Use a real microphone to dictate a unique sentence with the bundled model. Verify global toggle and output in Notepad, a browser text field, and Microsoft Word when available. Verify copied fallback against an elevated target, model operation with the network disabled, tray behavior, two displays when available, sleep/wake if feasible, startup registration, and installer launch in a clean Windows user profile or equivalent sandbox. Record exact observed results and any environment limitation; do not infer a pass from unrelated tests.

- [ ] **Step 5: Run the final automated release gate**

Run:

```powershell
npm ci
npm run model:verify
npm run lint
npm run typecheck
npm run test:coverage
npm run test:e2e
npm run package:dir
npm run package:win
```

Expected: every command exits 0, coverage includes all critical domain/native services, and both release artifacts are recreated from a clean dependency install.

- [ ] **Step 6: Write the completion audit**

In `docs/verification/2026-07-11-talktype-verification.md`, map every numbered success criterion and every delivery artifact from the approved specification to authoritative evidence: test name/output, file path, screenshot, artifact hash, or recorded manual observation. Mark any missing or indirect evidence as incomplete and continue work until it is proven.

- [ ] **Step 7: Request adversarial recheck and commit**

Ask the adversarial subagent to re-run critical/high reproductions and audit the final evidence document. It must explicitly state that no critical/high findings remain and identify any residual limitations.

```powershell
git add docs/qa/adversarial-review.md docs/verification/2026-07-11-talktype-verification.md src tests package-lock.json
git commit -m "test: complete adversarial QA and release audit"
```

## Plan self-review checklist

- Every success criterion in the approved specification maps to Tasks 1–15.
- Every production subsystem has a test-first RED/GREEN cycle.
- The bundled model, runtime, hashes, license notices, installer, and unpacked build are explicit deliverables.
- The user's requested implementation subagents, design subagent, and adversarial QA subagent are explicit execution gates.
- Settings, hotkey, light/dark themes, widget, clipboard, auto-paste, history, tray, startup, privacy, offline behavior, and polished recovery states all have implementation and verification tasks.
- Names and signatures used across tasks are consistent: `TalkTypeBridge`, `DictationController`, `TranscriptionClient`, `OutputService`, `HistoryRepository`, `SettingsRepository`, `WindowManager`, and `HotkeyManager`.
- No task depends on cloud transcription, an account, telemetry, or a paid API.
