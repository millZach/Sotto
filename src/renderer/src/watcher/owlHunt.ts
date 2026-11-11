import { planFlight, type Point, type SceneLayout, type WatcherOwlState } from './nightScene'

/**
 * Watcher's owl's dive for a mouse, one of the night wood's animals while nothing works (ADR-0199, decision 10): a mouse
 * comes out under Watcher's tree, the owl dives from its branch to the ground where the mouse stops, the mouse bolts a
 * moment before it lands, the owl sits there looking after it, and flies home. An owl that sits in the other tree, where
 * its last call left it, flies home first. Nothing here touches the DOM or a canvas: the scene gives it the owl as it
 * stands and takes back the owl as it should be.
 *
 * While the owl is on the ground, or on its way there or back, the place it sits in stands in for its perch in the
 * other tree (`layoutFor`), so the scene's own flights and poses carry it. Whatever ends a hunt early must end it
 * through `end`, which sends such an owl home: left where it is, it would be drawn at the other tree's real perch.
 */

/** What the hunt asks of the wood: a mouse, and that it bolt. */
export interface HuntWood {
  /** A mouse comes out under Watcher's tree. Returns where it stops, or null where the margin has no room for it. */
  mouse(t: number): Point | null
  bolt(t: number): void
}

/**
 * Whether a hunt began: `started`, with the owl flying home first or the mouse out; `later` when the owl is in the air
 * or a call is under way or waiting, so the hunt keeps its turn; `never` where this layout has no room for a mouse.
 */
export type HuntStart = 'started' | 'later' | 'never'

/** What the owl looks at for a moment: where the mouse went. */
export interface HuntLook { readonly at: Point; readonly since: number; readonly until: number }

/** How long the mouse is out before the owl dives, how long before landing it bolts, and how long the owl sits after, in seconds. */
const MOUSE_LEAD = 1.5, BOLT_BEFORE = 0.8, SIT = 2.6

export class OwlHunt {
  private stage: 'homing' | 'mouse' | 'dive' | 'sit' | 'back' | null = null
  private at = 0
  /** Where the owl sits on the ground, from the moment the mouse is out until the owl is home again. */
  private ground: Point | null = null

  /** Whether a hunt is under way, the flight home before it included. */
  get under(): boolean {
    return this.stage !== null
  }

  /** The layout Watcher's owl flies and sits by: its perch in the other tree is the place on the ground while there is one. */
  layoutFor(layout: SceneLayout): SceneLayout {
    return this.ground === null ? layout : { ...layout, visit: this.ground }
  }

  /**
   * The hunt's turn has come. `free` says no call is under way or waiting. An owl at home gets its mouse at once; one
   * sitting elsewhere flies home first; one in the air, or busy with a call, hunts later.
   */
  start(t: number, layout: SceneLayout, watcher: WatcherOwlState, wood: HuntWood, free: boolean): { readonly outcome: HuntStart; readonly watcher: WatcherOwlState } {
    if (this.stage !== null || !free || watcher.flight !== null) return { outcome: 'later', watcher }
    if (watcher.at !== 'home') {
      this.stage = 'homing'
      return { outcome: 'started', watcher: { ...watcher, flight: planFlight(layout, watcher, 'home', t, false) } }
    }
    return { outcome: this.mouseOut(t, wood) ? 'started' : 'never', watcher }
  }

  private mouseOut(t: number, wood: HuntWood): boolean {
    this.ground = wood.mouse(t)
    this.stage = this.ground === null ? null : 'mouse'
    this.at = t + MOUSE_LEAD
    return this.ground !== null
  }

  /**
   * Moves the hunt on at `t`, given the owl as the scene has it, a finished flight already landed. Returns the owl as
   * it should be now, and where it looks when it has just landed on where the mouse was.
   */
  step(t: number, layout: SceneLayout, watcher: WatcherOwlState, wood: HuntWood): { readonly watcher: WatcherOwlState; readonly look: HuntLook | null } {
    if (this.stage === 'homing') {
      if (watcher.flight === null) this.mouseOut(t, wood)
    } else if (this.stage === 'mouse' && t >= this.at) {
      this.stage = 'dive'
      return { watcher: { ...watcher, flight: planFlight(this.layoutFor(layout), watcher, 'tree', t, false) }, look: null }
    } else if (this.stage === 'dive') {
      const flight = watcher.flight
      if (flight !== null && t >= flight.t0 + flight.dur - BOLT_BEFORE) wood.bolt(t)
      if (flight === null && this.ground !== null) {
        this.stage = 'sit'; this.at = t + SIT
        return { watcher, look: { at: { x: this.ground.x + 320, y: this.ground.y - 30 }, since: t, until: t + 1.9 } }
      }
    } else if (this.stage === 'sit' && t >= this.at) {
      this.stage = 'back'
      return { watcher: { ...watcher, flight: planFlight(this.layoutFor(layout), watcher, 'home', t, false) }, look: null }
    } else if (this.stage === 'back' && watcher.flight === null) {
      this.stage = null; this.ground = null
    }
    return { watcher, look: null }
  }

  /**
   * Ends the hunt at once: the layout, the place or the living scene changed, or motion was reduced. An owl on the
   * ground, or flying there or back, is home in that same moment, since its place on the ground is gone with the hunt.
   * An owl only flying home before a hunt keeps its flight. Returns the owl as it should be now.
   */
  end(watcher: WatcherOwlState): WatcherOwlState {
    const grounded = this.ground !== null
    this.stage = null; this.ground = null
    return grounded ? { at: 'home', side: 'left', flight: null, next: watcher.next } : watcher
  }
}
