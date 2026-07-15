import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { APP_NAME } from '../../shared/constants'
import { AppProvider } from './state/AppContext'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProvider>
      <main>
        <h1>{APP_NAME}</h1>
      </main>
    </AppProvider>
  </StrictMode>,
)
