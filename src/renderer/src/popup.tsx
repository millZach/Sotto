import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { PopupApp } from './popup/PopupApp'
import { applyAppearance, appearancePreview, readCachedAppearance } from './state/appearance'
import { startInterfaceLanguage } from './state/interfaceLanguage'
import type { AppSettings } from '../../shared/settings'
import './styles/global.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Popup root element is missing')
const bridge = window.sottoPopup
if (!bridge) throw new Error('Popup bridge is missing')

// The popup wears the main window's look: the last one painted at once, then the saved one and every change to it.
applyAppearance(readCachedAppearance())
const paint = (settings: AppSettings): void => {
  applyAppearance(appearancePreview.effective(settings))
  if (settings.reducedMotion === 'on') document.documentElement.dataset.reducedMotion = 'on'
  else delete document.documentElement.dataset.reducedMotion
}
void bridge.getSettings().then(paint, () => undefined)
bridge.onSettingsChanged(paint)

// The first frame is in the interface language, as the other windows' are (ADR-0123).
await startInterfaceLanguage(bridge.interfaceLanguage)

createRoot(rootElement).render(
  <StrictMode>
    <PopupApp bridge={bridge} />
  </StrictMode>,
)
