import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { APP_NAME } from '../../shared/constants'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <main>
      <h1>{APP_NAME}</h1>
    </main>
  </StrictMode>,
)
