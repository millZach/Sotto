// The cut. Film times are on the 100 BPM grid (0.6 s a beat); each shot names the take it comes from and
// the moment in that take it starts at, so a retake keeps its place. Crops are in the 2560x1600 source.
import { moment as m, square, type Caption, type KeyCap, type Rect, type Shot } from './timeline'

const WIDE = { y: 420, h: 1080 * 1588 / 2560 }
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
/** The whole window, less the capture's top rows, which hold a strip of the desktop above Sotto. */
const WIN = rect(0, 12, 2560, 1588)

// Where things sit on the screen, in source pixels.
/** The composer as a strip (1.8:1), shown in the frame's upper-middle band. */
const COMPOSER = rect(820, 1120, 864, 480)
const STRIP = { y: 520, h: 600 }
const WIDGET = square(2440, 760, 700)
const TOOLS = (cy: number, size = 960) => square(1965, cy, size)
const NOTEPAD = square(1190, 935, 1100) // below Notepad's tabs and above the taskbar

// Source seconds at which the words land after dictation stops: 1 s in both takes (read off the footage).
const HOOK_LANDED = m('hook', 'landed')
const ANYWHERE_LANDED = m('anywhere', 'keys', 1) + 0.97

export const shots: Shot[] = [
  // 1. Hook: the empty composer, the shortcut, the widget listening, the words landing, Enter. Waits are cut.
  { id: 'hook: composer', take: 'hook', start: 0, end: 0.9, from: m('hook', 'keys', 0) - 0.5, frame: 'tight', ...STRIP,
    camera: [{ t: 0, rect: rect(800, 1110, 900, 500) }, { t: 1, rect: COMPOSER }] },
  // The microphone takes about 1.7 s to open; the listening shot starts once the meter moves.
  { id: 'hook: listening', take: 'hook', start: 0.9, end: 1.8, from: m('hook', 'keys', 0) + 1.7, frame: 'tight',
    camera: [{ t: 0, rect: WIDGET }] },
  { id: 'hook: stop', take: 'hook', start: 1.8, end: 2.4, from: m('hook', 'keys', 1) - 0.25, frame: 'tight',
    camera: [{ t: 0, rect: WIDGET }] },
  // 2. One window: the words land, Enter, and the camera pulls back to the whole window as the thread starts.
  { id: 'hook: landed, one window', take: 'hook', start: 2.4, end: 7.2, from: HOOK_LANDED - 0.15, frame: 'window',
    camera: [{ t: 0, rect: COMPOSER, out: STRIP }, { t: 0.23, rect: COMPOSER, out: STRIP }, { t: 0.48, rect: WIN, out: WIDE }, { t: 1, rect: WIN, out: WIDE }] },
  // 3. Three threads side by side, panning across the panes.
  { id: 'side by side', take: 'split', start: 7.2, end: 9.6, from: m('split', 'start') + 1.2, frame: 'tight',
    camera: [{ t: 0, rect: square(760, 700, 1400) }, { t: 1, rect: square(1800, 700, 1400) }] },
  // 4. A permission request answered, then a question with choices.
  { id: 'permission', take: 'requests', start: 9.6, end: 11.1, from: m('requests', 'allowed') - 1.03, frame: 'tight',
    camera: [{ t: 0, rect: square(1300, 930, 1000) }, { t: 1, rect: square(1300, 950, 940) }] },
  { id: 'question', take: 'requests', start: 11.1, end: 12.6, from: m('requests', 'chosen') - 0.4, frame: 'tight',
    camera: [{ t: 0, rect: square(1370, 860, 1040) }, { t: 1, rect: square(1370, 870, 1000) }] },
  // 5. Tools: the browser turning the page dark, the terminal, Files, and a comment in Changes.
  { id: 'browser', take: 'tools', start: 12.6, end: 14.4, from: m('tools', 'dark') - 1.14, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(1000) }, { t: 1, rect: TOOLS(1020, 920) }] },
  { id: 'terminal', take: 'tools', start: 14.4, end: 15.6, from: m('tools', 'keys-quiet') + 0.45, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(520) }] },
  { id: 'files', take: 'tools', start: 15.6, end: 16.8, from: m('tools', 'file-open') - 0.4, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(560) }, { t: 1, rect: TOOLS(580, 920) }] },
  { id: 'changes: select', take: 'tools', start: 16.8, end: 17.7, from: m('tools', 'commented') - 5.65, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(700) }] },
  { id: 'changes: comment', take: 'tools', start: 17.7, end: 19.2, from: m('tools', 'commented') - 0.75, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(700) }, { t: 0.5, rect: TOOLS(700) }, { t: 1, rect: square(1400, 820, 1560) }] },
  // 6. Git: the action, the dialog with its message left empty, the pull request, the checklist, Merge.
  { id: 'git: action', take: 'git', start: 19.2, end: 19.8, from: m('git', 'action') + 0.5, frame: 'tight', y: 500, h: 540,
    camera: [{ t: 0, rect: rect(1400, 0, 960, 480) }] },
  { id: 'git: dialog', take: 'git', start: 19.8, end: 21.0, from: m('git', 'committing') - 1.11, frame: 'tight',
    camera: [{ t: 0, rect: square(1330, 800, 1000) }, { t: 1, rect: square(1330, 810, 960) }] },
  { id: 'git: created', take: 'git', start: 21.0, end: 21.6, from: m('git', 'created') - 0.1, frame: 'tight',
    camera: [{ t: 0, rect: square(1300, 1000, 1000) }] },
  { id: 'git: checklist', take: 'git', start: 21.6, end: 23.4, from: m('git', 'checklist') + 0.8, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(540) }, { t: 1, rect: TOOLS(560, 920) }] },
  { id: 'git: confirm', take: 'git', start: 23.4, end: 24.0, from: m('git', 'merged') - 0.47, frame: 'tight',
    camera: [{ t: 0, rect: square(1330, 800, 1000) }] },
  // gh answers the merge 1.3 s after the confirm; the panel then reads Pull request merged.
  { id: 'git: merged', take: 'git', start: 24.0, end: 24.6, from: m('git', 'merged') + 1.32, frame: 'tight',
    camera: [{ t: 0, rect: TOOLS(520, 1000) }] },
  // 7. Worktrees: a new thread on its own worktree, each branch in the sidebar, and giving the folder back.
  { id: 'worktree: new', take: 'worktrees', start: 24.6, end: 25.8, from: m('worktrees', 'new-worktree') - 0.92, frame: 'tight',
    camera: [{ t: 0, rect: square(1380, 1150, 1000) }] },
  { id: 'worktree: branches', take: 'worktrees', start: 25.8, end: 27.0, from: m('worktrees', 'widen') + 1.3, frame: 'tight',
    camera: [{ t: 0, rect: square(480, 620, 980) }, { t: 1, rect: square(480, 640, 920) }] },
  { id: 'worktree: remove', take: 'worktrees', start: 27.0, end: 28.8, from: m('worktrees', 'working-copy') + 0.2, frame: 'tight',
    camera: [{ t: 0, rect: square(1760, 400, 1000) }, { t: 1, rect: square(1760, 420, 940) }] },
  // 8. Dictation into Notepad.
  { id: 'anywhere: listening', take: 'anywhere', start: 28.8, end: 29.7, from: m('anywhere', 'keys', 0) - 0.3, frame: 'tight',
    camera: [{ t: 0, rect: NOTEPAD }] },
  { id: 'anywhere: stop', take: 'anywhere', start: 29.7, end: 30.3, from: m('anywhere', 'keys', 1) - 0.2, frame: 'tight',
    camera: [{ t: 0, rect: NOTEPAD }] },
  { id: 'anywhere: pasted', take: 'anywhere', start: 30.3, end: 31.8, from: ANYWHERE_LANDED - 0.15, frame: 'tight',
    camera: [{ t: 0, rect: NOTEPAD }, { t: 1, rect: square(1190, 945, 1050) }] },
  // 9. The six built-in themes, alternating dark and light.
  ...['sotto-dark', 'hush-light', 'linen-dark', 'nocturne-light', 'tropic-dark', 'citrine-light'].map((name, i): Shot => ({
    id: `theme ${name}`, still: `stills/theme-${name}.png`, start: 31.8 + i * 0.2, end: 32.0 + i * 0.2, from: 0, frame: 'window', camera: [{ t: 0, rect: WIN }],
  })),
]

