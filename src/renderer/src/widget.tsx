import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import {
  WidgetEntry,
  isVisualPreviewEnabled,
  parseVisualPreview,
} from './widget/WidgetApp'
import './widget/widget.css'

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
const bridge = preview === null && previewRequested ? undefined : window.sottoWidget

createRoot(rootElement).render(
  <StrictMode>
    <WidgetEntry bridge={bridge} preview={preview} />
  </StrictMode>,
)
