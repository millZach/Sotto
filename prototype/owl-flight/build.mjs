// PROTOTYPE build: bundles src/entry.ts, which imports the app's real night-scene modules, into one self-contained
// index.html (inline script, inline style, data: fonts), so Sotto can show it beside a question.
// Run: node prototype/owl-flight/build.mjs   (esbuild and zod come from a checkout that has node_modules; SOTTO_MODULES
// points at it, the main checkout by default).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const modules = process.env.SOTTO_MODULES ?? join(homedir(), 'Developer/Sotto/node_modules')
const esbuild = createRequire(join(modules, 'x.js'))('esbuild')

// Vellum, the theme being added in thread 405a331c, read from that thread's checkout while it is unmerged.
const vellumFile = process.env.VELLUM_PALETTES ?? join(homedir(), 'Library/Application Support/sotto/thread-worktrees/be659735-b6eb-46c6-8c38-1bce034b88cc/src/shared/themes/palettes.ts')
function vellum() {
  if (!existsSync(vellumFile)) return null
  const text = readFileSync(vellumFile, 'utf8')
  const block = name => {
    const m = text.match(new RegExp(`export const ${name}: ThemeColors = \\{([\\s\\S]*?)\\n\\}`))
    if (!m) return null
    return Object.fromEntries([...m[1].matchAll(/(\w+): '([^']+)'/g)].map(([, k, v]) => [k, v]))
  }
  const light = block('VELLUM_LIGHT_THEME_COLORS'), dark = block('VELLUM_DARK_THEME_COLORS')
  return light && dark ? { light, dark } : null
}

const result = await esbuild.build({
  entryPoints: [join(here, 'src/entry.ts')],
  bundle: true, write: false, format: 'iife', target: 'chrome130', minify: true, outdir: join(here, 'out'),
  nodePaths: [modules],
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { __VELLUM__: JSON.stringify(vellum()) },
  logLevel: 'warning',
})
const js = result.outputFiles.find(f => f.path.endsWith('.js')).text
const css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? ''
const page = `<!doctype html>
<!--
  PROTOTYPE, throwaway (prototype/owl-flight). Question: how should Watcher's owl fly between perches?
  Today's flight beside five candidates, each drawn by the app's real night-scene painter at real cell size.
  Built by prototype/owl-flight/build.mjs from prototype/owl-flight/src. Picked: E, Slow, deep beats (Drake, October 27, 2026)
-->
<html lang="en"><head><meta charset="utf-8"><title>Watcher's owl in flight</title>
<style>${css.replaceAll('</style', '<\\/style')}</style></head>
<body><h1>Watcher's owl in flight</h1>
<p class="lede">Today's flight beside five candidates, on the app's own painter, theme tokens and 7 by 12 cells. Each loops through every trip the owl can make. Stats are this page's own: paints a second, the cost of one painted frame, and how many of the owl's glyphs change from one frame to the next once its movement is taken out.</p>
<section class="card"><h2>Pick one</h2>
<table><thead><tr><th>Flight</th><th>Glyphs changing per frame</th><th>Paints per second in flight</th><th>One frame</th><th>Renderer, flying loop</th></tr></thead><tbody>
<tr><td>Today</td><td>63 of 66 (96%)</td><td>26</td><td>0.30 ms</td><td>7.0%</td></tr>
<tr><td>A · Glide arc</td><td>27 of 65</td><td>23</td><td>0.32 ms</td><td>5.3%</td></tr>
<tr><td>B · Climb, then glide</td><td>31 of 62</td><td>22</td><td>0.30 ms</td><td>not run</td></tr>
<tr><td>C · Low swoop</td><td>18 of 65 (28%)</td><td>23</td><td>0.31 ms</td><td>5.6%</td></tr>
<tr><td>D · Two hops</td><td>28 of 64</td><td>20</td><td>0.32 ms</td><td>not run</td></tr>
<tr><td>E · Slow, deep beats</td><td>24 of 63</td><td>22</td><td>0.31 ms</td><td>5.6%</td></tr>
</tbody></table>
<p>The still scene costs 2.2 to 2.7% of the renderer here. Every flight holds the app's 30 frames a second. At 60 the low swoop costs 9.7%, so the candidates stay at 30. These numbers come from headless Chromium on this page, measured on the home to other tree crossing, not from the app.</p>
<p><b>My pick: C, Low swoop.</b> It is the most owl-like: it drops off the branch, glides low and level, and brakes by climbing onto the perch. Its glide keeps one drawing for whole stretches, so it changes the fewest glyphs of all.</p></section>
<div class="controls"></div><div class="panels"></div>
<script>${js.replaceAll('</script', '<\\/script')}</script></body></html>
`
writeFileSync(join(here, 'index.html'), page)
console.log(`index.html ${(page.length / 1024).toFixed(0)} KiB, Vellum ${vellum() ? 'included' : 'not found'}`)
