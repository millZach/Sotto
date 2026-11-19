// Installed in the main window's page by shoot.cjs (executeJavaScript). It only reads the DOM.
// window.__crefDump({ roots, origin }) -> every visible element under each root selector: tag, class, role, aria-label,
// title, its own text, the box relative to `origin` (the composer form) and to the window, and computed styles. SVGs
// carry their size, stroke and fill; ::before and ::after with content are listed with their styles. Elements clipped to
// 1x1 for assistive technology are listed apart, by name only.
window.__crefDump = ({ roots, origin = 'form.thread-prompt' }) => {
  const props = ['display', 'position', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-align', 'text-transform', 'white-space', 'color', 'caret-color', 'background-color', 'background-image',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-top-color',
    'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'row-gap', 'column-gap', 'box-shadow', 'outline',
    'opacity', 'filter', 'min-height', 'max-height', 'overflow', 'z-index', 'align-items', 'justify-content', 'flex-direction',
    'grid-template-columns', 'grid-template-rows', 'cursor', 'transform']
  const svgProps = ['color', 'stroke', 'stroke-width', 'fill', 'opacity', 'filter']
  const o = document.querySelector(origin)
  const or = o ? o.getBoundingClientRect() : { x: 0, y: 0 }
  const box = r => ({ x: +(r.x - or.x).toFixed(2), y: +(r.y - or.y).toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) })
  const win = r => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) })
  // Colours as Chromium computes them (often oklch or oklab, from the theme's tokens) and as sRGB hex through a canvas.
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const paint = canvas.getContext('2d', { willReadFrequently: true })
  const hex = colour => {
    paint.clearRect(0, 0, 1, 1); paint.fillStyle = '#010203'; paint.fillStyle = colour
    if (paint.fillStyle === '#010203' && colour !== '#010203') return colour
    paint.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data
    const h = v => v.toString(16).padStart(2, '0')
    return a === 255 ? `#${h(r)}${h(g)}${h(b)}` : a === 0 ? 'transparent' : `#${h(r)}${h(g)}${h(b)}${h(a)}`
  }
  const colourFn = /(?:oklch|oklab|rgba?|hsla?|lab|lch|color-mix|color)\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b|\btransparent\b|\bcurrentcolor\b/giu
  const srgb = v => v.replace(colourFn, m => hex(m))
  const style = (el, pseudo, list) => {
    const cs = getComputedStyle(el, pseudo)
    const out = {}
    for (const p of list) {
      const v = cs.getPropertyValue(p)
      const side = /^border-(top|right|bottom|left)-color$/u.exec(p)
      if (side && cs.getPropertyValue(`border-${side[1]}-width`) === '0px') continue
      out[p] = v
      if (colourFn.test(v) && !/^(font|line|letter|display|position)/u.test(p)) out[`${p}@srgb`] = srgb(v)
      colourFn.lastIndex = 0
    }
    return out
  }
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/gu, ' ').trim().slice(0, 160) || undefined
  const srOnly = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width <= 1 && r.height <= 1 && (cs.overflow === 'hidden' || cs.clipPath !== 'none') }
  const result = { origin: o ? { selector: origin, window: win(or) } : null, roots: [] }
  for (const selector of roots) {
    const root = document.querySelector(selector)
    if (!root) { result.roots.push({ selector, missing: true }); continue }
    const elements = []
    const hidden = []
    const walk = (el, depth) => {
      const cs = getComputedStyle(el)
      if (cs.display === 'none') return
      const rects = el.getClientRects()
      const inSvg = el instanceof SVGElement && !(el instanceof SVGSVGElement)
      if (inSvg) return
      if (srOnly(el)) { hidden.push({ tag: el.tagName.toLowerCase(), class: String(el.getAttribute('class') ?? ''), text: el.textContent.trim().slice(0, 160) }); return }
      const visible = cs.visibility !== 'hidden' && rects.length > 0 && (el.getBoundingClientRect().width > 0 || el.getBoundingClientRect().height > 0)
      if (visible) {
        const r = el.getBoundingClientRect()
        const entry = { depth, tag: el.tagName.toLowerCase(), class: String(el.getAttribute('class') ?? '') || undefined,
          id: el.id || undefined, role: el.getAttribute('role') ?? undefined, ariaLabel: el.getAttribute('aria-label') ?? undefined,
          title: el.getAttribute('title') ?? undefined, ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
          ariaChecked: el.getAttribute('aria-checked') ?? undefined, ariaSelected: el.getAttribute('aria-selected') ?? undefined,
          data: Object.keys(el.dataset).length ? { ...el.dataset } : undefined, text: ownText(el),
          box: box(r), window: win(r) }
        if (el instanceof SVGSVGElement) {
          entry.svg = { width: el.getAttribute('width'), height: el.getAttribute('height'), viewBox: el.getAttribute('viewBox'),
            strokeWidthAttr: el.getAttribute('stroke-width'), strokeAttr: el.getAttribute('stroke'), fillAttr: el.getAttribute('fill'),
            shapes: [...el.querySelectorAll('path, line, circle, rect, polyline, polygon, ellipse')].map(s => s.outerHTML).slice(0, 12) }
          entry.style = style(el, null, svgProps)
        } else {
          entry.style = style(el, null, props)
          for (const pseudo of ['::before', '::after', '::placeholder']) {
            const ps = getComputedStyle(el, pseudo)
            if (pseudo === '::placeholder' ? !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) : (ps.content === 'none' || ps.content === 'normal')) continue
            ;(entry.pseudo ??= {})[pseudo] = { content: ps.content, ...style(el, pseudo, props) }
          }
        }
        elements.push(entry)
      }
      if (el instanceof SVGSVGElement) return
      for (const child of el.children) walk(child, depth + 1)
    }
    walk(root, 0)
    result.roots.push({ selector, elements, hiddenForAssistiveTechnology: hidden })
  }
  return result
}

