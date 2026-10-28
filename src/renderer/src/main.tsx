import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { AppProvider } from './state/AppContext'
import { createE2EControllerFactory, createE2EMicrophoneTest, createE2ESettingsBridge } from './e2e/deterministicAdapters'
import { createE2ECheckQueuesBridge, createE2EWatcherBridge } from './e2e/watcherStandIn'
import { setCheckQueuesStandIn } from './watcher/checkQueues'
import './styles/global.css'
import './agents/threads.css'
import './agents/threadSidebar.css'
import './agents/threadsChrome.css'
import './features/dictate/dictate.css'
import './styles/crossing-settings.css'
import { applyAppearance, readCachedAppearance } from './state/appearance'
import { startInterfaceLanguage } from './state/interfaceLanguage'
import { startWindowVisibility } from './state/windowVisibility'

// Paint the last chosen look before settings arrive so a light room never
// opens black for a frame; App re-applies from settings once they load.
applyAppearance(readCachedAppearance())
startWindowVisibility()

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element is missing')
}

const e2e = window.sottoE2E
const settingsBridge = window.sotto === undefined ? undefined : createE2ESettingsBridge(window.sotto, e2e !== undefined)
const controllerFactory = e2e === undefined ? undefined : createE2EControllerFactory(e2e.scenario)
// An end-to-end run can seed Watcher's projection; otherwise the room reads main's own bridge.
const watcherBridge = e2e === undefined ? undefined : createE2EWatcherBridge()
// And each machine's check queue (#1312); otherwise the window reads main's.
if (e2e !== undefined) setCheckQueuesStandIn(createE2ECheckQueuesBridge())

// The first frame is in the interface language: its catalogs load from the bundle before React draws (ADR-0123).
await startInterfaceLanguage(window.sotto?.interfaceLanguage)

createRoot(rootElement).render(
  <StrictMode>
    <AppProvider {...(settingsBridge === undefined ? {} : { bridge: settingsBridge })} {...(controllerFactory === undefined ? {} : { createController: controllerFactory })}>
      <App {...(e2e === undefined ? {} : { createMicrophoneTest: () => createE2EMicrophoneTest(e2e.scenario) })} {...(watcherBridge === undefined ? {} : { watcherBridge })} />
    </AppProvider>
  </StrictMode>,
)
