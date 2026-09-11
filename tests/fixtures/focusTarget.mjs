import { app, BrowserWindow } from 'electron'

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 500, height: 220, title: 'Dictation focus target', webPreferences: { contextIsolation: true, nodeIntegration: false } })
  await window.loadURL('data:text/html,<title>Dictation focus target</title><textarea aria-label="Text target">before after</textarea>')
  window.show()
  window.focus()
})
app.on('window-all-closed', () => app.quit())
