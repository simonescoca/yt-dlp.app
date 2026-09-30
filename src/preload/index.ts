import { contextBridge } from 'electron'

const api = {
  platform: process.platform
}

contextBridge.exposeInMainWorld('grabbit', api)

export type GrabbitApi = typeof api
