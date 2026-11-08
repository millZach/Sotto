import { nativeImage, type NativeImage, type WebContents } from 'electron'
import { PageAutomation, type PageDebugger, type PageEventListener, type PageFrame, type PagePicture } from './pageAutomation'

export { BROWSER_COMMAND_DEADLINE_MS, cssIdentifier, type PointHandlers, type PointTarget, type PointedElement } from './pageAutomation'

type ElectronListener = (event: unknown, method: string, params: Record<string, unknown>) => void

/** Electron's own debugger for one page, as the shared automation drives it. */
function electronDebugger(contents: WebContents): PageDebugger {
  const wrapped = new Map<PageEventListener, ElectronListener>()
  return {
    isGone: () => contents.isDestroyed(),
    url: () => contents.getURL(),
    isAttached: () => contents.debugger?.isAttached() ?? false,
    attach: () => contents.debugger.attach('1.3'),
    detach: () => contents.debugger.detach(),
    sendCommand: (method, params) => contents.debugger.sendCommand(method, params),
    onEvent(listener) {
      const electron: ElectronListener = (_event, method, params) => listener(method, params)
      wrapped.set(listener, electron)
      contents.debugger.on('message', electron)
    },
    offEvent(listener) {
      const electron = wrapped.get(listener)
      if (!electron) return
      wrapped.delete(listener)
      contents.debugger?.removeListener('message', electron)
    },
  }
}

/** The desktop's browser page (ADR-0020): the shared automation, with pictures kept as Electron's images. */
export class BrowserAutomation extends PageAutomation {
  /**
   * `touch` is the test iPhone's (ADR-0045): while attached, the page sees a touch screen and the mouse taps it.
   * `prepareCapture` lends the page a surface to draw into while it is off screen, and returns its release.
   */
  constructor(contents: WebContents, prepareCapture: () => () => void = () => () => undefined, touch = false) {
    super(electronDebugger(contents), prepareCapture, touch)
  }
  /** Chromium's picture at the size asked for, which a scaled display can otherwise change. */
  private image(frame: PageFrame): NativeImage {
    const image = nativeImage.createFromBuffer(Buffer.from(frame.data, 'base64'))
    const size = image.getSize()
    return size.width === frame.width && size.height === frame.height ? image : image.resize({ width: frame.width, height: frame.height })
  }
  protected picture(frame: PageFrame): PagePicture {
    const image = this.image(frame)
    const size = image.getSize()
    return { empty: image.isEmpty(), width: size.width, height: size.height, dataUrl: image.toDataURL() }
  }
  evidence(capturedImage: string): { image: string; width: number; height: number } | null {
    const snapshot = nativeImage.createFromDataURL(capturedImage)
    if (snapshot.isEmpty()) return null
    const size = snapshot.getSize()
    let reduced = snapshot.resize({ width: Math.min(1280, size.width) })
    let image = `data:image/jpeg;base64,${reduced.toJPEG(70).toString('base64')}`
    if (image.length > 2_000_000) {
      reduced = snapshot.resize({ width: Math.min(640, size.width) })
      image = `data:image/jpeg;base64,${reduced.toJPEG(55).toString('base64')}`
    }
    return image.length <= 2_000_000 ? { image, width: size.width, height: size.height } : null
  }
  async thumbnail(capturedImage?: string): Promise<string | null> {
    const snapshot = capturedImage ? nativeImage.createFromDataURL(capturedImage) : this.image(await this.snapshot())
    if (snapshot.isEmpty()) return null
    return `data:image/jpeg;base64,${snapshot.resize({ width: 320 }).toJPEG(65).toString('base64')}`
  }
}
