// PROTOTYPE, throwaway. What the frame's page calls: start the scene in Watcher's pane, switch ideas on and off, and
// make things happen in the pretend room.
import { FLAGS, LIFE, LOOK, PRESETS, type FlagId } from './life'
import { startLife, type Life } from './sceneLife'

let running: Life | null = null
let reduced: boolean | null = null

/** Starts the scene, or starts it again when reduced motion changed. It is drawn in the frame it starts, so it never shows blank. */
function start(options: { reduced: boolean }): void {
  const pane = document.querySelector<HTMLElement>('.watcher-pane')
  const back = pane?.querySelector<HTMLCanvasElement>('canvas.watcher-scene--land'), front = pane?.querySelector<HTMLCanvasElement>('canvas.watcher-scene--owl')
  const probe = pane?.querySelector<HTMLElement>('.watcher-scene__ink')
  if (!pane || !back || !front || !probe || (running !== null && reduced === options.reduced)) return
  running?.stop()
  reduced = options.reduced
  running = startLife({ pane, back, front, probe, reduced: options.reduced, options: {}, owls: [] })
}

;(window as unknown as { ProtoScene: unknown }).ProtoScene = {
  flags: FLAGS,
  presets: PRESETS,
  start,
  setFlags(ids: FlagId[]): void { LIFE.flags = new Set(ids); running?.kick() },
  setPace(pace: 'demo' | 'real'): void { LIFE.pace = pace; running?.kick() },
  setAuto(on: boolean): void { LIFE.autoRoom = on; running?.kick() },
  setLook(look: { shape: boolean; depth: boolean; halo: boolean }): void {
    if (look.shape === LOOK.shape && look.depth === LOOK.depth && look.halo === LOOK.halo) return
    Object.assign(LOOK, look)
    running?.relook()
  },
  room(kind: string): void { running?.room(kind) },
  play(kind: string): void { running?.play(kind) },
  onSay(listener: (words: string) => void): void { LIFE.say = listener },
}
