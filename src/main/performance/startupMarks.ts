/**
 * Startup marks (#995, #2396): the points launch reaches in main, each kept as the milliseconds since main's clock
 * started, so every change to launch can show a before and an after. The names are a fixed list and the times are
 * numbers; nothing here is logged, written to disk or sent anywhere (AGENTS.md). Recording one is a push onto a list of
 * at most nine, and each name is kept the first time launch reaches it. Once launch has finished nothing more is kept, so
 * a window made later, such as the widget on the first dictation press while dictation was off at launch, leaves its
 * mark unrecorded rather than recorded late.
 *
 * They are off by default: an ordinary launch records none. Only a launch started for an e2e run (`SOTTO_E2E=1`) records
 * them, and only an unpackaged one of those can read them (`src/main/e2e/startupMarks.ts`), for
 * `tests/e2e/launch-time.spec.ts`. The switch is read from the environment because the first startup mark is main's
 * first statement, before anything else of main has run.
 */

/** In the order launch reaches them. The main window is shown only after the widget has loaded (#995). */
export const STARTUP_MARKS = [
  /** The first line of `src/main/index.ts` runs: Electron has started and main's bundle has loaded and run. */
  'main-bundle-evaluated',
  /** Electron's `app.whenReady()` has resolved. */
  'app-ready',
  /** `createRuntime` has returned: every store, the agent runtime, hosts and drafts. */
  'runtime-created',
  /** The main window's `BrowserWindow` exists, hidden. */
  'main-window-created',
  /** The main window's page has finished loading. */
  'main-window-loaded',
  /** The widget's `BrowserWindow` exists. Not reached at launch while dictation is off (ADR-0107). */
  'widget-created',
  /** The widget's page has finished loading. */
  'widget-loaded',
  /** The main window was first shown. Not reached at launch with Start minimized on. */
  'main-window-shown',
  /** The runtime's start has returned, the resting widget's first state included. Nothing is kept after it. */
  'launch-finished',
] as const

export type StartupMarkName = typeof STARTUP_MARKS[number]

export interface StartupMark {
  readonly name: StartupMarkName
  /** Milliseconds since main's clock started (`performance.timeOrigin`). */
  readonly atMs: number
}

const marks: StartupMark[] = []
/** Whether this launch records startup marks at all: one started for an e2e run. */
const recording = process.env.SOTTO_E2E === '1'
let finished = false

export function markStartup(name: StartupMarkName): void {
  if (!recording || finished) return
  for (const mark of marks) if (mark.name === name) return
  marks.push({ name, atMs: performance.now() })
  if (name === 'launch-finished') finished = true
}

/** The marks launch has reached so far, in the order it reached them. */
export function startupMarks(): readonly StartupMark[] {
  return marks.slice()
}
