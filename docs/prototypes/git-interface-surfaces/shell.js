/*
  PROTOTYPE — throwaway. The shared shell and floating switcher for the Git interface prototypes.

  A page calls Proto.page({ ... }) once:
    Proto.page({
      title: 'Branch toolbar',
      question: 'Where should a thread's workspace and branch live, and how is a branch picked?',
      states: [{ key: 'clean', label: 'Clean' }, ...],            // optional scenario switch
      variants: [
        { key: 'A', name: 'What ships today', note: 'One line on what this variant does.',
          render(ctx) { return { headerActions, aboveComposer, belowComposer, transcript, tools, overlay, crumb } },
          mount(root, ctx) { ...wire clicks; call ctx.rerender() after changing ctx.local... } },
        ...
      ],
    })

  render(ctx) returns HTML strings for the slots it wants; every slot is optional:
    headerActions  — buttons before the Tools toggle and More in the pane header
    crumb          — HTML after the project name in the header (default: the working-copy chip)
    transcript     — the conversation (default: a short sample exchange)
    aboveComposer  — notices above the composer
    composer       — replaces the whole composer box
    belowComposer  — rows under the composer (a toolbar)
    tools          — { active: 'changes' | 'pr' | 'files' | 'terminal' | 'browser', body: HTML } opens the Tools panel
    overlay        — dialogs and popovers drawn over the whole window (use .backdrop / .dialog / .popover)
    room           — replaces the whole room right of the sidebar (a Settings page, for example)
    prTileLabel    — the Tools rail's pull request tile label (default 'Pull request')
  ctx carries { state, variant, size, theme, local, rerender, icon }. ctx.local is a per-variant scratch
  object that survives rerenders, for open menus and typed text. ctx.icon(name) returns an inline SVG.

  URL: ?variant=A&state=clean&theme=dark&size=1280. Arrow keys cycle variants (not while typing).
*/
(function () {
  const ICONS = {
    branch: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3-12 5.6"/>',
    commit: '<circle cx="12" cy="12" r="3.2"/><path d="M3 12h5.8M15.2 12H21"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    pr: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5"/>',
    merge: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 8.2v7.6M8 7.2c2.6 3.4 5 4.4 7.8 4.8"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    file: '<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4.5 16v3.5h15V16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/>',
    comment: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
    computer: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 19.5h6M12 16v3.5"/>',
    tree: '<path d="M5 4.5v15M5 8h6M5 15.5h6"/><rect x="11" y="5.5" width="8.5" height="5" rx="1"/><rect x="11" y="13" width="8.5" height="5" rx="1"/>',
    split: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
    history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/><path d="M12 8v4.5l3 2"/>',
    sparkle: '<path d="M12 4.5 13.6 10.4 19.5 12l-5.9 1.6L12 19.5l-1.6-5.9L4.5 12l5.9-1.6z"/>',
    alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6.8M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.5-1.5"/>',
  }
  const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`

  const SAMPLE_TRANSCRIPT = `
    <div class="msg-you"><div class="msg-meta"><span>You</span><span>7:05 am</span></div>Make the voice preview button play a two-second sample, and keep the key out of settings.json.</div>
    <div class="msg-agent"><div class="msg-meta"><span>Claude</span><span>7:58 am</span></div>
      <p>Done. The preview plays a two-second sample through the selected voice, and the key now lives in the system keychain.</p>
      <span class="activity">${icon('file', 'sm')} Edited 3 files · +42 −11</span>
    </div>`

  function params() { return new URLSearchParams(location.search) }
  function setParam(key, value) { const p = params(); p.set(key, value); history.replaceState(null, '', '?' + p.toString()) }

  window.Proto = {
    icon,
    page(config) {
      const locals = {}
      const read = () => {
        const p = params()
        const variants = config.variants
        const variant = variants.find(v => v.key === p.get('variant')) ?? variants[0]
        const states = config.states ?? []
        const state = (states.find(s => s.key === p.get('state')) ?? states[0])?.key ?? null
        return { variant, state, theme: p.get('theme') === 'light' ? 'light' : 'dark', size: p.get('size') === '820' ? '820' : '1280' }
      }
      const root = document.createElement('div')
      root.className = 'proto-stage'
      document.body.appendChild(root)
      const bar = document.createElement('div')
      bar.className = 'proto-bar'
      document.body.appendChild(bar)

      function render() {
        const { variant, state, theme, size } = read()
        document.documentElement.dataset.theme = theme
        const local = locals[variant.key] ??= {}
        const ctx = { state, variant: variant.key, size, theme, local, icon, rerender: render }
        const slots = variant.render(ctx) ?? {}
        const [w, h] = size === '820' ? [820, 560] : [1280, 800]
        const tools = slots.tools
        const rail = tools ? `<div class="tools__rail">${[['files', 'Files', 'file'], ['changes', 'Changes', 'commit'], ['pr', slots.prTileLabel ?? 'Pull request', 'pr'], ['terminal', 'Terminal', 'computer'], ['browser', 'Browser', 'external']]
          .map(([id, label, glyph]) => `<span class="tools__tile" ${tools.active === id ? 'aria-current="page"' : ''}>${icon(glyph, 'sm')}${label}</span>`).join('')}</div>` : ''
        root.innerHTML = `
          <div class="proto-note" style="width:${w}px"><strong>${config.title} · ${variant.key}: ${variant.name}</strong>${config.question ? `<div style="opacity:.75;margin-bottom:4px">${config.question}</div>` : ''}${variant.note ?? ''}</div>
          <div class="app" data-size="${size}" style="width:${w}px;height:${h}px">
            <aside class="side">
              <div class="side__top"><span class="side__logo"></span>Sotto</div>
              <div class="side__search">${icon('search', 'sm')} Search threads</div>
              <div class="side__list">
                <div class="side__project">${icon('folder', 'sm')}<span>workshop</span><span>3</span></div>
                <div class="side__row" aria-current="page"><span>Grok voice previews</span><small>7:58 am</small><small>Claude</small><small>Done</small></div>
                <div class="side__row"><span>Streaming WAV stall</span><small>10:02 am</small><small>Codex</small><small>Done</small></div>
                <div class="side__project">${icon('folder', 'sm')}<span>sotto-site</span><span>1</span></div>
                <div class="side__row"><span>Footer links</span><small>3m</small><small>Codex</small><small>Working</small></div>
              </div>
              <div class="side__foot"><span>Dictate</span><span aria-current="page">Threads</span></div>
            </aside>
            ${slots.room !== undefined ? `<main class="room">${slots.room}</main>` : `<main class="room">
              <section class="pane">
                <header class="pane-head">
                  <div class="pane-head__title"><span class="provider-mark"></span><h2>Grok voice previews</h2>
                    <span class="pane-head__crumb"><span>workshop</span>${slots.crumb ?? `<span class="wc-chip">${icon('folder', 'sm')}Project folder</span>`}</span></div>
                  <div class="pane-head__actions">${slots.headerActions ?? ''}
                    <button class="pane-action" aria-label="Tools" ${tools ? 'aria-pressed="true"' : ''}>${icon('panel')}</button>
                    <button class="pane-action" aria-label="More actions">${icon('more')}</button></div>
                </header>
                <div class="transcript">${slots.transcript ?? SAMPLE_TRANSCRIPT}</div>
                <div class="compose">${slots.aboveComposer ?? ''}
                  ${slots.composer ?? `<div class="composer"><div class="composer__text">What would you like to do next?</div>
                    <div class="composer__row"><span class="muted">${icon('plus')}</span><span class="composer__pill">Sonnet 4.5 ${icon('chevron', 'sm')}</span><span class="composer__send">${icon('up', 'sm')}</span></div></div>`}
                  ${slots.belowComposer ?? ''}
                  <div class="pane-meta"><span>Context 38%</span><span>12.4k tokens</span></div>
                </div>
              </section>
              ${tools ? `<aside class="tools">${rail}<div class="tools__body">${tools.body}</div></aside>` : ''}
            </main>`}
            ${slots.overlay ?? ''}
          </div>`
        variant.mount?.(root, ctx)

        const i = config.variants.indexOf(variant)
        const states = config.states ?? []
        bar.innerHTML = `
          <a href="./index.html" title="All prototypes">All</a>
          <button data-go="-1" aria-label="Previous variant">&larr;</button>
          <span class="proto-bar__label">${variant.key} — ${variant.name}</span>
          <button data-go="1" aria-label="Next variant">&rarr;</button>
          ${states.length ? `<select aria-label="Scenario">${states.map(s => `<option value="${s.key}" ${s.key === state ? 'selected' : ''}>${s.label}</option>`).join('')}</select>` : ''}
          <button data-theme="${theme === 'dark' ? 'light' : 'dark'}">${theme === 'dark' ? 'Dark' : 'Light'}</button>
          <button data-size="${size === '820' ? '1280' : '820'}">${size === '820' ? '820 × 560' : '1280 × 800'}</button>`
        bar.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => {
          const next = config.variants[(i + Number(button.dataset.go) + config.variants.length) % config.variants.length]
          setParam('variant', next.key); render()
        }))
        bar.querySelector('select')?.addEventListener('change', event => { setParam('state', event.target.value); render() })
        bar.querySelector('[data-theme]').addEventListener('click', event => { setParam('theme', event.currentTarget.dataset.theme); render() })
        bar.querySelector('[data-size]').addEventListener('click', event => { setParam('size', event.currentTarget.dataset.size); render() })
      }
      document.addEventListener('keydown', event => {
        const target = event.target
        if (target instanceof HTMLElement && (target.matches('input, textarea, select, [contenteditable]'))) return
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const { variant } = read()
        const i = config.variants.indexOf(variant)
        const next = config.variants[(i + (event.key === 'ArrowRight' ? 1 : -1) + config.variants.length) % config.variants.length]
        setParam('variant', next.key); render()
      })
      render()
    },
  }
})()
