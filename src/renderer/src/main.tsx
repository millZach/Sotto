import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { AppProvider } from './state/AppContext'
import { createE2EControllerFactory, createE2EMicrophoneTest } from './e2e/deterministicAdapters'
import './styles/global.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element is missing')
}

const e2e = window.talktypeE2E
const controllerFactory = e2e === undefined ? undefined : createE2EControllerFactory(e2e.scenario)

createRoot(rootElement).render(
  <StrictMode>
    <AppProvider {...(controllerFactory === undefined ? {} : { createController: controllerFactory })}>
      <App {...(e2e === undefined ? {} : { createMicrophoneTest: () => createE2EMicrophoneTest(e2e.scenario) })} />
    </AppProvider>
  </StrictMode>,
)
