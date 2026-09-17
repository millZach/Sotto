/**
 * What a long transcript costs a real browser, which jsdom cannot say: layout and paint for 400 messages, with
 * and without the transcript's CSS containment. Also checks the two behaviours containment can break â€” landing
 * exactly at the end (Jump to latest, following the stream) and scrolling up without the content jumping.
 *
 *   node scripts/perf-bench/bench-transcript-paint.mjs
 *
 * The page reproduces the transcript's geometry and the containment rules from src/renderer/src/agents/threads.css;
 * it is a measuring rig, not the app.
 */
import { chromium } from '@playwright/test'

const MESSAGES = 400
const VIEWPORT = { width: 1200, height: 800 }
const FOLLOW_SLACK_PX = 48
const SCROLL_STEPS = 24
const STEP_PX = 600

const containment = estimate => `
.thread-transcript__content > .thread-message,
.thread-transcript__content > .thread-work { content-visibility: auto; contain-intrinsic-size: auto ${estimate}px; }
.thread-transcript__content > :nth-last-child(-n + 12) { content-visibility: visible; }
`

function page({ contained = 0, anchor = false } = {}) {
  const style = `
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.65 system-ui, sans-serif; background: #15161a; color: #d8d9de; }
    .thread-workspace__transcript { position: relative; height: ${VIEWPORT.height}px; overflow-y: auto; overflow-anchor: ${anchor ? 'auto' : 'none'}; padding: 28px max(24px, calc((100% - 760px) / 2)); }
    .thread-message { margin: 0 0 28px; }
    .thread-message header { display: flex; gap: 10px; margin-bottom: 8px; font-size: 13px; color: #8d8f98; }
    .thread-message__text { margin: 0 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
    .thread-message[data-role='user'] { margin-left: max(24px, 12%); padding: 14px 18px; background: #1e2026; border: 1px solid #2a2c33; border-radius: 14px 14px 4px 14px; }
    .thread-work { margin: 0 0 20px; padding: 10px 14px; border: 1px solid #2a2c33; border-radius: 12px; }
    pre { margin: 0 0 12px; padding: 12px 14px; overflow-x: auto; background: #101116; border-radius: 10px; font: 13px/1.5 ui-monospace, monospace; }
    ${contained ? containment(contained) : ''}
  `
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head>
<body><div class="thread-workspace__transcript" id="scroller"><div class="thread-transcript__content" id="content"></div></div></body></html>`
}

/** Messages of widely different heights, which is what makes an intrinsic-size estimate hard. */
function build(count) {
  return `
    const content = document.getElementById('content')
    const words = 'the agent read the file and rewrote the helper so the transcript keeps its place while a reply streams in'.split(' ')
    const paragraph = n => Array.from({ length: n }, (_u, i) => words[i % words.length]).join(' ')
    let html = ''
    for (let index = 0; index < ${count}; index += 1) {
      const user = index % 4 === 0
      const size = 20 + (index * 37) % 260
      if (user) {
        html += '<article class="thread-message" data-role="user"><header><span>You</span><time>12:00</time></header><p class="thread-message__text">' + paragraph(size / 4 | 0) + '</p></article>'
        continue
      }
      html += '<section class="thread-work"><span>Worked for 2 minutes</span></section>'
      const code = index % 3 === 0 ? '<pre>' + paragraph(60) + '</pre>' : ''
      html += '<article class="thread-message" data-role="assistant"><header><span>Codex</span><time>12:01</time></header><p class="thread-message__text">' + paragraph(size) + '</p>' + code + '<p class="thread-message__text">' + paragraph(size / 2 | 0) + '</p></article>'
    }
    const started = performance.now()
    content.innerHTML = html
    const height = document.getElementById('scroller').scrollHeight
    return { layoutMs: performance.now() - started, height, children: content.children.length }
  `
}

const frame = `await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`

async function measure(browser, options) {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const sheet = await context.newPage()
  await sheet.setContent(page(options))
  const mount = await sheet.evaluate(new Function(build(MESSAGES)))

  // Jump to latest, and following a stream, both do this: land within the follow slack of the true end.
  const jump = await sheet.evaluate(`(async () => {
    const scroller = document.getElementById('scroller')
    const started = performance.now()
    scroller.scrollTop = scroller.scrollHeight
    ${frame}
    const ms = performance.now() - started
    return { ms, offBy: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, height: scroller.scrollHeight }
  })()`)

  // Reading back through the history: the cost of the scroll, and how far the content moves under the reader.
  const scroll = await sheet.evaluate(`(async () => {
    const scroller = document.getElementById('scroller')
    let drift = 0
    let worst = 0
    const started = performance.now()
    for (let step = 0; step < ${SCROLL_STEPS}; step += 1) {
      const probe = document.elementFromPoint(${VIEWPORT.width / 2}, ${VIEWPORT.height / 2})?.closest('.thread-message, .thread-work')
      const before = probe?.getBoundingClientRect().top ?? null
      scroller.scrollTop -= ${STEP_PX}
      ${frame}
      if (probe && before !== null && probe.isConnected) {
        const moved = probe.getBoundingClientRect().top - before
        const jumped = Math.abs(moved - ${STEP_PX})
        drift += jumped
        worst = Math.max(worst, jumped)
      }
      if (scroller.scrollTop <= 0) break
    }
    return { ms: performance.now() - started, drift, worst, height: scroller.scrollHeight }
  })()`)

  await context.close()
  return { mount, jump, scroll }
}

const modes = [
  ['plain', {}],
  ['contained 160px', { contained: 160 }],
  ['contained 240px', { contained: 240 }],
  ['contained 160 + anchor', { contained: 160, anchor: true }],
  ['contained 240 + anchor', { contained: 240, anchor: true }],
  ['anchor only', { anchor: true }],
]
const browser = await chromium.launch()
const results = []
for (const [name, options] of modes) results.push([name, await measure(browser, options)])
await browser.close()

const round = value => Math.round(value * 100) / 100
const row = ([name, result]) => ({
  mode: name,
  mountLayoutMs: round(result.mount.layoutMs),
  jumpOffByPx: round(result.jump.offBy),
  scrollBackMs: round(result.scroll.ms),
  driftPx: round(result.scroll.drift),
  worstStepDriftPx: round(result.scroll.worst),
  heightAfterPx: result.scroll.height,
})
console.table(results.map(row))
console.info(`follow slack is ${FOLLOW_SLACK_PX}px; ${MESSAGES} messages, ${results[0][1].mount.children} elements`)