// The composer's surroundings: the pane, the form's ancestors up to the pane with their padding, and the transcript's
// last message, so the composer's distance from the pane's bottom and sides and from the transcript can be read.
window.__crefContext = () => {
  const form = document.querySelector('form.thread-prompt')
  const pane = form.closest('.thread-pane') ?? document.querySelector('.thread-pane')
  const r = el => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) } }
  const pick = el => { const cs = getComputedStyle(el); return { tag: el.tagName.toLowerCase(), class: String(el.getAttribute('class') ?? ''), window: r(el),
    padding: cs.padding, margin: cs.margin, gap: cs.gap, background: cs.backgroundColor, maxWidth: cs.maxWidth, display: cs.display } }
  const chain = []
  for (let el = form.parentElement; el && el !== pane.parentElement; el = el.parentElement) {
    chain.push({ ...pick(el), children: [...el.children].map(c => ({ tag: c.tagName.toLowerCase(), class: String(c.getAttribute('class') ?? ''), window: r(c) })) })
  }
  const messages = [...pane.querySelectorAll('.thread-message')]
  const last = messages.at(-1)
  const fr = form.getBoundingClientRect(), pr = pane.getBoundingClientRect()
  return {
    window: { innerWidth, innerHeight, devicePixelRatio, theme: document.documentElement.dataset.theme, themeId: document.documentElement.dataset.themeId },
    pane: pick(pane), form: pick(form),
    formRelativeToPane: { x: +(fr.x - pr.x).toFixed(2), y: +(fr.y - pr.y).toFixed(2), w: +fr.width.toFixed(2), h: +fr.height.toFixed(2),
      fromPaneLeft: +(fr.x - pr.x).toFixed(2), fromPaneRight: +(pr.right - fr.right).toFixed(2), fromPaneBottom: +(pr.bottom - fr.bottom).toFixed(2) },
    lastMessage: last ? { ...pick(last), gapToForm: +(fr.top - last.getBoundingClientRect().bottom).toFixed(2) } : null,
    transcript: (() => { const t = pane.querySelector('.thread-transcript'); if (!t) return null
      const walk = (el, depth) => depth > 3 ? [] : [...el.children].flatMap(c => [{ depth, ...pick(c), paddingBottom: getComputedStyle(c).paddingBottom, scrollPaddingBottom: getComputedStyle(c).scrollPaddingBottom }, ...(c.classList.contains('thread-message') ? [] : walk(c, depth + 1))])
      return { ...pick(t), paddingBottom: getComputedStyle(t).paddingBottom, scrollPaddingBottom: getComputedStyle(t).scrollPaddingBottom, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, descendants: walk(t, 1) } })(),
    ancestors: chain,
  }
}
true
