// What the menu bar owl does, frame by frame (ADR-0114). Plain JavaScript, so scripts/generate-tray-owl.mjs reads it as the
// app does: the generator draws one image for every pose `allOwlPoses()` lists, and the schedule in schedule.ts only ever
// shows poses from that list, so the app never needs a frame the generator did not draw. The numbers are the approved
// prototype's (docs/prototypes/menubar-owl-prototype.html, variant A).

/** The icon's canvas in points. The frames are drawn at 1x and shown pixel-doubled. */
export const OWL_WIDTH = 27
export const OWL_HEIGHT = 22

/** A frame lasts 80 ms, the 12.5 a second every Sotto sprite shares; a few hold longer (`ms`). */
export const OWL_FRAME_MS = 80

/**
 * Everything the drawing needs. `lx`, `ly`: where the eyes look, -1 to 1. `lid`: 0 open, 0.5 half, 1 shut. `glow`: 0 dim,
 * 1 resting, 2 flared. `th`, `thR`: the wings' angle in degrees (-100 folded, 60 raised); `thR` is the right wing when it
 * differs, else null. `r`: the wings' length. `lift`, `sq`, `tilt`: the body's hop in points, squash and lean in degrees.
 * `sm`: the faint blur copy of a wing on a fast stroke, in degrees behind it, 0 for none.
 */
export const REST_POSE = Object.freeze({ lx: 0, ly: 0, lid: 0, glow: 1, th: -100, thR: null, r: 5, lift: 0, sq: 1, tilt: 0, sm: 0 })

const pose = patch => Object.freeze({ ...REST_POSE, ...patch })

/** Where the owl can rest its eyes, as [lx, ly]. */
export const LOOK_TARGETS = Object.freeze([[-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 0], [0, 1]].map(look => Object.freeze(look)))
/** The same, as the schedule draws from them: sideways looks come up twice as often. */
export const LOOK_CHOICES = Object.freeze([[-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 0], [0, 1], [-1, 0], [1, 0]].map(look => Object.freeze(look)))

const flapFrame = (th, r, lift, sq, glow, extra) => ({ th, r, lift, sq, glow, ...extra })
const FLAP_ROWS = {
  flap: [flapFrame(-100, 5, 0, 0.97, 2), flapFrame(-72, 6.2, 0, 0.93, 2, { tilt: -1 }), flapFrame(8, 8, 0.4, 1.04, 2), flapFrame(58, 7.2, 1, 1.05, 2, { tilt: 1.2 }), flapFrame(16, 8, 1.1, 1.03, 2), flapFrame(-30, 7, 0.8, 1, 2, { tilt: -1.2 }), flapFrame(24, 7.8, 1.1, 1.04, 2), flapFrame(60, 7.1, 1.1, 1.05, 2, { tilt: 1.2 }), flapFrame(10, 8, 0.8, 1.02, 2), flapFrame(-38, 6.8, 0.3, 0.99, 2, { tilt: -0.8 }), flapFrame(-84, 5.6, 0, 0.96, 1, { lid: 0.5 }), flapFrame(-106, 4.8, 0, 1.02, 1, { lid: 1 }), flapFrame(-100, 5, 0, 1, 1, { lid: 0.5 })],
  flutter: [flapFrame(-100, 5, 0, 0.97, 2), flapFrame(-60, 6.6, 0, 0.94, 2), flapFrame(40, 7.8, 0.8, 1.05, 2, { thR: 30 }), flapFrame(-6, 7.8, 0.6, 1.02, 2, { thR: 6 }), flapFrame(46, 7.6, 1, 1.05, 2, { thR: 34, tilt: 1 }), flapFrame(-18, 7.2, 0.3, 1, 2, { thR: -8, tilt: -1 }), flapFrame(-88, 5.4, 0, 0.97, 1, { lid: 0.5 }), flapFrame(-104, 4.8, 0, 1.02, 1, { lid: 1 }), flapFrame(-100, 5, 0, 1, 1, { lid: 0.5 })],
  stretch: [flapFrame(-100, 5, 0, 0.96, 2), flapFrame(-66, 6.8, 0, 0.94, 2), flapFrame(-24, 7.8, 0.2, 1.02, 2), flapFrame(12, 8.2, 0.6, 1.04, 2, { d: 120 }), flapFrame(30, 8.2, 0.8, 1.05, 2, { d: 260 }), flapFrame(24, 8.2, 0.8, 1.05, 2, { d: 90, tilt: 0.8 }), flapFrame(34, 8.2, 0.8, 1.05, 2, { d: 90, tilt: -0.8 }), flapFrame(20, 8.2, 0.6, 1.04, 2, { d: 200 }), flapFrame(-20, 7.4, 0.2, 1.01, 2), flapFrame(-70, 6, 0, 0.96, 2), flapFrame(-106, 4.8, 0, 1.02, 1, { lid: 0.5 }), flapFrame(-100, 5, 0, 1, 1, { lid: 1 }), flapFrame(-100, 5, 0, 1, 1, { lid: 0.5 })],
}

