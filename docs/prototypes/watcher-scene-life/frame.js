// PROTOTYPE, throwaway. Runs one frame of the watcher-scene-life prototype: Sotto's own Watcher room, dumped from the
// built app on November 6, 2026 with the tidied controls laid over it (controls2.css), its night scene drawn by scene.js,
// and the prototype's switch bar. Nothing here is pressed through to the app, which is not running.
(function () {
  const q = new URLSearchParams(location.search)
  const root = document.documentElement
  for (const el of document.querySelectorAll('[data-proto-scroll]')) el.scrollTop = Number(el.getAttribute('data-proto-scroll'))
  for (const el of document.querySelectorAll('select[data-proto-value]')) el.value = el.getAttribute('data-proto-value')
  document.addEventListener('click', e => { if (!e.target.closest('[data-proto-live]')) { e.preventDefault(); e.stopPropagation() } }, true)

  const pane = document.querySelector('.watcher-pane')
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

  // The owner's machines: This computer 2 working, forge 1 working (the fixture's window counted its own three).
  for (const group of pane.querySelectorAll('.watcher-machines__wide, .watcher-machines__narrow')) {
    const here = group.querySelector('.watcher-machines__machine')
    if (!here) continue
    here.querySelector('.watcher-machines__count').textContent = ' 2 working'
    const forge = here.cloneNode(true)
    forge.dataset.host = 'forge'
    forge.querySelector('.watcher-machines__name span').textContent = 'forge'
    forge.querySelector('.watcher-machines__count').textContent = ' 1 working'
    group.appendChild(forge)
  }

  // ---------- The tidied controls (controls2.css), as the November 6 prototype built them ----------
  for (const work of pane.querySelectorAll('.thread-message__work')) {
    const text = [...work.childNodes].find(n => n.nodeType === 3)
    if (text) { const span = el('span', 'proto-work-text', text.textContent); work.replaceChild(span, text) }
    work.setAttribute('data-proto-live', '')
    work.setAttribute('aria-label', 'Details: ' + work.textContent.trim())
    work.addEventListener('click', () => work.toggleAttribute('data-proto-open'))
  }
  // Two Watcher messages within 5 minutes share one header; a reply to news starts its own, since it is a new turn.
  let groupStart = null
  for (const article of pane.querySelectorAll('.thread-message')) {
    const time = article.querySelector(':scope > header time')
    const at = time ? Date.parse(time.getAttribute('datetime')) : NaN
    const watcher = article.dataset.role === 'assistant'
    const news = article.querySelector(':scope > header .thread-message__work') !== null
    if (watcher && !news && groupStart !== null && at - groupStart <= 5 * 60_000) article.setAttribute('data-proto-grouped', '')
    else groupStart = watcher ? at : null
  }
  // The answered card's line, in one row.
  for (const receipt of pane.querySelectorAll('.watcher-ask-receipt')) {
    const row = el('p', 'proto-receipt2 tt-paragraph')
    row.append(el('span', 'proto-receipt2__tick', '✓'), el('span', 'proto-receipt2__words', 'You answered Crash Sim'), el('span', 'proto-receipt2__sep', '·'),
      el('span', 'proto-receipt2__count', '6 choices'), el('span', 'proto-receipt2__sep', '·'))
    const open = el('button', 'watcher-ask__open proto-receipt2__open tt-focusable', 'Open ›')
    open.type = 'button'; open.title = 'Open Crash Sim beside Watcher'
    row.append(open)
    receipt.after(row)
  }
  // The New messages pill, fixed just above the composer, with its count.
  const viewport = pane.querySelector('.thread-transcript__viewport')
  const pill = el('button', 'proto-pill tt-focusable')
  pill.type = 'button'; pill.setAttribute('aria-label', '2 new messages. Jump to them')
  pill.append(el('span', null, '2 new'), el('span', 'proto-pill__arrow', '↓'))
  viewport.appendChild(pill)
  // The status line in one line, left-aligned with the column: waiting first, then failures, then the machines, dimmed.
  const glance = pane.querySelector(':scope > .watcher-glance')
  const status = el('div', 'proto-status2')
  status.setAttribute('role', 'group'); status.setAttribute('aria-label', 'What needs you and what works where')
  const part = (cls, name, why) => { const s = el('span', 'proto-status2__part ' + cls); const b = el('button', 'proto-status2__name tt-focusable', name); b.type = 'button'; s.append(el('span', 'watcher-row__ring'), b, el('span', 'proto-status2__why', ' ' + why)); return s }
  const waiting = part('', 'Visual gate flake', 'waits on a permission'); waiting.querySelector('.watcher-row__ring').dataset.tone = 'needs'
  const failed = part('', 'Streaming WAV stall', 'last turn failed'); failed.querySelector('.watcher-row__ring').dataset.tone = 'failed'
  status.append(waiting, el('span', 'proto-status2__sep', '·'), failed, el('span', 'proto-status2__sep', '·'), el('span', 'proto-status2__machines', 'This computer 2 · forge 1 working'))
  glance.appendChild(status)
  // Stop all: set apart from Move threads, saying how many it stops.
  const stop = pane.querySelector('.watcher-stop-all__button')
  if (stop) {
    stop.append(el('span', 'proto-stop-count', 'Stop 4 running'))
    stop.parentElement.before(el('span', 'proto-strip-gap'))
  }
  // The list ends at the composer's top edge.
  const cut = () => {
    const scroller = pane.querySelector('.thread-workspace__transcript'), form = pane.querySelector('.thread-workspace__compose .thread-prompt')
    if (!scroller || !form) return
    const v = scroller.getBoundingClientRect(), f = form.getBoundingClientRect()
    pane.style.setProperty('--proto-cut', Math.max(0, Math.round(v.bottom - f.top + 6)) + 'px')
    pane.style.setProperty('--proto-pill-bottom', Math.max(0, Math.round(viewport.getBoundingClientRect().bottom - f.top + 10)) + 'px')
  }
  new ResizeObserver(cut).observe(pane)
  cut()

  // ---------- The switch bar ----------
  const P = window.ProtoScene
  const groups = { wood: 'The wood', owls: 'The owls', events: 'Events' }
  const presetOf = flags => { const key = [...flags].sort().join(); return P.presets.find(p => [...p.flags].sort().join() === key) }
  // With no choice in the address the page opens on E, everything at once; A to D take it apart.
  const first = P.presets.find(p => p.id === (q.get('v') || 'E')) || P.presets[P.presets.length - 1]
  const state = {
    flags: new Set(q.has('flags') ? q.get('flags').split(',').filter(Boolean) : first.flags),
    mode: q.get('mode') || 'dark', reduced: q.get('reduced') === '1', pace: q.get('pace') || 'demo', auto: q.get('auto') !== '0',
    open: q.get('open') === '1', hidden: q.get('bar') === '0', look: q.get('look') || 'both',
  }
  // How the scene is drawn, apart from what moves in it.
  const LOOKS = [
    ['today', 'Today', 'Each cell becomes the character for how dense it is, as the scene is drawn now.', { shape: false, depth: false, halo: false }],
    ['lines', 'Line art', 'Each cell becomes the character whose shape fits what is drawn in it: a ridge is _ - ~, a branch / \\ |.', { shape: true, depth: false, halo: false }],
    ['depth', 'Depth', 'The wood is drawn in layers: what is in front hides what is behind, far hills are fainter, and the moon has a halo.', { shape: false, depth: true, halo: true }],
    ['both', 'Line art + depth', 'Characters picked by shape, in layers with depth and the moon\u2019s halo.', { shape: true, depth: true, halo: true }],
  ]
  root.dataset.protoControls = '2'

  const host = el('div'); host.setAttribute('data-proto-live', '')
  const shadow = host.attachShadow({ mode: 'open' })
  // The bar is a strip under the room, which is made that much shorter, so nothing of the scene is ever covered by it.
  const STRIP = 46
  // The app's shell is as tall as the window whatever holds it, so each box down to it is given the shorter height.
  const shell = [root, document.body, document.getElementById('root'), document.querySelector('.app-shell')].filter(Boolean)
  const room = hidden => { for (const box of shell) { box.style.height = hidden ? '' : `calc(100vh - ${STRIP}px)`; box.style.minHeight = hidden ? '' : '0' } }
  room(false)
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .strip, .panel { font: 13px/1.4 Figtree, system-ui, sans-serif; color: #e9e6df; }
    .strip { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; height: ${STRIP}px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 10px;
      background: #26221d; border-top: 1px solid #4a4239; }
    .tag { flex: none; padding: 1px 7px; border-radius: 6px; background: #e7b15a; color: #26221d; font-weight: 700; font-size: 11px; letter-spacing: .05em; }
    .seg { display: flex; flex-wrap: wrap; gap: 4px; }
    .strip .seg { flex: none; flex-wrap: nowrap; }
    button { height: 28px; padding: 0 9px; border: 1px solid #4a4239; border-radius: 7px; background: #302a24; color: #e9e6df; font: inherit; cursor: pointer; white-space: nowrap; }
    button:hover { background: #3a332b; }
    button[aria-pressed="true"] { background: #e7b15a; border-color: #e7b15a; color: #26221d; font-weight: 700; }
    button:focus-visible, input:focus-visible { outline: 2px solid #f3d29b; outline-offset: 2px; }
    #presets button b { font-weight: 700; }
    #presets button span { margin-left: 6px; }
    @media (max-width: 1500px) { #presets button:not([aria-pressed="true"]) span { display: none; } }
    @media (max-width: 1000px) { #presets button span, .tag { display: none; } }
    .sep { flex: none; width: 1px; height: 22px; margin: 0 4px; background: #4a4239; }
    .lab { flex: none; color: #b9ae9f; font-size: 12px; }
    @media (max-width: 1250px) { .lab { display: none; } }
    @media (max-width: 1000px) { #looks button:not([aria-pressed="true"]) { display: none; } }
    .now { flex: 1; min-width: 0; margin: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cfc6b9; }
    .now b { color: #e7b15a; font-weight: 600; }
    .panel { position: fixed; right: 10px; bottom: ${STRIP + 8}px; z-index: 2147483000; width: 400px; max-width: calc(100vw - 20px); max-height: calc(100vh - ${STRIP + 24}px); overflow: auto; box-sizing: border-box; padding: 4px 12px 12px;
      background: #26221d; border: 1px solid #4a4239; border-radius: 12px; box-shadow: 0 12px 34px -10px rgba(0,0,0,.7); }
    .panel[hidden], .strip[hidden] { display: none; }
    .line { margin: 8px 0; color: #cfc6b9; }
    h2 { margin: 12px 0 5px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #9c9284; }
    .mix { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px 10px; }
    .mix div > b { display: block; margin-bottom: 2px; color: #b9ae9f; font-size: 12px; font-weight: 600; }
    label { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; white-space: nowrap; }
    input { accent-color: #e7b15a; margin: 0; }
    .pair { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
    .pair > span { width: 52px; flex: none; color: #b9ae9f; font-size: 12px; }
    .keys { margin: 10px 0 0; color: #9c9284; font-size: 11.5px; }
  </style>
  <section class="panel" id="panel" aria-label="Prototype controls" hidden>
    <p class="line" id="line"></p>
    <h2>Mix your own</h2><div class="mix" id="mix"></div>
    <label title="Nothing runs on a timer: the wood answers what your threads do."><input type="checkbox" data-flag="mirror"> Tied to the room, not a timer</label>
    <h2>Make the room do something</h2>
    <div class="seg" id="room">
      <button type="button" data-v="start">Thread starts</button><button type="button" data-v="finish">Thread finishes</button><button type="button" data-v="ask">Thread asks you</button>
      <button type="button" data-v="answer">You answer</button><button type="button" data-v="fail">Thread fails</button><button type="button" data-v="merge">Pull request merges</button>
    </div>
    <label><input type="checkbox" id="auto"> The room plays by itself</label>
    <h2>Play now</h2>
    <div class="seg" id="play">
      <button type="button" data-v="gust">Gust</button><button type="button" data-v="star">Shooting star</button><button type="button" data-v="round">Watcher checks a thread</button>
      <button type="button" data-v="meteors">Meteor shower</button><button type="button" data-v="bats">Bats</button><button type="button" data-v="fox">Fox</button>
      <button type="button" data-v="fish">Fish</button><button type="button" data-v="hunt">Owl hunts</button><button type="button" data-v="cloud">Cloud</button>
    </div>
    <div class="pair"><span>Pace</span><div class="seg" id="pace"><button type="button" data-v="demo" title="Things come a few seconds apart, to show them">Demo</button><button type="button" data-v="real" title="As often as they would in the app: most of a minute apart">As in the app</button></div></div>
    <div class="pair"><span>Mode</span><div class="seg" id="mode"><button type="button" data-v="dark">Dark</button><button type="button" data-v="light">Light</button></div></div>
    <div class="pair"><span>Motion</span><div class="seg" id="reduced"><button type="button" data-v="0">Normal</button><button type="button" data-v="1">Reduced</button></div></div>
    <p class="keys">← → or 1 to 5 variant · ↑ ↓ how it is drawn · C controls · L light · R reduced motion · H hide this strip</p>
  </section>
  <section class="strip" id="strip" aria-label="Prototype variants">
    <span class="tag">PROTOTYPE</span>
    <div class="seg" id="presets"></div>
    <span class="sep"></span><span class="lab">Drawn as</span>
    <div class="seg" id="looks"></div>
    <p class="now" id="now" aria-live="polite"></p>
    <button type="button" id="fold" aria-expanded="false">Controls</button>
  </section>`
  document.body.appendChild(host)
  const $ = id => shadow.getElementById(id)
  for (const p of P.presets) { const b = el('button'); b.type = 'button'; b.dataset.v = p.id; b.title = p.line; b.setAttribute('aria-label', `Variant ${p.id}, ${p.name}`); b.append(el('b', null, p.id), el('span', null, p.name)); $('presets').append(b) }
  for (const [id, name, line] of LOOKS) { const b = el('button', null, name); b.type = 'button'; b.dataset.v = id; b.title = line; b.setAttribute('aria-label', `Drawn as: ${name}`); $('looks').append(b) }
  for (const [group, title] of Object.entries(groups)) {
    const box = el('div'); box.append(el('b', null, title))
    for (const f of P.flags.filter(f => f.group === group)) { const l = el('label'); l.title = f.line; const i = el('input'); i.type = 'checkbox'; i.dataset.flag = f.id; l.append(i, ' ' + f.name); box.append(l) }
    $('mix').append(box)
  }

  const params = () => {
    const preset = presetOf(state.flags), out = new URLSearchParams()
    if (preset) out.set('v', preset.id); else out.set('flags', [...state.flags].join(','))
    out.set('look', state.look); out.set('mode', state.mode); out.set('reduced', state.reduced ? '1' : '0'); out.set('pace', state.pace); out.set('auto', state.auto ? '1' : '0')
    if (state.open) out.set('open', '1')
    if (state.hidden) out.set('bar', '0')
    return out
  }
  const render = () => {
    const preset = presetOf(state.flags)
    $('line').textContent = preset ? preset.line : [...state.flags].map(id => P.flags.find(f => f.id === id).name).join(', ') || 'Nothing switched on.'
    const press = (group, value) => { for (const b of $(group).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === value)) }
    press('presets', preset ? preset.id : ''); press('looks', state.look); press('pace', state.pace); press('mode', state.mode); press('reduced', state.reduced ? '1' : '0')
    for (const i of shadow.querySelectorAll('input[data-flag]')) i.checked = state.flags.has(i.dataset.flag)
    $('auto').checked = state.auto
    $('panel').hidden = !state.open || state.hidden; $('strip').hidden = state.hidden
    room(state.hidden)
    $('fold').setAttribute('aria-expanded', String(state.open)); $('fold').textContent = state.open ? 'Hide controls' : 'Controls'
    history.replaceState(null, '', `?${params()}`)
  }
  const apply = () => {
    if (window.protoTheme && root.getAttribute('data-theme') !== state.mode) window.protoTheme(state.mode)
    cut()
    P.setFlags([...state.flags]); P.setPace(state.pace); P.setAuto(state.auto)
    const look = (LOOKS.find(l => l[0] === state.look) || LOOKS[0])[3]
    // Before the scene starts the look is only noted; once it runs, a change is drawn in the same frame.
    P.setLook(look)
    P.start({ reduced: state.reduced })
    render()
  }
  const say = words => { $('now').textContent = ''; $('now').append(el('b', null, 'Now: '), words); $('now').title = words }
  P.onSay(say)
  const choose = id => { const p = P.presets.find(p => p.id === id); if (!p) return; state.flags = new Set(p.flags); say(p.line); apply() }
  const cycle = d => { const now = presetOf(state.flags), i = now ? P.presets.indexOf(now) : 0; choose(P.presets[(i + d + P.presets.length) % P.presets.length].id) }
  const wire = (group, fn) => $(group).addEventListener('click', e => { const b = e.target.closest('button'); if (b) fn(b.dataset.v) })
  wire('presets', choose)
  const drawAs = id => { const l = LOOKS.find(l => l[0] === id); if (!l) return; state.look = id; say(`Drawn as ${l[1].toLowerCase()}: ${l[2]}`); apply() }
  wire('looks', drawAs)
  const cycleLook = d => { const i = Math.max(0, LOOKS.findIndex(l => l[0] === state.look)); drawAs(LOOKS[(i + d + LOOKS.length) % LOOKS.length][0]) }
  wire('room', v => P.room(v)); wire('play', v => P.play(v))
  wire('pace', v => { state.pace = v; apply() }); wire('mode', v => { state.mode = v; apply() }); wire('reduced', v => { state.reduced = v === '1'; apply() })
  shadow.addEventListener('change', e => {
    const i = e.target
    if (i.dataset && i.dataset.flag) { if (i.checked) state.flags.add(i.dataset.flag); else state.flags.delete(i.dataset.flag); apply() }
    else if (i.id === 'auto') { state.auto = i.checked; apply() }
  })
  $('fold').addEventListener('click', () => { state.open = !state.open; render() })
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest('input, textarea, [contenteditable]'))) return
    if (e.key === 'ArrowRight') cycle(1); else if (e.key === 'ArrowLeft') cycle(-1)
    else if (e.key === 'ArrowDown') { e.preventDefault(); cycleLook(1) } else if (e.key === 'ArrowUp') { e.preventDefault(); cycleLook(-1) }
    else if (/^[1-9]$/.test(e.key) && P.presets[Number(e.key) - 1]) choose(P.presets[Number(e.key) - 1].id)
    else if (e.key === 'l') { state.mode = state.mode === 'dark' ? 'light' : 'dark'; apply() }
    else if (e.key === 'r') { state.reduced = !state.reduced; apply() }
    else if (e.key === 'c') { state.open = !state.open; render() }
    else if (e.key === 'h') { state.hidden = !state.hidden; render() }
  })
  // The room was dumped at three window sizes; a window that crosses into another's range loads that one.
  const frameFor = () => innerWidth >= 1760 ? 1920 : innerWidth >= 1100 ? 1600 : 820
  const mine = Number((location.pathname.match(/frame-(\d+)\.html/) || [])[1])
  addEventListener('resize', () => { if (mine && frameFor() !== mine) location.replace(`frame-${frameFor()}.html?${params()}`) })
  document.fonts.ready.then(() => { for (const el of document.querySelectorAll('[data-proto-scroll]')) el.scrollTop = Number(el.getAttribute('data-proto-scroll')); cut() })
  const opening = presetOf(state.flags)
  say(opening ? opening.line : 'Your own mix')
  apply()
})()
