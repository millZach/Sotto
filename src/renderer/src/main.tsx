import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { AppProvider } from './state/AppContext'
import { createE2EControllerFactory, createE2EMicrophoneTest, createE2ESettingsBridge } from './e2e/deterministicAdapters'
import './styles/global.css'
import './agents/threads.css'
import './agents/room.css'
import './features/history/history.css'
import './styles/crossing-settings.css'
import { applyAppearance, readCachedAppearance } from './state/appearance'

// Paint the last chosen look before settings arrive so a light room never
// opens black for a frame; App re-applies from settings once they load.
applyAppearance(readCachedAppearance())

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element is missing')
}

const e2e = window.sottoE2E
const settingsBridge = window.sotto === undefined ? undefined : createE2ESettingsBridge(window.sotto, e2e !== undefined)
const controllerFactory = e2e === undefined ? undefined : createE2EControllerFactory(e2e.scenario)

createRoot(rootElement).render(
  <StrictMode>
    <AppProvider {...(settingsBridge === undefined ? {} : { bridge: settingsBridge })} {...(controllerFactory === undefined ? {} : { createController: controllerFactory })}>
      <App {...(e2e === undefined ? {} : { createMicrophoneTest: () => createE2EMicrophoneTest(e2e.scenario) })} />
    </AppProvider>
  </StrictMode>,
)
