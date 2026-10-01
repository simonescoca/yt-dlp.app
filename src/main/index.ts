import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, Notification, shell } from 'electron'
import { AppCore } from './core/app-core'
import { registerIpc } from './ipc'

// Allow tests (and developers) to isolate app data from the real profile.
if (process.env['GRABBIT_USER_DATA']) app.setPath('userData', process.env['GRABBIT_USER_DATA'])

const core = new AppCore()
let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 600,
    minHeight: 560,
    show: false,
    title: 'Grabbit',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1012' : '#f7f7f8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  // External links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function notifyCompletions(): void {
  core.jobs.on('job', (job) => {
    if (job.status !== 'completed' || !Notification.isSupported()) return
    if (mainWindow?.isFocused()) return
    const n = new Notification({ title: 'Download completato', body: job.title ?? job.url, silent: false })
    n.on('click', () => job.filePath && shell.showItemInFolder(job.filePath))
    n.show()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.simonescoca.grabbit')
    await core.init()
    registerIpc(core, () => mainWindow)
    notifyCompletions()
    mainWindow = createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void core.shutdown().finally(() => app.quit())
  })
}
