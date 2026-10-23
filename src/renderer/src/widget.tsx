import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import {
  WidgetEntry,
  isVisualPreviewEnabled,
  parseVisualPreview,
} from './widget/WidgetApp'
import './widget/widget.css'
import { startInterfaceLanguage } from './state/interfaceLanguage'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Widget root element is missing')
}

const parameters = new URLSearchParams(window.location.search)
const previewRequested = parameters.has('preview') || parameters.has('theme')
const preview = parseVisualPreview(
  parameters,
  isVisualPreviewEnabled(window, import.meta.env.SOTTO_VISUAL_PREVIEW),
)
const widgetBridge = window.sottoWidget
const bridge = preview === null && previewRequested ? undefined : widgetBridge
// The widget has no AppContext; the bridge carries the platform the main
// process resolved. Without a bridge (visual preview) the Windows row applies.
const platform = widgetBridge?.platform ?? 'win32'

// The widget follows the interface language too, from its first frame (ADR-0122).
await startInterfaceLanguage(bridge?.interfaceLanguage)

createRoot(rootElement).render(
  <StrictMode>
    <WidgetEntry bridge={bridge} preview={preview} platform={platform} />
  </StrictMode>,
)