export const captions: Caption[] = [
  { start: 4.2, end: 7.2, text: 'Your coding agents. One window.' },
  { start: 7.2, end: 9.6, text: 'Run them side by side.' },
  { start: 9.6, end: 12.6, text: 'You answer every request.' },
  { start: 12.6, end: 16.8, text: 'Browser, terminal, files and changes.' },
  { start: 16.8, end: 19.2, text: 'Beside every thread.' },
  { start: 19.2, end: 21.9, text: 'Leave the message. The agent writes it.' },
  { start: 21.9, end: 24.6, text: 'Commit, push and open a pull request.' },
  { start: 24.6, end: 26.4, text: 'Its own branch and folder.' },
  { start: 26.4, end: 28.8, text: 'Remove the folder when you’re done.' },
  { start: 29.4, end: 31.8, text: 'Dictation anywhere.' },
]

/** A key cap at the moment a take's key press shows, on the film's clock. */
const pressed = (shot: string, source: number) => {
  const s = shots.find(x => x.id === shot)
  if (!s) throw new Error(`No shot ${shot}`)
  return s.start + (source - s.from)
}
const CHORD = ['Ctrl', 'Shift', 'Space']
export const keyCaps: KeyCap[] = [
  { at: pressed('hook: composer', m('hook', 'keys', 0)), keys: CHORD },
  { at: pressed('hook: stop', m('hook', 'keys', 1)), keys: CHORD, hold: 0.35 },
  { at: pressed('hook: landed, one window', m('hook', 'keys', 2)), keys: ['Enter'], hold: 0.5 },
  { at: pressed('anywhere: listening', m('anywhere', 'keys', 0)), keys: CHORD, hold: 0.6, y: 1450 },
  { at: pressed('anywhere: stop', m('anywhere', 'keys', 1)), keys: CHORD, hold: 0.4, y: 1450 },
]

export const END_CARD = { start: 33.0, tagline: 0.6, facts: 1.8, url: 2.4 }
export const FILM_SECONDS = 37.2
