import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

// Allow tests (and developers) to isolate app data from the real profile.
if (process.env['GRABBIT_USER_DATA']) {
  app.setPath('userData', process.env['GRABBIT_USER_DATA'])
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 740,
    minWidth: 620,
    minHeight: 560,
    show: false,
    title: 'Grabbit',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Never open external links inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
