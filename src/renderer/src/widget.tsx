import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { APP_NAME } from '../../shared/constants'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Widget root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <aside aria-label={`${APP_NAME} dictation widget`}>
      <strong>{APP_NAME}</strong>
    </aside>
  </StrictMode>,
)
