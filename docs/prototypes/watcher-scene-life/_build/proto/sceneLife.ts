// PROTOTYPE, throwaway. Runs the night wood the way WatcherNightScene.tsx does, with Sotto's own nightScene.ts,
// nightScenePainter.ts, owlFamily.ts and placeNightWood.ts unchanged, and directs what the prototype adds: when a gust
// or an event starts, what Watcher's owl flies for, and what a change in the pretend room sets off. With every idea
// switched off this is today's scene.
import {
  addRipple, CELL, clamp, frameDelay, groundAt, inMargin, liveRipples, nextPlace, owlAt, planFlight, stayAt,
  type Look, type OwlPlace, type Point, type Ripple, type SceneLayout, type WatcherOwlState,
} from '@w/nightScene'
import { NightScenePainter } from './painterLook'
import { OwlFamily, type OwlMood, type ThreadOwlPose, type WatchedOwl } from '@w/owlFamily'
import { NIGHT_WOOD } from '@w/placeNightWood'
import type { ScenePlace } from '@w/scenePlace'
import { SCENE_PLACES } from '@w/scenePlaces'
import { makeAmbience, riverPath } from './ambience'
import { activity, EVENTS, fast, fidgetOf, has, LIFE, LOOK, threadOf, working, type Happening, type Thread } from './life'
import { runStage, type SceneCtx } from './stage'

export interface Life { stop(): void; kick(): void; relook(): void; room(kind: string): void; play(kind: string): void }

const SEED: ReadonlyArray<readonly [string, string, Thread['state'], Thread['ask']]> = [
  ['crash-sim', 'Crash Sim', 'working', null], ['samurai-ep3', 'Samurai Ep 3', 'working', null], ['design-climb', 'Design climb', 'working', null],
  ['visual-gate', 'Visual gate flake', 'waiting', 'permission'], ['footer-links', 'Footer links', 'resting', null], ['weekly-note', 'Weekly note', 'resting', null],
  ['wav-stall', 'Streaming WAV stall', 'failed', null], ['inside-parts', 'Inside parts', 'working', null], ['grok-previews', 'Grok voice previews', 'resting', null],
  ['arena', 'Arena background', 'resting', null],
]
const NEW_NAMES = ['Fire fix', 'Round 16 scores', 'Record the sound', 'Tray icon', 'Release notes', 'Host pairing']
/** What the pretend room does by itself, in turn. */
const ROOM_SCRIPT = ['finish', 'wake', 'ask', 'answer', 'start', 'fail', 'merge', 'retry'] as const
/** Seconds between things, at the pace for showing them and at the pace they would have in the app. */
const PACE = { demo: { round: 11, event: 13, shoot: 9, room: 8, gust: 9 }, real: { round: 50, event: 90, shoot: 45, room: 35, gust: 16 } } as const
/** Where a press is a control's and sends out no ripple (WatcherNightScene.tsx). */
const NOT_BACKGROUND = [
  'button', 'a', 'input', 'textarea', 'select', 'label', 'summary', 'dialog', '[contenteditable]',
  ...['button', 'tab', 'link', 'menuitem', 'option', 'combobox', 'textbox', 'dialog', 'menu', 'listbox', 'checkbox', 'radio', 'switch', 'slider'].map(role => `[role="${role}"]`),
  '.thread-workspace__compose', '.watcher-head', '.watcher-glance',
].join(', ')

const moodOf = (thread: Thread): OwlMood => thread.state === 'working' ? 'awake' : thread.state === 'waiting' ? 'waiting' : 'asleep'
const watched = (): WatchedOwl[] => LIFE.threads.map(thread => ({ key: thread.key, title: thread.title, threadId: null, mood: moodOf(thread) }))

