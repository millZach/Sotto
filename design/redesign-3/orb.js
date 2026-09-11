/* global window, document, requestAnimationFrame */
// The agent orb, second pass.
//
// A subdivided icosphere (uniform triangle mesh, no poles) displaced by three
// octaves of 3D Perlin noise, drawn as additive strokes in three passes: a wide
// bloom, a tight bloom and a sharp pass. Alpha rises toward the silhouette so
// the rim reads as the bright band in the reference renders, and colour runs
// diagonally across the screen (colour A top-left, colour B bottom-right) with
// the brightest edges pushed toward white.
//
//   const orb = SottoOrb(canvas, { colors: 'violet', state: 'wake' })
//   orb.setState('listening')     // idle | wake | listening | speaking | working
//   orb.setColors('teal')         // preset name or ['#a', '#b']
//   orb.tune({ amp: 0.3 })        // override any TUNE value live
//   orb.settings()                // current TUNE values (for the lab page)
(function () {
  // ---- colour helpers ----
  function hex(c) { const n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  const rgba = (c, al) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;
  const WHITE = [255, 255, 255];

  const PRESETS = {
    violet: ['#4f7dff', '#e04cff'],
    ice: ['#bff4ff', '#5cc8ff'],
    teal: ['#9df0e3', '#2c7a72'],
    amber: ['#ffd89a', '#e0701a'],
    mono: ['#ffffff', '#8a9099'],
  };

  // Motion per state. amp scales the lumps, flow is how fast the noise field
  // evolves, spin is the slow rotation, pulse is a breathing radius change,
  // glow multiplies bloom.
  const STATES = {
    idle: { amp: 0.55, flow: 0.25, spin: 0.04, pulse: 0.00, glow: 0.7 },
    wake: { amp: 0.85, flow: 0.45, spin: 0.06, pulse: 0.00, glow: 1.0 },
    listening: { amp: 1.05, flow: 0.90, spin: 0.08, pulse: 0.06, glow: 1.15 },
    speaking: { amp: 1.35, flow: 1.40, spin: 0.10, pulse: 0.03, glow: 1.25 },
    working: { amp: 0.75, flow: 0.60, spin: 0.22, pulse: 0.00, glow: 0.9 },
  };

  // Look. Everything here can be overridden with tune().
  const TUNE = {
    density: 4,       // icosphere subdivision level: 3 (642 verts), 4 (2562), 5 (10242)
    radius: 0.23,     // sphere radius as a fraction of min(canvas w, h)
    amp: 0.18,        // displacement amplitude (multiplied by the state's amp)
    lump: 2.2,        // frequency of the big lumps
    ripple: 6.4,      // frequency of the medium ripples
    rippleMix: 1.0,  // how much medium ripple is added
    grain: 9.5,       // frequency of the fine grain
    grainMix: 0.10,   // how much fine grain is added
    line: 0.5,        // sharp line width in CSS px
    alpha: 0.46,      // overall line opacity
    rim: 0.9,         // how much the silhouette brightens
    back: 0.24,       // opacity of the far side relative to the near side
    hot: 0.10,        // how far the brightest edges push toward white
    bloom: 0.85,       // bloom strength
    bloomWide: 27,    // wide bloom blur in CSS px
    bloomTight: 9,    // tight bloom blur in CSS px
    fill: 1.0,       // interior glow
    halo: 0.20,       // outer halo behind the orb
    dust: 220,        // number of dust points
    tilt: -0.75,       // camera tilt in radians
    perspective: 0.6,
  };

  // ---- improved Perlin noise (Ken Perlin 2002), 3D ----
  const perm = new Uint8Array(512);
  (function () {
    const p = []; for (let i = 0; i < 256; i++) p[i] = i;
    let s = 1337; const r = () => (s = s * 16807 % 2147483647) / 2147483647;
    for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  })();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  function grad(h, x, y, z) {
    switch (h & 15) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
      case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
      case 12: return y + x; case 13: return -y + z; case 14: return y - x; default: return -y - z;
    }
  }
  function noise(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z, B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    return lerp(
      lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  }

  // ---- icosphere ----
  const meshCache = {};
  function icosphere(level) {
    if (meshCache[level]) return meshCache[level];
    const t = (1 + Math.sqrt(5)) / 2;
    let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
    verts = verts.map(norm);
    for (let l = 0; l < level; l++) {
      const mid = new Map();
      const midpoint = (a, b) => {
        const key = a < b ? a * 65536 + b : b * 65536 + a;
        if (mid.has(key)) return mid.get(key);
        const va = verts[a], vb = verts[b];
        verts.push(norm([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
        mid.set(key, verts.length - 1); return verts.length - 1;
      };
      const next = [];
      for (const [a, b, c] of faces) {
        const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
        next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      faces = next;
    }
    const edgeSet = new Set(); const edges = [];
    for (const [a, b, c] of faces) for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p * 65536 + q : q * 65536 + p;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push(p < q ? [p, q] : [q, p]); }
    }
    return (meshCache[level] = { verts, edges });
  }

  window.SottoOrb = function (canvas, options) {
    options = options || {};
    const ctx = canvas.getContext('2d');
    // bloom is computed at quarter resolution: stroke into `glow`, blur into
    // `wide` and `tight`, then upscale. The blur hides the low resolution.
    const glow = document.createElement('canvas'), gctx = glow.getContext('2d');
    const wide = document.createElement('canvas'), wctx = wide.getContext('2d');
    const tight = document.createElement('canvas'), tctx = tight.getContext('2d');
    const Q = 0.25;
    const tune = { ...TUNE, ...(options.tune || {}) };
    let mesh = icosphere(tune.density);

    let seed = 7; const rand = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    let dust = [];
    const makeDust = () => {
      seed = 7; dust = [];
      for (let i = 0; i < tune.dust; i++) {
        const u = rand() * 2 - 1, ph = rand() * 6.283, r = 1.25 + rand() * 0.75, s = Math.sqrt(1 - u * u);
        dust.push([s * Math.cos(ph) * r, u * r, s * Math.sin(ph) * r, 0.4 + rand() * 0.6]);
      }
    };
    makeDust();

    let pair = PRESETS[options.colors] || options.colors || PRESETS.teal;
    let A = hex(pair[0]), B = hex(pair[1]);
    let target = STATES[options.state] || STATES.wake;
    const cur = { ...target };
    const still = !!options.still;
    let t = still ? 3.7 : 0, spin = still ? 0.6 : 0, running = true;

    // colour lookup: 12 hue steps x 4 heat steps
    const HUES = 12, HEAT = 4;
    let palette = [];
    const buildPalette = () => {
      palette = [];
      for (let h = 0; h < HUES; h++) {
        const base = mix(A, B, h / (HUES - 1));
        for (let k = 0; k < HEAT; k++) palette.push(mix(base, WHITE, (k / (HEAT - 1)) * tune.hot));
      }
    };
    buildPalette();

    const ALPHAS = 10;
    const bucketCount = HUES * HEAT * ALPHAS;
    let buckets = new Array(bucketCount);

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (cw === 0 || ch === 0) { if (running && !still) requestAnimationFrame(draw); return; }
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
      }
      const w = canvas.width, h = canvas.height;
      const gw = Math.max(2, Math.round(w * Q)), gh = Math.max(2, Math.round(h * Q));
      for (const c of [glow, wide, tight]) if (c.width !== gw || c.height !== gh) { c.width = gw; c.height = gh; }

      for (const k in target) cur[k] += (target[k] - cur[k]) * (still ? 1 : 0.05);
      const dt = 0.016;
      t += dt * cur.flow; spin += dt * cur.spin;

      const R = Math.min(w, h) * tune.radius * (1 + cur.pulse * Math.sin(t * 3.2));
      const cx = w / 2, cy = h / 2;
      const ca = Math.cos(spin), sa = Math.sin(spin), cb = Math.cos(tune.tilt), sb = Math.sin(tune.tilt);
      const ampNow = tune.amp * cur.amp;

      // ---- displace and project ----
      const V = mesh.verts, n = V.length;
      const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
      const rimv = new Float32Array(n), huev = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = V[i];
        const big = noise(v[0] * tune.lump + t * 0.31, v[1] * tune.lump - t * 0.23, v[2] * tune.lump + t * 0.17);
        const med = noise(v[0] * tune.ripple - t * 0.5, v[1] * tune.ripple + t * 0.4, v[2] * tune.ripple - t * 0.3);
        const fine = noise(v[0] * tune.grain + t, v[1] * tune.grain - t * 0.8, v[2] * tune.grain + t * 0.6);
        const d = big + med * tune.rippleMix + fine * tune.grainMix;
        const r = 1 + ampNow * d;
        const x = v[0] * r, y = v[1] * r, z = v[2] * r;
        // rotate: spin about y, then tilt about x
        const X = x * ca - z * sa; let Z = x * sa + z * ca;
        const Y = y * cb - Z * sb; Z = y * sb + Z * cb;
        const p = 1 / (1 - Z * tune.perspective);
        sx[i] = cx + X * R * p; sy[i] = cy + Y * R * p; sz[i] = Z;
        // rim: how grazing the surface is to the camera (normal ~ radial direction)
        const nz = Z / Math.hypot(X, Y, Z);
        rimv[i] = Math.pow(1 - Math.abs(nz), 2);
        // hue runs from A (top-left) to B (bottom-right) on screen
        huev[i] = Math.max(0, Math.min(1, 0.5 + (X + Y) * 0.36));
      }

      // ---- bucket edges by colour and alpha ----
      for (let i = 0; i < bucketCount; i++) buckets[i] = null;
      const E = mesh.edges;
      for (let e = 0; e < E.length; e++) {
        const a = E[e][0], b = E[e][1];
        const z = (sz[a] + sz[b]) / 2;
        const front = (z + 1) / 2;
        const rim = (rimv[a] + rimv[b]) / 2;
        const depthAlpha = tune.back + (1 - tune.back) * front * front;
        let al = tune.alpha * depthAlpha * (0.35 + rim * tune.rim);
        if (al > 1) al = 1;
        const ai = Math.min(ALPHAS - 1, (al * ALPHAS) | 0);
        if (ai === 0 && al < 0.03) continue;
        const hi = Math.round(((huev[a] + huev[b]) / 2) * (HUES - 1));
        const ki = Math.min(HEAT - 1, (rim * front * 2.2 * (HEAT - 1)) | 0);
        const key = (hi * HEAT + ki) * ALPHAS + ai;
        let path = buckets[key];
        if (!path) path = buckets[key] = new Path2D();
        path.moveTo(sx[a], sy[a]); path.lineTo(sx[b], sy[b]);
      }

      // ---- background: halo and interior fill ----
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.clearRect(0, 0, w, h);
      const m = mix(A, B, 0.5);
      if (tune.halo > 0) {
        // the halo must reach zero inside the canvas or its edge shows as a box
        const edge = Math.min(cx, cy);
        const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, edge);
        halo.addColorStop(0, rgba(m, tune.halo * cur.glow));
        halo.addColorStop(0.4, rgba(m, tune.halo * cur.glow * 0.22));
        halo.addColorStop(0.85, rgba(m, tune.halo * cur.glow * 0.02));
        halo.addColorStop(1, rgba(m, 0));
        ctx.fillStyle = halo; ctx.fillRect(0, 0, w, h);
      }
      if (tune.fill > 0) {
        const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (1 + ampNow * 0.6));
        inner.addColorStop(0, rgba(mix(m, WHITE, 0.25), tune.fill * 0.55));
        inner.addColorStop(0.7, rgba(m, tune.fill * 0.35));
        inner.addColorStop(1, rgba(m, 0));
        ctx.fillStyle = inner; ctx.fillRect(0, 0, w, h);
      }

      // ---- glow passes: stroke the same paths at half resolution, then blur up ----
      const strokeAll = (c, scale, width, alphaMul) => {
        c.lineWidth = width; c.lineCap = 'round';
        for (let key = 0; key < bucketCount; key++) {
          const path = buckets[key]; if (!path) continue;
          const ai = key % ALPHAS, ci = (key / ALPHAS) | 0;
          const al = Math.min(1, ((ai + 0.5) / ALPHAS) * alphaMul);
          c.strokeStyle = rgba(palette[ci], al);
          c.stroke(path);
        }
      };
      if (tune.bloom > 0) {
        gctx.setTransform(Q, 0, 0, Q, 0, 0);
        gctx.globalCompositeOperation = 'source-over';
        gctx.clearRect(0, 0, w, h);
        gctx.globalCompositeOperation = 'lighter';
        strokeAll(gctx, Q, dpr * 0.8 / Q, 0.75);
        const blurInto = (c, px) => {
          c.setTransform(1, 0, 0, 1, 0, 0); c.filter = 'none'; c.clearRect(0, 0, gw, gh);
          c.filter = `blur(${Math.max(0.5, px * dpr * Q)}px)`; c.drawImage(glow, 0, 0); c.filter = 'none';
        };
        blurInto(wctx, tune.bloomWide);
        blurInto(tctx, tune.bloomTight);
        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.globalAlpha = Math.min(1, 0.7 * tune.bloom * cur.glow);
        ctx.drawImage(wide, 0, 0, gw, gh, 0, 0, w, h);
        ctx.globalAlpha = Math.min(1, 0.55 * tune.bloom * cur.glow);
        ctx.drawImage(tight, 0, 0, gw, gh, 0, 0, w, h);
        ctx.globalAlpha = 1;
      }

      // ---- sharp pass ----
      ctx.globalCompositeOperation = 'lighter';
      strokeAll(ctx, 1, dpr * tune.line, 1);

      // ---- dust ----
      for (let i = 0; i < dust.length; i++) {
        const d = dust[i];
        const x = d[0], y = d[1], z = d[2];
        const X = x * ca - z * sa; let Z = x * sa + z * ca;
        const Y = y * cb - Z * sb; Z = y * sb + Z * cb;
        const p = 1 / (1 - Z * tune.perspective);
        const px = cx + X * R * p, py = cy + Y * R * p;
        const c = mix(A, B, Math.max(0, Math.min(1, 0.5 + (X + Y) * 0.3)));
        const al = (0.10 + (Z + 1) * 0.28) * d[3];
        ctx.fillStyle = rgba(c, al);
        const s = dpr * (0.8 + d[3] * 0.8);
        ctx.fillRect(px - s / 2, py - s / 2, s, s);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (running && !still) requestAnimationFrame(draw);
    }
    draw();

    return {
      setState(name) { target = STATES[name] || STATES.wake; if (still) draw(); },
      setColors(next) { pair = PRESETS[next] || next; A = hex(pair[0]); B = hex(pair[1]); buildPalette(); if (still) draw(); },
      tune(patch) {
        Object.assign(tune, patch);
        if (patch.density !== undefined) mesh = icosphere(tune.density);
        if (patch.dust !== undefined) makeDust();
        if (patch.hot !== undefined) buildPalette();
        if (still) draw();
      },
      settings() { return { ...tune }; },
      colors() { return pair; },
      stop() { running = false; },
      presets: PRESETS,
      states: STATES,
      defaults: TUNE,
    };
  };
})();
