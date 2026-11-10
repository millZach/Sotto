"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // proto/life.ts
  function fast(t) {
    return LIFE.happenings.some((h) => FAST.has(h.kind) && t >= h.t0 && t <= h.t0 + h.dur);
  }
  function hash(a, b = 0, c = 0) {
    let h = Math.imul(a ^ 2654435769, 2246822507) ^ Math.imul(b + 1663821227, 3266489909) ^ Math.imul(c + 668265263, 374761393);
    h = Math.imul(h ^ h >>> 15, 739982445);
    return ((h ^ h >>> 13) >>> 0) / 4294967296;
  }
  function fidgetOf(order, t) {
    const at = t + order * 1.7, slot = Math.floor(at / 2.8);
    return { roll: Math.floor(hash(order + 1, slot) * 12), into: at - slot * 2.8 };
  }
  var FLAGS, WOOD, OWLS, EVENTS, PRESETS, LOOK, LIFE, has, threadOf, working, activity, FAST;
  var init_life = __esm({
    "proto/life.ts"() {
      "use strict";
      FLAGS = [
        { id: "wind", group: "wood", name: "Wind", line: "Gusts cross the wood: grass leans, crowns sway, leaves fly." },
        { id: "river", group: "wood", name: "River flows", line: "Glints run down the river toward you." },
        { id: "fireflies", group: "wood", name: "Fireflies", line: "A dozen lights drift and pulse in the margins." },
        { id: "mist", group: "wood", name: "Mist", line: "Thin wisps drift between the hills." },
        { id: "shooting", group: "wood", name: "Shooting stars", line: "Now and then one crosses the sky." },
        { id: "sleepZ", group: "owls", name: "Sleepers", line: "A resting thread’s owl sleeps under rising z’s." },
        { id: "fidget", group: "owls", name: "Workers fidget", line: "A working thread’s owl looks down at its work, turns, stretches and hops. A failed one winces." },
        { id: "wave", group: "owls", name: "Waiting owl waves", line: "An owl that waits on you waves its wings under a ? or a !." },
        { id: "sparkle", group: "owls", name: "Finish sparkle", line: "A thread that finishes gets a burst of sparks and a happy owl." },
        { id: "rounds", group: "owls", name: "Watcher’s rounds", line: "Watcher’s owl flies to the tree of the thread it checks and calls to its owl, which answers." },
        { id: "gaze", group: "owls", name: "Follows your pointer", line: "Watcher’s owl watches your pointer in the margins; an owl you point at hops." },
        { id: "meteors", group: "events", name: "Meteor shower", line: "Eight meteors in three seconds." },
        { id: "bats", group: "events", name: "Bats", line: "A flock crosses in front of the moon." },
        { id: "fox", group: "events", name: "Fox", line: "A fox trots the length of the ground and stops to look up." },
        { id: "fish", group: "events", name: "Fish", line: "A fish jumps in the river." },
        { id: "hunt", group: "events", name: "Owl hunts", line: "Watcher’s owl dives for a mouse in the grass." },
        { id: "cloud", group: "events", name: "Cloud", line: "A cloud drifts across the moon." },
        { id: "mirror", group: "room", name: "Tied to the room", line: "Nothing runs on a timer: the wood answers what your threads do." }
      ];
      WOOD = ["wind", "river", "fireflies", "mist", "shooting"];
      OWLS = ["sleepZ", "fidget", "wave", "sparkle", "rounds", "gaze"];
      EVENTS = ["meteors", "bats", "fox", "fish", "hunt", "cloud"];
      PRESETS = [
        { id: "A", name: "Today", line: "The night wood as it ships. Stars twinkle, owls blink, Watcher’s owl flies now and then.", flags: [] },
        { id: "B", name: "The wood breathes", line: "Always something small moving: wind, the river, fireflies, mist, a shooting star. Decoration only.", flags: WOOD },
        { id: "C", name: "The owls have lives", line: "Each owl acts out its thread: sleeping, working, waving for you, celebrating. Watcher’s owl does its rounds.", flags: OWLS },
        { id: "D", name: "Things happen at night", line: "The scene as today, but every so often a set piece: meteors, bats, a fox, a fish, a hunt, a cloud.", flags: EVENTS },
        { id: "E", name: "The wood mirrors the room", line: "All of it, and nothing on a timer: wind follows how busy the room is, and events fire when threads finish, fail, ask or merge.", flags: [...WOOD, ...OWLS, ...EVENTS, "mirror"] }
      ];
      LOOK = { shape: false, depth: false, halo: false };
      LIFE = {
        flags: /* @__PURE__ */ new Set(),
        pace: "demo",
        autoRoom: true,
        /** Reduced motion: nothing moves, and the extras are drawn once where they rest. */
        still: false,
        /** The scene's clock at the last frame, in seconds. */
        now: 0,
        threads: [],
        acts: /* @__PURE__ */ new Map(),
        happenings: [],
        /** The thread owls as the last frame drew them. */
        poses: [],
        watcher: null,
        watcherFlying: false,
        pointer: null,
        say: (_words) => void 0
      };
      has = (id) => LIFE.flags.has(id);
      threadOf = (key) => LIFE.threads.find((thread) => thread.key === key);
      working = () => LIFE.threads.filter((thread) => thread.state === "working").length;
      activity = () => LIFE.threads.length === 0 ? 0 : Math.min(1, working() / Math.max(4, LIFE.threads.length * 0.6));
      FAST = /* @__PURE__ */ new Set(["star", "meteors", "note", "sparkle", "fish", "bats", "mouse", "fox"]);
    }
  });

  // ../../../../src/shared/themes/color.ts
  function relativeLuminance(color) {
    const linearize = (channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
  }
  function contrastRatio(first, second) {
    const a = relativeLuminance(first);
    const b = relativeLuminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  var NUMBER, NUMBER_PATTERN;
  var init_color = __esm({
    "../../../../src/shared/themes/color.ts"() {
      "use strict";
      NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
      NUMBER_PATTERN = new RegExp(`^${NUMBER}$`, "iu");
    }
  });

  // ../../../../src/renderer/src/watcher/nightScene.ts
  function seeded(seed) {
    let state = seed | 0;
    return () => {
      state = state + 1831565813 | 0;
      let t = Math.imul(state ^ state >>> 15, 1 | state);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function limbY(limb2, x) {
    const t = clamp((x - limb2.x0) / (limb2.x1 - limb2.x0), 0, 1);
    return lerp(limb2.y0, limb2.y1, t) + 2 * t * (1 - t) * limb2.sag;
  }
  function groundAt(layout, x) {
    return layout.groundY + Math.sin(x * 0.013) * 3 + Math.sin(x * 0.051) * 1.5;
  }
  function limbSpots(along2, kind, clear) {
    const out = [], dir = Math.sign(along2.x1 - along2.x0);
    for (let x = along2.x1 - dir * 20; dir * (x - along2.x0) > 24; x -= dir * SPOT) {
      if (clear.some((c) => Math.abs(x - c.x) < c.w)) continue;
      out.push({ x, y: limbY(along2, x), kind });
    }
    return out;
  }
  function heldRoom(slim, full) {
    if (slim === null || full === null) return slim;
    const near = (a, b) => Math.abs(a - b) < 1;
    const lane = slim.lane === void 0 || full.lane === void 0 ? slim.lane === full.lane : near(slim.lane.x, full.lane.x) && near(slim.lane.y, full.lane.y) && near(slim.lane.w, full.lane.w) && near(slim.lane.h, full.lane.h);
    return near(slim.width, full.width) && near(slim.height, full.height) && near(slim.header, full.header) && lane ? full : slim;
  }
  function layoutScene(measure) {
    const { width: W, height: H, composer: comp, header } = measure;
    const colL = comp.x, colR = comp.x + comp.w;
    const lane = measure.lane ?? null;
    const inL = lane === null ? colL : Math.max(0, Math.min(colL, lane.x));
    const leftRoom = Math.max(0, inL), rightRoom = Math.max(0, W - colR);
    const margin = Math.min(leftRoom, rightRoom);
    const mode = margin >= TREES_MIN_MARGIN ? "trees" : Math.max(leftRoom, rightRoom) >= RAIL_MIN_MARGIN ? "rail" : "none";
    const groundY = comp.y + comp.h * 0.55;
    const sky = Math.max(1, groundY - header);
    const L = { x0: 6, x1: inL - 14 }, R = { x0: colR + 14, x1: W - 6 };
    const Mw = Math.max(1, Math.min(L.x1 - L.x0, R.x1 - R.x0));
    const s = clamp(Math.min(margin / OWL_SCALE.perMargin, sky / OWL_SCALE.perSky), OWL_SCALE.min, OWL_SCALE.max);
    const lh = sky * 0.8, rh = sky * 0.64;
    const ltx = L.x0 + Mw * 0.3, rtx = R.x1 - Mw * 0.3;
    const left = { x: ltx, y: groundY + 4, h: lh, dir: 1, limbs: [
      limb(ltx, groundY - lh * 0.42, L.x1 - 2, groundY - lh * 0.47),
      // Watcher's, toward the room
      limb(ltx, groundY - lh * 0.56, ltx + (L.x1 - ltx) * 0.62, groundY - lh * 0.63, 3),
      // higher, toward the room
      limb(ltx, groundY - lh * 0.27, Math.max(L.x0 + 4, ltx - Mw * 0.29), groundY - lh * 0.32)
      // outward
    ] };
    const right = { x: rtx, y: groundY + 4, h: rh, dir: -1, limbs: [limb(rtx, groundY - rh * 0.48, R.x0 + 2, groundY - rh * 0.53)] };
    const homeX = L.x1 - 2 - 26 * s, visitX = rtx - 30 * s;
    const home = { x: homeX, y: limbY(left.limbs[0], homeX) };
    const visit = { x: visitX, y: limbY(right.limbs[0], visitX) };
    const by = comp.y + 12, reach = 64 * s + 44;
    const branches = {
      left: limb(colL - COLUMN_GAP, by, Math.max(L.x0 + 8, colL - COLUMN_GAP - reach), by - 12 * s, -4),
      right: limb(colR + COLUMN_GAP, by, Math.min(R.x1 - 8, colR + COLUMN_GAP + reach), by - 12 * s, -4)
    };
    const perchOn = (b) => {
      const x = b.x0 + Math.sign(b.x1 - b.x0) * (22 * s + 10);
      return { x, y: limbY(b, x) };
    };
    const composerPerch = { left: perchOn(branches.left), right: perchOn(branches.right) };
    const moonR = clamp(Mw * 0.1, 15, 44);
    const moon = { x: R.x0 + Mw * 0.34, y: header + Math.max(moonR + 12, sky * 0.15 + moonR * 0.5), r: moonR };
    let spots = [];
    if (mode === "trees") {
      const owlWidth = 20 * s + 22;
      const limbFirst = limbSpots(right.limbs[0], "limb", [{ x: visit.x, w: owlWidth }]);
      const tree = [
        ...limbSpots(left.limbs[0], "tree", [{ x: home.x, w: owlWidth }]),
        ...limbSpots(left.limbs[1], "tree", [{ x: home.x, w: owlWidth }]),
        ...limbSpots(left.limbs[2], "tree", [])
      ];
      const open = (x, trunk) => Math.abs(x - trunk) > 30 && Math.abs(x - branches.left.x0) >= 40 && Math.abs(x - branches.right.x0) >= 40;
      const ground = [];
      for (let x = R.x0 + 20; x < R.x1 - 16; x += SPOT) if (open(x, rtx)) ground.push({ x, y: groundAt({ groundY }, x), kind: "ground" });
      for (let x = L.x1 - 20; x > L.x0 + 16; x -= SPOT) if (open(x, ltx)) ground.push({ x, y: groundAt({ groundY }, x), kind: "ground" });
      spots = [...limbFirst, ...tree, ...ground];
    } else if (mode === "rail") {
      const rails = [...rightRoom >= RAIL_MIN_MARGIN ? [(colR + OWL_GAP + W) / 2] : [], ...leftRoom >= RAIL_MIN_MARGIN ? [(inL - OWL_GAP) / 2] : []];
      for (const x of rails) for (let y = header + RAIL_STEP; y < H - 14; y += RAIL_STEP) spots.push({ x, y, kind: "rail" });
    }
    return {
      width: W,
      height: H,
      composer: comp,
      words: measure.words,
      header,
      column: { left: colL, right: colR },
      lane,
      margin,
      mode,
      s,
      groundY,
      sky,
      horizon: groundY - sky * 0.3,
      left,
      right,
      moon,
      home,
      visit,
      branches,
      composerPerch,
      spots
    };
  }
  function inMargin(layout, x) {
    return x < layout.column.left - COLUMN_GAP || x > layout.column.right + COLUMN_GAP;
  }
  function boxDistance(box, x, y) {
    return Math.hypot(Math.max(box.x - x, 0, x - box.x - box.w), Math.max(box.y - y, 0, y - box.y - box.h));
  }
  function columnFactor(layout, x, strength) {
    const { left, right } = layout.column;
    const out = x < left ? left - x : x > right ? x - right : -Math.min(x - left, right - x);
    return lerp(strength, 1, smooth(-COLUMN_BLEND, COLUMN_BLEND, out));
  }
  function inLane(layout, x, y) {
    const lane = layout.lane;
    return lane !== null && x >= lane.x - LANE_PAD && x <= lane.x + lane.w + LANE_PAD && y >= lane.y && y <= lane.y + lane.h;
  }
  function owlLayer(layout, x, y) {
    if (y <= layout.header || layout.words.some((box) => x >= box.x - 4 && x <= box.x + box.w + 4 && y >= box.y - 4 && y <= box.y + box.h + 4)) return null;
    return owlRoom(layout, x) && !inLane(layout, x, y) ? "over" : "behind";
  }
  function quietAt(layout, x, y, strength = COLUMN_QUIET.dark) {
    const inside = !inMargin(layout, x);
    if (inside && y < layout.header) return 0;
    for (const box of layout.words) if (boxDistance(box, x, y) <= WORD_PAD) return 0;
    const toColumn = Math.min(Math.abs(x - layout.column.left), Math.abs(x - layout.column.right));
    const onBranch = !inside && Math.abs(y - layout.branches.left.y0) < 16 + 12 * layout.s && toColumn < 64 * layout.s + 52;
    const share = inLane(layout, x, y) ? strength : onBranch ? 1 : columnFactor(layout, x, strength);
    return lerp(0.1, 1, smooth(layout.header - 2, layout.header + 14, y)) * share;
  }
  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    };
  }
  function makeRoute(points) {
    const ext = [points[0], ...points, points[points.length - 1]];
    const samples = [{ ...points[0], d: 0 }];
    for (let k = 1; k < ext.length - 2; k++) for (let j = 1; j <= 16; j++) {
      const p = catmull(ext[k - 1], ext[k], ext[k + 1], ext[k + 2], j / 16);
      const last = samples[samples.length - 1];
      samples.push({ ...p, d: last.d + Math.hypot(p.x - last.x, p.y - last.y) });
    }
    return { samples, length: samples[samples.length - 1].d };
  }
  function along(route, u) {
    const target = clamp(u, 0, 1) * route.length, S = route.samples;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) {
      const mid = lo + hi >> 1;
      if (S[mid].d < target) lo = mid;
      else hi = mid;
    }
    const a = S[lo], b = S[hi], t = b.d === a.d ? 0 : (target - a.d) / (b.d - a.d);
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }
  function placeOf(layout, place, side) {
    return place === "home" ? layout.home : place === "tree" ? layout.visit : layout.composerPerch[side];
  }
  function stayAt(place, roll) {
    const [low, high] = place === "home" ? OWL_STAY.home : OWL_STAY.away;
    return lerp(low, high, clamp(roll, 0, 1));
  }
  function nextPlace(at, roll, leftBranch = true) {
    if (at === "home") return roll < 0.5 || !leftBranch ? "tree" : "composer";
    if (at === "tree") return roll < 0.35 ? "composer" : "home";
    return "home";
  }
  function owlRoom(layout, x) {
    return x < layout.column.left - OWL_GAP || x > layout.column.right + OWL_GAP;
  }
  function planFlight(layout, owl, to, t0, calm = false) {
    const { s, moon } = layout;
    const side = to === "composer" ? owl.at === "tree" ? "right" : "left" : owl.side;
    const a = placeOf(layout, owl.at, owl.side), b = placeOf(layout, to, side);
    const dir = Math.sign(b.x - a.x) || 1, d = Math.abs(b.x - a.x);
    const high = Math.max(layout.header + 34, Math.min(a.y, b.y) - clamp(d * 0.3, 26 * s, 150 * s));
    const between = [
      { x: a.x + dir * 16 * s, y: a.y + 3 * s },
      { x: a.x + dir * d * 0.14, y: lerp(a.y, high, 0.55) },
      { x: b.x - dir * d * 0.2, y: lerp(high, b.y, 0.82) + 10 * s },
      { x: b.x - dir * 22 * s, y: b.y + 7 * s }
    ];
    const past = { x: moon.x - dir * moon.r * 0.6, y: moon.y + moon.r * 0.9 };
    if (d > layout.width * 0.4 && dir * (past.x - a.x) > 0 && dir * (b.x - past.x) > 0) between.push(past, { x: lerp(a.x, past.x, 0.55), y: Math.min(high, past.y) });
    else between.push({ x: a.x + dir * d * 0.5, y: high });
    const points = [a];
    for (const p of between.filter((p2) => dir * (p2.x - a.x) > 0 && dir * (b.x - p2.x) > 0).sort((p2, q) => dir * (p2.x - q.x))) {
      if (dir * (p.x - points[points.length - 1].x) >= 14 * s && dir * (b.x - p.x) >= 14 * s) points.push(p);
    }
    points.push(b);
    const samples = [];
    for (const p of makeRoute(points).samples) {
      const last = samples[samples.length - 1];
      const x = last === void 0 ? p.x : dir * p.x < dir * last.x ? last.x : p.x;
      samples.push({ x, y: p.y, d: last === void 0 ? 0 : last.d + Math.hypot(x - last.x, p.y - last.y) });
    }
    const route = { samples, length: samples[samples.length - 1].d };
    const air = clamp(route.length / OWL_FLIGHT_SPEED, OWL_FLIGHT_TIME[0], OWL_FLIGHT_TIME[1]);
    const dur = calm ? CALM_STEP * (CALM_STEPS.length + 1) : OWL_CROUCH + air + OWL_FOLD;
    return { from: owl.at, to, side, t0, dur, route, air, calm };
  }
  function wingFrame(beats) {
    let at = (beats - Math.floor(beats)) * BEAT_HOLD;
    for (const key of WINGBEAT) {
      if (at < key.hold) return key;
      at -= key.hold;
    }
    return WINGBEAT[0];
  }
  function airProgress(k) {
    const x = clamp(k, 0, 1) * 200, j = Math.min(199, Math.floor(x));
    return lerp(PROGRESS[j], PROGRESS[j + 1], x - j);
  }
  function heading(route, u) {
    const p = along(route, Math.max(0, u - 0.012)), q = along(route, Math.min(1, u + 0.012));
    return Math.atan2(q.y - p.y, q.x - p.x);
  }
  function turning(route, u) {
    let sum = 0;
    for (const du of [-0.03, 0, 0.03]) {
      const at = clamp(u + du, 0.02, 0.98);
      let d = heading(route, at + 0.015) - heading(route, at - 0.015);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      sum += d / 0.03;
    }
    return sum / 3;
  }
  function owlAt(t, layout, owl, options) {
    const { s } = layout;
    const pose = { x: 0, y: 0, s, bank: 0, squash: 1, spread: 0, flap: 0, turn: 0, gx: 0, gy: 0, blink: false, legs: 0 };
    const flight = options.still ? null : owl.flight;
    const calm = options.calm === true;
    if (flight !== null && t >= flight.t0 && t < flight.t0 + flight.dur) {
      const a = placeOf(layout, flight.from, owl.side), b = placeOf(layout, flight.to, flight.side);
      const dir = Math.sign(b.x - a.x) || 1, local = t - flight.t0;
      if (flight.calm) {
        const j = Math.floor(local / CALM_STEP + 1e-6);
        if (j <= 0) {
          pose.x = a.x;
          pose.y = a.y;
          return { pose, stage: "perched" };
        }
        if (j > CALM_STEPS.length) {
          pose.x = b.x;
          pose.y = b.y;
          return { pose, stage: "perched" };
        }
        const p2 = along(flight.route, CALM_STEPS[j - 1]);
        pose.x = b.x + Math.round((p2.x - b.x) / CELL.w) * CELL.w;
        pose.y = b.y + Math.round((p2.y - b.y) / CELL.h) * CELL.h;
        pose.flap = 0.22;
        pose.spread = 1;
        pose.turn = dir * 0.25;
        pose.gx = dir * 0.5;
        pose.gy = 0.6;
        return { pose, stage: "flying" };
      }
      if (local < OWL_CROUCH) {
        pose.x = a.x;
        pose.y = a.y;
        pose.turn = dir * 0.5;
        pose.squash = 1 - 0.1 * Math.sin(local / OWL_CROUCH * Math.PI * 0.5);
        return { pose, stage: "flying" };
      }
      const air = local - OWL_CROUCH;
      if (air >= flight.air) {
        const k2 = (air - flight.air) / OWL_FOLD;
        pose.x = b.x;
        pose.y = b.y;
        pose.spread = stepped(0.95, 0.06, k2, 3);
        pose.flap = stepped(FLARE.flap, 0.5, k2, 3);
        pose.legs = 1 - smooth(0.5, 1, k2);
        pose.squash = 1 - 0.08 * Math.sin(k2 * Math.PI);
        pose.gy = 0.3;
        return { pose, stage: "flying" };
      }
      const k = air / flight.air, u = airProgress(k), p = along(flight.route, u);
      const flareAt = FLARE_AT * flight.air, climbEnd = Math.min(CLIMB.beats / CLIMB.hz, flareAt), approach = Math.max(flareAt - APPROACH.beats / APPROACH.hz, climbEnd);
      let flap, spread;
      if (air < climbEnd) {
        const key = wingFrame(air * CLIMB.hz);
        flap = key.flap * CLIMB.depth;
        spread = key.spread;
      } else if (air >= flareAt) {
        flap = stepped(0.22, FLARE.flap, (air - flareAt) / (flight.air - flareAt) * 1.6, 3);
        spread = FLARE.spread;
      } else if (air >= approach) {
        const key = wingFrame(APPROACH.beats - (flareAt - air) * APPROACH.hz);
        flap = key.flap * APPROACH.depth + 0.15;
        spread = key.spread;
      } else {
        const key = wingFrame((air - climbEnd) * CRUISE.hz);
        flap = key.flap * CRUISE.depth;
        spread = key.spread * 1.08;
      }
      const away = smooth(0, 0.15, k) * (1 - smooth(0.78, 0.95, k));
      const y = p.y + Math.sin(t * 2 * Math.PI * 0.55 + a.x * 0.013) * 0.8 * s * away;
      pose.bank = Math.round(clamp(-turning(flight.route, u) * 0.06 * airSpeed(k) * away, -0.32, 0.32) / 0.05) * 0.05;
      pose.x = b.x + Math.round((p.x - b.x) / CELL.w) * CELL.w;
      pose.y = b.y + Math.round((y - b.y) / CELL.h) * CELL.h;
      pose.flap = flap;
      pose.spread = spread;
      pose.legs = smooth(0.8, 1, k);
      pose.squash = stepped(1, 0.93, smooth(FLARE_AT, 1, k), 2);
      pose.turn = dir * 0.25 * (1 - smooth(0.9, 1, k));
      pose.gx = dir * 0.6;
      pose.gy = 0.6;
      return { pose, stage: "flying" };
    }
    const at = placeOf(layout, options.still ? "home" : flight !== null && t >= flight.t0 + flight.dur ? flight.to : owl.at, flight !== null && t >= flight.t0 + flight.dur ? flight.side : owl.side);
    pose.x = at.x;
    pose.y = at.y;
    if (options.still || calm) return { pose, stage: "perched" };
    const seg = Math.floor(t / IDLE_TURN_EVERY);
    pose.turn = lerp(IDLE_TURNS[(seg + IDLE_TURNS.length - 1) % IDLE_TURNS.length], IDLE_TURNS[seg % IDLE_TURNS.length], smooth(0, 0.25, t - seg * IDLE_TURN_EVERY));
    pose.blink = (t + 1.3) % BLINK_EVERY < 0.14;
    const look = options.look;
    const target = options.watch != null ? { x: options.watch.at.x, y: options.watch.at.y, k: smooth(options.watch.since, options.watch.since + 0.25, t) } : look != null && t - look.t >= 0 && t - look.t < 1.8 ? { x: look.x, y: look.y, k: smooth(0, 0.2, t - look.t) * (1 - smooth(1.4, 1.8, t - look.t)) } : null;
    if (target !== null && target.k > 0) {
      pose.turn = lerp(pose.turn, clamp((target.x - pose.x) / 240, -1, 1), target.k);
      pose.gx = lerp(0, clamp((target.x - pose.x) / 200, -1.2, 1.2), target.k);
      pose.gy = lerp(0, clamp((target.y - (pose.y - 47 * s)) / 200, -1, 1.2), target.k);
      pose.blink = false;
    }
    return { pose, stage: "perched" };
  }
  function liveRipples(ripples, t, still) {
    const life = still ? STILL_RIPPLE_LIFE : RIPPLE_LIFE;
    return ripples.filter((ripple) => t - ripple.t <= life);
  }
  function runningRipples(ripples, t) {
    return ripples.reduce((count, ripple) => count + (t >= ripple.t ? 1 : 0), 0);
  }
  function addRipple(ripples, ripple) {
    return [...ripples, ripple].slice(-MAX_RIPPLES);
  }
  function rippleReach(ripple, t, still) {
    if (t < ripple.t) return 0;
    return still ? STILL_REACH : (t - ripple.t) * RIPPLE_SPEED + RIPPLE_REACH;
  }
  function rippleAt(x, y, ripples, t, still, out) {
    out.ring = 0;
    out.dx = 0;
    out.dy = 0;
    for (const ripple of ripples) {
      const age = t - ripple.t, ddx = x - ripple.x, ddy = y - ripple.y, dist = Math.hypot(ddx, ddy) || 1;
      if (age < 0) continue;
      if (still) {
        const f = (1 - age / STILL_RIPPLE_LIFE) * (1 - smooth(0, STILL_REACH, dist));
        if (f > 0) out.ring += f * 0.8;
        continue;
      }
      const amp = Math.max(0, 1 - age / RIPPLE_LIFE) ** 1.6;
      for (const [share, width, strength] of RINGS) {
        const off = dist - age * RIPPLE_SPEED * share, band = Math.exp(-(off * off) / (2 * width * width)) * amp * strength;
        if (band < 0.01) continue;
        const wave = band * Math.cos(off / width * 1.7);
        out.ring += band;
        out.dx += ddx / dist * wave * 1.8;
        out.dy += ddy / dist * wave * 1.8;
      }
    }
    return out;
  }
  function frameDelay(moving, ripples, still) {
    if (moving || ripples > 0) return MOVING_MS;
    return still ? null : IDLE_CHECK_MS;
  }
  function isLightSurface(surface) {
    return relativeLuminance(surface) > 0.179;
  }
  function over(surface, ink, alpha) {
    const mix = (a, b) => Math.round(a + (b - a) * alpha);
    return { r: mix(surface.r, ink.r), g: mix(surface.g, ink.g), b: mix(surface.b, ink.b) };
  }
  function wordContrast(word, pixel) {
    const alpha = word.a ?? 1;
    return contrastRatio(alpha >= 1 ? word : over(pixel, word, alpha), pixel);
  }
  function columnCeiling(surface, ink, boost, words) {
    let best = 0;
    for (let k = 1; k <= 20; k++) {
      const pixel = over(surface, ink, Math.min(1, k / 20 * boost));
      if (words.some((word) => wordContrast(word, pixel) < WORD_CONTRAST)) break;
      best = k / 20;
    }
    return best;
  }
  function sceneInk(surface, text, accent, words = [text]) {
    const light = isLightSurface(surface);
    const inkBoost = light ? LIGHT_INK_BOOST : 1, accentBoost = light ? LIGHT_ACCENT_BOOST : 1;
    const ramp = ({ r, g, b }, boost) => Array.from({ length: 21 }, (_, k) => `rgba(${r}, ${g}, ${b}, ${Math.min(1, k / 20 * boost).toFixed(2)})`);
    return {
      light,
      ink: ramp(text, inkBoost),
      accent: ramp(accent, accentBoost),
      column: { ink: columnCeiling(surface, text, inkBoost, words), accent: columnCeiling(surface, accent, accentBoost, words) }
    };
  }
  function inkAt(steps, strength) {
    return steps[Math.round(clamp(strength, 0, 1) * 20)];
  }
  function gridFor(width, height) {
    return { cols: Math.ceil(width / CELL.w), rows: Math.ceil(height / CELL.h), cw: CELL.w, ch: CELL.h };
  }
  function placeStars(layout, grid, ink, density = 1) {
    const S = seeded(5), count = Math.round(layout.width * layout.height / 6e3 * density), stars = [], taken = /* @__PURE__ */ new Set();
    for (let k = 0; k < count; k++) {
      const c = Math.floor(S() * grid.cols), r = Math.floor(S() * grid.rows), y = r * grid.ch;
      if (y < layout.header + 6 || y > layout.horizon - layout.sky * 0.08) continue;
      const i = r * grid.cols + c;
      if ((ink[i] ?? 1) > 0.05) continue;
      const tier = S();
      const star = { i, base: tier > 0.93 ? 0.9 : tier > 0.7 ? 0.55 : 0.3, phase: S() * 6.28, speed: 0.5 + S() * 1.2, accent: S() > 0.86 };
      if (taken.has(i)) continue;
      taken.add(i);
      stars.push(star);
    }
    return stars;
  }
  function twinkleStep(t, still) {
    return still ? 0 : Math.floor(t * TWINKLE_STEPS_PER_SECOND);
  }
  function starStrength(star, step, still) {
    return star.base * (still ? 1 : 0.65 + 0.35 * Math.sin(step / TWINKLE_STEPS_PER_SECOND * star.speed + star.phase));
  }
  function rampGlyph(density) {
    return RAMP[Math.max(1, Math.round(clamp(density, 0, 1) * (RAMP.length - 1)))];
  }
  var clamp, lerp, smooth, OWL_SCALE, TREES_MIN_MARGIN, RAIL_MIN_MARGIN, COLUMN_GAP, SPOT, RAIL_STEP, limb, COLUMN_QUIET, COLUMN_BLEND, WORD_PAD, LANE_PAD, glide, OWL_STAY, OWL_FLIGHT_SPEED, OWL_FLIGHT_TIME, OWL_CROUCH, OWL_FOLD, CALM_STEP, CALM_STEPS, OWL_GAP, WINGBEAT, BEAT_HOLD, CLIMB, CRUISE, APPROACH, FLARE_AT, FLARE, airSpeed, PROGRESS, stepped, IDLE_TURNS, IDLE_TURN_EVERY, BLINK_EVERY, RIPPLE_LIFE, STILL_RIPPLE_LIFE, MAX_RIPPLES, RIPPLE_SPEED, ECHO_SHARE, RINGS, RIPPLE_REACH, STILL_REACH, IDLE_CHECK_MS, MOVING_MS, WORD_CONTRAST, LIGHT_INK_BOOST, LIGHT_ACCENT_BOOST, CELL, TWINKLE_STEPS_PER_SECOND, RAMP, RIPPLE_GLYPHS, WHIRL_GLYPHS;
  var init_nightScene = __esm({
    "../../../../src/renderer/src/watcher/nightScene.ts"() {
      init_color();
      clamp = (value, low, high) => Math.max(low, Math.min(high, value));
      lerp = (a, b, t) => a + (b - a) * t;
      smooth = (a, b, x) => {
        const t = clamp((x - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
      };
      OWL_SCALE = { perMargin: 225, perSky: 330, min: 0.8, max: 1.9 };
      TREES_MIN_MARGIN = 160;
      RAIL_MIN_MARGIN = 16;
      COLUMN_GAP = 8;
      SPOT = 44;
      RAIL_STEP = 26;
      limb = (x0, y0, x1, y1, sag = 5) => ({ x0, y0, x1, y1, sag });
      COLUMN_QUIET = { dark: 0.85, light: 0.85 };
      COLUMN_BLEND = 40;
      WORD_PAD = 4;
      LANE_PAD = 4;
      glide = (k) => clamp(k - Math.sin(2 * Math.PI * k) / (2 * Math.PI) * 0.55, 0, 1);
      OWL_STAY = { home: [45, 110], away: [10, 22] };
      OWL_FLIGHT_SPEED = 170;
      OWL_FLIGHT_TIME = [2.2, 7.5];
      OWL_CROUCH = 0.16;
      OWL_FOLD = 0.34;
      CALM_STEP = 0.7;
      CALM_STEPS = [0.36, 0.7];
      OWL_GAP = 2;
      WINGBEAT = [
        { flap: 1.2, spread: 0.86, hold: 1 },
        { flap: 0.5, spread: 1, hold: 0.55 },
        { flap: -0.3, spread: 1.06, hold: 0.55 },
        { flap: -0.95, spread: 0.98, hold: 0.85 },
        { flap: -0.5, spread: 0.74, hold: 1.1 },
        { flap: 0.2, spread: 0.66, hold: 1.1 },
        { flap: 0.8, spread: 0.74, hold: 1 }
      ];
      BEAT_HOLD = WINGBEAT.reduce((sum, key) => sum + key.hold, 0);
      CLIMB = { beats: 2, hz: 1.7, depth: 1.1 };
      CRUISE = { hz: 1.45, depth: 0.85 };
      APPROACH = { beats: 2, hz: 2.2, depth: 0.6 };
      FLARE_AT = 0.84;
      FLARE = { flap: 1.15, spread: 1 };
      airSpeed = (k) => lerp(0.3, 1, smooth(0, 0.2, k)) * (1 - 0.8 * smooth(0.66, 1, k));
      PROGRESS = (() => {
        const n = 200, out = new Float32Array(n + 1);
        let sum = 0;
        for (let j = 1; j <= n; j++) {
          sum += airSpeed((j - 0.5) / n);
          out[j] = sum;
        }
        for (let j = 0; j <= n; j++) out[j] = out[j] / sum;
        return out;
      })();
      stepped = (a, b, k, steps) => lerp(a, b, Math.round(clamp(k, 0, 1) * steps) / steps);
      IDLE_TURNS = [0, -0.7, 0, 0.55, 0.15, -0.35];
      IDLE_TURN_EVERY = 5.2;
      BLINK_EVERY = 4.7;
      RIPPLE_LIFE = 2.4;
      STILL_RIPPLE_LIFE = 0.7;
      MAX_RIPPLES = 12;
      RIPPLE_SPEED = 430;
      ECHO_SHARE = 0.62;
      RINGS = [[1, 20, 1], [ECHO_SHARE, 14, 0.45]];
      RIPPLE_REACH = 62;
      STILL_REACH = 70;
      IDLE_CHECK_MS = 125;
      MOVING_MS = 33;
      WORD_CONTRAST = 4.6;
      LIGHT_INK_BOOST = 1.9;
      LIGHT_ACCENT_BOOST = 1.5;
      CELL = { w: 7, h: 12 };
      TWINKLE_STEPS_PER_SECOND = 2;
      RAMP = " .·:-=+*#%@";
      RIPPLE_GLYPHS = "·∘oO";
      WHIRL_GLYPHS = "·:+*%@";
    }
  });

  // ../../../../src/renderer/src/watcher/owlFamily.ts
  function animationEnd(animation) {
    return animation.kind === "arrive" ? animation.emerge + animation.dur : animation.t0 + animation.dur;
  }
  function assignSpots(owls, capacity) {
    const held = new Set(owls.filter((owl) => leaving(owl) && owl.spot !== null && owl.spot >= 0).map((owl) => owl.spot));
    const staying = owls.filter((owl) => !leaving(owl));
    const free = [];
    for (let k = 0; k < capacity; k++) if (!held.has(k)) free.push(k);
    const pile = staying.length > free.length && capacity > 0;
    const usable = new Set(pile ? free.filter((k) => k !== capacity - 1) : free);
    const spots = /* @__PURE__ */ new Map(), taken = /* @__PURE__ */ new Set(), waiting = [];
    for (const owl of staying) {
      if (owl.spot !== null && owl.spot >= 0 && usable.has(owl.spot) && !taken.has(owl.spot)) {
        taken.add(owl.spot);
        spots.set(owl.key, owl.spot);
      } else waiting.push(owl);
    }
    const open = [...usable].filter((k) => !taken.has(k)).sort((a, b) => a - b);
    for (const owl of [...waiting].sort((a, b) => a.order - b.order)) spots.set(owl.key, open.shift() ?? -1);
    for (const owl of owls) if (leaving(owl)) spots.set(owl.key, owl.spot ?? -1);
    return { spots, pile };
  }
  function pileLabel(count, rail) {
    return rail && count > 9 ? "9+" : `+${count}`;
  }
  function blinking(order, t) {
    return (t + order * 1.37) % 6.1 < 0.15;
  }
  function glowStep(t, still) {
    return still ? 0.5 : Math.round((0.5 + 0.5 * Math.sin(t * Math.PI * 2 / 1.8)) * 3) / 3;
  }
  function owlEyes(owl, t, canBlink) {
    const shut = owl.mood === "asleep" || owl.mood === "awake" && canBlink && blinking(owl.order, t);
    return shut ? "-" : owl.mood === "waiting" ? "O" : "o";
  }
  function perchedGlyphs(eyes) {
    return [PERCHED_OWL[0].replace(/o/g, eyes), PERCHED_OWL[1], PERCHED_OWL[2]];
  }
  function owlGlyphs(pose, t, options) {
    const { owl } = pose;
    const eyes = owlEyes(owl, t, !options.still && !pose.flying);
    if (options.rail) return [RAIL_OWL.replace(/o/g, eyes)];
    if (pose.flying) {
      const beat = FLYING_OWL[Math.floor(t * 8 + owl.order) % 3];
      return [beat[0].replace(/o/g, eyes), beat[1]];
    }
    return perchedGlyphs(eyes);
  }
  function spriteCells(lines, x, y, cell) {
    const w = Math.max(...lines.map((line) => line.length)), n = lines.length;
    return { c0: Math.round(x / cell.w - w / 2), r0: Math.floor((y - 1) / cell.h) - n + 1, w, n };
  }
  var ARRIVAL_STAGGER, FADE_STAGGER, EMERGE, FADE, HOP, OWL_SPEED, FLIGHT_TIME, flightTime, leaving, OwlFamily, PERCHED_OWL, FLYING_OWL, RAIL_OWL;
  var init_owlFamily = __esm({
    "../../../../src/renderer/src/watcher/owlFamily.ts"() {
      init_nightScene();
      ARRIVAL_STAGGER = 0.45;
      FADE_STAGGER = 0.1;
      EMERGE = 0.55;
      FADE = 0.6;
      HOP = 1.2;
      OWL_SPEED = 190;
      FLIGHT_TIME = [1.3, 3.4];
      flightTime = (a, b) => clamp(Math.hypot(a.x - b.x, a.y - b.y) / OWL_SPEED, FLIGHT_TIME[0], FLIGHT_TIME[1]);
      leaving = (owl) => owl.animation?.kind === "leave" || owl.animation?.kind === "fade";
      OwlFamily = class {
        constructor(layout) {
          this.layout = layout;
        }
        owls = [];
        whirls = [];
        joined = 0;
        lastArrival = Number.NEGATIVE_INFINITY;
        placed = false;
        /** How the last update said owls should move, for an owl that leaves the pile between updates. */
        motion = "fly";
        /** The pile's spot, worked out whenever the spots are, so a frame never works it out again for each owl. */
        pileSpot = null;
        /** The last spot, while it holds the "+N" pile. */
        get marker() {
          return this.pileSpot;
        }
        /** How many owls wait in the "+N" pile. */
        get pileCount() {
          return this.owls.filter((owl) => !leaving(owl) && owl.spot === -1).length;
        }
        /** Where an owl sits: its spot, or the pile's. */
        spotOf(owl) {
          if (owl.spot !== null && owl.spot >= 0) return this.layout.spots[owl.spot] ?? null;
          return this.marker;
        }
        /**
         * Takes the room's watched threads now. New ones come out of the moon one after another, gone ones go back into it,
         * and the rest take their new titles and moods where they sit. The first call places every owl at once: a room that
         * opens with threads already watched shows them sitting. Returns when the moon's whirlpool opens for each flight, so
         * the scene can send out a ripple from it then.
         */
        update(watched2, t, motion) {
          const incoming = new Map(watched2.map((owl) => [owl.key, owl]));
          const whirlpools = [];
          const instant = motion === "still" || !this.placed;
          this.motion = motion;
          for (const owl of this.owls) {
            const next = incoming.get(owl.key);
            if (next !== void 0) {
              owl.title = next.title;
              owl.threadId = next.threadId;
              owl.mood = next.mood;
              if (leaving(owl)) {
                const at = this.poseOf(owl, t);
                owl.animation = motion === "fly" && at !== null ? { kind: "hop", t0: t, from: { x: at.x, y: at.y }, dur: HOP } : instant ? null : { kind: "appear", t0: t, dur: FADE };
              }
              continue;
            }
            if (leaving(owl)) continue;
            if (instant || this.spotOf(owl) === null) {
              owl.animation = { kind: "fade", t0: t, dur: 0 };
              continue;
            }
            if (motion === "fade") {
              owl.animation = { kind: "fade", t0: t, dur: FADE };
              continue;
            }
            const from = this.spotOf(owl), dur = flightTime(from, this.layout.moon);
            owl.animation = { kind: "leave", t0: t, from, dur };
            this.whirls.push({ t0: t + dur - EMERGE, t1: t + dur + 0.15 });
            whirlpools.push(t + dur - EMERGE);
          }
          const known = new Set(this.owls.map((owl) => owl.key));
          const arrivals = [];
          for (const owl of watched2) {
            if (known.has(owl.key)) continue;
            const added = { key: owl.key, title: owl.title, threadId: owl.threadId, mood: owl.mood, spot: null, animation: null, order: this.joined++ };
            this.owls.push(added);
            arrivals.push(added);
          }
          this.reconcile(t, !instant);
          if (!instant) for (const owl of arrivals) {
            const target = this.spotOf(owl);
            if (target === null) continue;
            const start = Math.max(t, this.lastArrival + (motion === "fly" ? ARRIVAL_STAGGER : FADE_STAGGER));
            this.lastArrival = start;
            if (motion === "fade") {
              owl.animation = { kind: "appear", t0: start, dur: FADE };
              continue;
            }
            owl.animation = { kind: "arrive", t0: start, emerge: start + EMERGE, dur: flightTime(this.layout.moon, target) };
            this.whirls.push({ t0: start, t1: start + EMERGE + 0.5 });
            whirlpools.push(start);
          }
          this.placed = true;
          this.step(t);
          return whirlpools;
        }
        /** A new size for the room: every flight ends where it was going, and every owl keeps its spot while the spot exists. */
        relayout(layout, t) {
          this.layout = layout;
          this.owls = this.owls.filter((owl) => !leaving(owl));
          for (const owl of this.owls) owl.animation = null;
          this.whirls = [];
          this.lastArrival = Number.NEGATIVE_INFINITY;
          this.reconcile(t, false);
        }
        /** Ends what has finished at `t`: an owl gone into the moon leaves the family, and its spot goes to the pile's oldest. */
        step(t) {
          let gone = false;
          for (const owl of this.owls) if (owl.animation !== null && t >= animationEnd(owl.animation)) {
            if (leaving(owl)) {
              gone = true;
              continue;
            }
            owl.animation = null;
          }
          if (gone) {
            this.owls = this.owls.filter((owl) => !(leaving(owl) && t >= animationEnd(owl.animation)));
            this.reconcile(t, true);
          }
          this.whirls = this.whirls.filter((whirl) => t <= whirl.t1 + 0.6);
        }
        /** Whether anything moves at `t`: an owl flying, appearing or fading, or the whirlpool turning. */
        moving(t) {
          return this.owls.some((owl) => owl.animation !== null && t < animationEnd(owl.animation)) || this.whirl(t) > 0.01 || this.owls.some((owl) => owl.animation?.kind === "arrive" && t < owl.animation.t0);
        }
        /** How open the moon's whirlpool is at `t`, 0 to 1. */
        whirl(t) {
          let open = 0;
          for (const whirl of this.whirls) open = Math.max(open, smooth(whirl.t0, whirl.t0 + 0.45, t) * (1 - smooth(whirl.t1, whirl.t1 + 0.6, t)));
          return open;
        }
        /** The newest owl coming out of the moon at `t`, with when it started: Watcher's owl watches it. */
        newcomer(t) {
          let newest = null;
          for (const owl of this.owls) if (owl.animation?.kind === "arrive" && t >= owl.animation.t0 && t < animationEnd(owl.animation) && (newest === null || owl.animation.t0 > newest.animation.t0)) newest = owl;
          if (newest === null || newest.animation?.kind !== "arrive") return null;
          const pose = t < newest.animation.emerge ? null : this.poseOf(newest, t);
          return { at: pose ?? this.layout.moon, since: newest.animation.t0 };
        }
        /** Every owl that shows at `t`, where it is. */
        poses(t) {
          const out = [];
          for (const owl of this.owls) {
            const pose = this.poseOf(owl, t);
            if (pose !== null && pose.alpha > 0.02) out.push(pose);
          }
          return out;
        }
        poseOf(owl, t) {
          const a = owl.animation, target = this.spotOf(owl), moon = this.layout.moon;
          const sits = (alpha) => target !== null && owl.spot !== null && owl.spot >= 0 ? { owl, x: target.x, y: target.y, flying: false, alpha } : null;
          if (a === null) return sits(1);
          const k = clamp((t - a.t0) / Math.max(1e-3, a.dur), 0, 1);
          if (a.kind === "appear") return t < a.t0 ? null : sits(smooth(0, 1, k));
          if (a.kind === "fade") return sits(1 - smooth(0, 1, k));
          if (a.kind === "arrive") {
            if (t < a.emerge || target === null) return null;
            const u = clamp((t - a.emerge) / a.dur, 0, 1);
            const p2 = along(makeRoute([{ x: moon.x, y: moon.y }, { x: moon.x + (target.x - moon.x) * 0.25, y: moon.y + 34 }, { x: target.x, y: target.y - 46 }, target]), glide(u));
            const toPile = owl.spot === -1;
            return { owl, x: p2.x, y: p2.y, flying: u < 0.97, alpha: smooth(0, 0.2, u) * (toPile ? 1 - smooth(0.85, 1, u) : 1) };
          }
          if (a.kind === "hop") {
            if (target === null) return null;
            const p2 = along(makeRoute([a.from, { x: (a.from.x + target.x) / 2, y: Math.min(a.from.y, target.y) - 50 }, target]), glide(k));
            return { owl, x: p2.x, y: p2.y, flying: k < 0.97, alpha: 1 };
          }
          const p = along(makeRoute([a.from, { x: a.from.x, y: a.from.y - 46 }, { x: a.from.x + (moon.x - a.from.x) * 0.75, y: moon.y + 36 }, { x: moon.x, y: moon.y }]), glide(k));
          return { owl, x: p.x, y: p.y, flying: k > 0.03, alpha: 1 - smooth(0.82, 1, k) };
        }
        reconcile(t, animate) {
          const was = new Map(this.owls.map((owl) => [owl.key, owl.spot]));
          const capacity = this.layout.spots.length;
          const { spots, pile } = assignSpots(this.owls, capacity);
          const from = this.pileSpot;
          this.pileSpot = pile ? this.layout.spots[capacity - 1] : null;
          for (const owl of this.owls) {
            owl.spot = spots.get(owl.key) ?? -1;
            if (animate && was.get(owl.key) === -1 && owl.spot >= 0 && owl.animation === null) {
              owl.animation = from === null || this.motion !== "fly" ? { kind: "appear", t0: t, dur: FADE } : { kind: "hop", t0: t, from, dur: HOP };
            }
          }
        }
      };
      PERCHED_OWL = ["{o,o}", "/)__)", ' " " '];
      FLYING_OWL = [["\\{o,o}/", " (__) "], ["-{o,o}-", " (__) "], ["/{o,o}\\", " (__) "]];
      RAIL_OWL = "oo";
    }
  });

  // proto/owlFamilyLife.ts
  function owlGlyphs2(pose, t, options) {
    const real = owlGlyphs(pose, t, options);
    if (options.rail || options.still || pose.flying || LIFE.flags.size === 0) return real;
    const owl = pose.owl, thread = threadOf(owl.key);
    const act = LIFE.acts.get(owl.key), acting = act !== void 0 && t >= act.t0 && t < act.t0 + act.dur ? act : null;
    const step = Math.floor(t * 4) % 2 === 1;
    if (thread?.state === "failed" && has("fidget")) return five("><", BODY_RUFFLED);
    if (owl.mood === "waiting") {
      if (!has("wave")) return real;
      const beat = Math.floor(t * 3) % 4;
      return beat === 0 ? seven("\\", "O", " ") : beat === 2 ? seven(" ", "O", "/") : seven(" ", "O", " ");
    }
    if (acting?.kind === "happy") return five("^^", BODY, step ? FEET_UP : FEET);
    if (acting?.kind === "wake") {
      const k = (t - acting.t0) / acting.dur;
      return k < 0.3 ? five("-o") : k < 0.75 ? seven("\\", "o", "/") : five("oo");
    }
    if (acting?.kind === "hop") return five(owl.mood === "asleep" ? "--" : "oo", BODY, FEET_UP);
    if (acting?.kind === "lookup") return five("°°");
    if (owl.mood !== "awake" || !has("fidget")) return real;
    if (LIFE.watcherFlying) return five("°°");
    const { roll, into } = fidgetOf(owl.order, t);
    if (roll <= 2 && into < 1.8) return five("..", BODY, step ? ' ".  ' : FEET);
    if (roll === 3) return five("oo", BODY_TURNED);
    if (roll === 4 && into < 0.8) return seven("\\", "o", "/");
    if (roll === 5 && into < 1.2) return five("°°");
    if (roll === 6 && into < 0.28) return five("oo", BODY, FEET_UP);
    return real;
  }
  var BODY, BODY_TURNED, BODY_RUFFLED, FEET, FEET_UP, five, seven;
  var init_owlFamilyLife = __esm({
    "proto/owlFamilyLife.ts"() {
      "use strict";
      init_owlFamily();
      init_owlFamily();
      init_life();
      BODY = "/)__)";
      BODY_TURNED = "(__(\\";
      BODY_RUFFLED = "/)~~)";
      FEET = ' " " ';
      FEET_UP = " ' ' ";
      five = (eyes, body = BODY, feet = FEET) => [`{${eyes[0]},${eyes[1] ?? eyes[0]}}`, body, feet];
      seven = (left, eyes, right, feet = FEET) => [`${left}{${eyes},${eyes}}${right}`, ` ${BODY} `, ` ${feet} `];
    }
  });

  // ../../../../src/renderer/src/watcher/scenePlace.ts
  function ambienceStep(ambience, t, still) {
    return ambience === null || still ? 0 : Math.floor(t * ambience.steps);
  }
  function ambienceTime(ambience, t, still) {
    return still ? STILL_AMBIENCE_T : Math.floor(t * ambience.steps) / ambience.steps;
  }
  var STILL_AMBIENCE_T, wrap;
  var init_scenePlace = __esm({
    "../../../../src/renderer/src/watcher/scenePlace.ts"() {
      "use strict";
      STILL_AMBIENCE_T = 41.3;
      wrap = (value, size) => (value % size + size) % size;
    }
  });

  // ../../../../src/renderer/src/watcher/sceneDraw.ts
  function strokeLimb(fx, l) {
    fx.beginPath();
    fx.moveTo(l.x0, l.y0);
    fx.quadraticCurveTo((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2 + l.sag, l.x1, l.y1);
    fx.stroke();
  }
  function poly(fx, pts) {
    fx.beginPath();
    fx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) fx.lineTo(p[0], p[1]);
    fx.closePath();
    fx.fill();
  }
  function strokePts(fx, pts) {
    fx.beginPath();
    pts.forEach((p, k) => k === 0 ? fx.moveTo(p[0], p[1]) : fx.lineTo(p[0], p[1]));
    fx.stroke();
  }
  function ellipse(fx, x, y, rx, ry, rot = 0) {
    fx.beginPath();
    fx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
    fx.fill();
  }
  function cutOut(fx, draw) {
    fx.globalCompositeOperation = "destination-out";
    draw();
    fx.globalCompositeOperation = "source-over";
  }
  function alongLimb(l, step = 6) {
    const n = Math.max(2, Math.ceil(Math.abs(l.x1 - l.x0) / step)), out = [];
    for (let k = 0; k <= n; k++) {
      const x = l.x0 + (l.x1 - l.x0) * k / n;
      out.push([x, limbY(l, x)]);
    }
    return out;
  }
  function drawMoon(fx, ax, moon, scale = 1) {
    const m = { x: moon.x, y: moon.y, r: moon.r * scale };
    fx.globalAlpha = 0.05;
    for (let k = 2.4; k > 1.2; k -= 0.4) {
      fx.beginPath();
      fx.arc(m.x, m.y, m.r * k, 0, 7);
      fx.fill();
    }
    fx.globalAlpha = 0.3;
    fx.beginPath();
    fx.arc(m.x, m.y, m.r, 0, 7);
    fx.fill();
    fx.globalAlpha = 1;
    fx.lineWidth = 6;
    fx.beginPath();
    fx.arc(m.x, m.y, m.r - 1.5, 0, 7);
    fx.stroke();
    fx.globalCompositeOperation = "destination-out";
    fx.globalAlpha = 0.35;
    for (const [dx, dy, r] of [[-0.3, -0.25, 0.22], [0.25, 0.1, 0.16], [-0.05, 0.4, 0.12], [0.35, -0.38, 0.09]]) {
      fx.beginPath();
      fx.arc(m.x + dx * m.r, m.y + dy * m.r, r * m.r, 0, 7);
      fx.fill();
    }
    fx.globalCompositeOperation = "source-over";
    const glow = ax.createRadialGradient(m.x, m.y, m.r * 0.9, m.x, m.y, m.r * 2.8);
    glow.addColorStop(0, "rgba(0, 0, 0, 0.55)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ax.globalAlpha = 1;
    ax.fillStyle = glow;
    ax.beginPath();
    ax.arc(m.x, m.y, m.r * 2.8, 0, 7);
    ax.fill();
    ax.fillStyle = MASK;
    ax.globalCompositeOperation = "destination-out";
    ax.beginPath();
    ax.arc(m.x, m.y, m.r * 0.98, 0, 7);
    ax.fill();
    ax.globalCompositeOperation = "source-over";
  }
  var MASK;
  var init_sceneDraw = __esm({
    "../../../../src/renderer/src/watcher/sceneDraw.ts"() {
      "use strict";
      init_nightScene();
      MASK = "black";
    }
  });

  // ../../../../src/renderer/src/watcher/placeDesert.ts
  function drawDesert(fx, ax, g) {
    const W = g.width, H = g.height, sky = g.sky, R = seeded(83), edge = g.column.left - 14;
    drawMoon(fx, ax, g.moon, DESERT_MOON);
    const mesa = (x0, x1, h) => {
      const y = g.horizon + sky * 0.04, pts = [[x0, y], [x0 + (x1 - x0) * 0.14, y - h], [x1 - (x1 - x0) * 0.16, y - h], [x1, y]];
      for (const field of [fx, ax]) cutOut(field, () => {
        field.globalAlpha = 1;
        poly(field, pts);
      });
      fx.globalAlpha = 0.09;
      poly(fx, pts);
      fx.globalAlpha = 0.58;
      fx.lineWidth = 4;
      strokePts(fx, pts);
    };
    mesa(edge * 0.05, edge * 0.6, sky * 0.1);
    mesa(W * 0.44, W * 0.56, sky * 0.05);
    mesa(g.column.right + (W - g.column.right) * 0.55, W + 30, sky * 0.07);
    const dune = (base, amp, period, ph, alpha, ridge) => {
      const pts = [];
      for (let x = 0; x <= W + 8; x += 8) {
        const u = frac(x / period + ph);
        pts.push([x, base - amp * (u < 0.7 ? Math.sin(u / 0.7 * Math.PI / 2) : Math.cos((u - 0.7) / 0.3 * Math.PI / 2))]);
      }
      fx.globalAlpha = alpha;
      poly(fx, [...pts, [W + 8, g.groundY + 2], [0, g.groundY + 2]]);
      fx.globalAlpha = ridge;
      fx.lineWidth = 4.5;
      strokePts(fx, pts);
    };
    dune(g.horizon + sky * 0.12, sky * 0.07, Math.max(120, W * 0.3), 0.2, 0.05, 0.5);
    dune(g.groundY - sky * 0.08, sky * 0.08, Math.max(140, W * 0.42), 0.55, 0.06, 0.62);
    for (let i = 0; i < 6; i++) {
      const x = edge * (0.1 + R() * 0.85), y = g.horizon + sky * (0.13 + R() * 0.06), h = 9 + R() * 12;
      fx.globalAlpha = 0.5;
      fx.lineWidth = 2.5;
      strokePts(fx, [[x, y], [x, y - h]]);
      fx.lineWidth = 2;
      strokePts(fx, [[x, y - h * 0.45], [x - h * 0.3, y - h * 0.45], [x - h * 0.3, y - h * 0.75]]);
      if (R() > 0.4) strokePts(fx, [[x, y - h * 0.6], [x + h * 0.28, y - h * 0.6], [x + h * 0.28, y - h * 0.85]]);
    }
    const ground = [];
    for (let x = 0; x <= W; x += 8) ground.push([x, groundAt(g, x)]);
    const grad = fx.createLinearGradient(0, g.groundY, 0, H);
    grad.addColorStop(0, "rgba(0, 0, 0, 0.08)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.02)");
    fx.globalAlpha = 1;
    fx.fillStyle = grad;
    poly(fx, [...ground, [W, H], [0, H]]);
    fx.fillStyle = MASK;
    fx.globalAlpha = 0.6;
    fx.lineWidth = 5;
    strokePts(fx, ground);
    fx.globalAlpha = 0.24;
    fx.lineWidth = 2;
    for (let y = g.groundY + 12; y < H; y += 9) {
      for (let x = -R() * 30; x < W; ) {
        const len = 20 + R() * 50;
        strokePts(fx, [[x, y + Math.sin(x * 0.05) * 2], [x + len * 0.5, y - 2], [x + len, y + Math.sin((x + len) * 0.05) * 2]]);
        x += len + 10 + R() * 30;
      }
    }
    for (let i = 0; i < 7; i++) {
      const x = R() * W, y = groundAt(g, x) + 6 + R() * 10;
      fx.globalAlpha = 0.45;
      ellipse(fx, x, y, 3 + R() * 4, 2 + R() * 2);
    }
    saguaro(fx, g.left, g.s);
    saguaro(fx, g.right, g.s);
    for (const b of [g.branches.left, g.branches.right]) arm(fx, b, Math.max(5, 7 * g.s), 14 * g.s + 6);
  }
  function saguaro(fx, t, s) {
    const w = clamp(t.h * 0.06, 8, 26), top = t.y - t.h * 0.88;
    fx.globalAlpha = 0.72;
    fx.lineCap = "round";
    fx.lineWidth = w;
    strokePts(fx, [[t.x, t.y], [t.x, top + w / 2]]);
    fx.lineCap = "butt";
    cutOut(fx, () => {
      fx.globalAlpha = 0.35;
      fx.lineWidth = 1.4;
      for (const k of [-0.22, 0.18]) strokePts(fx, [[t.x + w * k, t.y], [t.x + w * k, top + w]]);
    });
    for (const l of t.limbs) arm(fx, l, w * 0.62, clamp(t.h * 0.14, 16, 80) * Math.min(1, s));
  }
  function arm(fx, l, w, rise) {
    const drop = w * 0.4, pts = alongLimb(l).map(([x, y]) => [x, y + drop]);
    const end = pts[pts.length - 1];
    fx.globalAlpha = 0.68;
    fx.lineCap = "round";
    fx.lineJoin = "round";
    fx.lineWidth = w;
    strokePts(fx, [...pts, [end[0], end[1] - rise]]);
    fx.lineCap = "butt";
    fx.lineJoin = "miter";
    cutOut(fx, () => {
      fx.globalAlpha = 0.3;
      fx.lineWidth = 1.2;
      strokePts(fx, pts.map(([x, y]) => [x, y + w * 0.15]));
    });
    fx.globalAlpha = 0.4;
    fx.lineWidth = 1.2;
    for (let k = 2; k < pts.length - 1; k += 3) {
      const [x, y] = pts[k];
      strokePts(fx, [[x, y + w / 2], [x + 1, y + w / 2 + 4]]);
    }
  }
  function sandAmbience(g) {
    const R = seeded(29), low = g.horizon + g.sky * 0.15;
    const grains = Array.from({ length: GRAINS }, () => ({ x0: R() * g.width, y0: lerp(low, g.height - 4, R() ** 0.7), v: 40 + R() * 70, ph: R() }));
    return {
      steps: 8,
      most: GRAINS,
      cells(t, emit) {
        for (const p of grains) {
          const a = Math.sin(Math.PI * frac(t * 0.33 + p.ph));
          if (a < 0.2) continue;
          emit(wrap(p.x0 + p.v * t, g.width + 20) - 10, p.y0 + Math.sin(t * 2 + p.ph * 6) * 3, a > 0.7 ? "·" : ".", false, 0.22 + 0.32 * a, false);
        }
      }
    };
  }
  var DESERT_MOON, frac, GRAINS, DESERT;
  var init_placeDesert = __esm({
    "../../../../src/renderer/src/watcher/placeDesert.ts"() {
      "use strict";
      init_nightScene();
      init_scenePlace();
      init_sceneDraw();
      DESERT_MOON = 1.6;
      frac = (x) => x - Math.floor(x);
      GRAINS = 60;
      DESERT = { draw: drawDesert, stars: 1.35, ambience: sandAmbience };
    }
  });

  // ../../../../src/renderer/src/watcher/placeHarbour.ts
  function harbourLamp(g) {
    const t = g.right, bw = towerWidth(t);
    return { x: t.x, y: t.y - t.h * 0.92 - 4 - bw * 0.55 };
  }
  function drawHarbour(fx, ax, g) {
    const W = g.width, H = g.height, R = seeded(19), seaY = seaLevel(g), edge = g.column.left - 14;
    const headland = (x0, x1, rise) => {
      const pts = [];
      for (let x = x0; x <= x1; x += 6) {
        const k = (x - x0) / (x1 - x0);
        pts.push([x, seaY - rise * Math.sin(Math.PI * k) ** 0.7 * (0.75 + 0.25 * Math.sin(x * 0.05))]);
      }
      fx.globalAlpha = 0.05;
      poly(fx, [...pts, [x1, seaY]]);
      fx.globalAlpha = 0.5;
      fx.lineWidth = 4;
      strokePts(fx, pts);
    };
    headland(-20, edge * 0.7, g.sky * 0.07);
    headland(W - Math.max(60, (W - g.column.right) * 0.45), W + 20, g.sky * 0.04);
    fx.globalAlpha = 0.55;
    fx.lineWidth = 3;
    strokePts(fx, [[0, seaY], [W, seaY]]);
    for (let y = seaY + 9; y < H + 8; y += 8 + (y - seaY) * 0.05) {
      const k = clamp((y - seaY) / Math.max(1, g.groundY - seaY), 0, 1);
      fx.globalAlpha = 0.28 + 0.3 * k;
      fx.lineWidth = 3 + 2.4 * k;
      for (let x = -R() * 40; x < W; ) {
        const len = 18 + R() * 60, yy = y + Math.sin(x * 0.04 + y) * 1.5;
        strokePts(fx, [[x, yy], [x + len * 0.5, yy - 1.2], [x + len, yy]]);
        x += len + 6 + R() * 26;
      }
    }
    const m = g.moon;
    for (let y = seaY + 4; y < g.groundY - 4; y += 6) {
      const k = (y - seaY) / Math.max(1, g.groundY - seaY), w = m.r * (0.4 + k * 1.4) * (0.5 + R() * 0.7);
      ax.globalAlpha = 0.85;
      ax.lineWidth = 3.5;
      strokePts(ax, [[m.x - w, y], [m.x + w, y]]);
      fx.globalAlpha = 0.3;
      fx.lineWidth = 3;
      strokePts(fx, [[m.x - w, y], [m.x + w, y]]);
    }
    drawMoon(fx, ax, m);
    drawShip(fx, ax, g);
    drawLighthouse(fx, ax, g);
    const face = Math.max(10, g.sky * 0.03);
    fx.fillStyle = MASK;
    fx.globalAlpha = 0.32;
    fx.beginPath();
    fx.moveTo(0, g.groundY);
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x));
    for (let x = W; x >= 0; x -= 10) fx.lineTo(x, groundAt(g, x) + face);
    fx.closePath();
    fx.fill();
    cutOut(fx, () => {
      fx.globalAlpha = 0.6;
      fx.lineWidth = 1.6;
      for (let x = 12 + R() * 10; x < W; x += 24 + R() * 10) {
        const y = groundAt(g, x);
        strokePts(fx, [[x, y + 4], [x, y + face - 1]]);
      }
    });
    fx.globalAlpha = 0.7;
    fx.lineWidth = 5;
    fx.beginPath();
    fx.moveTo(0, g.groundY);
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x));
    fx.stroke();
    for (const b of [g.branches.left, g.branches.right]) {
      const d = Math.sign(b.x1 - b.x0), w = Math.max(4, 6 * g.s);
      fx.globalAlpha = 0.8;
      fx.lineCap = "round";
      fx.lineWidth = w;
      strokeLimb(fx, b);
      fx.lineCap = "butt";
      const lx = b.x1 - d * 4 * g.s, top = limbY(b, lx), drop = 9 * g.s, lw = 5 * g.s, lh = 8 * g.s;
      fx.globalAlpha = 0.5;
      fx.lineWidth = 1.6;
      strokePts(fx, [[lx, top], [lx, top + drop]]);
      fx.globalAlpha = 0.55;
      fx.fillRect(lx - lw / 2, top + drop, lw, lh);
      ax.globalAlpha = 1;
      ax.fillRect(lx - lw / 2, top + drop, lw, lh);
    }
  }
  function drawShip(fx, ax, g) {
    const t = g.left, mastW = clamp(t.h * 0.022, 4, 12), top = t.y - t.h * 0.98;
    const gunwale = g.groundY - Math.max(12, g.sky * 0.045);
    const stern = t.x - t.h * 0.24, bow = Math.min(g.column.left - COLUMN_GAP - 10, t.x + t.h * 0.3);
    fx.globalAlpha = 0.5;
    poly(fx, [[stern, gunwale + 3], [lerp(stern, bow, 0.6), gunwale], [bow, gunwale - Math.max(6, g.sky * 0.02)], [bow - 8, g.groundY + 2], [stern, g.groundY + 2]]);
    fx.globalAlpha = 0.8;
    fx.lineWidth = 4.5;
    strokePts(fx, [[stern, gunwale + 3], [lerp(stern, bow, 0.6), gunwale], [bow, gunwale - Math.max(6, g.sky * 0.02)]]);
    const highest = Math.min(...t.limbs.map((l) => Math.min(l.y0, l.y1)));
    fx.globalAlpha = 0.82;
    fx.lineWidth = mastW;
    strokePts(fx, [[t.x, gunwale], [t.x, highest]]);
    fx.lineWidth = Math.max(2, mastW * 0.55);
    strokePts(fx, [[t.x, highest], [t.x, top]]);
    const nest = lerp(highest, top, 0.35), nw = Math.max(6, mastW * 2.2);
    fx.globalAlpha = 0.6;
    poly(fx, [[t.x - nw, nest - 5], [t.x + nw, nest - 5], [t.x + nw * 0.7, nest + 4], [t.x - nw * 0.7, nest + 4]]);
    fx.globalAlpha = 0.5;
    poly(fx, [[t.x, top + 2], [t.x + t.dir * Math.max(14, t.h * 0.05), top + 6], [t.x, top + 10]]);
    ellipse(ax, t.x, top - 2, 3, 3);
    fx.globalAlpha = 0.5;
    ellipse(fx, t.x, top - 2, 3, 3);
    for (const l of t.limbs) {
      const d = Math.sign(l.x1 - l.x0), back = (l.x1 - l.x0) * -0.35;
      const yard = { ...l, x0: l.x0 + back, y0: l.y0 - (l.y1 - l.y0) * 0.35 };
      fx.globalAlpha = 0.8;
      fx.lineCap = "round";
      fx.lineWidth = Math.max(4, t.h * 0.02);
      strokeLimb(fx, yard);
      fx.lineCap = "butt";
      const sail = alongLimb(yard).map(([x, y]) => [x, y + 3]);
      fx.globalAlpha = 0.34;
      poly(fx, [...sail, ...sail.slice().reverse().map(([x, y]) => [x, y + Math.max(4, t.h * 0.012)])]);
      fx.globalAlpha = 0.28;
      fx.lineWidth = 1.5;
      strokePts(fx, [[t.x, top + 8], [l.x1 - d * 3, limbY(l, l.x1)]]);
    }
    const lowest = Math.max(...t.limbs.map((l) => l.y0));
    fx.globalAlpha = 0.3;
    fx.lineWidth = 1.5;
    strokePts(fx, [[t.x, lowest - 4], [stern + 10, gunwale + 3]]);
    strokePts(fx, [[t.x, lowest - 4], [lerp(t.x, bow, 0.7), gunwale]]);
  }
  function drawLighthouse(fx, ax, g) {
    const t = g.right, bw = towerWidth(t), base = g.groundY + 2, topY = t.y - t.h * 0.92;
    fx.globalAlpha = 0.5;
    ellipse(fx, t.x, base, bw * 2.4, 8 + bw * 0.4);
    fx.globalAlpha = 0.56;
    poly(fx, [[t.x - bw, base], [t.x + bw, base], [t.x + bw * 0.62, topY], [t.x - bw * 0.62, topY]]);
    cutOut(fx, () => {
      fx.globalAlpha = 0.5;
      for (const k of [0.2, 0.6]) fx.fillRect(t.x - bw * 1.2, lerp(base, topY, k + 0.2), bw * 2.4, (base - topY) * 0.12);
    });
    fx.globalAlpha = 0.95;
    fx.fillRect(t.x - bw * 0.95, topY - 4, bw * 1.9, 5);
    fx.globalAlpha = 0.6;
    fx.fillRect(t.x - bw * 0.48, topY - 4 - bw * 1.1, bw * 0.96, bw * 1.1);
    ax.globalAlpha = 1;
    ax.fillRect(t.x - bw * 0.48, topY - 4 - bw * 1.1, bw * 0.96, bw * 1.1);
    fx.globalAlpha = 0.9;
    poly(fx, [[t.x - bw * 0.7, topY - 4 - bw * 1.1], [t.x + bw * 0.7, topY - 4 - bw * 1.1], [t.x, topY - 4 - bw * 1.9]]);
    for (const l of t.limbs) {
      const d = Math.sign(l.x1 - l.x0);
      fx.globalAlpha = 0.8;
      fx.lineWidth = Math.max(3.5, t.h * 0.014);
      strokeLimb(fx, l);
      const poleTop = l.y1 - Math.max(18, t.h * 0.06);
      fx.globalAlpha = 0.85;
      fx.lineWidth = Math.max(4, t.h * 0.016);
      strokePts(fx, [[l.x1, g.groundY], [l.x1, poleTop]]);
      fx.globalAlpha = 0.5;
      poly(fx, [[l.x1, poleTop], [l.x1 - d * Math.max(12, t.h * 0.04), poleTop + 5], [l.x1, poleTop + 10]]);
    }
  }
  function harbourAmbience(g) {
    const lamp = harbourLamp(g), seaY = seaLevel(g), m = g.moon, R = seeded(53);
    const right = g.width - lamp.x, left = Math.max(0, lamp.x - g.column.right - COLUMN_GAP);
    const glints = [];
    for (let k = 0; k < GLINTS; k++) {
      const y = lerp(seaY + 6, g.groundY - 8, R() ** 0.8), w = m.r * (0.4 + (y - seaY) / Math.max(1, g.groundY - seaY) * 1.4);
      glints.push({ x: m.x + (R() * 2 - 1) * w, y, phase: Math.floor(R() * 5), kind: R() });
    }
    return {
      steps: 8,
      most: BEAM.most + GLINTS + 5,
      cells(t, emit) {
        const th = t * BEAM.turn + 2.2, cs = Math.cos(th), side = cs >= 0 ? 1 : -1;
        const reach = Math.abs(cs) * (side > 0 ? right : left);
        let drawn = 0;
        if (reach > 16) {
          for (let dx = 10; dx <= reach && drawn < BEAM.most; dx += 7) {
            const half = Math.max(6, dx * BEAM.spread), yc = lamp.y - dx * 0.09;
            for (let dy = -half; dy <= half && drawn < BEAM.most; dy += 12) {
              const off = dy / half, s = 0.75 * (1 - dx / (reach + 1)) ** 0.8 * (1 - off * off) * Math.min(1, Math.abs(cs) * 1.6);
              if (s < 0.1) continue;
              emit(lamp.x + side * dx, yc + dy, s > 0.5 ? "=" : s > 0.32 ? "-" : s > 0.2 ? ":" : "·", true, 0.2 + 0.7 * s, false);
              drawn++;
            }
          }
        }
        const flash = Math.max(0, 1 - Math.abs(cs) * 3);
        if (flash > 0.05) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0]]) emit(lamp.x + dx * 7, lamp.y + dy * 12, Math.abs(dx) > 1 ? "·" : "*", true, 0.3 + 0.6 * flash, false);
        const step = Math.floor(t * 2.4);
        for (const glint of glints) {
          if (wrap(glint.phase + step, 5) !== 0) continue;
          emit(glint.x, glint.y, glint.kind > 0.6 ? "∘" : glint.kind > 0.3 ? "·" : "-", true, 0.5 + 0.3 * glint.kind, true);
        }
      }
    };
  }
  var seaLevel, towerWidth, BEAM, GLINTS, HARBOUR;
  var init_placeHarbour = __esm({
    "../../../../src/renderer/src/watcher/placeHarbour.ts"() {
      "use strict";
      init_nightScene();
      init_scenePlace();
      init_sceneDraw();
      seaLevel = (g) => g.horizon + g.sky * 0.06;
      towerWidth = (t) => clamp(t.h * 0.055, 7, 22);
      BEAM = { spread: 0.1, turn: 0.45, most: 140 };
      GLINTS = 40;
      HARBOUR = {
        draw: drawHarbour,
        stars: 1,
        ambience: harbourAmbience
      };
    }
  });

  // ../../../../src/renderer/src/watcher/placeNightWood.ts
  function drawNightWood(fx, ax, g) {
    const W = g.width, H = g.height, sky = g.sky, edge = g.column.left - 14;
    const R = seeded(7);
    const hill = (base, amp, seed, alpha, fade, ridge) => {
      const r = seeded(seed), ph = [r() * 6, r() * 6, r() * 6];
      fx.globalAlpha = alpha;
      fx.beginPath();
      fx.moveTo(0, g.groundY + 2);
      for (let x = 0; x <= W; x += 6) {
        const k = x / W;
        const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp;
        fx.lineTo(x, base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2])));
      }
      fx.lineTo(W, g.groundY + 2);
      fx.closePath();
      fx.fill();
      fx.globalAlpha = ridge;
      fx.lineWidth = 5;
      fx.stroke();
    };
    hill(g.horizon, sky * 0.22, 11, 0.03, 0.6, 0.45);
    hill(g.horizon + sky * 0.1, sky * 0.16, 23, 0.04, 0.5, 0.55);
    hill(g.groundY - sky * 0.04, sky * 0.12, 37, 0.05, 0.42, 0.65);
    fx.globalAlpha = 0.3;
    fx.lineWidth = 3.5;
    for (let i = 0; i < 6; i++) {
      const y = g.groundY - sky * 0.05 + i * 11 - 30;
      fx.beginPath();
      fx.moveTo(0, y + 26);
      fx.quadraticCurveTo(edge * 0.45, y, edge * 0.9, y + 16);
      fx.stroke();
    }
    const river = new Path2D();
    river.moveTo(edge * 0.8, g.horizon + 6);
    river.bezierCurveTo(edge * 0.55, g.horizon + sky * 0.14, edge * 0.7, g.groundY - sky * 0.03, edge * 0.35, g.groundY + 20);
    river.quadraticCurveTo(edge * 0.12, g.groundY + 45, -10, H);
    fx.globalCompositeOperation = "destination-out";
    for (const [w, a] of [[5, 1], [12, 0.6]]) {
      fx.lineWidth = w;
      fx.globalAlpha = a;
      fx.stroke(river);
    }
    fx.globalCompositeOperation = "source-over";
    ax.globalAlpha = 0.7;
    ax.lineWidth = 5;
    ax.stroke(river);
    fx.globalAlpha = 0.22;
    fx.lineWidth = 4;
    fx.stroke(river);
    for (let i = 0; i < 9; i++) {
      const x = edge * (0.15 + R() * 0.8), y = g.horizon + sky * (0.03 + R() * 0.12), h = 10 + R() * 14;
      fx.globalAlpha = 0.4;
      fx.beginPath();
      fx.moveTo(x, y - h);
      fx.lineTo(x + h * 0.35, y);
      fx.lineTo(x - h * 0.35, y);
      fx.fill();
    }
    const grad = fx.createLinearGradient(0, g.groundY, 0, H);
    grad.addColorStop(0, "rgba(0, 0, 0, 0.07)");
    grad.addColorStop(0.4, "rgba(0, 0, 0, 0.03)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    fx.globalAlpha = 1;
    fx.fillStyle = grad;
    fx.beginPath();
    fx.moveTo(0, g.groundY);
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x));
    fx.lineTo(W, H);
    fx.lineTo(0, H);
    fx.closePath();
    fx.fill();
    fx.fillStyle = MASK;
    fx.globalAlpha = 0.6;
    fx.lineWidth = 5;
    fx.beginPath();
    fx.moveTo(0, g.groundY);
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x));
    fx.stroke();
    fx.lineWidth = 3;
    fx.globalAlpha = 0.45;
    for (let x = 4; x < W; x += 5 + R() * 9) {
      const h = 4 + R() * 9, y = g.groundY + Math.sin(x * 0.013) * 3;
      fx.beginPath();
      fx.moveTo(x, y + 2);
      fx.lineTo(x + (R() - 0.5) * 5, y - h);
      fx.stroke();
    }
    drawMoon(fx, ax, g.moon);
    const spots = [...g.spots.filter((spot) => spot.kind === "tree"), g.home];
    drawTree(fx, g.left, 101, true, spots);
    drawTree(fx, g.right, 202, false, []);
    for (const b of [g.branches.left, g.branches.right]) {
      const d = Math.sign(b.x1 - b.x0), w = Math.max(5, 7 * g.s);
      fx.globalAlpha = 0.8;
      fx.lineCap = "round";
      fx.lineWidth = w;
      strokeLimb(fx, b);
      fx.lineWidth = Math.max(2.5, w * 0.4);
      fx.beginPath();
      fx.moveTo(b.x1 - d * 10, limbY(b, b.x1 - d * 10));
      fx.lineTo(b.x1 + d * 6, b.y1 - 16 * g.s);
      fx.stroke();
      fx.globalAlpha = 0.18;
      for (const [dx, dy, r] of [[6, -18, 9], [-2, -10, 7], [14, -8, 6]]) {
        fx.beginPath();
        fx.arc(b.x1 + d * dx * g.s, b.y1 + dy * g.s, r * g.s, 0, 7);
        fx.fill();
      }
    }
  }
  function drawTree(fx, t, seed, leaves, clear) {
    const r = seeded(seed), dir = t.dir;
    const w0 = t.h * 0.05;
    const topX = t.x - dir * t.h * 0.03, topY = t.y - t.h * 0.6;
    fx.globalAlpha = 0.72;
    fx.beginPath();
    fx.moveTo(t.x - w0 * 2.2, t.y);
    fx.quadraticCurveTo(t.x - w0 * 0.9, t.y - w0 * 0.6, t.x - w0 * 0.8, t.y - t.h * 0.12);
    fx.quadraticCurveTo(t.x - w0 * 0.7, topY + t.h * 0.15, topX - w0 * 0.4, topY);
    fx.lineTo(topX + w0 * 0.4, topY);
    fx.quadraticCurveTo(t.x + w0 * 0.7, topY + t.h * 0.15, t.x + w0 * 0.8, t.y - t.h * 0.12);
    fx.quadraticCurveTo(t.x + w0 * 0.9, t.y - w0 * 0.6, t.x + w0 * 2.2, t.y);
    fx.closePath();
    fx.fill();
    fx.lineCap = "round";
    const tips = [];
    const branch = (x, y, len, ang, w, depth, max2) => {
      const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len;
      const bend = (r() - 0.5) * len * 0.35;
      fx.globalAlpha = 0.7;
      fx.lineWidth = Math.max(2.6, w);
      fx.beginPath();
      fx.moveTo(x, y);
      fx.quadraticCurveTo((x + x1) / 2 - Math.sin(ang) * bend, (y + y1) / 2 + Math.cos(ang) * bend, x1, y1);
      fx.stroke();
      if (depth >= max2) {
        tips.push([x1, y1, len]);
        return;
      }
      const n = r() > 0.6 ? 3 : 2;
      for (let k = 0; k < n; k++) branch(x1, y1, len * (0.68 + r() * 0.12), ang + (k - (n - 1) / 2) * (0.55 + r() * 0.25) + (r() - 0.5) * 0.2, w * 0.64, depth + 1, max2);
    };
    const max = leaves ? 4 : 5;
    branch(topX, topY, t.h * 0.17, -Math.PI / 2 - dir * 0.18, w0 * 0.8, 0, max);
    branch(topX, topY + t.h * 0.03, t.h * 0.13, -Math.PI / 2 + dir * 0.7, w0 * 0.55, 1, max);
    branch(topX, topY + t.h * 0.06, t.h * 0.14, -Math.PI / 2 - dir * 1, w0 * 0.55, 1, max);
    for (const l of t.limbs) {
      fx.globalAlpha = 0.75;
      fx.lineWidth = w0 * 0.42;
      strokeLimb(fx, l);
      const d = Math.sign(l.x1 - l.x0);
      fx.lineWidth = Math.max(1, w0 * 0.16);
      fx.beginPath();
      fx.moveTo(l.x1 - d * 14, limbY(l, l.x1 - d * 14));
      fx.lineTo(l.x1 - d * 2, limbY(l, l.x1) - 16);
      fx.stroke();
    }
    if (leaves) {
      for (const [x, y, len] of tips) {
        if (clear.some((spot) => Math.hypot(x - spot.x, y - spot.y) < 46) || r() < 0.45) continue;
        for (let k = 0; k < 2; k++) {
          fx.globalAlpha = 0.1;
          fx.beginPath();
          fx.arc(x + (r() - 0.5) * len, y + (r() - 0.5) * len * 0.7, len * (0.45 + r() * 0.4), 0, 7);
          fx.fill();
        }
      }
      fx.globalCompositeOperation = "destination-out";
      fx.globalAlpha = 0.3;
      for (const [x, y, len] of tips) {
        fx.beginPath();
        fx.arc(x + (r() - 0.5) * len, y + (r() - 0.5) * len, len * 0.18, 0, 7);
        fx.fill();
      }
      fx.globalCompositeOperation = "source-over";
    }
  }
  var NIGHT_WOOD;
  var init_placeNightWood = __esm({
    "../../../../src/renderer/src/watcher/placeNightWood.ts"() {
      init_nightScene();
      init_sceneDraw();
      NIGHT_WOOD = { draw: drawNightWood, stars: 1, ambience: null };
    }
  });

  // ../../../../src/renderer/src/watcher/placeSnowfield.ts
  function drawSnowfield(fx, ax, g) {
    const W = g.width, H = g.height, sky = g.sky, R = seeded(41), edge = g.column.left - 14;
    drawAurora(fx, ax, g);
    const peaks = [];
    for (let x = -40; x < W + 80; x += 60 + R() * 90) peaks.push([x, g.horizon - sky * (0.06 + R() * 0.16)]);
    const outline = [];
    for (let k = 0; k < peaks.length - 1; k++) {
      const a = peaks[k], b = peaks[k + 1];
      outline.push(a, [(a[0] + b[0]) / 2, g.horizon + sky * 0.02 - R() * sky * 0.05]);
    }
    fx.globalAlpha = 0.04;
    poly(fx, [[-40, g.groundY], ...outline, [W + 80, g.groundY]]);
    fx.globalAlpha = 0.48;
    fx.lineWidth = 4;
    strokePts(fx, outline);
    for (const [x, y] of peaks) {
      const h = (g.horizon - y) * 0.38;
      fx.globalAlpha = 0.2;
      poly(fx, [[x, y], [x + h * 0.9, y + h], [x + h * 0.3, y + h * 0.75], [x - h * 0.2, y + h * 1.05], [x - h * 0.9, y + h]]);
    }
    const roll = (base, amp, seed, alpha, ridge) => {
      const r = seeded(seed), ph = r() * 6;
      fx.globalAlpha = alpha;
      fx.beginPath();
      fx.moveTo(0, g.groundY + 2);
      const pts = [];
      for (let x = 0; x <= W; x += 6) pts.push([x, base - amp * (0.5 + 0.35 * Math.sin(x / W * 5 + ph) + 0.15 * Math.sin(x / W * 13 + ph * 2))]);
      for (const [x, y] of pts) fx.lineTo(x, y);
      fx.lineTo(W, g.groundY + 2);
      fx.closePath();
      fx.fill();
      fx.globalAlpha = ridge;
      fx.lineWidth = 4;
      strokePts(fx, pts);
    };
    roll(g.horizon + sky * 0.12, sky * 0.08, 61, 0.03, 0.42);
    roll(g.groundY - sky * 0.05, sky * 0.07, 67, 0.04, 0.5);
    for (let i = 0; i < 8; i++) {
      const x = edge * (0.12 + R() * 0.82), y = g.horizon + sky * (0.06 + R() * 0.1), h = 10 + R() * 14;
      fx.globalAlpha = 0.42;
      poly(fx, [[x, y - h], [x + h * 0.32, y], [x - h * 0.32, y]]);
      cutOut(fx, () => {
        fx.globalAlpha = 0.5;
        fx.lineWidth = 1.5;
        strokePts(fx, [[x - h * 0.2, y - h * 0.35], [x + h * 0.2, y - h * 0.35]]);
      });
    }
    const ground = [];
    for (let x = 0; x <= W; x += 8) ground.push([x, groundAt(g, x)]);
    const grad = fx.createLinearGradient(0, g.groundY, 0, H);
    grad.addColorStop(0, "rgba(0, 0, 0, 0.08)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.01)");
    fx.globalAlpha = 1;
    fx.fillStyle = grad;
    poly(fx, [...ground, [W, H], [0, H]]);
    fx.fillStyle = MASK;
    fx.globalAlpha = 0.6;
    fx.lineWidth = 4.5;
    strokePts(fx, ground);
    fx.globalAlpha = 0.26;
    fx.lineWidth = 2.5;
    for (let k = 1; k < 4; k++) {
      const d = [];
      for (let x = 0; x <= W; x += 10) d.push([x, g.groundY + k * (H - g.groundY) / 4 + Math.sin(x * 0.02 + k * 2) * 3]);
      strokePts(fx, d);
    }
    drawMoon(fx, ax, g.moon);
    const clear = [...g.spots.filter((spot) => spot.kind === "tree" || spot.kind === "limb"), g.home, g.visit];
    drawPine(fx, g.left, 0.2, clear, g.s);
    drawPine(fx, g.right, 0.15, clear, g.s);
    for (const b of [g.branches.left, g.branches.right]) bough(fx, b, Math.max(4, 6 * g.s), g.s);
  }
  function drawAurora(fx, ax, g) {
    const base = g.header + g.sky * 0.1, amp = g.sky * 0.035, m = g.moon;
    for (let x = 0; x <= g.width; x += 4) {
      const top = base + Math.sin(x * 6e-3 + 0.8) * amp + Math.sin(x * 0.017 + 1.3) * amp * 0.6;
      const bright = 0.5 + 0.5 * Math.sin(x * 0.045 + Math.sin(x * 0.011) * 2.2);
      if (bright < 0.25) continue;
      const len = g.sky * (0.06 + 0.1 * bright);
      fx.globalAlpha = 0.3 * bright;
      fx.lineWidth = 3;
      strokePts(fx, [[x, top], [x, top + len]]);
      ax.globalAlpha = 0.9;
      ax.lineWidth = 3;
      strokePts(ax, [[x, top], [x, top + len]]);
    }
    for (const field of [fx, ax]) cutOut(field, () => {
      field.globalAlpha = 1;
      ellipse(field, m.x, m.y, m.r * 1.5, m.r * 1.5);
    });
  }
  function drawPine(fx, t, spread, clear, s) {
    const top = t.y - t.h, foot = t.y - t.h * 0.28, trunk = clamp(t.h * 0.03, 4, 14);
    fx.globalAlpha = 0.8;
    poly(fx, [[t.x - trunk, t.y], [t.x + trunk, t.y], [t.x + trunk * 0.3, top], [t.x - trunk * 0.3, top]]);
    const tiers = 6;
    for (let k = 0; k < tiers; k++) {
      const u = k / (tiers - 1), y0 = lerp(top, foot - t.h * 0.12, u), y1 = y0 + t.h * (0.12 + 0.05 * u);
      const half = t.h * lerp(0.04, spread, u);
      const tier = [[t.x, y0], [t.x + half, y1], [t.x + half * 0.45, y1 - t.h * 0.02], [t.x, y1 + t.h * 0.01], [t.x - half * 0.45, y1 - t.h * 0.02], [t.x - half, y1]];
      fx.globalAlpha = 0.4;
      poly(fx, tier);
      fx.globalAlpha = 0.7;
      fx.lineWidth = 4;
      strokePts(fx, [[t.x - half, y1], [t.x, y0], [t.x + half, y1]]);
      cutOut(fx, () => {
        fx.globalAlpha = 0.45;
        fx.lineWidth = 2.5;
        strokePts(fx, [[t.x - half * 0.9, y1 - 4], [t.x - half * 0.4, y1 - t.h * 0.02 - 4], [t.x, y1 + t.h * 0.01 - 4], [t.x + half * 0.4, y1 - t.h * 0.02 - 4], [t.x + half * 0.9, y1 - 4]]);
      });
    }
    cutOut(fx, () => {
      fx.globalAlpha = 1;
      for (const spot of clear) ellipse(fx, spot.x, spot.y - 18 * s, 24 * s + 6, 26 * s + 8);
    });
    for (const l of t.limbs) bough(fx, l, Math.max(4, t.h * 0.02), s);
  }
  function bough(fx, l, w, s) {
    const d = Math.sign(l.x1 - l.x0);
    fx.globalAlpha = 0.78;
    fx.lineCap = "round";
    fx.lineWidth = w;
    strokeLimb(fx, l);
    fx.lineCap = "butt";
    fx.globalAlpha = 0.35;
    fx.lineWidth = 3;
    strokeLimb(fx, { ...l, y0: l.y0 - w * 0.6 - 1, y1: l.y1 - w * 0.6 - 1 });
    fx.globalAlpha = 0.42;
    fx.lineWidth = 2;
    const len = Math.abs(l.x1 - l.x0);
    for (let k = 10; k < len - 4; k += 9) {
      const x = l.x0 + d * k, y = limbY(l, x) + w * 0.4, droop = lerp(5, 9, smooth(0, len, k)) * Math.max(1, s);
      strokePts(fx, [[x, y], [x + d * 3, y + droop]]);
    }
    fx.globalAlpha = 0.3;
    ellipse(fx, l.x1, limbY(l, l.x1) - w * 0.4, 6 * s, 3.5 * s);
  }
  function snowAmbience(g) {
    const R = seeded(31), span = Math.max(1, g.height - g.header);
    const flakes = Array.from({ length: FLAKES }, () => ({ x0: R() * g.width, y0: R() * span, v: 14 + R() * 18, amp: 6 + R() * 14, ph: R() * 6.28, size: R() }));
    return {
      steps: 8,
      most: FLAKES,
      cells(t, emit) {
        for (const f of flakes) {
          const y = g.header + wrap(f.y0 + f.v * t, span), x = wrap(f.x0 + Math.sin(t * 0.7 + f.ph) * f.amp + 6 * t, g.width);
          emit(x, y, f.size > 0.78 ? "*" : f.size > 0.4 ? "·" : ".", false, 0.4 + 0.45 * f.size, false);
        }
      }
    };
  }
  var FLAKES, SNOWFIELD;
  var init_placeSnowfield = __esm({
    "../../../../src/renderer/src/watcher/placeSnowfield.ts"() {
      "use strict";
      init_nightScene();
      init_scenePlace();
      init_sceneDraw();
      FLAKES = 90;
      SNOWFIELD = { draw: drawSnowfield, stars: 1.2, ambience: snowAmbience };
    }
  });

  // ../../../../src/renderer/src/watcher/scenePlaces.ts
  var SCENE_PLACES;
  var init_scenePlaces = __esm({
    "../../../../src/renderer/src/watcher/scenePlaces.ts"() {
      init_placeDesert();
      init_placeHarbour();
      init_placeNightWood();
      init_placeSnowfield();
      SCENE_PLACES = {
        "night-wood": NIGHT_WOOD,
        harbour: HARBOUR,
        snowfield: SNOWFIELD,
        desert: DESERT
      };
    }
  });

  // proto/woodLayers.ts
  function drawWoodLayers(target, ax, g, apart) {
    const W = g.width, H = g.height, sky = g.sky, edge = g.column.left - 14;
    const R = seeded(7);
    const hill = (fx2, base, amp, seed, alpha, fade, ridge) => {
      const r = seeded(seed), ph = [r() * 6, r() * 6, r() * 6];
      fx2.globalAlpha = alpha;
      fx2.beginPath();
      fx2.moveTo(0, g.groundY + 2);
      for (let x = 0; x <= W; x += 6) {
        const k = x / W;
        const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp;
        fx2.lineTo(x, base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2])));
      }
      fx2.lineTo(W, g.groundY + 2);
      fx2.closePath();
      fx2.fill();
      fx2.globalAlpha = ridge;
      fx2.lineWidth = 5;
      if (!apart) {
        fx2.stroke();
        return;
      }
      fx2.beginPath();
      for (let x = 0; x <= W; x += 6) {
        const k = x / W;
        const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp;
        const y = base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2]));
        if (x === 0) fx2.moveTo(x, y);
        else fx2.lineTo(x, y);
      }
      fx2.stroke();
    };
    hill(target("far"), g.horizon, sky * 0.22, 11, 0.03, 0.6, 0.45);
    hill(target("mid"), g.horizon + sky * 0.1, sky * 0.16, 23, 0.04, 0.5, 0.55);
    hill(target("near"), g.groundY - sky * 0.04, sky * 0.12, 37, 0.05, 0.42, 0.65);
    let fx = target("near");
    fx.globalAlpha = 0.3;
    fx.lineWidth = 3.5;
    for (let i = 0; i < 6; i++) {
      const y = g.groundY - sky * 0.05 + i * 11 - 30;
      fx.beginPath();
      fx.moveTo(0, y + 26);
      fx.quadraticCurveTo(edge * 0.45, y, edge * 0.9, y + 16);
      fx.stroke();
    }
    const river = new Path2D();
    river.moveTo(edge * 0.8, g.horizon + 6);
    river.bezierCurveTo(edge * 0.55, g.horizon + sky * 0.14, edge * 0.7, g.groundY - sky * 0.03, edge * 0.35, g.groundY + 20);
    river.quadraticCurveTo(edge * 0.12, g.groundY + 45, -10, H);
    for (const layer of ["far", "mid", "near"]) {
      fx = target(layer);
      fx.globalCompositeOperation = "destination-out";
      for (const [w, a] of [[5, 1], [12, 0.6]]) {
        fx.lineWidth = w;
        fx.globalAlpha = a;
        fx.stroke(river);
      }
      fx.globalCompositeOperation = "source-over";
    }
    ax.globalAlpha = 0.7;
    ax.lineWidth = 5;
    ax.stroke(river);
    fx = target("river");
    fx.globalAlpha = 0.22;
    fx.lineWidth = 4;
    fx.stroke(river);
    fx = target("far");
    for (let i = 0; i < 9; i++) {
      const x = edge * (0.15 + R() * 0.8), y = g.horizon + sky * (0.03 + R() * 0.12), h = 10 + R() * 14;
      fx.globalAlpha = 0.4;
      fx.beginPath();
      fx.moveTo(x, y - h);
      fx.lineTo(x + h * 0.35, y);
      fx.lineTo(x - h * 0.35, y);
      fx.fill();
    }
    fx = target("ground");
    const grad = fx.createLinearGradient(0, g.groundY, 0, H);
    grad.addColorStop(0, "rgba(0, 0, 0, 0.07)");
    grad.addColorStop(0.4, "rgba(0, 0, 0, 0.03)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    fx.globalAlpha = 1;
    fx.fillStyle = grad;
    fx.beginPath();
    fx.moveTo(0, g.groundY);
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x));
    fx.lineTo(W, H);
    fx.lineTo(0, H);
    fx.closePath();
    fx.fill();
    fx.fillStyle = MASK;
    fx.globalAlpha = apart ? 0.95 : 0.6;
    fx.lineWidth = apart ? 7 : 5;
    fx.beginPath();
    fx.moveTo(0, g.groundY);
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x));
    fx.stroke();
    fx.lineWidth = 3;
    fx.globalAlpha = 0.45;
    for (let x = 4; x < W; x += 5 + R() * 9) {
      const h = 4 + R() * 9, y = g.groundY + Math.sin(x * 0.013) * 3;
      fx.beginPath();
      fx.moveTo(x, y + 2);
      fx.lineTo(x + (R() - 0.5) * 5, y - h);
      fx.stroke();
    }
    drawMoon(target("moon"), ax, g.moon);
    const spots = [...g.spots.filter((spot) => spot.kind === "tree"), g.home];
    drawTree(target("tree"), g.left, 101, true, spots);
    drawTree(target("bare"), g.right, 202, false, []);
    fx = target("branch");
    for (const b of [g.branches.left, g.branches.right]) {
      const d = Math.sign(b.x1 - b.x0), w = Math.max(5, 7 * g.s);
      fx.globalAlpha = 0.8;
      fx.lineCap = "round";
      fx.lineWidth = w;
      strokeLimb(fx, b);
      fx.lineWidth = Math.max(2.5, w * 0.4);
      fx.beginPath();
      fx.moveTo(b.x1 - d * 10, limbY(b, b.x1 - d * 10));
      fx.lineTo(b.x1 + d * 6, b.y1 - 16 * g.s);
      fx.stroke();
      fx.globalAlpha = 0.18;
      for (const [dx, dy, r] of [[6, -18, 9], [-2, -10, 7], [14, -8, 6]]) {
        fx.beginPath();
        fx.arc(b.x1 + d * dx * g.s, b.y1 + dy * g.s, r * g.s, 0, 7);
        fx.fill();
      }
    }
  }
  var WOOD_LAYERS, LAYER_TONE;
  var init_woodLayers = __esm({
    "proto/woodLayers.ts"() {
      "use strict";
      init_nightScene();
      init_placeNightWood();
      init_sceneDraw();
      WOOD_LAYERS = ["moon", "far", "mid", "near", "river", "ground", "bare", "tree", "branch"];
      LAYER_TONE = { moon: 1.3, far: 0.5, mid: 0.64, near: 0.78, river: 0.9, ground: 0.92, bare: 0.9, tree: 1.08, branch: 1.08 };
    }
  });

  // proto/painterLook.ts
  function pickGlyph(px, at, shape, noise, out) {
    let sum = 0, most = 0;
    for (let k = 0; k < CELL_PX; k++) {
      const v = px[at + k];
      sum += v;
      if (v > most) most = v;
    }
    const mean = sum / (CELL_PX * 255);
    out.code = 0;
    out.strength = 0;
    const fill = () => {
      if (mean < 0.1) return out;
      const dd = clamp(mean + (noise - 0.5) * 0.1, 0, 1);
      out.code = rampGlyph(dd).charCodeAt(0);
      out.strength = 0.1 + 0.5 * dd;
      return out;
    };
    if (!shape || most < 46) return fill();
    const cover = sum / (CELL_PX * most);
    if (cover > 0.6 || cover < 0.06) return fill();
    let mx = 0, my = 0;
    for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) {
      const w = px[at + y * PX + x];
      mx += w * (x + 0.5) / PX;
      my += w * (y + 0.5) / PY;
    }
    mx /= sum;
    my /= sum;
    let sxx = 0, syy = 0, sxy = 0;
    for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) {
      const w = px[at + y * PX + x], dx = (x + 0.5) / PX - mx, dy = (y + 0.5) / PY - my;
      sxx += w * dx * dx;
      syy += w * dy * dy;
      sxy += w * dx * dy;
    }
    sxx /= sum;
    syy /= sum;
    sxy /= sum;
    const spread = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy), along2 = (sxx + syy + spread) / 2, across = (sxx + syy - spread) / 2;
    if (along2 <= 0 || (along2 - across) / (along2 + across) < 0.56) return fill();
    const degrees = 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI, level = my;
    let glyph = null;
    if (Math.abs(degrees) < 22.5) {
      if (Math.sqrt(across * 12) > 0.55) glyph = "=";
      else if (level < 0.25) {
        out.code = RAISED;
        out.strength = Math.min(1, 0.16 + 0.62 * most / 255);
        return out;
      } else glyph = level < 0.7 ? "-" : "_";
    } else if (Math.abs(degrees) < 67.5) glyph = degrees > 0 ? "\\" : "/";
    else glyph = Math.sqrt(along2 * 12) < 0.6 ? level < 0.4 ? "'" : level > 0.62 ? "," : "|" : "|";
    out.code = glyph.charCodeAt(0);
    out.strength = Math.min(1, 0.16 + 0.62 * most / 255);
    return out;
  }
  function context(canvas, read = false) {
    return canvas.getContext("2d", read ? { willReadFrequently: true } : void 0);
  }
  function makeCanvas() {
    return document.createElement("canvas");
  }
  function readField(ctx, out, grid, c0, r0, cn, rn) {
    if (cn <= 0 || rn <= 0) return;
    const data = ctx.getImageData(c0 * SS, r0 * SS, cn * SS, rn * SS).data;
    const stride = cn * SS;
    for (let r = 0; r < rn; r++) for (let c = 0; c < cn; c++) {
      let sum = 0;
      for (let y = 0; y < SS; y++) for (let x = 0; x < SS; x++) sum += data[((r * SS + y) * stride + c * SS + x) * 4 + 3];
      out[(r0 + r) * grid.cols + c0 + c] = sum / (SS * SS * 255);
    }
  }
  function prepare(ctx, grid, layout) {
    ctx.setTransform(SS / grid.cw, 0, 0, SS / grid.ch, 0, 0);
    ctx.clearRect(-layout.width, -layout.height, layout.width * 3, layout.height * 3);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = MASK;
    ctx.strokeStyle = MASK;
  }
  function ellipse2(ctx, x, y, rx, ry, rot = 0) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    ctx.fill();
  }
  function wing(d, side, o) {
    const span = 12 + 52 * o.spread;
    const lift = Math.sin(o.flap) * span * 0.55;
    const persp = 0.8 + 0.2 * Math.cos(o.flap);
    const sx = side * 9, sy = -3;
    const tx = side * (9 + span * persp), ty = sy - lift;
    const rx = side * 7, ry = sy + 17 - lift * 0.15;
    d.globalAlpha = 0.72;
    d.beginPath();
    d.moveTo(sx, sy - 5);
    d.quadraticCurveTo(side * (9 + span * 0.5 * persp), sy - lift * 0.8 - 10, tx, ty);
    let px = tx, py = ty;
    for (let k = 1; k <= 5; k++) {
      const t = k / 5;
      const nx = lerp(tx, rx, t), ny = lerp(ty, ry, t) + Math.sin(t * Math.PI) * 7;
      d.quadraticCurveTo((px + nx) / 2, (py + ny) / 2 + 5, nx, ny);
      px = nx;
      py = ny;
    }
    d.closePath();
    d.fill();
    d.globalCompositeOperation = "destination-out";
    d.globalAlpha = 0.32;
    d.lineWidth = 1.6;
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      d.beginPath();
      d.moveTo(lerp(sx, tx, t), lerp(sy - 3, ty, t));
      d.lineTo(lerp(sx, tx, t * 0.85), lerp(sy + 12, ty + 6, t));
      d.stroke();
    }
    d.globalCompositeOperation = "source-over";
  }
  function drawOwl(d, a, o) {
    for (const ctx of [d, a]) {
      ctx.save();
      ctx.translate(o.x, o.y - 30 * o.s);
      ctx.rotate(o.bank);
      ctx.scale(o.s, o.s * o.squash);
      ctx.translate(0, 30 * (1 - o.squash));
    }
    const fly = o.spread > 0.05;
    d.globalAlpha = 0.9;
    poly(d, [[-5, 22], [5, 22], [fly ? 8 : 4, fly ? 33 : 31], [fly ? -8 : -4, fly ? 33 : 31]]);
    if (fly) {
      wing(d, -1, o);
      wing(d, 1, o);
    }
    d.globalAlpha = 0.5;
    ellipse2(d, 0, 6, fly ? 14 : 17, fly ? 19 : 22);
    if (!fly) {
      d.globalAlpha = 0.85;
      ellipse2(d, -13.5, 7, 6.5, 18, 0.12);
      ellipse2(d, 13.5, 7, 6.5, 18, -0.12);
    }
    d.globalCompositeOperation = "destination-out";
    d.globalAlpha = 0.55;
    d.lineWidth = 1.5;
    for (let row = 0; row < 4; row++) for (let k = -1; k <= 1; k++) {
      const x = k * 6 + row % 2 * 3 - 1.5, y = 1 + row * 5.5;
      if (Math.abs(x) > 9 - row) continue;
      d.beginPath();
      d.moveTo(x - 2.2, y);
      d.lineTo(x, y + 2);
      d.lineTo(x + 2.2, y);
      d.stroke();
    }
    d.globalCompositeOperation = "source-over";
    const hx = o.turn * 4;
    d.globalAlpha = 0.62;
    ellipse2(d, hx * 0.5, -17, 16, 13);
    d.globalAlpha = 0.85;
    const tuft = fly ? -31 : -37;
    poly(d, [[-12 + hx, -25], [-18 + hx * 1.2, tuft], [-5 + hx, -28]]);
    poly(d, [[12 + hx, -25], [18 + hx * 1.2, tuft], [5 + hx, -28]]);
    const sp = 6.6 * (1 - 0.22 * Math.abs(o.turn));
    d.globalCompositeOperation = "destination-out";
    d.globalAlpha = 0.6;
    ellipse2(d, hx - sp, -17, 6.8, 6.8);
    ellipse2(d, hx + sp, -17, 6.8, 6.8);
    d.globalCompositeOperation = "source-over";
    for (const side of [-1, 1]) {
      const ex = hx + side * sp, ey = -17;
      if (o.blink) {
        d.globalAlpha = 0.9;
        ellipse2(d, ex, ey + 0.5, 4.8, 1.5);
      } else {
        d.globalAlpha = 1;
        ellipse2(d, ex + o.gx, ey + o.gy, 3.2, 3.2);
        a.globalAlpha = 1;
        ellipse2(a, ex + o.gx, ey + o.gy, 3.8, 3.8);
      }
    }
    d.globalAlpha = 1;
    poly(d, [[hx - 1.9, -13], [hx + 1.9, -13], [hx, -8.3]]);
    d.lineCap = "round";
    d.lineWidth = 1.7;
    if (!fly) {
      for (const side of [-1, 1]) for (const t of [-2, 0, 2]) {
        d.beginPath();
        d.moveTo(side * 5, 27);
        d.lineTo(side * 5 + t, 30.5);
        d.stroke();
      }
    } else if (o.legs > 0) {
      for (const side of [-1, 1]) {
        const fy = 24 + 9 * o.legs;
        d.beginPath();
        d.moveTo(side * 4, 22);
        d.lineTo(side * 5, fy);
        d.stroke();
        for (const t of [-2.2, 0, 2.2]) {
          d.beginPath();
          d.moveTo(side * 5, fy);
          d.lineTo(side * 5 + t, fy + 3);
          d.stroke();
        }
      }
    }
    d.restore();
    a.restore();
  }
  var PX, PY, CELL_PX, RAISED, SS, GLYPH_PX, NightScenePainter;
  var init_painterLook = __esm({
    "proto/painterLook.ts"() {
      "use strict";
      init_nightScene();
      init_owlFamilyLife();
      init_scenePlace();
      init_scenePlaces();
      init_sceneDraw();
      init_life();
      init_woodLayers();
      PX = 6;
      PY = 10;
      CELL_PX = PX * PY;
      RAISED = 1;
      SS = 2;
      GLYPH_PX = 10.5;
      NightScenePainter = class {
        constructor(back, front) {
          this.back = back;
          this.front = front;
        }
        layout = null;
        grid = { cols: 0, rows: 0, cw: 7, ch: 12 };
        dpr = 1;
        ink = null;
        font = "";
        land = new Float32Array(0);
        landAccent = new Float32Array(0);
        /** Each cell's share of the scene: quietAt, for the theme's column strength. */
        quiet = new Float32Array(0);
        /** Cells in a margin, the only ones a ripple or the whirlpool reaches, and the only ones past the column's ink ceiling. */
        marginCells = new Uint8Array(0);
        light = false;
        /** Cells an owl may be drawn in: the margins, below the header, clear of words. */
        owlCells = new Uint8Array(0);
        /** Cells where an owl passing over the column or the scrubber's lane is drawn behind the words, on the landscape's canvas. */
        behindCells = new Uint8Array(0);
        /** What the last painted frame drew behind the words over the column and the scrubber's lane: ripple cells and owl glyphs. */
        behind = { ripple: 0, owl: 0 };
        /** Where the flying owl's wings just were: each cell's ink, fading frame by frame, for the faint trail behind them. */
        owlTrail = new Float32Array(0);
        noise = new Float32Array(0);
        stars = [];
        starAt = new Int32Array(0);
        /** The place the scene is set in, and what moves in it there. */
        placeId = "night-wood";
        ambience = null;
        /** The frame each cell last had an ambient glyph in, so no cell takes two and goes past the column's ceiling. */
        ambientAt = new Uint32Array(0);
        frameCount = 0;
        owlInk = new Float32Array(0);
        owlAccent = new Float32Array(0);
        cleared = new Uint8Array(0);
        touched = new Uint8Array(0);
        owlBox = null;
        painted = "";
        glyphs = makeCanvas();
        owlCanvas = makeCanvas();
        owlAccentCanvas = makeCanvas();
        effect = { ring: 0, dx: 0, dy: 0 };
        // LOOK: each landscape cell's character and ink, null while every cell is drawn the real painter's way; the shape
        // characters as the scene's face draws them; and the same for the cells of Watcher's owl.
        lookGlyph = null;
        lookStrength = new Float32Array(0);
        owlGlyph = new Uint16Array(0);
        owlLook = false;
        lookCanvas = makeCanvas();
        owlLookCanvas = makeCanvas();
        spare = makeCanvas();
        pick = { code: 0, strength: 0 };
        owlPx = new Uint8ClampedArray(CELL_PX);
        /** LOOK: the choices changed, so the landscape is worked out and drawn again. */
        relook() {
          const layout = this.layout;
          if (layout === null) return;
          if (!this.buildLand(layout, this.grid)) {
            this.invalidate();
            return;
          }
          this.painted = "";
          this.paintGlyphs();
        }
        /**
         * LOOK: works out each landscape cell's character. The night wood is drawn a layer at a time on a finer field; with
         * depth, a nearer layer that covers a cell takes it whole and each layer's ink is as strong as it is near, and without
         * it the layers are laid over one another as the real painter's one field is.
         */
        buildLook(layout, grid) {
          this.lookGlyph = null;
          if (!LOOK.shape && !LOOK.depth || layout.mode !== "trees" || this.placeId !== "night-wood") return;
          const { cols, rows } = grid, cells = cols * rows;
          const canvas = this.lookCanvas, spare = this.spare;
          canvas.width = cols * PX;
          canvas.height = rows * PY;
          spare.width = 2;
          spare.height = 2;
          const ctx = context(canvas, true), nowhere = context(spare);
          if (ctx === null || nowhere === null) return;
          const ready = (field, w, h) => {
            field.setTransform(PX / grid.cw, 0, 0, PY / grid.ch, 0, 0);
            field.clearRect(-w, -h, w * 3, h * 3);
            field.globalAlpha = 1;
            field.globalCompositeOperation = "source-over";
            field.lineCap = "butt";
            field.fillStyle = MASK;
            field.strokeStyle = MASK;
          };
          const top = new Uint8ClampedArray(cells * CELL_PX), tone = new Float32Array(cells).fill(1);
          for (const name of WOOD_LAYERS) {
            ready(ctx, layout.width, layout.height);
            ready(nowhere, 2, 2);
            drawWoodLayers((wanted) => wanted === name ? ctx : nowhere, nowhere, layout, LOOK.depth);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              const i = r * cols + c, at = i * CELL_PX;
              if (LOOK.depth) {
                let most = 0;
                for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) most = Math.max(most, data[((r * PY + y) * canvas.width + c * PX + x) * 4 + 3]);
                if (most < 36) continue;
                for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) top[at + y * PX + x] = data[((r * PY + y) * canvas.width + c * PX + x) * 4 + 3];
                tone[i] = LAYER_TONE[name];
              } else for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) {
                const k = at + y * PX + x;
                top[k] = 255 - (255 - top[k]) * (255 - data[((r * PY + y) * canvas.width + c * PX + x) * 4 + 3]) / 255;
              }
            }
          }
          const N = seeded(99), noise = new Float32Array(cells);
          for (let i = 0; i < cells; i++) noise[i] = N();
          const glyph = new Uint16Array(cells), strength = new Float32Array(cells);
          for (let i = 0; i < cells; i++) {
            const x = (i % cols + 0.5) * grid.cw, y = (Math.floor(i / cols) + 0.5) * grid.ch;
            const picked = pickGlyph(top, i * CELL_PX, LOOK.shape && inMargin(layout, x) && !inLane(layout, x, y), noise[i], this.pick);
            glyph[i] = picked.code;
            strength[i] = Math.min(1, picked.strength * tone[i]);
          }
          for (let i = 0; i < cells; i++) if (glyph[i] === RAISED) {
            const above = i - cols;
            if (above >= 0 && glyph[above] === 0) {
              glyph[above] = 95;
              strength[above] = strength[i];
            }
            glyph[i] = 0;
          }
          for (let i = 0; i < cells; i++) if (glyph[i] !== 0) this.land[i] = Math.max(this.land[i], 0.1);
          this.lookGlyph = glyph;
          this.lookStrength = strength;
        }
        /** Lays the scene out for the room's size and builds its landscape; null when the room is too small to draw in. */
        resize(measure, dpr) {
          if (measure.width < 120 || measure.height < 120) {
            this.layout = null;
            return null;
          }
          const layout = layoutScene(measure), grid = gridFor(measure.width, measure.height);
          const cells = grid.cols * grid.rows;
          for (const canvas of [this.owlCanvas, this.owlAccentCanvas]) {
            canvas.width = grid.cols * SS;
            canvas.height = grid.rows * SS;
          }
          this.owlLookCanvas.width = grid.cols * PX;
          this.owlLookCanvas.height = grid.rows * PY;
          this.owlGlyph = new Uint16Array(cells);
          if (!this.buildLand(layout, grid)) {
            this.layout = null;
            return null;
          }
          this.owlInk = new Float32Array(cells);
          this.owlAccent = new Float32Array(cells);
          this.owlTrail = new Float32Array(cells);
          this.cleared = new Uint8Array(cells);
          this.touched = new Uint8Array(cells);
          const N = seeded(99);
          this.noise = new Float32Array(cells);
          for (let i = 0; i < cells; i++) this.noise[i] = N();
          this.quiet = new Float32Array(cells);
          this.owlCells = new Uint8Array(cells);
          this.behindCells = new Uint8Array(cells);
          this.marginCells = new Uint8Array(cells);
          for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
            const x = (c + 0.5) * grid.cw, y = (r + 0.5) * grid.ch, i = r * grid.cols + c;
            const owl = owlLayer(layout, x, y);
            this.marginCells[i] = inMargin(layout, x) && !inLane(layout, x, y) ? 1 : 0;
            this.owlCells[i] = owl === "over" ? 1 : 0;
            this.behindCells[i] = owl === "behind" ? 1 : 0;
          }
          this.layout = layout;
          this.grid = grid;
          this.dpr = dpr;
          this.baseQuiet();
          this.owlBox = null;
          this.painted = "";
          for (const canvas of [this.back, this.front, this.glyphs]) {
            canvas.width = Math.round(measure.width * dpr);
            canvas.height = Math.round(measure.height * dpr);
          }
          this.paintGlyphs();
          return layout;
        }
        /**
         * The landscape's fields for the place, its stars and what moves in it; false when no field can be drawn. Only the
         * trees have a landscape: the rail of eyes is the same in every place.
         */
        buildLand(layout, grid) {
          const cells = grid.cols * grid.rows, place = SCENE_PLACES[this.placeId];
          this.land = new Float32Array(cells);
          this.landAccent = new Float32Array(cells);
          this.ambience = null;
          if (layout.mode === "trees") {
            const field = makeCanvas(), accent = makeCanvas();
            for (const canvas of [field, accent]) {
              canvas.width = grid.cols * SS;
              canvas.height = grid.rows * SS;
            }
            const fx = context(field, true), ax = context(accent, true);
            if (fx === null || ax === null) return false;
            prepare(fx, grid, layout);
            prepare(ax, grid, layout);
            place.draw(fx, ax, layout);
            readField(fx, this.land, grid, 0, 0, grid.cols, grid.rows);
            readField(ax, this.landAccent, grid, 0, 0, grid.cols, grid.rows);
            this.ambience = place.ambience?.(layout) ?? null;
          }
          this.buildLook(layout, grid);
          this.stars = layout.mode === "trees" ? placeStars(layout, grid, this.land, place.stars) : [];
          this.starAt = new Int32Array(cells).fill(-1);
          this.stars.forEach((star, index) => {
            this.starAt[star.i] = index;
          });
          this.ambientAt = new Uint32Array(cells);
          return true;
        }
        /** The place the scene is set in. */
        get place() {
          return this.placeId;
        }
        /**
         * Sets the scene in another place: its landscape is drawn now, and the next frame shows it whole. The owls, the moon
         * and every spot stay where they are, since every place is laid out alike. Returns whether the place changed.
         */
        setPlace(place) {
          if (place === this.placeId) return false;
          this.placeId = place;
          const layout = this.layout;
          if (layout === null) return true;
          if (!this.buildLand(layout, this.grid)) {
            this.invalidate();
            return true;
          }
          this.painted = "";
          this.paintGlyphs();
          return true;
        }
        /** The theme's inks and the glyph face; the landscape's glyphs are drawn again in them. */
        setInk(ink, fontFamily) {
          this.ink = ink;
          const font = `${GLYPH_PX}px ${fontFamily}`;
          this.font = font;
          this.painted = "";
          if (ink.light !== this.light) {
            this.light = ink.light;
            this.baseQuiet();
          }
          this.paintGlyphs();
        }
        /** Every cell's share, for the theme's column strength. */
        baseQuiet() {
          const layout = this.layout;
          if (layout === null) return;
          const { cols, rows, cw, ch } = this.grid, strength = this.light ? COLUMN_QUIET.light : COLUMN_QUIET.dark;
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.quiet[r * cols + c] = quietAt(layout, (c + 0.5) * cw, (r + 0.5) * ch, strength);
        }
        get ready() {
          return this.layout !== null && this.ink !== null;
        }
        /**
         * Forgets the layout, so nothing is drawn until the room can be measured again. The canvases keep the last frame drawn:
         * the scene never blinks, and the next layout draws over it in the frame it is made.
         */
        invalidate() {
          this.layout = null;
          this.owlBox = null;
          this.painted = "";
        }
        /** The perched thread owls' boxes in the pane, for their buttons. */
        targets(owls, t, still) {
          const layout = this.layout;
          if (layout === null) return [];
          const { cw, ch } = this.grid, rail = layout.mode === "rail";
          return owls.filter((pose) => !pose.flying && pose.owl.animation === null).map((pose) => {
            const box = spriteCells(owlGlyphs2(pose, t, { rail, still }), pose.x, pose.y, { w: cw, h: ch });
            const x0 = Math.max(0, box.c0 * cw - 3), x1 = Math.min(layout.width, (box.c0 + box.w) * cw + 3);
            const y0 = Math.max(0, box.r0 * ch - 3), y1 = Math.min(layout.height, (box.r0 + box.n) * ch + 3);
            return { key: pose.owl.key, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          });
        }
        /**
         * The landscape's glyphs, kept: every cell dense enough to show, in its own ink, quiet in the column and around still words.
         * Given rows and columns, only that block is cleared and drawn again, clipped to it so its neighbours keep every pixel.
         */
        paintGlyphs(r0 = 0, r1 = this.grid.rows, c0 = 0, c1 = this.grid.cols) {
          const ctx = context(this.glyphs);
          if (ctx === null || this.layout === null || this.ink === null) return;
          const { cols, rows, cw, ch } = this.grid, dpr = this.dpr;
          const x0 = Math.round(c0 * cw * dpr), x1 = Math.round(c1 * cw * dpr), y0 = Math.round(r0 * ch * dpr), y1 = Math.round(r1 * ch * dpr);
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.beginPath();
          ctx.rect(x0, y0, x1 - x0, y1 - y0);
          ctx.clip();
          ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.textStyle(ctx);
          for (let r = Math.max(0, r0 - 1); r < Math.min(rows, r1 + 1); r++) for (let c = Math.max(0, c0 - 1); c < Math.min(cols, c1 + 1); c++) {
            const i = r * cols + c;
            this.cell(ctx, i, i, 0, -1, (c + 0.5) * cw, (r + 0.5) * ch);
          }
          ctx.restore();
        }
        textStyle(ctx) {
          ctx.font = this.font;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
        }
        /**
         * Draws cell `i` showing the landscape at cell `j` (where a ripple bends it), with a ripple's ring and a star's
         * strength. Returns whether it drew anything. This is the prototype's rule for a cell, whole.
         */
        cell(ctx, i, j, ring, star, x, y) {
          const ink = this.ink;
          const q = this.quiet[i];
          if (q === 0) return false;
          const cap = this.marginCells[i] ? 1 : ink.column.ink, accentCap = this.marginCells[i] ? 1 : ink.column.accent;
          const tone = (accent2, strength) => accent2 ? inkAt(ink.accent, Math.min(accentCap, strength)) : inkAt(ink.ink, Math.min(cap, strength));
          const look = this.lookGlyph;
          if (look !== null) {
            const code = look[j], held = code === 0 ? 0 : Math.max(0.1, this.land[j] * q);
            ring = Math.min(1, ring) * (0.5 + 0.5 * q);
            if (code === 0 && ring < 0.08 && star <= 0) return false;
            if (ring > held + 0.05) {
              ctx.fillStyle = tone(true, 0.18 + 0.6 * ring);
              ctx.fillText(RIPPLE_GLYPHS[Math.min(3, Math.floor(ring * 4))], x, y);
              return true;
            }
            const starHere = this.starAt[i] >= 0 ? this.stars[this.starAt[i]] : null;
            const lit = this.landAccent[j] > 0.3 || starHere?.accent === true;
            if (star > held) {
              ctx.fillStyle = tone(lit, 0.15 + 0.6 * star);
              ctx.fillText(star > 0.7 ? "*" : star > 0.45 ? "+" : "·", x, y);
              return true;
            }
            if (code === 0) return false;
            ctx.fillStyle = tone(lit, Math.min(1, (this.lookStrength[j] * q + ring * 0.2) * (lit ? 1.25 : 1)));
            ctx.fillText(String.fromCharCode(code), x, y);
            return true;
          }
          const d = this.land[j] * q;
          ring = Math.min(1, ring) * (0.5 + 0.5 * q);
          if (d < 0.1 && ring < 0.08 && star <= 0) return false;
          if (ring > d + 0.05) {
            ctx.fillStyle = tone(true, 0.18 + 0.6 * ring);
            ctx.fillText(RIPPLE_GLYPHS[Math.min(3, Math.floor(ring * 4))], x, y);
            return true;
          }
          const st = this.starAt[i] >= 0 ? this.stars[this.starAt[i]] : null;
          const accent = this.landAccent[j] > 0.3 || st?.accent === true;
          if (star > d) {
            ctx.fillStyle = tone(accent, 0.15 + 0.6 * star);
            ctx.fillText(star > 0.7 ? "*" : star > 0.45 ? "+" : "·", x, y);
            return true;
          }
          const dd = clamp(d + (this.noise[j] - 0.5) * 0.1 + ring * 0.3, 0, 1);
          ctx.fillStyle = tone(accent, (0.1 + 0.5 * dd) * (accent ? 1.25 : 1));
          ctx.fillText(rampGlyph(dd), x, y);
          return true;
        }
        /** What the frame would show, summed up: the same summary means the same picture, so it is not painted again. */
        summary(frame, owlLines) {
          const { t, still } = frame, { cw, ch } = this.grid;
          const parts = [this.layout.mode === "trees" ? twinkleStep(t, still) : 0, ambienceStep(this.ambience, t, still)];
          if (frame.whirl > 0.01 || runningRipples(frame.ripples, t) > 0) parts.push("m", Math.round(t * 30));
          const w = frame.watcher?.pose;
          if (w !== void 0) parts.push(
            Math.round(w.x),
            Math.round(w.y),
            Math.round(w.turn * 20),
            Math.round(w.gx * 4),
            Math.round(w.gy * 4),
            w.blink ? 1 : 0,
            Math.round(w.flap * 4),
            Math.round(w.spread * 10),
            Math.round(w.bank * 40),
            Math.round(w.squash * 50),
            Math.round(w.legs * 8),
            frame.watcherGlows === true ? glowStep(t, still) : -1
          );
          frame.owls.forEach((pose, k) => {
            parts.push(
              pose.owl.key,
              Math.round(pose.x / cw),
              Math.round(pose.y / ch),
              Math.round(pose.alpha * 10),
              owlLines[k][0],
              pose.owl.mood,
              pose.owl.mood === "waiting" ? glowStep(t, still) : 0
            );
          });
          if (frame.pile !== null) parts.push("p", frame.pile.count);
          return parts.join("|");
        }
        /** Draws the frame, unless its picture is the one already on screen. Returns whether it painted. */
        draw(frame) {
          const layout = this.layout, ink = this.ink;
          const back = context(this.back), front = context(this.front);
          if (layout === null || ink === null || back === null || front === null) return false;
          const { t, still, ripples } = frame;
          const rail = layout.mode === "rail";
          const owlLines = frame.owls.map((pose) => owlGlyphs2(pose, t, { rail, still }));
          const summary = this.summary(frame, owlLines);
          if (summary === this.painted) return false;
          this.painted = summary;
          this.behind = { ripple: 0, owl: 0 };
          const { cols, rows, cw, ch } = this.grid;
          if (frame.watcher !== null) this.readOwl(frame.watcher.pose);
          else this.owlBox = null;
          const box = this.owlBox;
          back.setTransform(1, 0, 0, 1, 0, 0);
          back.clearRect(0, 0, this.back.width, this.back.height);
          back.drawImage(this.glyphs, 0, 0);
          back.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
          this.textStyle(back);
          this.cleared.fill(0);
          const clear = (c, r) => {
            if (c < 0 || c >= cols || r < 0 || r >= rows) return;
            const i = r * cols + c;
            if (this.cleared[i] || this.quiet[i] === 0) return;
            this.cleared[i] = 1;
            back.clearRect(c * cw, r * ch, cw, ch);
          };
          if (box !== null && frame.watcher !== null) {
            const feet = frame.watcher.pose.spread < 0.05 ? Math.floor((frame.watcher.pose.y - 1) / ch) : rows;
            for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
              if (this.owlInk[r * cols + c] < 0.1 || !(this.owlCells[r * cols + c] || this.behindCells[r * cols + c])) continue;
              for (let y = r - 1; y <= Math.min(r + 1, feet - 1); y++) for (let x = c - 1; x <= c + 1; x++) clear(x, y);
            }
          }
          const sprites = frame.owls.map((pose, k) => ({ pose, lines: owlLines[k], cells: spriteCells(owlLines[k], pose.x, pose.y, { w: cw, h: ch }) }));
          for (const { lines, cells } of sprites) for (let k = 0; k < lines.length; k++) for (let j = 0; j < lines[k].length; j++) {
            if (lines[k][j] !== " ") clear(cells.c0 + j, cells.r0 + k);
          }
          this.touched.fill(0);
          for (const ripple of ripples) {
            const reach = rippleReach(ripple, t, still);
            if (reach <= 0) continue;
            const c0 = clamp(Math.floor((ripple.x - reach) / cw), 0, cols), c1 = clamp(Math.ceil((ripple.x + reach) / cw), 0, cols);
            const r0 = clamp(Math.floor((ripple.y - reach) / ch), 0, rows), r1 = clamp(Math.ceil((ripple.y + reach) / ch), 0, rows);
            for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
              const i = r * cols + c;
              if (this.touched[i] || this.cleared[i] || this.quiet[i] === 0) continue;
              const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
              const effect = rippleAt(x, y, ripples, t, still, this.effect);
              const sc = c - Math.round(effect.dx), sr = r - Math.round(effect.dy);
              if (effect.ring < 0.01 && sc === c && sr === r) continue;
              this.touched[i] = 1;
              const j = sc >= 0 && sc < cols && sr >= 0 && sr < rows ? sr * cols + sc : i;
              const star = this.starAt[i] >= 0 ? starStrength(this.stars[this.starAt[i]], twinkleStep(t, still), still) * this.quiet[i] : 0;
              back.clearRect(c * cw, r * ch, cw, ch);
              if (this.cell(back, i, j, effect.ring, star, x, y) && !this.marginCells[i]) this.behind.ripple++;
            }
          }
          const step = twinkleStep(t, still);
          for (const star of this.stars) {
            if (this.cleared[star.i] || this.touched[star.i]) continue;
            const c = star.i % cols, r = (star.i - c) / cols;
            this.cell(back, star.i, star.i, 0, starStrength(star, step, still) * this.quiet[star.i], (c + 0.5) * cw, (r + 0.5) * ch);
          }
          if (this.ambience !== null) {
            const stamp = ++this.frameCount;
            const emit = (x, y, glyph2, accent, strength, over2) => {
              const c = Math.floor(x / cw), r = Math.floor(y / ch);
              if (c < 0 || c >= cols || r < 0 || r >= rows) return;
              const i = r * cols + c, q = this.quiet[i];
              if (q === 0 || this.cleared[i] || this.touched[i] || this.starAt[i] >= 0 || this.ambientAt[i] === stamp) return;
              if (!over2 && this.land[i] * q >= 0.1) return;
              this.ambientAt[i] = stamp;
              const cap = this.marginCells[i] ? 1 : accent ? ink.column.accent : ink.column.ink;
              if (over2) back.clearRect(c * cw, r * ch, cw, ch);
              back.fillStyle = inkAt(accent ? ink.accent : ink.ink, Math.min(cap, strength * q));
              back.fillText(glyph2, (c + 0.5) * cw, (r + 0.5) * ch);
            };
            this.ambience.cells(ambienceTime(this.ambience, t, still), emit);
          }
          if (frame.whirl > 0.01 && layout.mode === "trees") {
            const w = frame.whirl, m = layout.moon, R = m.r * (0.9 + 0.9 * w);
            const c0 = clamp(Math.floor((m.x - R) / cw), 0, cols - 1), c1 = clamp(Math.ceil((m.x + R) / cw), 0, cols - 1);
            const r0 = clamp(Math.floor((m.y - R) / ch), 0, rows - 1), r1 = clamp(Math.ceil((m.y + R) / ch), 0, rows - 1);
            for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
              const i = r * cols + c;
              const dx = (c + 0.5) * cw - m.x, dy = (r + 0.5) * ch - m.y, d = Math.hypot(dx, dy);
              if (d > R || this.quiet[i] === 0 || this.cleared[i] || !this.marginCells[i]) continue;
              const v = 0.5 + 0.5 * Math.sin(3 * Math.atan2(dy, dx) + d * 0.22 - t * 7);
              const a = w * (1 - d / R * 0.7) * (0.4 + 0.6 * v);
              back.clearRect(c * cw, r * ch, cw, ch);
              if (a > 0.12) {
                back.fillStyle = inkAt(ink.accent, 0.25 + a);
                back.fillText(WHIRL_GLYPHS[Math.min(WHIRL_GLYPHS.length - 1, Math.floor(a * WHIRL_GLYPHS.length))], (c + 0.5) * cw, (r + 0.5) * ch);
              }
            }
          }
          for (const { pose, cells } of sprites) {
            if (pose.owl.mood !== "waiting" || !this.owlCells[clamp(cells.r0, 0, rows - 1) * cols + clamp(cells.c0 + (cells.w >> 1), 0, cols - 1)]) continue;
            const [x0, x1] = this.withinMargin(cells.c0 * cw - 5, (cells.c0 + cells.w) * cw + 5);
            const y = cells.r0 * ch - 4, h = cells.n * ch + 4;
            for (let r = cells.r0 - 1; r <= cells.r0 + cells.n; r++) for (let c = cells.c0 - 1; c <= cells.c0 + cells.w; c++) clear(c, r);
            back.fillStyle = inkAt(ink.accent, (0.12 + 0.12 * glowStep(t, still)) * pose.alpha);
            back.beginPath();
            back.roundRect(x0, y, x1 - x0, h, 7);
            back.fill();
          }
          let pileCells = null;
          if (frame.pile !== null) {
            pileCells = spriteCells([pileLabel(frame.pile.count, rail)], frame.pile.spot.x, frame.pile.spot.y, { w: cw, h: ch });
            for (let c = pileCells.c0 - 1; c <= pileCells.c0 + pileCells.w; c++) clear(c, pileCells.r0);
            if (!rail) {
              const [x0, x1] = this.withinMargin(pileCells.c0 * cw - 3.5, (pileCells.c0 + pileCells.w) * cw + 3.5);
              back.strokeStyle = inkAt(ink.ink, 0.4);
              back.lineWidth = 1;
              back.beginPath();
              back.roundRect(x0, pileCells.r0 * ch - 1.5, x1 - x0, ch + 3, 5);
              back.stroke();
            }
          }
          front.setTransform(1, 0, 0, 1, 0, 0);
          front.clearRect(0, 0, this.front.width, this.front.height);
          front.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
          this.textStyle(front);
          const glyph = (c, r, text, accent, strength) => {
            if (c < 0 || c >= cols || r < 0 || r >= rows) return;
            const i = r * cols + c;
            if (this.owlCells[i]) {
              front.fillStyle = inkAt(accent ? ink.accent : ink.ink, strength);
              front.fillText(text, (c + 0.5) * cw, (r + 0.5) * ch);
              return;
            }
            if (!this.behindCells[i]) return;
            const cap = accent ? ink.column.accent : ink.column.ink;
            back.clearRect(c * cw, r * ch, cw, ch);
            back.fillStyle = inkAt(accent ? ink.accent : ink.ink, Math.min(cap, strength * this.quiet[i]));
            back.fillText(text, (c + 0.5) * cw, (r + 0.5) * ch);
            this.behind.owl++;
          };
          if (box !== null) {
            let strongest = 0;
            for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) strongest = Math.max(strongest, this.owlAccent[r * cols + c]);
            const eyeBar = Math.max(0.08, Math.min(0.35, strongest * 0.7));
            const glow = frame.watcherGlows === true ? 0.8 + 0.2 * glowStep(t, still) : null;
            const flying = frame.watcher.pose.spread > 0.05;
            const dense = (c, r) => c < 0 || c >= cols || r < 0 || r >= rows ? 0 : this.owlInk[r * cols + c];
            for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
              const i = r * cols + c, d = this.owlInk[i];
              if (flying) {
                const was = this.owlTrail[i] * 0.42;
                this.owlTrail[i] = Math.max(d, was);
                if (d < 0.1 && was >= 0.12 && this.cleared[i]) glyph(c, r, was > 0.24 ? ":" : "·", false, 0.22 + 0.6 * was);
              }
              if (d < 0.1) continue;
              if (flying && d < 0.24 && Math.max(dense(c - 1, r), dense(c + 1, r), dense(c, r - 1), dense(c, r + 1), dense(c - 1, r - 1), dense(c + 1, r - 1), dense(c - 1, r + 1), dense(c + 1, r + 1)) < 0.34) continue;
              const eye = this.owlAccent[i] > eyeBar;
              const strength = eye ? 1 : 0.5 + 0.5 * d;
              const shaped = this.owlLook ? this.owlGlyph[i] : 0;
              glyph(c, r, eye ? "@" : shaped !== 0 ? String.fromCharCode(shaped) : rampGlyph(flying ? d : d + (this.noise[i] - 0.5) * 0.08), eye || glow !== null, glow === null || eye ? strength : glow * strength);
            }
          }
          if (frame.watcher === null || frame.watcher.pose.spread <= 0.05) this.owlTrail.fill(0);
          for (const { pose, lines, cells } of sprites) {
            const waiting = pose.owl.mood === "waiting", base = pose.owl.mood === "asleep" ? 0.5 : 0.85;
            const strength = waiting ? (0.8 + 0.2 * glowStep(t, still)) * pose.alpha : 0;
            for (let k = 0; k < lines.length; k++) for (let j = 0; j < lines[k].length; j++) {
              const g = lines[k][j];
              if (g === " ") continue;
              const eye = k === 0 && (g === "o" || g === "O");
              glyph(cells.c0 + j, cells.r0 + k, g, waiting, waiting ? strength : (eye ? base + 0.15 : base) * pose.alpha);
            }
          }
          if (frame.pile !== null && pileCells !== null) {
            const label = pileLabel(frame.pile.count, rail);
            for (let j = 0; j < label.length; j++) glyph(pileCells.c0 + j, pileCells.r0, label[j], false, 0.95);
          }
          return true;
        }
        /** A span from `x0` to `x1` cut to the margin it starts in, so a glow or an outline never reaches the column. */
        withinMargin(x0, x1) {
          const { left, right } = this.layout.column;
          return x0 < left ? [Math.max(0, x0), Math.min(x1, left - OWL_GAP)] : [Math.max(x0, right + OWL_GAP), Math.min(x1, this.layout.width)];
        }
        /** The owl's own field, drawn and read only around it. */
        readOwl(pose) {
          const ox = context(this.owlCanvas, true), oax = context(this.owlAccentCanvas, true);
          const layout = this.layout, grid = this.grid;
          const previous = this.owlBox;
          if (previous !== null) for (let r = previous.r0; r < previous.r0 + previous.rn; r++) for (let c = previous.c0; c < previous.c0 + previous.cn; c++) {
            this.owlInk[r * grid.cols + c] = 0;
            this.owlAccent[r * grid.cols + c] = 0;
            this.owlGlyph[r * grid.cols + c] = 0;
          }
          const pad = 84 * pose.s;
          const c0 = clamp(Math.floor((pose.x - pad) / grid.cw), 0, grid.cols), c1 = clamp(Math.ceil((pose.x + pad) / grid.cw), 0, grid.cols);
          const r0 = clamp(Math.floor((pose.y - 30 * pose.s - pad) / grid.ch), 0, grid.rows), r1 = clamp(Math.ceil((pose.y + 14 * pose.s) / grid.ch), 0, grid.rows);
          this.owlBox = { c0, r0, cn: c1 - c0, rn: r1 - r0 };
          if (ox === null || oax === null) return;
          prepare(ox, grid, layout);
          prepare(oax, grid, layout);
          drawOwl(ox, oax, pose);
          readField(ox, this.owlInk, grid, c0, r0, c1 - c0, r1 - r0);
          readField(oax, this.owlAccent, grid, c0, r0, c1 - c0, r1 - r0);
          this.owlLook = false;
          const hx = LOOK.shape ? context(this.owlLookCanvas, true) : null, nowhere = context(this.spare);
          const cn = c1 - c0, rn = r1 - r0;
          if (hx === null || nowhere === null || cn <= 0 || rn <= 0) return;
          hx.setTransform(PX / grid.cw, 0, 0, PY / grid.ch, 0, 0);
          hx.clearRect(-layout.width, -layout.height, layout.width * 3, layout.height * 3);
          hx.globalAlpha = 1;
          hx.globalCompositeOperation = "source-over";
          hx.lineCap = "butt";
          hx.fillStyle = MASK;
          hx.strokeStyle = MASK;
          drawOwl(hx, nowhere, pose);
          const data = hx.getImageData(c0 * PX, r0 * PY, cn * PX, rn * PY).data, stride = cn * PX, cell = this.owlPx;
          for (let r = 0; r < rn; r++) for (let c = 0; c < cn; c++) {
            for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) cell[y * PX + x] = data[((r * PY + y) * stride + c * PX + x) * 4 + 3];
            const code = pickGlyph(cell, 0, true, 0.5, this.pick).code;
            this.owlGlyph[(r0 + r) * grid.cols + c0 + c] = code === RAISED ? 45 : code;
          }
          this.owlLook = true;
        }
      };
    }
  });

  // proto/ambience.ts
  function riverPath(g) {
    const edge = g.column.left - 14, sky = g.sky;
    const a = { x: edge * 0.8, y: g.horizon + 6 }, c1 = { x: edge * 0.55, y: g.horizon + sky * 0.14 }, c2 = { x: edge * 0.7, y: g.groundY - sky * 0.03 };
    const b = { x: edge * 0.35, y: g.groundY + 20 }, q = { x: edge * 0.12, y: g.groundY + 45 }, c = { x: -10, y: g.height };
    const pts = [];
    const push = (x, y) => {
      const last = pts[pts.length - 1];
      pts.push({ x, y, d: last === void 0 ? 0 : last.d + Math.hypot(x - last.x, y - last.y) });
    };
    for (let k = 0; k <= 40; k++) {
      const u = k / 40, v = 1 - u;
      push(v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x, v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y);
    }
    for (let k = 1; k <= 24; k++) {
      const u = k / 24, v = 1 - u;
      push(v * v * b.x + 2 * v * u * q.x + u * u * c.x, v * v * b.y + 2 * v * u * q.y + u * u * c.y);
    }
    const length = pts[pts.length - 1].d;
    return {
      at(share) {
        const target = clamp(share, 0, 1) * length;
        let k = 1;
        while (k < pts.length - 1 && pts[k].d < target) k++;
        const p = pts[k - 1], n = pts[k], u = n.d === p.d ? 0 : (target - p.d) / (n.d - p.d);
        return { x: lerp(p.x, n.x, u), y: lerp(p.y, n.y, u) };
      }
    };
  }
  function windAt(x, t) {
    let wind = 0.08;
    for (const h of LIFE.happenings) if (h.kind === "gust") {
      const d = (x - (-220 + (t - h.t0) * 320)) / 190;
      wind += h.strength * Math.exp(-d * d);
    }
    return Math.min(1, wind);
  }
  function makeAmbience(g, painter) {
    const grid = gridFor(g.width, g.height), { cols, rows, cw, ch } = grid;
    const W = g.width, H = g.height, sky = g.sky;
    const river = riverPath(g);
    const R = seeded(71);
    const flies = Array.from({ length: 16 }, (_, k) => ({
      x: k % 2 === 0 ? lerp(10, Math.max(12, g.column.left - 26), R()) : lerp(Math.min(W - 12, g.column.right + 26), W - 10, R()),
      y: lerp(g.horizon + sky * 0.16, Math.min(H - 16, g.groundY + 74), R()),
      p1: R() * 6.28,
      p2: R() * 6.28,
      p3: R() * 6.28,
      w: 0.2 + R() * 0.16
    }));
    const wisps = [g.horizon + sky * 0.03, g.horizon + sky * 0.1, g.groundY - sky * 0.09, g.groundY - sky * 0.035].map((y, k) => ({ y, len: 26 + k * 7, speed: 5 + k * 1.6, x0: hash(k, 9) * (W + 400) }));
    const grass = Array.from({ length: cols }, (_, c) => {
      const x = (c + 0.5) * cw;
      return { x, y: (Math.floor((groundAt(g, x) - 7) / ch) + 0.5) * ch };
    });
    let crown = null;
    let land = new Float32Array(0), noise = new Float32Array(0), lookGlyph = null, lookStrength = new Float32Array(0);
    const readCrowns = () => {
      const p = painter;
      land = p.land;
      noise = p.noise;
      lookGlyph = p.lookGlyph;
      lookStrength = p.lookStrength;
      crown = [];
      for (const tree of [g.left, g.right]) {
        const top = tree.y - tree.h * 1.02, bottom = tree.y - tree.h * 0.66;
        const c0 = clamp(Math.floor((tree.x - tree.h * 0.42) / cw), 1, cols - 1), c1 = clamp(Math.ceil((tree.x + tree.h * 0.42) / cw), 1, cols - 1);
        for (let r = clamp(Math.floor(top / ch), 0, rows - 1); r <= clamp(Math.floor(bottom / ch), 0, rows - 1); r++) for (let c = c0; c <= c1; c++) {
          const i = r * cols + c, x = (c + 0.5) * cw, y = (r + 0.5) * ch;
          if (Math.hypot(x - g.moon.x, y - g.moon.y) < g.moon.r * 2.9) continue;
          if ((land[i] ?? 0) >= 0.1 || (land[i - 1] ?? 0) >= 0.1) crown.push({ i, x, y, high: clamp((bottom - y) / Math.max(1, bottom - top), 0, 1) });
        }
      }
    };
    return {
      // As often as the stars twinkle while nothing is switched on, eight times a second otherwise, and more while
      // something quick crosses.
      get steps() {
        return LIFE.flags.size === 0 ? 2 : !LIFE.still && fast(LIFE.now) ? 24 : 8;
      },
      most: 900,
      cells(t, emit) {
        if (LIFE.flags.size === 0) return;
        const still = LIFE.still;
        const sprite = (lines, x, y, strength, accents = "") => {
          const w = Math.max(...lines.map((line) => line.length)), c0 = Math.round(x / cw - w / 2), r0 = Math.floor((y - 1) / ch) - lines.length + 1;
          lines.forEach((line, k) => {
            for (let j = 0; j < line.length; j++) if (line[j] !== " ") emit((c0 + j + 0.5) * cw, (r0 + k + 0.5) * ch, line[j], accents.includes(line[j]), strength, true);
          });
        };
        const meteor = (m, tau) => {
          if (tau < 0 || tau > m.life + 0.3) return;
          const head = Math.min(tau, m.life), fade = tau > m.life ? clamp(1 - (tau - m.life) / 0.3, 0, 1) : 1;
          for (let j = 0; j < 13; j++) {
            const s = head - j * 0.011;
            if (s < 0) break;
            const x = m.x0 + m.dx * m.speed * s, y = m.y0 + m.dy * m.speed * s;
            if (j === 0) {
              if (tau <= m.life) emit(x, y, "*", true, 1, true);
              continue;
            }
            emit(x, y, j < 4 ? "=" : j < 8 ? "-" : "·", j < 5, (0.9 - j * 0.06) * fade, true);
          }
        };
        if (!still) for (const h of LIFE.happenings) {
          const tau = t - h.t0;
          if (tau < 0 || tau > h.dur) continue;
          if (h.kind === "star") meteor(h, tau);
          else if (h.kind === "meteors") for (const m of h.list) meteor(m, tau - m.at);
          else if (h.kind === "note") {
            const k = clamp(tau / h.dur, 0, 1), e = k * k * (3 - 2 * k);
            const at = (u) => {
              const v = 1 - u, mx = (h.from.x + h.to.x) / 2, my = Math.min(h.from.y, h.to.y) - h.lift;
              return { x: v * v * h.from.x + 2 * v * u * mx + u * u * h.to.x, y: v * v * h.from.y + 2 * v * u * my + u * u * h.to.y };
            };
            const p = at(e);
            emit(p.x, p.y, "♪", h.accent, 1, true);
            for (const [back, strength] of [[0.05, 0.55], [0.1, 0.32]]) if (e - back > 0) {
              const q = at(e - back);
              emit(q.x, q.y, "·", h.accent, strength, false);
            }
          } else if (h.kind === "sparkle") {
            const k = tau / h.dur;
            for (let j = 0; j < 12; j++) {
              const a = j / 12 * Math.PI * 2 + h.spin, r = 10 + 58 * (1 - (1 - k) ** 2) * (0.6 + 0.4 * hash(j, 3));
              emit(h.x + Math.cos(a) * r, h.y - 20 + Math.sin(a) * r * 0.62, k < 0.35 ? "*" : k < 0.7 ? "+" : "·", true, 1 - k * 0.8, true);
            }
          } else if (h.kind === "bats") {
            for (const bat of h.bats) {
              const x = h.from === null ? W + 30 + bat.dx - 150 * tau : h.from.x + bat.vx * tau, y = h.from === null ? bat.y + 9 * Math.sin(tau * 2.3 + bat.ph) : h.from.y + bat.vy * tau + 7 * Math.sin(tau * 3 + bat.ph);
              const wings = Math.floor(tau * 7 + bat.ph) % 2 === 0 ? "^v^" : "-v-";
              for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, wings[j], false, 0.85, true);
            }
          } else if (h.kind === "fox") {
            const speed = 95, toStop = (h.stopX + 70) / speed, pause = 2;
            const stopped = tau >= toStop && tau < toStop + pause;
            const x = tau < toStop ? -70 + speed * tau : stopped ? h.stopX : h.stopX + speed * (tau - toStop - pause);
            const y = Math.floor(groundAt(g, x) / ch) * ch;
            sprite(stopped ? FOX_STOP : FOX_WALK[Math.floor(tau * 6) % 2], x, y, 0.9, "°");
            if (stopped && tau - toStop > 0.35 && tau - toStop < 1.7) emit(x + 40, y - 30, "?", true, 0.9, true);
          } else if (h.kind === "mouse") {
            let x = tau < h.run ? lerp(h.x0, h.x1, tau / h.run) : h.x1;
            if (h.boltAt !== null) x = h.x1 + (t - h.boltAt) * 420;
            const y = groundAt(g, x) - 3;
            for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, "~o>"[j], j === 1, 0.9, true);
          } else if (h.kind === "fish") {
            if (tau < 0.9) {
              const k = tau / 0.9, x = h.x - 14 + 28 * k, y = h.y - 42 * Math.sin(Math.PI * k);
              for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, "><>"[j], true, 1, true);
              if (tau < 0.45) for (const side of [-1, 1]) emit(h.x - 14 + side * (6 + tau * 30), h.y - 8 - tau * 26, "'", true, 0.7 - tau, true);
            } else {
              const k = (tau - 0.9) / (h.dur - 0.9), r = 6 + 36 * k, x = h.x + 14;
              emit(x - r, h.y, "(", true, 0.9 * (1 - k), true);
              emit(x + r, h.y, ")", true, 0.9 * (1 - k), true);
              if (r > 16) {
                emit(x - r / 2, h.y, "~", true, 0.5 * (1 - k), true);
                emit(x + r / 2, h.y, "~", true, 0.5 * (1 - k), true);
              }
              if (k < 0.45) for (const side of [-1, 0, 1]) emit(x + side * (8 + k * 22), h.y - 10 - 34 * k + 60 * k * k, side === 0 ? "." : "'", true, 0.8 - k, true);
            }
          }
        }
        for (const pose of LIFE.poses) {
          if (pose.flying || pose.alpha < 0.9) continue;
          const column = Math.round(pose.x / cw - 2.5) + 2, top = Math.floor((pose.y - 1) / ch) - 3;
          if (has("wave") && pose.owl.mood === "waiting") {
            const up = still ? 0 : Math.floor(t * 2) % 2;
            emit((column + 0.5) * cw, (top - 1 - up + 0.5) * ch, threadOf(pose.owl.key)?.ask === "permission" ? "!" : "?", true, 1, true);
          }
          if (has("sleepZ") && pose.owl.mood === "asleep" && threadOf(pose.owl.key)?.state !== "failed") {
            const tau = still ? 1.2 : (t + pose.owl.order * 1.9) % 5.6;
            if (tau < 2.9) for (let stage = 0; stage <= Math.min(2, Math.floor(tau / 0.9)); stage++) {
              emit((column + 2 + stage + 0.5) * cw, (top - stage + 0.5) * ch, stage === 2 ? "Z" : "z", false, [0.62, 0.5, 0.4][stage], false);
            }
          }
        }
        if (has("fireflies")) {
          const count = has("mirror") ? Math.round(lerp(16, 5, activity())) : 14;
          const pointer = has("gaze") && LIFE.pointer !== null && LIFE.now - LIFE.pointer.t < 2 ? LIFE.pointer : null;
          flies.forEach((fly, k) => {
            if (k >= count) return;
            let x = fly.x + 26 * Math.sin(t * 0.31 + fly.p1) + 9 * Math.sin(t * 1.3 + fly.p2), y = fly.y + 12 * Math.sin(t * 0.43 + fly.p3) + 5 * Math.sin(t * 1.7 + fly.p1);
            if (pointer !== null) {
              const dx = x - pointer.x, dy = y - pointer.y, d = Math.hypot(dx, dy) || 1;
              if (d < 90) {
                x += dx / d * (90 - d) * 0.8;
                y += dy / d * (90 - d) * 0.8;
              }
            }
            const phase = (t * fly.w + fly.p2) % 1, glow = still ? k % 3 === 0 ? 0.9 : 0 : phase < 0.4 ? Math.sin(phase / 0.4 * Math.PI) : 0;
            if (glow < 0.12) return;
            emit(x, y, glow > 0.7 ? "*" : glow > 0.35 ? "°" : "·", true, 0.45 + 0.55 * glow, false);
          });
        }
        if (has("wind") && !still) {
          for (const h of LIFE.happenings) if (h.kind === "gust") for (const leaf of h.leaves) {
            const s = t - h.t0 - leaf.delay;
            if (s < 0 || s > 2.8) continue;
            emit(leaf.x + 250 * s + 6 * s * s, leaf.y + 26 * s + 14 * Math.sin(s * 5 + leaf.ph) + 9 * s * s, ",'`."[Math.floor(s * 7 + leaf.ph) % 4], false, 0.75 - s * 0.2, false);
          }
        }
        if (has("river")) {
          const speed = has("mirror") ? lerp(0.025, 0.085, activity()) : 0.055;
          for (let k = 0; k < 18; k++) {
            const share = (k / 18 + t * speed * (0.8 + 0.4 * hash(k, 31))) % 1;
            if (!still && hash(k, Math.floor(t * 2), 5) < 0.15) continue;
            const p = river.at(share);
            emit(p.x + (hash(k, 37) - 0.5) * (4 + 14 * share), p.y, share > 0.6 ? "~" : share > 0.3 ? "-" : "·", true, 0.45 + 0.4 * hash(k, 41), true);
          }
        }
        if (has("wind") && !still) {
          if (crown === null) readCrowns();
          for (let c = 0; c < cols; c++) {
            const blade = grass[c], wind = windAt(blade.x, t);
            if (wind < 0.3 + 0.6 * hash(c, 43)) continue;
            emit(blade.x, blade.y, "/", false, 0.5, true);
          }
          for (const cell of crown) {
            if (windAt(cell.x, t) < 0.52 - 0.14 * cell.high) continue;
            if (lookGlyph !== null) {
              const code = lookGlyph[cell.i - 1] ?? 0;
              emit(cell.x, cell.y, code === 0 ? " " : String.fromCharCode(code), false, code === 0 ? 0.1 : lookStrength[cell.i - 1], true);
              continue;
            }
            const d = land[cell.i - 1] ?? 0;
            if (d >= 0.1) emit(cell.x, cell.y, rampGlyph(clamp(d + ((noise[cell.i - 1] ?? 0.5) - 0.5) * 0.1, 0, 1)), false, 0.1 + 0.5 * d, true);
            else emit(cell.x, cell.y, " ", false, 0.1, true);
          }
        }
        if (!still) for (const h of LIFE.happenings) {
          const tau = t - h.t0;
          if (h.kind !== "cloud" || tau < 0 || tau > h.dur) continue;
          const cx = h.x0 - 22 * tau, shift = Math.floor(cx / cw), fade = Math.min(1, tau / 1.5, (h.dur - tau) / 1.5);
          for (let r = Math.floor((h.y - h.ry) / ch); r <= Math.ceil((h.y + h.ry) / ch); r++) for (let c = Math.floor((cx - h.rx) / cw); c <= Math.ceil((cx + h.rx) / cw); c++) {
            const x = (c + 0.5) * cw, y = (r + 0.5) * ch, dx = (x - cx) / h.rx, dy = (y - h.y) / h.ry;
            const v = 1 - dx * dx - dy * dy - hash(c - shift, r, 5) * 0.45 + 0.18 * Math.sin((c - shift) * 0.9 + r * 1.7);
            if (v <= 0.05) continue;
            emit(x, y, v > 0.55 ? "=" : v > 0.3 ? "~" : v > 0.15 ? "-" : "·", false, (0.24 + 0.3 * Math.min(1, v)) * fade, true);
          }
        }
        if (has("mist")) {
          const thick = has("mirror") ? lerp(1.25, 0.35, activity()) : 1;
          wisps.forEach((wisp, k) => {
            const start = Math.floor((((wisp.x0 - t * wisp.speed) % (W + 400) + W + 400) % (W + 400) - 200) / cw), row = Math.floor(wisp.y / ch);
            for (let j = 0; j < wisp.len; j++) {
              const taper = Math.sin(Math.PI * j / wisp.len);
              for (const [line, share] of [[0, 1], [1, 0.55]]) {
                if (hash(j, k * 2 + line, 17) > (0.25 + 0.5 * taper) * share * thick) continue;
                const pick = hash(j, k * 2 + line, 23);
                emit((start + j + 0.5) * cw, (row + line + 0.5) * ch, pick < 0.4 ? "~" : pick < 0.75 ? "-" : "·", false, 0.2 + 0.14 * taper, false);
              }
            }
          });
        }
      }
    };
  }
  var FOX_WALK, FOX_STOP;
  var init_ambience = __esm({
    "proto/ambience.ts"() {
      "use strict";
      init_nightScene();
      init_life();
      FOX_WALK = [["~-.__/\\°>", "   /|  |\\ "], ["~-.__/\\°>", "   |\\  /| "]];
      FOX_STOP = ["~-.__/\\°>", "   ||  || "];
    }
  });

  // ../../../../src/renderer/src/watcher/canvasColor.ts
  function toRgb(value, pixel) {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = "rgba(0, 0, 0, 0)";
    pixel.fillStyle = value;
    pixel.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = pixel.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : { r, g, b };
  }
  var init_canvasColor = __esm({
    "../../../../src/renderer/src/watcher/canvasColor.ts"() {
    }
  });

  // proto/stage.ts
  function relative(box, base, scrollTop) {
    return { x: box.left - base.left, y: box.top - base.top + scrollTop, w: box.width, h: box.height };
  }
  function measureRoom(pane) {
    const form = pane.querySelector(".thread-workspace__compose .thread-prompt");
    const compose = form?.closest(".thread-workspace__compose");
    if (form == null || compose == null) return null;
    const base = pane.getBoundingClientRect(), top = pane.scrollTop;
    const at = (element) => relative(element.getBoundingClientRect(), base, top);
    const card = at(form);
    if (card.w < 1 || card.h < 1) return null;
    const slim = compose.hasAttribute("data-slim"), style = getComputedStyle(compose);
    const full = slim ? parseFloat(style.getPropertyValue("--thread-prompt-full")) : Number.NaN;
    const foot = slim ? parseFloat(style.getPropertyValue("--thread-prompt-foot")) : Number.NaN;
    const room = at(compose);
    const composer = !Number.isFinite(full) ? card : Number.isFinite(foot) ? { ...card, y: room.y + room.h - foot - full, h: full } : full > card.h ? { ...card, y: card.y + card.h - full, h: full } : card;
    const words = [];
    const shown = (box) => box.w > 1 && box.h > 1;
    const word = (element) => {
      const box = at(element);
      if (shown(box) && element.textContent?.trim()) words.push(box);
    };
    let header = 0;
    for (const band of pane.querySelectorAll(":scope > :is(.watcher-head, .watcher-glance, .thread-workspace__error)")) {
      const box = at(band);
      header = Math.max(header, box.y + box.h);
      word(band);
    }
    for (const child of compose.children) {
      if (child.contains(form)) break;
      word(child);
    }
    for (const line of compose.querySelectorAll(":scope > .thread-pane__meta")) word(line);
    const scrubber = pane.querySelector(".message-scrubber");
    const lane = scrubber === null ? void 0 : at(scrubber);
    return { width: pane.clientWidth, height: pane.clientHeight, header, composer, words, ...lane !== void 0 && shown(lane) ? { lane } : {} };
  }
  function toWord(value, pixel) {
    const rgb = toRgb(value, pixel);
    if (rgb === null) return null;
    const a = pixel.getImageData(0, 0, 1, 1).data[3] / 255;
    return a >= 1 ? rgb : { ...rgb, a };
  }
  function surfaceOf(pane, pixel, ink) {
    const layers = [];
    for (let node = pane; node !== null; node = node.parentElement) {
      const found = toWord(getComputedStyle(node).backgroundColor, pixel);
      if (found === null) continue;
      const a = found.a ?? 1;
      layers.push({ rgb: { r: found.r, g: found.g, b: found.b }, a });
      if (a >= 1) break;
    }
    if (layers.length === 0) return null;
    const flatten = (desk) => layers.reduceRight((under, { rgb, a }) => ({ r: rgb.r * a + under.r * (1 - a), g: rgb.g * a + under.g * (1 - a), b: rgb.b * a + under.b * (1 - a) }), desk);
    if (layers[layers.length - 1].a >= 1) return flatten(DESKS[0]);
    const [white, black] = DESKS.map(flatten);
    if (ink === null) return white;
    const d = (one) => Math.abs(one.r - ink.r) + Math.abs(one.g - ink.g) + Math.abs(one.b - ink.b);
    return d(white) <= d(black) ? white : black;
  }
  function readInks(pane, probe, pixel) {
    const style = getComputedStyle(probe);
    const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel);
    const surface = surfaceOf(pane, pixel, text);
    if (text === null || accent === null || surface === null) return null;
    const words = [toWord(style.color, pixel), toWord(style.borderTopColor, pixel), toWord(style.borderRightColor, pixel), toWord(style.borderBottomColor, pixel)].filter((w) => w !== null);
    const scene = sceneInk(surface, text, accent, words);
    const role = (name) => {
      const el = document.createElement("i");
      el.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
      pane.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return toRgb(c, pixel) ?? text;
    };
    const roles = { text, text2: role("--tt-text-2"), muted: role("--tt-text-muted"), hint: role("--tt-text-hint"), border: role("--tt-hairline"), accent, canvas: surface };
    return { scene, font: style.fontFamily, light: scene.light, roles };
  }
  function runStage(ctx, hooks) {
    const { pane, probe } = ctx;
    const pixelCanvas = document.createElement("canvas");
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixel = pixelCanvas.getContext("2d", { willReadFrequently: true });
    const origin = performance.now();
    const clock = () => (performance.now() - origin) / 1e3;
    let disposed = false, timer = null, raf = null, laid = false, inked = "", measured = "", fullRoom = null;
    const cancel = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };
    const frame = () => {
      cancel();
      if (disposed || !laid) return;
      const next = hooks.frame(clock());
      if (next !== null && !disposed) timer = window.setTimeout(() => {
        timer = null;
        raf = requestAnimationFrame(() => {
          raf = null;
          frame();
        });
      }, Math.max(0, next - 12));
    };
    const wake = () => frame();
    const wakeSoon = () => {
      if (disposed) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (raf === null) raf = requestAnimationFrame(() => {
        raf = null;
        frame();
      });
    };
    const readInk = (force = false) => {
      const inks = readInks(pane, probe, pixel);
      if (inks === null) return;
      const key = JSON.stringify([inks.roles, inks.font]);
      if (key === inked && !force) return;
      inked = key;
      hooks.ink(inks);
      wake();
    };
    const relayout = () => {
      if (disposed) return;
      const room = measureRoom(pane);
      const compose = pane.querySelector(":scope > .thread-workspace__compose");
      if (compose?.hasAttribute("data-slim") !== true) fullRoom = room;
      const measure = heldRoom(room, fullRoom);
      const dpr = window.devicePixelRatio || 1;
      const key = JSON.stringify([measure, dpr]);
      if (key === measured) return;
      measured = key;
      if (measure === null) return;
      const head = pane.querySelector(":scope > .watcher-head");
      const strip = head ? head.getBoundingClientRect().bottom - pane.getBoundingClientRect().top : 0;
      const form = pane.querySelector(".thread-workspace__compose .thread-prompt");
      const cardTop = form ? form.getBoundingClientRect().top - pane.getBoundingClientRect().top : measure.composer.y;
      laid = hooks.layout(measure, dpr, { strip, cardTop });
      readInk(true);
      wake();
    };
    const sizes = new ResizeObserver(() => requestAnimationFrame(relayout));
    sizes.observe(pane);
    const theme = new MutationObserver(() => readInk());
    theme.observe(document.documentElement, { attributes: true });
    const font = `10.5px ${getComputedStyle(probe).fontFamily}`;
    void document.fonts?.load(font).then(() => {
      if (!disposed) readInk(true);
    });
    relayout();
    return { stop: () => {
      disposed = true;
      cancel();
      sizes.disconnect();
      theme.disconnect();
    }, wake: wakeSoon, clock };
  }
  var DESKS;
  var init_stage = __esm({
    "proto/stage.ts"() {
      "use strict";
      init_nightScene();
      init_canvasColor();
      DESKS = [{ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }];
    }
  });

  // proto/sceneLife.ts
  function startLife(ctx) {
    const { pane } = ctx;
    const painter = new NightScenePainter(ctx.back, ctx.front);
    const halo = document.createElement("div");
    halo.setAttribute("aria-hidden", "true");
    halo.style.cssText = "position:absolute;z-index:-1;pointer-events:none;display:none";
    ctx.back.before(halo);
    const setHalo = () => {
      const g = layout;
      if (!LOOK.halo || g === null || g.mode !== "trees") {
        halo.style.display = "none";
        return;
      }
      const left = g.column.right + 8, reach = g.moon.r * 3.8;
      halo.style.display = "block";
      halo.style.left = `${left}px`;
      halo.style.top = `${g.header}px`;
      halo.style.width = `${Math.max(0, g.width - left)}px`;
      halo.style.height = `${Math.max(0, g.moon.y + reach - g.header)}px`;
      halo.style.background = `radial-gradient(circle ${reach}px at ${g.moon.x - left}px ${g.moon.y - g.header}px, color-mix(in srgb, var(--tt-accent) 24%, transparent) 0, color-mix(in srgb, var(--tt-accent) 10%, transparent) 38%, transparent 100%)`;
    };
    SCENE_PLACES["night-wood"] = { ...NIGHT_WOOD, ambience: (layout2) => makeAmbience(layout2, painter) };
    const still = ctx.reduced;
    LIFE.still = still;
    LIFE.threads = SEED.map(([key, title, state, ask]) => ({ key, title, state, ask }));
    LIFE.acts.clear();
    LIFE.happenings = [];
    LIFE.poses = [];
    LIFE.pointer = null;
    let layout = null;
    let family = null;
    let watcher = { at: "home", side: "left", flight: null, next: 0 };
    let ripples = [];
    let look = null;
    let gazeFrom = null;
    let hoverKey = null;
    let lastT = 0;
    let perch = null;
    let callWatch = null;
    let round = null;
    let hunt = null;
    let roundIndex = 0, eventIndex = 0, scriptIndex = 0, made = 0;
    let later = [];
    const next = { gust: 1.2, shoot: 4, event: 2.5, round: 5, room: 7, fox: 4 };
    const cost = { frames: 0, painted: 0, ms: 0 };
    window.protoCost = cost;
    const say = (words) => LIFE.say(words);
    const act = (key, kind, dur, t0 = lastT) => {
      LIFE.acts.set(key, { kind, t0, dur });
    };
    const owlLayout = () => perch !== null && layout !== null ? { ...layout, visit: perch } : layout;
    const poseOf = (key) => LIFE.poses.find((pose) => pose.owl.key === key && !pose.flying);
    const takeOwls = (t) => {
      if (family === null || layout === null) return;
      for (const at of family.update(watched(), t, still ? "still" : layout.mode === "trees" ? "fly" : "fade")) ripples = addRipple(ripples, { x: layout.moon.x, y: layout.moon.y, t: at });
    };
    const meteorSpec = (rightward) => {
      const g = layout, W = g.width, speed = 560 + 160 * Math.random(), life = 0.55 + 0.3 * Math.random(), run = speed * life * 0.9;
      const roll = Math.random(), from = roll < 0.375 ? 0 : roll < 0.75 ? g.column.right : g.column.left, to = roll < 0.375 ? g.column.left : roll < 0.75 ? W : g.column.right;
      const room2 = Math.max(0, to - from - run), start = from + Math.random() * room2;
      return { x0: rightward ? start : start + run, y0: g.header + 12 + g.sky * 0.16 * Math.random(), dx: rightward ? 0.95 : -0.95, dy: 0.3, speed, life };
    };
    const gust = (t) => {
      const g = layout, tree = g.left;
      const leaves = Array.from({ length: 9 }, () => {
        const x = tree.x + (Math.random() - 0.3) * tree.h * 0.3;
        return { x, y: tree.y - tree.h * (0.62 + Math.random() * 0.3), delay: (x + 220) / 320 + Math.random() * 0.5, ph: Math.random() * 6 };
      });
      LIFE.happenings.push({ kind: "gust", t0: t, dur: (g.width + 700) / 320 + 3, strength: 0.75 + 0.25 * Math.random(), leaves });
    };
    const startRound = (t, key) => {
      if (round !== null || hunt !== null || layout === null || layout.mode !== "trees" || still) return false;
      const perched = LIFE.poses.filter((pose) => !pose.flying && pose.alpha > 0.9);
      let target = key === void 0 ? void 0 : perched.find((pose) => pose.owl.key === key);
      if (target === void 0) {
        const awake = perched.filter((pose) => pose.owl.mood === "awake");
        if (awake.length === 0) return false;
        target = awake[roundIndex++ % awake.length];
      }
      round = { key: target.owl.key, stage: "fly", at: t, flown: false, dur: 1 };
      return true;
    };
    const startHunt = (t) => {
      if (hunt !== null || round !== null || watcher.flight !== null || watcher.at !== "home" || layout === null) return false;
      const g = layout, x0 = g.left.x + 46 * g.s, x1 = Math.min(g.column.left - 70, x0 + 110);
      if (x1 - x0 < 40) return false;
      const mouse = { kind: "mouse", t0: t, dur: 40, x0, x1, run: 2.4, boltAt: null };
      LIFE.happenings.push(mouse);
      hunt = { stage: "mouse", at: t + 1.5, mouse };
      say("A mouse in the grass under Watcher’s tree");
      return true;
    };
    const play = (kind, t = lastT, burstFrom = null, quiet = false) => {
      const tell = (words) => {
        if (!quiet) say(words);
      };
      if (layout === null || layout.mode !== "trees" || still) return false;
      const g = layout, W = g.width;
      if (kind === "star") {
        LIFE.happenings.push({ kind: "star", t0: t, dur: 1.3, ...meteorSpec(Math.random() < 0.5) });
        return true;
      }
      if (kind === "gust") {
        gust(t);
        return true;
      }
      if (kind === "round") return startRound(t);
      if (kind === "hunt") return startHunt(t);
      if (kind === "meteors") {
        const rightward = Math.random() < 0.5;
        LIFE.happenings.push({ kind: "meteors", t0: t, dur: 4.6, list: Array.from({ length: 10 }, (_, k) => ({ at: k * 0.3 + Math.random() * 0.2, ...meteorSpec(rightward) })) });
        tell("A meteor shower");
      } else if (kind === "bats") {
        const bats = Array.from({ length: 7 }, (_, k) => ({ dx: k * 30 + Math.random() * 18, y: g.moon.y - 34 + Math.random() * 78, ph: Math.random() * 6, vx: -(70 + Math.random() * 150), vy: -(40 + Math.random() * 70) }));
        LIFE.happenings.push({ kind: "bats", t0: t, dur: burstFrom === null ? (W + 320) / 150 : 5, bats, from: burstFrom });
        tell(burstFrom === null ? "Bats cross the moon" : "Bats scatter from the bare tree");
      } else if (kind === "fox") {
        LIFE.happenings.push({ kind: "fox", t0: t, dur: (W + 170) / 95 + 2.2, stopX: g.column.left * 0.62 });
        tell("A fox crosses the wood");
      } else if (kind === "fish") {
        const p = riverPath(g).at(0.4);
        LIFE.happenings.push({ kind: "fish", t0: t, dur: 2.1, x: p.x, y: p.y });
        tell("A fish jumps in the river");
      } else if (kind === "cloud") {
        const r = g.moon.r;
        LIFE.happenings.push({ kind: "cloud", t0: t, dur: (r * 6.4 + 160) / 22, x0: g.moon.x + r * 3.2 + 80, y: g.moon.y - r * 0.1, rx: r * 2.3, ry: r * 0.85 });
        tell("A cloud crosses the moon");
      } else return false;
      return true;
    };
    const celebrate = (thread, t) => {
      const pose = poseOf(thread.key);
      if (!has("sparkle") || pose === void 0 || still) return;
      LIFE.happenings.push({ kind: "sparkle", t0: t, dur: 1.2, x: pose.x, y: pose.y, spin: Math.random() * 6 });
      act(thread.key, "happy", 2.6, t);
    };
    const room = (kind, t = lastT) => {
      const pick = (state) => {
        const list = LIFE.threads.filter((thread) => thread.state === state);
        return list[Math.floor(Math.random() * list.length)];
      };
      const mirror = has("mirror");
      if (kind === "start") {
        if (LIFE.threads.length >= 14) {
          room("wake", t);
          return;
        }
        const title = NEW_NAMES[made++ % NEW_NAMES.length];
        LIFE.threads.push({ key: `new-${made}`, title, state: "working", ask: null });
        const gusty = mirror && has("wind") && layout !== null && !still;
        say(`${title} starts: its owl comes out of the moon${gusty ? ", and the wind picks up" : ""}`);
        if (gusty) gust(t);
      } else if (kind === "wake" || kind === "retry") {
        const thread = pick(kind === "wake" ? "resting" : "failed");
        if (thread === void 0) return;
        thread.state = "working";
        act(thread.key, "wake", 1.5, t);
        say(kind === "wake" ? `${thread.title} starts working again` : `${thread.title} is tried again`);
      } else if (kind === "finish") {
        const thread = pick("working");
        if (thread === void 0) return;
        const star = mirror && has("shooting") && play("star", t + 0.4);
        say(`${thread.title} finished its turn${has("sparkle") ? ": sparks, a happy owl" : ""}${star ? ", a shooting star" : ""}`);
        celebrate(thread, t);
        if (has("sparkle") && !still) {
          later.push({ at: t + 2.6, run: () => {
            thread.state = "resting";
            takeOwls(lastT);
          } });
          return;
        }
        thread.state = "resting";
      } else if (kind === "ask") {
        const thread = pick("working");
        if (thread === void 0) return;
        thread.state = "waiting";
        thread.ask = Math.random() < 0.5 ? "question" : "permission";
        say(`${thread.title} ${thread.ask === "question" ? "asks you a question" : "asks for a permission"}${has("wave") ? ": its owl waves" : ""}`);
        if (mirror && has("rounds")) later.push({ at: t + 1.6, run: () => {
          startRound(lastT, thread.key);
        } });
      } else if (kind === "answer") {
        const thread = pick("waiting");
        if (thread === void 0) return;
        thread.state = "working";
        thread.ask = null;
        act(thread.key, "happy", 1.6, t);
        say(`You answered ${thread.title}`);
      } else if (kind === "fail") {
        const thread = pick("working");
        if (thread === void 0) return;
        thread.state = "failed";
        const bats = mirror && has("bats") && layout !== null && play("bats", t, { x: layout.right.x - layout.right.h * 0.1, y: layout.right.y - layout.right.h * 0.7 }, true);
        say(`${thread.title}: its last turn failed${has("fidget") ? ", its owl winces" : ""}${bats ? ", bats scatter from the bare tree" : ""}`);
      } else if (kind === "merge") {
        const thread = pick("working") ?? pick("resting");
        if (thread === void 0) return;
        LIFE.threads = LIFE.threads.filter((other) => other !== thread);
        const shower = mirror && has("meteors") && play("meteors", t + 0.7, null, true);
        say(`${thread.title}’s pull request merged: its owl flies home to the moon${shower ? " under a meteor shower" : ""}`);
      } else return;
      takeOwls(t);
      stage.wake();
    };
    const stepRound = (t) => {
      if (round === null || layout === null) return;
      const pose = poseOf(round.key), thread = threadOf(round.key);
      if (pose === void 0 || thread === void 0) {
        round = null;
        return;
      }
      const want = pose.x < layout.column.left ? "home" : "tree";
      if (round.stage === "fly") {
        if (watcher.flight !== null) return;
        if (watcher.at !== want && !round.flown && perch === null) {
          watcher = { ...watcher, flight: planFlight(layout, watcher, want, t, false) };
          round.flown = true;
          say(`Watcher checks ${thread.title}: its owl flies over`);
          return;
        }
        if (!round.flown) say(`Watcher checks ${thread.title}`);
        round.stage = "call";
        round.at = t + 0.45;
      } else if (round.stage === "call" && t >= round.at) {
        const owl = LIFE.watcher;
        if (owl === null) {
          round = null;
          return;
        }
        const from = { x: owl.x, y: owl.y - 50 * owl.s }, to = { x: pose.x, y: pose.y - 34 };
        round.dur = clamp(Math.hypot(to.x - from.x, to.y - from.y) / 300, 0.7, 1.5);
        LIFE.happenings.push({ kind: "note", t0: t, dur: round.dur, from, to, lift: 50, accent: true });
        callWatch = { at: to, since: t, until: t + round.dur * 2 + 1.4 };
        act(round.key, "lookup", round.dur, t);
        round.stage = "reply";
        round.at = t + round.dur;
      } else if (round.stage === "reply" && t >= round.at) {
        const owl = LIFE.watcher;
        act(round.key, "happy", 2, t);
        if (owl !== null) LIFE.happenings.push({ kind: "note", t0: t + 0.25, dur: round.dur, from: { x: pose.x, y: pose.y - 34 }, to: { x: owl.x, y: owl.y - 50 * owl.s }, lift: 50, accent: false });
        round.stage = "done";
        round.at = t + round.dur + 0.9;
      } else if (round.stage === "done" && t >= round.at) {
        round = null;
        watcher = { ...watcher, next: Math.max(watcher.next, t + 5) };
      }
    };
    const stepHunt = (t) => {
      if (hunt === null || layout === null) return;
      const mouse = hunt.mouse;
      if (hunt.stage === "mouse" && t >= hunt.at) {
        perch = { x: mouse.x1 - 6, y: groundAt(layout, mouse.x1 - 6) };
        watcher = { ...watcher, flight: planFlight(owlLayout(), watcher, "tree", t, false) };
        hunt.stage = "dive";
        say("Watcher’s owl dives for it");
      } else if (hunt.stage === "dive") {
        const flight = watcher.flight;
        if (flight !== null && mouse.boltAt === null && t >= flight.t0 + flight.dur - 0.8) {
          mouse.boltAt = t;
          mouse.until = t + 1.3;
        }
        if (flight === null && perch !== null) {
          hunt.stage = "sit";
          hunt.at = t + 2.6;
          callWatch = { at: { x: perch.x + 320, y: perch.y - 30 }, since: t, until: t + 1.9 };
          say("The mouse got away");
        }
      } else if (hunt.stage === "sit" && t >= hunt.at) {
        watcher = { ...watcher, flight: planFlight(owlLayout(), watcher, "home", t, false) };
        hunt.stage = "return";
      } else if (hunt.stage === "return" && watcher.flight === null) {
        perch = null;
        hunt = null;
      }
    };
    const stepWatcher = (t) => {
      if (layout === null || layout.mode !== "trees" || still) return;
      const flight = watcher.flight;
      if (flight !== null && t >= flight.t0 + flight.dur) watcher = { at: flight.to, side: flight.side, flight: null, next: t + stayAt(flight.to, Math.random()) * (LIFE.pace === "demo" ? 0.3 : 1) };
      if (watcher.flight === null && t >= watcher.next && !has("rounds") && hunt === null && round === null && perch === null) {
        watcher = { ...watcher, flight: planFlight(layout, watcher, nextPlace(watcher.at, Math.random(), layout.lane === null), t, false) };
      }
    };
    const direct = (t) => {
      LIFE.happenings = LIFE.happenings.filter((h) => t <= h.t0 + h.dur + 0.5 && (h.until === void 0 || t <= h.until));
      for (const [key, doing] of LIFE.acts) if (t > doing.t0 + doing.dur) LIFE.acts.delete(key);
      if (callWatch !== null && t > callWatch.until) callWatch = null;
      const due = later.filter((item) => t >= item.at);
      if (due.length > 0) {
        later = later.filter((item) => t < item.at);
        for (const item of due) item.run();
      }
      if (still || layout === null || layout.mode !== "trees") return;
      const pace = PACE[LIFE.pace], mirror = has("mirror"), jitter = () => 0.7 + 0.6 * Math.random();
      if (LIFE.autoRoom && t >= next.room) {
        room(ROOM_SCRIPT[scriptIndex++ % ROOM_SCRIPT.length], t);
        next.room = t + pace.room;
      }
      if (has("wind") && t >= next.gust) {
        gust(t);
        next.gust = t + (mirror ? 26 - 20 * activity() : pace.gust) * jitter();
      }
      if (has("shooting") && !mirror && t >= next.shoot) {
        play("star", t);
        next.shoot = t + pace.shoot * jitter();
      }
      if (has("rounds") && t >= next.round) {
        startRound(t);
        next.round = t + pace.round * jitter();
      }
      if (!mirror && t >= next.event) {
        const kinds = EVENTS.filter(has);
        for (let tries = 0; tries < kinds.length; tries++) if (play(kinds[eventIndex++ % kinds.length], t)) break;
        next.event = t + pace.event;
      }
      if (mirror && has("fox") && working() === 0 && t >= next.fox) {
        play("fox", t);
        next.fox = t + 45;
      }
      stepRound(t);
      stepHunt(t);
    };
    const lifted = (pose, t) => {
      if (pose.flying || still || LIFE.flags.size === 0) return pose;
      const doing = LIFE.acts.get(pose.owl.key);
      let up = false;
      if (doing !== void 0 && t >= doing.t0 && t < doing.t0 + doing.dur) up = doing.kind === "hop" || doing.kind === "happy" && Math.floor((t - doing.t0) * 4) % 4 === 1;
      else if (pose.owl.mood === "waiting") up = has("wave") && Math.floor(t * 3) % 12 === 6;
      else if (pose.owl.mood === "awake" && has("fidget") && !LIFE.watcherFlying) {
        const fidget = fidgetOf(pose.owl.order, t);
        up = fidget.roll === 6 && fidget.into < 0.28;
      }
      return up ? { ...pose, y: pose.y - CELL.h } : pose;
    };
    const stage = runStage(ctx, {
      layout(measure, dpr) {
        const laid = painter.resize(measure, dpr);
        if (laid === null) {
          layout = null;
          return false;
        }
        layout = laid;
        setHalo();
        if (watcher.flight !== null) watcher = { at: watcher.flight.to, side: watcher.flight.side, flight: null, next: watcher.next };
        if (laid.mode !== "trees" || perch !== null) watcher = { at: "home", side: "left", flight: null, next: watcher.next };
        perch = null;
        hunt = null;
        round = null;
        callWatch = null;
        ripples = [];
        LIFE.happenings = LIFE.happenings.filter((h) => h.kind === "gust");
        if (watcher.next === 0) watcher = { ...watcher, next: lastT + stayAt("home", Math.random()) * 0.25 };
        if (family === null) {
          family = new OwlFamily(laid);
          family.update(watched(), lastT, "still");
        } else {
          family.relayout(laid, lastT);
          takeOwls(lastT);
        }
        return true;
      },
      ink(inks) {
        painter.setInk(inks.scene, inks.font);
      },
      frame(t) {
        lastT = t;
        LIFE.now = t;
        if (layout === null || family === null || !painter.ready) return null;
        const began = performance.now();
        family.step(t);
        direct(t);
        stepWatcher(t);
        ripples = liveRipples(ripples, t, still);
        const trees = layout.mode === "trees";
        if (has("gaze") && !still && trees && LIFE.pointer !== null) {
          const pointer = LIFE.pointer;
          if (t - pointer.t < 1 && inMargin(layout, pointer.x) && pointer.y > layout.header) {
            gazeFrom ??= t;
            look = { x: pointer.x, y: pointer.y, t: Math.max(gazeFrom, t - 0.8) };
          } else gazeFrom = null;
        }
        const watch = callWatch !== null ? { at: callWatch.at, since: callWatch.since } : family.newcomer(t);
        const owlNow = trees ? owlAt(t, owlLayout(), watcher, { still, look, watch }) : null;
        LIFE.watcher = owlNow?.pose ?? null;
        LIFE.watcherFlying = owlNow?.stage === "flying";
        const poses = family.poses(t).map((pose) => lifted(pose, t));
        LIFE.poses = poses;
        const marker = family.marker, count = family.pileCount;
        const painted = painter.draw({ t, still, ripples, watcher: owlNow, watcherGlows: LIFE.threads.some((thread) => thread.state === "waiting"), owls: poses, whirl: family.whirl(t), pile: marker !== null && count > 0 ? { spot: marker, count } : null });
        cost.frames++;
        cost.ms += performance.now() - began;
        if (painted) cost.painted++;
        const looking = look !== null && t - look.t < 1.8;
        return frameDelay(family.moving(t) || owlNow?.stage === "flying" || looking || fast(t), ripples.length, still);
      }
    });
    const inPane = (event) => {
      const base = pane.getBoundingClientRect();
      return { x: event.clientX - base.left, y: event.clientY - base.top + pane.scrollTop };
    };
    const owlUnder = (p) => LIFE.poses.find((pose) => !pose.flying && Math.abs(p.x - pose.x) < 22 && p.y > pose.y - 42 && p.y < pose.y + 6);
    const move = (event) => {
      const p = inPane(event);
      LIFE.pointer = { ...p, t: stage.clock() };
      if (!has("gaze") || still) return;
      const key = owlUnder(p)?.owl.key ?? null;
      if (key !== hoverKey) {
        hoverKey = key;
        if (key !== null && !LIFE.acts.has(key)) act(key, "hop", 0.3, stage.clock());
      }
      stage.wake();
    };
    const press = (event) => {
      if (event.button !== 0 || layout === null || layout.mode !== "trees") return;
      if (!(event.target instanceof Element) || event.target.closest(NOT_BACKGROUND) !== null) return;
      const p = inPane(event), t = stage.clock();
      if (!inMargin(layout, p.x) || p.y < layout.header) return;
      const owl = owlUnder(p);
      if (owl !== void 0 && has("gaze") && !still && LIFE.watcher !== null) {
        act(owl.owl.key, "happy", 1.8, t);
        LIFE.happenings.push({ kind: "note", t0: t, dur: 1, from: { x: owl.x, y: owl.y - 34 }, to: { x: LIFE.watcher.x, y: LIFE.watcher.y - 50 * LIFE.watcher.s }, lift: 50, accent: true });
        callWatch = { at: { x: owl.x, y: owl.y - 30 }, since: t, until: t + 2.4 };
        say(`${owl.owl.title}’s owl calls to Watcher`);
      } else {
        ripples = addRipple(liveRipples(ripples, t, still), { x: p.x, y: p.y, t });
        look = { x: p.x, y: p.y, t };
        gazeFrom = null;
      }
      stage.wake();
    };
    pane.addEventListener("pointermove", move);
    pane.addEventListener("pointerdown", press);
    return {
      stop() {
        stage.stop();
        halo.remove();
        pane.removeEventListener("pointermove", move);
        pane.removeEventListener("pointerdown", press);
      },
      /** How the scene is drawn changed: the landscape is worked out and drawn again in this frame. */
      relook() {
        painter.relook();
        setHalo();
        stage.wake();
      },
      /** The choices changed: whatever is now switched on starts soon, and the picture is drawn again even while it holds still. */
      kick() {
        const t = stage.clock();
        next.gust = Math.min(next.gust, t + 0.8);
        next.shoot = Math.min(next.shoot, t + 3);
        next.event = Math.min(next.event, t + 2);
        next.round = Math.min(next.round, t + 4);
        next.room = Math.min(next.room, t + 6);
        next.fox = Math.min(next.fox, t + 3);
        painter.painted = "";
        stage.wake();
      },
      room(kind) {
        room(kind, stage.clock());
      },
      play(kind) {
        if (!play(kind, stage.clock()) && kind === "hunt") say("The owl hunts only from its own branch; try again when it is home");
        stage.wake();
      }
    };
  }
  var SEED, NEW_NAMES, ROOM_SCRIPT, PACE, NOT_BACKGROUND, moodOf, watched;
  var init_sceneLife = __esm({
    "proto/sceneLife.ts"() {
      "use strict";
      init_nightScene();
      init_painterLook();
      init_owlFamily();
      init_placeNightWood();
      init_scenePlaces();
      init_ambience();
      init_life();
      init_stage();
      SEED = [
        ["crash-sim", "Crash Sim", "working", null],
        ["samurai-ep3", "Samurai Ep 3", "working", null],
        ["design-climb", "Design climb", "working", null],
        ["visual-gate", "Visual gate flake", "waiting", "permission"],
        ["footer-links", "Footer links", "resting", null],
        ["weekly-note", "Weekly note", "resting", null],
        ["wav-stall", "Streaming WAV stall", "failed", null],
        ["inside-parts", "Inside parts", "working", null],
        ["grok-previews", "Grok voice previews", "resting", null],
        ["arena", "Arena background", "resting", null]
      ];
      NEW_NAMES = ["Fire fix", "Round 16 scores", "Record the sound", "Tray icon", "Release notes", "Host pairing"];
      ROOM_SCRIPT = ["finish", "wake", "ask", "answer", "start", "fail", "merge", "retry"];
      PACE = { demo: { round: 11, event: 13, shoot: 9, room: 8, gust: 9 }, real: { round: 50, event: 90, shoot: 45, room: 35, gust: 16 } };
      NOT_BACKGROUND = [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "label",
        "summary",
        "dialog",
        "[contenteditable]",
        ...["button", "tab", "link", "menuitem", "option", "combobox", "textbox", "dialog", "menu", "listbox", "checkbox", "radio", "switch", "slider"].map((role) => `[role="${role}"]`),
        ".thread-workspace__compose",
        ".watcher-head",
        ".watcher-glance"
      ].join(", ");
      moodOf = (thread) => thread.state === "working" ? "awake" : thread.state === "waiting" ? "waiting" : "asleep";
      watched = () => LIFE.threads.map((thread) => ({ key: thread.key, title: thread.title, threadId: null, mood: moodOf(thread) }));
    }
  });

  // proto/index.ts
  var require_index = __commonJS({
    "proto/index.ts"() {
      init_life();
      init_sceneLife();
      var running = null;
      var reduced = null;
      function start(options) {
        const pane = document.querySelector(".watcher-pane");
        const back = pane?.querySelector("canvas.watcher-scene--land"), front = pane?.querySelector("canvas.watcher-scene--owl");
        const probe = pane?.querySelector(".watcher-scene__ink");
        if (!pane || !back || !front || !probe || running !== null && reduced === options.reduced) return;
        running?.stop();
        reduced = options.reduced;
        running = startLife({ pane, back, front, probe, reduced: options.reduced, options: {}, owls: [] });
      }
      window.ProtoScene = {
        flags: FLAGS,
        presets: PRESETS,
        start,
        setFlags(ids) {
          LIFE.flags = new Set(ids);
          running?.kick();
        },
        setPace(pace) {
          LIFE.pace = pace;
          running?.kick();
        },
        setAuto(on) {
          LIFE.autoRoom = on;
          running?.kick();
        },
        setLook(look) {
          if (look.shape === LOOK.shape && look.depth === LOOK.depth && look.halo === LOOK.halo) return;
          Object.assign(LOOK, look);
          running?.relook();
        },
        room(kind) {
          running?.room(kind);
        },
        play(kind) {
          running?.play(kind);
        },
        onSay(listener) {
          LIFE.say = listener;
        }
      };
    }
  });
  require_index();
})();