export function startLife(ctx: SceneCtx): Life {
  const { pane } = ctx
  const painter = new NightScenePainter(ctx.back, ctx.front)
  // The moon's halo: a soft wash of the accent under the landscape, in the moon's own margin only.
  const halo = document.createElement('div')
  halo.setAttribute('aria-hidden', 'true')
  halo.style.cssText = 'position:absolute;z-index:-1;pointer-events:none;display:none'
  ctx.back.before(halo)
  const setHalo = (): void => {
    const g = layout
    if (!LOOK.halo || g === null || g.mode !== 'trees') { halo.style.display = 'none'; return }
    const left = g.column.right + 8, reach = g.moon.r * 3.8
    halo.style.display = 'block'
    halo.style.left = `${left}px`; halo.style.top = `${g.header}px`; halo.style.width = `${Math.max(0, g.width - left)}px`; halo.style.height = `${Math.max(0, g.moon.y + reach - g.header)}px`
    halo.style.background = `radial-gradient(circle ${reach}px at ${g.moon.x - left}px ${g.moon.y - g.header}px, color-mix(in srgb, var(--tt-accent) 24%, transparent) 0, color-mix(in srgb, var(--tt-accent) 10%, transparent) 38%, transparent 100%)`
  }
  // The night wood, with what the prototype adds drawn through the hook a place has for what moves in it.
  ;(SCENE_PLACES as Record<string, ScenePlace>)['night-wood'] = { ...NIGHT_WOOD, ambience: layout => makeAmbience(layout, painter) }
  const still = ctx.reduced
  LIFE.still = still
  LIFE.threads = SEED.map(([key, title, state, ask]) => ({ key, title, state, ask }))
  LIFE.acts.clear(); LIFE.happenings = []; LIFE.poses = []; LIFE.pointer = null

  let layout: SceneLayout | null = null
  let family: OwlFamily | null = null
  let watcher: WatcherOwlState = { at: 'home', side: 'left', flight: null, next: 0 }
  let ripples: Ripple[] = []
  let look: Look | null = null
  let gazeFrom: number | null = null
  let hoverKey: string | null = null
  let lastT = 0
  /** Where Watcher's owl sits in place of its visiting perch, while it is on the ground after a dive. */
  let perch: Point | null = null
  /** What Watcher's owl is looking at because of a call or a miss. */
  let callWatch: { at: Point; since: number; until: number } | null = null
  let round: { key: string; stage: 'fly' | 'call' | 'reply' | 'done'; at: number; flown: boolean; dur: number } | null = null
  let hunt: { stage: 'mouse' | 'dive' | 'sit' | 'return'; at: number; mouse: Happening } | null = null
  let roundIndex = 0, eventIndex = 0, scriptIndex = 0, made = 0
  let later: Array<{ at: number; run: () => void }> = []
  const next = { gust: 1.2, shoot: 4, event: 2.5, round: 5, room: 7, fox: 4 }
  const cost = { frames: 0, painted: 0, ms: 0 }
  ;(window as unknown as { protoCost: unknown }).protoCost = cost

  const say = (words: string): void => LIFE.say(words)
  const act = (key: string, kind: 'hop' | 'happy' | 'wake' | 'lookup', dur: number, t0 = lastT): void => { LIFE.acts.set(key, { kind, t0, dur }) }
  const owlLayout = (): SceneLayout => perch !== null && layout !== null ? { ...layout, visit: perch } : layout!
  const poseOf = (key: string): ThreadOwlPose | undefined => LIFE.poses.find(pose => pose.owl.key === key && !pose.flying)

  /** The room's threads as they are now: newcomers come out of the moon, the gone fly back into it. */
  const takeOwls = (t: number): void => {
    if (family === null || layout === null) return
    for (const at of family.update(watched(), t, still ? 'still' : layout.mode === 'trees' ? 'fly' : 'fade')) ripples = addRipple(ripples, { x: layout.moon.x, y: layout.moon.y, t: at })
  }

  // ---------- What can happen ----------
  const meteorSpec = (rightward: boolean): Record<string, number> => {
    const g = layout!, W = g.width, speed = 560 + 160 * Math.random(), life = 0.55 + 0.3 * Math.random(), run = speed * life * 0.9
    // Three in four fall over a margin, where they show at full strength; the rest cross behind the conversation's words.
    const roll = Math.random(), from = roll < 0.375 ? 0 : roll < 0.75 ? g.column.right : g.column.left, to = roll < 0.375 ? g.column.left : roll < 0.75 ? W : g.column.right
    const room = Math.max(0, to - from - run), start = from + Math.random() * room
    // High in the sky and falling shallow, so most of each streak is over open sky above the crowns.
    return { x0: rightward ? start : start + run, y0: g.header + 12 + g.sky * 0.16 * Math.random(), dx: rightward ? 0.95 : -0.95, dy: 0.3, speed, life }
  }
  const gust = (t: number): void => {
    const g = layout!, tree = g.left
    const leaves = Array.from({ length: 9 }, () => { const x = tree.x + (Math.random() - 0.3) * tree.h * 0.3; return { x, y: tree.y - tree.h * (0.62 + Math.random() * 0.3), delay: (x + 220) / 320 + Math.random() * 0.5, ph: Math.random() * 6 } })
    LIFE.happenings.push({ kind: 'gust', t0: t, dur: (g.width + 700) / 320 + 3, strength: 0.75 + 0.25 * Math.random(), leaves })
  }
  const startRound = (t: number, key?: string): boolean => {
    if (round !== null || hunt !== null || layout === null || layout.mode !== 'trees' || still) return false
    const perched = LIFE.poses.filter(pose => !pose.flying && pose.alpha > 0.9)
    let target = key === undefined ? undefined : perched.find(pose => pose.owl.key === key)
    if (target === undefined) {
      const awake = perched.filter(pose => pose.owl.mood === 'awake')
      if (awake.length === 0) return false
      target = awake[roundIndex++ % awake.length]!
    }
    round = { key: target.owl.key, stage: 'fly', at: t, flown: false, dur: 1 }
    return true
  }
  const startHunt = (t: number): boolean => {
    if (hunt !== null || round !== null || watcher.flight !== null || watcher.at !== 'home' || layout === null) return false
    const g = layout, x0 = g.left.x + 46 * g.s, x1 = Math.min(g.column.left - 70, x0 + 110)
    if (x1 - x0 < 40) return false
    const mouse: Happening = { kind: 'mouse', t0: t, dur: 40, x0, x1, run: 2.4, boltAt: null }
    LIFE.happenings.push(mouse)
    hunt = { stage: 'mouse', at: t + 1.5, mouse }
    say('A mouse in the grass under Watcher’s tree')
    return true
  }
  /** Starts one thing now. False when it cannot start, such as a hunt while the owl is away from home. */
  const play = (kind: string, t = lastT, burstFrom: Point | null = null, quiet = false): boolean => {
    const tell = (words: string): void => { if (!quiet) say(words) }
    if (layout === null || layout.mode !== 'trees' || still) return false
    const g = layout, W = g.width
    if (kind === 'star') { LIFE.happenings.push({ kind: 'star', t0: t, dur: 1.3, ...meteorSpec(Math.random() < 0.5) }); return true }
    if (kind === 'gust') { gust(t); return true }
    if (kind === 'round') return startRound(t)
    if (kind === 'hunt') return startHunt(t)
    if (kind === 'meteors') {
      const rightward = Math.random() < 0.5
      LIFE.happenings.push({ kind: 'meteors', t0: t, dur: 4.6, list: Array.from({ length: 10 }, (_, k) => ({ at: k * 0.3 + Math.random() * 0.2, ...meteorSpec(rightward) })) })
      tell('A meteor shower')
    } else if (kind === 'bats') {
      const bats = Array.from({ length: 7 }, (_, k) => ({ dx: k * 30 + Math.random() * 18, y: g.moon.y - 34 + Math.random() * 78, ph: Math.random() * 6, vx: -(70 + Math.random() * 150), vy: -(40 + Math.random() * 70) }))
      LIFE.happenings.push({ kind: 'bats', t0: t, dur: burstFrom === null ? (W + 320) / 150 : 5, bats, from: burstFrom })
      tell(burstFrom === null ? 'Bats cross the moon' : 'Bats scatter from the bare tree')
    } else if (kind === 'fox') {
      LIFE.happenings.push({ kind: 'fox', t0: t, dur: (W + 170) / 95 + 2.2, stopX: g.column.left * 0.62 })
      tell('A fox crosses the wood')
    } else if (kind === 'fish') {
      // Where the river runs open between the far hills and the near field; lower down Watcher's tree stands in front of it.
      const p = riverPath(g).at(0.4)
      LIFE.happenings.push({ kind: 'fish', t0: t, dur: 2.1, x: p.x, y: p.y })
      tell('A fish jumps in the river')
    } else if (kind === 'cloud') {
      const r = g.moon.r
      LIFE.happenings.push({ kind: 'cloud', t0: t, dur: (r * 6.4 + 160) / 22, x0: g.moon.x + r * 3.2 + 80, y: g.moon.y - r * 0.1, rx: r * 2.3, ry: r * 0.85 })
      tell('A cloud crosses the moon')
    } else return false
    return true
  }
  const celebrate = (thread: Thread, t: number): void => {
    const pose = poseOf(thread.key)
    if (!has('sparkle') || pose === undefined || still) return
    LIFE.happenings.push({ kind: 'sparkle', t0: t, dur: 1.2, x: pose.x, y: pose.y, spin: Math.random() * 6 })
    act(thread.key, 'happy', 2.6, t)
  }

  /** Something changes in the pretend room. */
  const room = (kind: string, t = lastT): void => {
    const pick = (state: Thread['state']): Thread | undefined => { const list = LIFE.threads.filter(thread => thread.state === state); return list[Math.floor(Math.random() * list.length)] }
    const mirror = has('mirror')
    if (kind === 'start') {
      if (LIFE.threads.length >= 14) { room('wake', t); return }
      const title = NEW_NAMES[made++ % NEW_NAMES.length]!
      LIFE.threads.push({ key: `new-${made}`, title, state: 'working', ask: null })
      const gusty = mirror && has('wind') && layout !== null && !still
      say(`${title} starts: its owl comes out of the moon${gusty ? ', and the wind picks up' : ''}`)
      if (gusty) gust(t)
    } else if (kind === 'wake' || kind === 'retry') {
      const thread = pick(kind === 'wake' ? 'resting' : 'failed')
      if (thread === undefined) return
      thread.state = 'working'
      act(thread.key, 'wake', 1.5, t)
      say(kind === 'wake' ? `${thread.title} starts working again` : `${thread.title} is tried again`)
    } else if (kind === 'finish') {
      const thread = pick('working')
      if (thread === undefined) return
      const star = mirror && has('shooting') && play('star', t + 0.4)
      say(`${thread.title} finished its turn${has('sparkle') ? ': sparks, a happy owl' : ''}${star ? ', a shooting star' : ''}`)
      celebrate(thread, t)
      // It stays bright while it celebrates, then goes to sleep.
      if (has('sparkle') && !still) { later.push({ at: t + 2.6, run: () => { thread.state = 'resting'; takeOwls(lastT) } }); return }
      thread.state = 'resting'
    } else if (kind === 'ask') {
      const thread = pick('working')
      if (thread === undefined) return
      thread.state = 'waiting'; thread.ask = Math.random() < 0.5 ? 'question' : 'permission'
      say(`${thread.title} ${thread.ask === 'question' ? 'asks you a question' : 'asks for a permission'}${has('wave') ? ': its owl waves' : ''}`)
      if (mirror && has('rounds')) later.push({ at: t + 1.6, run: () => { startRound(lastT, thread.key) } })
    } else if (kind === 'answer') {
      const thread = pick('waiting')
      if (thread === undefined) return
      thread.state = 'working'; thread.ask = null
      act(thread.key, 'happy', 1.6, t)
      say(`You answered ${thread.title}`)
    } else if (kind === 'fail') {
      const thread = pick('working')
      if (thread === undefined) return
      thread.state = 'failed'
      const bats = mirror && has('bats') && layout !== null && play('bats', t, { x: layout.right.x - layout.right.h * 0.1, y: layout.right.y - layout.right.h * 0.7 }, true)
      say(`${thread.title}: its last turn failed${has('fidget') ? ', its owl winces' : ''}${bats ? ', bats scatter from the bare tree' : ''}`)
    } else if (kind === 'merge') {
      const thread = pick('working') ?? pick('resting')
      if (thread === undefined) return
      LIFE.threads = LIFE.threads.filter(other => other !== thread)
      const shower = mirror && has('meteors') && play('meteors', t + 0.7, null, true)
      say(`${thread.title}’s pull request merged: its owl flies home to the moon${shower ? ' under a meteor shower' : ''}`)
    } else return
    takeOwls(t)
    stage.wake()
  }

  // ---------- Between frames ----------
  const stepRound = (t: number): void => {
    if (round === null || layout === null) return
    const pose = poseOf(round.key), thread = threadOf(round.key)
    if (pose === undefined || thread === undefined) { round = null; return }
    const want: OwlPlace = pose.x < layout.column.left ? 'home' : 'tree'
    if (round.stage === 'fly') {
      if (watcher.flight !== null) return
      if (watcher.at !== want && !round.flown && perch === null) {
        watcher = { ...watcher, flight: planFlight(layout, watcher, want, t, false) }
        round.flown = true
        say(`Watcher checks ${thread.title}: its owl flies over`)
        return
      }
      if (!round.flown) say(`Watcher checks ${thread.title}`)
      round.stage = 'call'; round.at = t + 0.45
    } else if (round.stage === 'call' && t >= round.at) {
      const owl = LIFE.watcher
      if (owl === null) { round = null; return }
      const from = { x: owl.x, y: owl.y - 50 * owl.s }, to = { x: pose.x, y: pose.y - 34 }
      round.dur = clamp(Math.hypot(to.x - from.x, to.y - from.y) / 300, 0.7, 1.5)
      LIFE.happenings.push({ kind: 'note', t0: t, dur: round.dur, from, to, lift: 50, accent: true })
      callWatch = { at: to, since: t, until: t + round.dur * 2 + 1.4 }
      act(round.key, 'lookup', round.dur, t)
      round.stage = 'reply'; round.at = t + round.dur
    } else if (round.stage === 'reply' && t >= round.at) {
      const owl = LIFE.watcher
      act(round.key, 'happy', 2, t)
      if (owl !== null) LIFE.happenings.push({ kind: 'note', t0: t + 0.25, dur: round.dur, from: { x: pose.x, y: pose.y - 34 }, to: { x: owl.x, y: owl.y - 50 * owl.s }, lift: 50, accent: false })
      round.stage = 'done'; round.at = t + round.dur + 0.9
    } else if (round.stage === 'done' && t >= round.at) {
      round = null
      watcher = { ...watcher, next: Math.max(watcher.next, t + 5) }
    }
  }
  const stepHunt = (t: number): void => {
    if (hunt === null || layout === null) return
    const mouse = hunt.mouse
    if (hunt.stage === 'mouse' && t >= hunt.at) {
      perch = { x: mouse.x1 - 6, y: groundAt(layout, mouse.x1 - 6) }
      watcher = { ...watcher, flight: planFlight(owlLayout(), watcher, 'tree', t, false) }
      hunt.stage = 'dive'
      say('Watcher’s owl dives for it')
    } else if (hunt.stage === 'dive') {
      const flight = watcher.flight
      if (flight !== null && mouse.boltAt === null && t >= flight.t0 + flight.dur - 0.8) { mouse.boltAt = t; mouse.until = t + 1.3 }
      if (flight === null && perch !== null) {
        hunt.stage = 'sit'; hunt.at = t + 2.6
        callWatch = { at: { x: perch.x + 320, y: perch.y - 30 }, since: t, until: t + 1.9 }
        say('The mouse got away')
      }
    } else if (hunt.stage === 'sit' && t >= hunt.at) {
      watcher = { ...watcher, flight: planFlight(owlLayout(), watcher, 'home', t, false) }
      hunt.stage = 'return'
    } else if (hunt.stage === 'return' && watcher.flight === null) { perch = null; hunt = null }
  }
  /** Watcher's owl: a finished flight lands, and with no rounds to fly, a due one sets off at random as it does today. */
  const stepWatcher = (t: number): void => {
    if (layout === null || layout.mode !== 'trees' || still) return
    const flight = watcher.flight
    if (flight !== null && t >= flight.t0 + flight.dur) watcher = { at: flight.to, side: flight.side, flight: null, next: t + stayAt(flight.to, Math.random()) * (LIFE.pace === 'demo' ? 0.3 : 1) }
    if (watcher.flight === null && t >= watcher.next && !has('rounds') && hunt === null && round === null && perch === null) {
      watcher = { ...watcher, flight: planFlight(layout, watcher, nextPlace(watcher.at, Math.random(), layout.lane === null), t, false) }
    }
  }
  /** Starts whatever is due. */
  const direct = (t: number): void => {
    LIFE.happenings = LIFE.happenings.filter(h => t <= h.t0 + h.dur + 0.5 && (h.until === undefined || t <= h.until))
    for (const [key, doing] of LIFE.acts) if (t > doing.t0 + doing.dur) LIFE.acts.delete(key)
    if (callWatch !== null && t > callWatch.until) callWatch = null
    const due = later.filter(item => t >= item.at)
    if (due.length > 0) { later = later.filter(item => t < item.at); for (const item of due) item.run() }
    if (still || layout === null || layout.mode !== 'trees') return
    const pace = PACE[LIFE.pace], mirror = has('mirror'), jitter = (): number => 0.7 + 0.6 * Math.random()
    if (LIFE.autoRoom && t >= next.room) { room(ROOM_SCRIPT[scriptIndex++ % ROOM_SCRIPT.length]!, t); next.room = t + pace.room }
    // The wind follows how busy the room is when the wood mirrors it; otherwise it keeps its own time.
    if (has('wind') && t >= next.gust) { gust(t); next.gust = t + (mirror ? 26 - 20 * activity() : pace.gust) * jitter() }
    if (has('shooting') && !mirror && t >= next.shoot) { play('star', t); next.shoot = t + pace.shoot * jitter() }
    if (has('rounds') && t >= next.round) { startRound(t); next.round = t + pace.round * jitter() }
    if (!mirror && t >= next.event) {
      const kinds = EVENTS.filter(has)
      for (let tries = 0; tries < kinds.length; tries++) if (play(kinds[eventIndex++ % kinds.length]!, t)) break
      next.event = t + pace.event
    }
    // Mirroring the room, the fox comes out only when nothing is working.
    if (mirror && has('fox') && working() === 0 && t >= next.fox) { play('fox', t); next.fox = t + 45 }
    stepRound(t)
    stepHunt(t)
  }
  /** A thread owl a row higher for a moment: a hop. */
  const lifted = (pose: ThreadOwlPose, t: number): ThreadOwlPose => {
    if (pose.flying || still || LIFE.flags.size === 0) return pose
    const doing = LIFE.acts.get(pose.owl.key)
    let up = false
    if (doing !== undefined && t >= doing.t0 && t < doing.t0 + doing.dur) up = doing.kind === 'hop' || (doing.kind === 'happy' && Math.floor((t - doing.t0) * 4) % 4 === 1)
    else if (pose.owl.mood === 'waiting') up = has('wave') && Math.floor(t * 3) % 12 === 6
    else if (pose.owl.mood === 'awake' && has('fidget') && !LIFE.watcherFlying) { const fidget = fidgetOf(pose.owl.order, t); up = fidget.roll === 6 && fidget.into < 0.28 }
    return up ? { ...pose, y: pose.y - CELL.h } : pose
  }

  const stage = runStage(ctx, {
    layout(measure, dpr) {
      const laid = painter.resize(measure, dpr)
      if (laid === null) { layout = null; return false }
      layout = laid
      setHalo()
      // A new layout ends every flight where it was going, and whatever was under way with it.
      if (watcher.flight !== null) watcher = { at: watcher.flight.to, side: watcher.flight.side, flight: null, next: watcher.next }
      if (laid.mode !== 'trees' || perch !== null) watcher = { at: 'home', side: 'left', flight: null, next: watcher.next }
      perch = null; hunt = null; round = null; callWatch = null; ripples = []
      LIFE.happenings = LIFE.happenings.filter(h => h.kind === 'gust')
      if (watcher.next === 0) watcher = { ...watcher, next: lastT + stayAt('home', Math.random()) * 0.25 }
      if (family === null) { family = new OwlFamily(laid); family.update(watched(), lastT, 'still') } else { family.relayout(laid, lastT); takeOwls(lastT) }
      return true
    },
    ink(inks) { painter.setInk(inks.scene, inks.font) },
    frame(t) {
      lastT = t; LIFE.now = t
      if (layout === null || family === null || !painter.ready) return null
      const began = performance.now()
      family.step(t)
      direct(t)
      stepWatcher(t)
      ripples = liveRipples(ripples, t, still)
      const trees = layout.mode === 'trees'
      // Its eyes follow the pointer while it moves in a margin, and let go a moment after it stops.
      if (has('gaze') && !still && trees && LIFE.pointer !== null) {
        const pointer = LIFE.pointer
        if (t - pointer.t < 1 && inMargin(layout, pointer.x) && pointer.y > layout.header) { gazeFrom ??= t; look = { x: pointer.x, y: pointer.y, t: Math.max(gazeFrom, t - 0.8) } }
        else gazeFrom = null
      }
      const watch = callWatch !== null ? { at: callWatch.at, since: callWatch.since } : family.newcomer(t)
      const owlNow = trees ? owlAt(t, owlLayout(), watcher, { still, look, watch }) : null
      LIFE.watcher = owlNow?.pose ?? null
      LIFE.watcherFlying = owlNow?.stage === 'flying'
      const poses = family.poses(t).map(pose => lifted(pose, t))
      LIFE.poses = poses
      const marker = family.marker, count = family.pileCount
      const painted = painter.draw({ t, still, ripples, watcher: owlNow, watcherGlows: LIFE.threads.some(thread => thread.state === 'waiting'), owls: poses, whirl: family.whirl(t), pile: marker !== null && count > 0 ? { spot: marker, count } : null })
      // What the scene costs, for the prototype's builder to read: frames run, frames painted, and the time they took.
      cost.frames++; cost.ms += performance.now() - began
      if (painted) cost.painted++
      const looking = look !== null && t - look.t < 1.8
      return frameDelay(family.moving(t) || owlNow?.stage === 'flying' || looking || fast(t), ripples.length, still)
    },
  })

  // ---------- The pointer ----------
  const inPane = (event: PointerEvent): Point => { const base = pane.getBoundingClientRect(); return { x: event.clientX - base.left, y: event.clientY - base.top + pane.scrollTop } }
  const owlUnder = (p: Point): ThreadOwlPose | undefined => LIFE.poses.find(pose => !pose.flying && Math.abs(p.x - pose.x) < 22 && p.y > pose.y - 42 && p.y < pose.y + 6)
  const move = (event: PointerEvent): void => {
    const p = inPane(event)
    LIFE.pointer = { ...p, t: stage.clock() }
    if (!has('gaze') || still) return
    const key = owlUnder(p)?.owl.key ?? null
    if (key !== hoverKey) { hoverKey = key; if (key !== null && !LIFE.acts.has(key)) act(key, 'hop', 0.3, stage.clock()) }
    stage.wake()
  }
  const press = (event: PointerEvent): void => {
    if (event.button !== 0 || layout === null || layout.mode !== 'trees') return
    if (!(event.target instanceof Element) || event.target.closest(NOT_BACKGROUND) !== null) return
    const p = inPane(event), t = stage.clock()
    if (!inMargin(layout, p.x) || p.y < layout.header) return
    const owl = owlUnder(p)
    if (owl !== undefined && has('gaze') && !still && LIFE.watcher !== null) {
      // A press on a thread owl: it calls to Watcher's owl, which turns to it. In the app the press opens the thread.
      act(owl.owl.key, 'happy', 1.8, t)
      LIFE.happenings.push({ kind: 'note', t0: t, dur: 1, from: { x: owl.x, y: owl.y - 34 }, to: { x: LIFE.watcher.x, y: LIFE.watcher.y - 50 * LIFE.watcher.s }, lift: 50, accent: true })
      callWatch = { at: { x: owl.x, y: owl.y - 30 }, since: t, until: t + 2.4 }
      say(`${owl.owl.title}’s owl calls to Watcher`)
    } else {
      // A press in the open margin sends out a ripple, and Watcher's owl looks toward it, as today.
      ripples = addRipple(liveRipples(ripples, t, still), { x: p.x, y: p.y, t })
      look = { x: p.x, y: p.y, t }; gazeFrom = null
    }
    stage.wake()
  }
  pane.addEventListener('pointermove', move)
  pane.addEventListener('pointerdown', press)

  return {
    stop() { stage.stop(); halo.remove(); pane.removeEventListener('pointermove', move); pane.removeEventListener('pointerdown', press) },
    /** How the scene is drawn changed: the landscape is worked out and drawn again in this frame. */
    relook() { painter.relook(); setHalo(); stage.wake() },
    /** The choices changed: whatever is now switched on starts soon, and the picture is drawn again even while it holds still. */
    kick() {
      const t = stage.clock()
      next.gust = Math.min(next.gust, t + 0.8); next.shoot = Math.min(next.shoot, t + 3); next.event = Math.min(next.event, t + 2)
      next.round = Math.min(next.round, t + 4); next.room = Math.min(next.room, t + 6); next.fox = Math.min(next.fox, t + 3)
      ;(painter as unknown as { painted: string }).painted = ''
      stage.wake()
    },
    room(kind) { room(kind, stage.clock()) },
    play(kind) { if (!play(kind, stage.clock()) && kind === 'hunt') say('The owl hunts only from its own branch; try again when it is home'); stage.wake() },
  }
}
