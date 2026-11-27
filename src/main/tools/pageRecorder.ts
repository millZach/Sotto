import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { RECORDING_LIMIT } from './browserFiles'

/**
 * The page that makes a recording (ADR-0220): it draws each picture Chromium sends of the browser page on a canvas and
 * Chromium's own MediaRecorder encodes the canvas as WebM, so no encoder is added to Sotto. It loads nothing, runs no
 * Sotto code and has no preload; main hands it pictures and takes the video back.
 */
const RECORDER_PAGE = `<!doctype html><meta charset="utf-8"><canvas id="c" width="2" height="2"></canvas><script>
const canvas = document.getElementById('c'), context = canvas.getContext('2d')
const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0]
const chunks = []; let size = 0, recorder = null, drawing = Promise.resolve()
window.sottoFrame = data => { drawing = drawing.then(() => new Promise(done => { const image = new Image(); image.onload = () => {
  if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height }
  context.drawImage(image, 0, 0)
  if (!recorder) { recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2500000 }); recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); size += event.data.size } }; recorder.start(1000) }
  track.requestFrame(); done() }; image.onerror = () => done(); image.src = 'data:image/jpeg;base64,' + data })); return size }
window.sottoSize = () => size
window.sottoFinish = () => drawing.then(() => new Promise(done => { if (!recorder) { done(''); return }
  recorder.onstop = () => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1] || ''); reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' })) }
  track.requestFrame(); recorder.stop() }))
</script>`

/** One recording in progress. `frame` takes each picture; `finish` ends it and answers the WebM's bytes. */
export class PageRecording {
  private readonly window: BrowserWindow
  private ready: Promise<void>
  private pending = Promise.resolve()
  private stopped = false
  private last: string | null = null
  private keepAlive: ReturnType<typeof setInterval> | null = null
  readonly startedAt = Date.now()
  /** `full`: the recording reached its limit and should stop; called once. */
  constructor(private readonly full: () => void) {
    // A partition of its own and nothing on disk: the recorder never shares the app's session or the browser's.
    const own = session.fromPartition(`sotto-recorder-${randomUUID()}`)
    own.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    own.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
    this.window = new BrowserWindow({ show: false, width: 64, height: 64, skipTaskbar: true, focusable: false,
      webPreferences: { session: own, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: false, javascript: true } })
    this.ready = this.window.loadURL(`data:text/html;base64,${Buffer.from(RECORDER_PAGE).toString('base64')}`)
    // A page that stops changing sends no more pictures; the last one is drawn again each second so the video keeps time.
    this.keepAlive = setInterval(() => { if (this.last) this.frame(this.last, true) }, 1000)
  }
  frame(data: string, repeat = false): void {
    if (this.stopped || this.window.isDestroyed()) return
    if (!repeat) this.last = data
    if (!/^[A-Za-z0-9+/=]+$/u.test(data)) return
    this.pending = this.pending.then(async () => {
      await this.ready
      if (this.stopped || this.window.isDestroyed()) return
      const size = await this.window.webContents.executeJavaScript(`window.sottoFrame(${JSON.stringify(data)})`) as number
      if (size >= RECORDING_LIMIT) { this.stopped = true; this.full() }
    }).catch(() => undefined)
  }
  async finish(): Promise<Buffer> {
    this.stopped = true
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    try {
      await this.ready
      await this.pending
      if (this.window.isDestroyed()) return Buffer.alloc(0)
      const encoded = await this.window.webContents.executeJavaScript('window.sottoFinish()') as string
      return Buffer.from(encoded, 'base64')
    } finally { this.close() }
  }
  close(): void {
    this.stopped = true
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
