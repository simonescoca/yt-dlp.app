import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { AppEvent, DownloadOptions, PlaylistDecision, Settings } from '@shared/types'
import type { AppCore } from './core/app-core'

const URL_RE = /https?:\/\/[^\s"'<>]+/i

/** Wires every `window.grabbit` method to the core (see GrabbitApi in shared/types). */
export function registerIpc(core: AppCore, getWindow: () => BrowserWindow | null): void {
  const h = <A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(`grabbit:${name}`, (_e, ...args) => fn(...(args as A)))
  }
  const job = (id: string) => core.jobs.get(id)

  h('getState', () => core.state())
  h('addDownload', (url: string, options?: Partial<DownloadOptions>) => core.addDownload(url, options))
  h('cancelJob', (id: string) => core.jobs.cancel(id))
  h('retryJob', (id: string) => core.jobs.retry(id))
  h('removeJob', (id: string) => core.jobs.remove(id))
  h('clearHistory', () => core.jobs.clearFinished())
  h('resolvePlaylist', (id: string, d: PlaylistDecision) => core.resolvePlaylist(id, d))
  h('chooseStream', (id: string, candidateId: string | null) => core.jobs.chooseStream(id, candidateId))
  h('scanInteractively', (id: string) => void core.jobs.scanInteractively(id))
  h('openFile', async (id: string) => {
    const p = job(id)?.filePath
    if (p) await shell.openPath(p)
  })
  h('showInFolder', (id: string) => {
    const j = job(id)
    if (j?.filePath) shell.showItemInFolder(j.filePath)
    else if (j) void shell.openPath(j.options.folder)
  })
  h('chooseFolder', async () => {
    const win = getWindow()
    const opts = { title: 'Scegli la cartella di destinazione', defaultPath: core.settings.folder, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  h('openFolder', async (path: string) => {
    await shell.openPath(path)
  })
  h('updateSettings', (patch: Partial<Settings>) => core.updateSettings(patch))
  h('installEngine', () => core.installEngine())
  h('checkEngineUpdates', () => core.refreshEngine(true))
  h('openLoginWindow', (url: string) => core.openLogin(url))
  h('clearLogins', () => core.clearLogins())
  h('readClipboardUrl', async () => URL_RE.exec(await clipboard.readText())?.[0] ?? null)
  h('openExternal', async (url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  core.onEvent((e: AppEvent) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('grabbit:event', e)
  })
}
