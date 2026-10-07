import { ipcRenderer } from 'electron'
import {
  VISUAL_GUEST_ESCAPE, VISUAL_GUEST_HEIGHT, VISUAL_GUEST_STEP, VISUAL_GUEST_THEME, VISUAL_THEME_MESSAGE,
  clampVisualPageHeight, readVisualStep, readVisualTheme, visualThemeCss,
} from '../shared/visualGuest'

// Sotto's preload for an interactive visual's sealed page (ADR-0057). It runs in an isolated world: the page sees none
// of it and nothing of Electron. It hands the page the walkthrough's steps and the theme as window messages, keeps the
// theme's style current, measures the page for Sotto, and gives Escape back to Sotto. It exposes nothing.

// The node project types this file without the DOM library, so the few page objects it touches are named here.
interface PageElement { textContent: string | null; setAttribute(name: string, value: string): void; getBoundingClientRect(): { height: number } }
interface PageKeyEvent { readonly key: string; readonly repeat: boolean }
declare const window: {
  postMessage(message: unknown, targetOrigin: string): void
  addEventListener(type: 'keydown', listener: (event: PageKeyEvent) => void, capture: true): void
  addEventListener(type: 'DOMContentLoaded' | 'load', listener: () => void): void
}
declare const document: { readonly documentElement: PageElement; readonly body: PageElement | null; getElementById(id: string): PageElement | null; querySelector(selector: string): PageElement | null }
declare class ResizeObserver { constructor(callback: () => void); observe(target: PageElement): void }

const post = (message: unknown): void => window.postMessage(message, '*')

ipcRenderer.on(VISUAL_GUEST_STEP, (_event, value: unknown) => {
  const step = readVisualStep(value)
  if (step) post(step)
})

ipcRenderer.on(VISUAL_GUEST_THEME, (_event, value: unknown) => {
  const theme = readVisualTheme(value)
  if (!theme) return
  const style = document.getElementById('sotto-visual-theme')
  if (style) style.textContent = visualThemeCss(theme)
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.mode)
  post({ type: VISUAL_THEME_MESSAGE, ...theme })
})

// Registered before any script on the page runs, so the page's own listeners cannot stop it.
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.repeat) ipcRenderer.sendToHost(VISUAL_GUEST_ESCAPE)
}, true)

let sent = 0
const measure = (): void => {
  const height = clampVisualPageHeight(document.documentElement.getBoundingClientRect().height)
  if (height === sent) return
  sent = height
  ipcRenderer.sendToHost(VISUAL_GUEST_HEIGHT, height)
}
window.addEventListener('DOMContentLoaded', () => {
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(document.documentElement)
  if (document.body) observer.observe(document.body)
})
window.addEventListener('load', measure)
