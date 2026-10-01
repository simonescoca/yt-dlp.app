import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppEvent, GrabbitApi } from '@shared/types'

// The handlers are typed on the main side (ipc.ts); here every method just forwards its arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (name: string) => (...args: unknown[]): Promise<any> => ipcRenderer.invoke(`grabbit:${name}`, ...args)

const api: GrabbitApi = {
  getState: call('getState'),
  onEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, ev: AppEvent): void => listener(ev)
    ipcRenderer.on('grabbit:event', wrapped)
    return () => ipcRenderer.removeListener('grabbit:event', wrapped)
  },
  addDownload: call('addDownload'),
  cancelJob: call('cancelJob'),
  retryJob: call('retryJob'),
  removeJob: call('removeJob'),
  clearHistory: call('clearHistory'),
  resolvePlaylist: call('resolvePlaylist'),
  chooseStream: call('chooseStream'),
  scanInteractively: call('scanInteractively'),
  openFile: call('openFile'),
  showInFolder: call('showInFolder'),
  chooseFolder: call('chooseFolder'),
  openFolder: call('openFolder'),
  updateSettings: call('updateSettings'),
  installEngine: call('installEngine'),
  checkEngineUpdates: call('checkEngineUpdates'),
  openLoginWindow: call('openLoginWindow'),
  clearLogins: call('clearLogins'),
  readClipboardUrl: call('readClipboardUrl'),
  openExternal: call('openExternal')
}

contextBridge.exposeInMainWorld('grabbit', api)
