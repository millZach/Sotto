import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

import { APP_NAME } from '../shared/constants'
import { selectRendererSource, secureWebPreferences } from './security'

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    title: APP_NAME,
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js')),
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const rendererSource = selectRendererSource(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
    join(__dirname, '../renderer/index.html'),
  )

  if (rendererSource.kind === 'url') {
    void mainWindow.loadURL(rendererSource.value)
  } else {
    void mainWindow.loadFile(rendererSource.value)
  }
}

void app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
