// A frame preload registered on every session by bench-main.cjs. It runs in Sotto's main window only, in an isolated
// world (Sotto's own code is untouched), and records:
// - launch: the first requestAnimationFrame after the thread pane holds the thread's newest message;
// - stream: every requestAnimationFrame timestamp once armed, long tasks, Event Timing entries, and typing latency
//   (capturing keydown on window -> the composer's DOM changes -> next rAF -> a MessageChannel message from it).
const { ipcRenderer } = require('electron')

const href = location.href
const isMainWindow = window.top === window && !/widget\.html/u.test(href)
  && (/\/index\.html(\?|#|$)/u.test(href) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?(index\.html)?(\?|#|$)/u.test(href))

const config = isMainWindow ? ipcRenderer.sendSync('bench:config') : null

if (config && config.mode) {
  const origin = performance.timeOrigin
  const afterPaint = (keys, done) => requestAnimationFrame(rafTs => {
    const rafNow = performance.now()
    const channel = new MessageChannel()
    channel.port1.onmessage = () => done(rafTs, rafNow, performance.now())
    channel.port2.postMessage(0)
  })

  // Launch: the thread is on screen once its pane holds the newest history message's words.
  if (config.snippet) {
    let found = false
    const check = () => {
      if (found) return
      const pane = document.querySelector('.thread-pane')
      if (!pane || !pane.textContent.includes(config.snippet)) return
      found = true
      observer.disconnect()
      const foundAt = performance.now()
      afterPaint(null, (rafTs, rafNow, paint) => ipcRenderer.send('bench:launch', { origin, foundAt, rafTs, rafNow, paint,
        innerWidth, innerHeight, devicePixelRatio }))
    }
    const observer = new MutationObserver(check)
    observer.observe(document, { childList: true, subtree: true, characterData: true })
  }

  // Stream: recorders start when main arms them, just before the stream.
  const raf = []
  const rafNow = []
  const longtasks = []
  const events = []
  const typing = []
  const keys = []
  let pending = []
  let armed = false
  let composer = null
  let composerObserver = null
  window.addEventListener('keydown', event => {
    if (!armed || !event.isTrusted) return
    const key = { now: performance.now(), stamp: event.timeStamp }
    keys.push(key)
    pending.push(key)
  }, true)
  const loop = ts => {
    if (!armed) return
    raf.push(ts)
    rafNow.push(performance.now())
    requestAnimationFrame(loop)
  }
  ipcRenderer.on('bench:arm', () => {
    composer = document.activeElement
    composerObserver = new MutationObserver(() => {
      if (!pending.length) return
      const batch = pending
      pending = []
      const change = performance.now()
      afterPaint(batch, (rafTs, rafCallback, paint) => {
        for (const key of batch) typing.push({ key: key.now, stamp: key.stamp, change, raf: rafCallback, paint })
      })
    })
    composerObserver.observe(composer, { childList: true, subtree: true, characterData: true })
    try {
      new PerformanceObserver(list => { for (const e of list.getEntries()) longtasks.push({ start: e.startTime, duration: e.duration }) })
        .observe({ type: 'longtask', buffered: true })
    } catch (error) { longtasks.push({ error: String(error) }) }
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) events.push({ name: e.name, start: e.startTime, duration: e.duration,
          processingStart: e.processingStart, processingEnd: e.processingEnd, interactionId: e.interactionId })
      }).observe({ type: 'event', durationThreshold: 16, buffered: true })
    } catch (error) { events.push({ error: String(error) }) }
    armed = true
    requestAnimationFrame(loop)
    ipcRenderer.send('bench:armed', { composer: composer ? `${composer.tagName}.${String(composer.className)}` : null,
      editable: composer?.isContentEditable ?? false, innerWidth, innerHeight, devicePixelRatio })
  })
  ipcRenderer.on('bench:collect', () => {
    armed = false
    composerObserver?.disconnect()
    ipcRenderer.send('bench:data', { origin, raf, rafNow, longtasks, events, typing, keys: keys.length,
      composerTextLength: composer?.textContent?.length ?? null, innerWidth, innerHeight, devicePixelRatio })
  })
}
