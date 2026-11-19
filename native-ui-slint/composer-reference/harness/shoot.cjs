// Body of an async function run in Sotto's main process by ev.sh; shoot.sh puts `const P = {...}` before it.
// P: { name, out, harness, roots: [selectors to dump], boxOf: [selectors whose union, plus 24 px, is captured] }.
// Writes <out>/<name>.png (webContents.capturePage of that rect) and <out>/<name>.json (the dump, the composer's
// surroundings and the rect).
await ctx.js(ctx.fs.readFileSync(ctx.path.join(P.harness, 'dump.js'), 'utf8'))
await ctx.sleep(P.settle ?? 600)
const rect = await ctx.js(`const els = ${JSON.stringify(P.boxOf)}.flatMap(s => [...document.querySelectorAll(s)]).filter(e => e.getClientRects().length)
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (const e of els) { const r = e.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom) }
  const m = 24, X = Math.max(0, Math.floor(x0 - m)), Y = Math.max(0, Math.floor(y0 - m))
  return { x: X, y: Y, width: Math.min(innerWidth, Math.ceil(x1 + m)) - X, height: Math.min(innerHeight, Math.ceil(y1 + m)) - Y }`)
const size = await ctx.capture(rect, ctx.path.join(P.out, `${P.name}.png`))
const data = await ctx.js(`return { dump: window.__crefDump(${JSON.stringify({ roots: P.roots })}), context: window.__crefContext(),
  activeElement: document.activeElement ? { tag: document.activeElement.tagName.toLowerCase(), class: String(document.activeElement.className), ariaLabel: document.activeElement.getAttribute('aria-label') } : null,
  hasFocus: document.hasFocus() }`)
ctx.fs.writeFileSync(ctx.path.join(P.out, `${P.name}.json`), JSON.stringify({ state: P.name, captureRectInWindow: rect, pngSize: size, ...data }, null, 1))
return { rect, size, active: data.activeElement, hasFocus: data.hasFocus }