/**
 * The three ways the owl flaps, as `{ pose, ms }` steps: each pose shows for `ms`, and the next comes `ms` after it starts. A stroke of 34
 * degrees or more, to a wing that is not folded, carries a faint blur copy (`sm`). After the last step the schedule
 * returns to `REST_POSE`.
 */
export const FLAP_SEQUENCES = Object.freeze(Object.fromEntries(Object.entries(FLAP_ROWS).map(([name, rows]) => [name, Object.freeze(rows.map((row, i) => {
  const { d, ...rest } = row
  const delta = rest.th - (i > 0 ? rows[i - 1].th : -100)
  const sm = Math.abs(delta) >= 34 && rest.th > -45 ? Math.round(-delta / 2) : 0
  return Object.freeze({ pose: pose({ thR: null, ...rest, sm }), ms: d ?? OWL_FRAME_MS })
}))])))

/** The pose that rests its eyes on `look`: its glow settled, its head leaning with the look. */
export function lookPose(look) {
  return pose({ lx: look[0], ly: look[1], tilt: look[0] * 2.2 })
}

/**
 * A glance from one look to another, as `{ pose, afterMs }` steps counted from the glance's start. A far one (sideways by
 * more than half) first passes through a flared half-step, 80 ms; a near one goes straight there.
 */
export function glanceSteps(from, to) {
  const far = Math.abs(to[0] - from[0]) > 0.6
  const arrive = { pose: lookPose(to), afterMs: far ? OWL_FRAME_MS : 0 }
  if (!far) return Object.freeze([Object.freeze(arrive)])
  const half = pose({ lx: (from[0] + to[0]) / 2, ly: (from[1] + to[1]) / 2, tilt: to[0] * 1.2, glow: 2 })
  return Object.freeze([Object.freeze({ pose: half, afterMs: 0 }), Object.freeze(arrive)])
}

/** A blink at `look`, or two in a row, as `{ pose, afterMs }` steps counted from its start, with its total length. */
export function blinkSteps(look, double) {
  const steps = []
  const once = from => [0.5, 1, 0.5, 0].forEach((lid, i) => steps.push(Object.freeze({ pose: pose({ ...lookPose(look), lid }), afterMs: from + i * OWL_FRAME_MS })))
  once(0)
  if (double) once(5 * OWL_FRAME_MS)
  return Object.freeze({ steps: Object.freeze(steps), lengthMs: (double ? 9 : 4) * OWL_FRAME_MS })
}

/** A pose's identity: two poses with one key are one picture. */
export function poseKey(p) {
  return [p.lx, p.ly, p.lid, p.glow, p.th, p.thR, p.r, p.lift, p.sq, p.tilt, p.sm].join(',')
}

let all = null
/**
 * Every pose the schedule can show, once each, in a fixed order that is the frame numbers: the resting pose first, then a rest
 * on each look, a blink on each look (half, shut), every flared half-step between two looks, and every step of every flap.
 */
export function allOwlPoses() {
  if (all !== null) return all
  const seen = new Map()
  const add = p => { if (!seen.has(poseKey(p))) seen.set(poseKey(p), p) }
  add(REST_POSE)
  for (const look of LOOK_TARGETS) add(lookPose(look))
  for (const look of LOOK_TARGETS) for (const lid of [0.5, 1]) add(pose({ ...lookPose(look), lid }))
  for (const from of LOOK_TARGETS) for (const to of LOOK_TARGETS) for (const step of glanceSteps(from, to)) add(step.pose)
  for (const sequence of Object.values(FLAP_SEQUENCES)) for (const step of sequence) add(step.pose)
  all = Object.freeze([...seen.values()])
  return all
}

/** A pose's frame number, or -1 when it is not one the schedule can show. */
export function owlFrameIndex(p) {
  return allOwlPoses().findIndex(candidate => poseKey(candidate) === poseKey(p))
}
