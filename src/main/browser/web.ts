import { BrowserWindow, session, type Session } from 'electron'

/** Persistent browser profile shared by the login window and the page scanner. */
export const WEB_PARTITION = 'persist:grabbit-web'

export function webSession(): Session {
  return session.fromPartition(WEB_PARTITION)
}

/** "accounts.google.com" → "google.com", "www.bbc.co.uk" → "bbc.co.uk" (good enough for display). */
export function siteOf(hostname: string): string {
  const parts = hostname.replace(/^\.+/, '').toLowerCase().split('.')
  if (parts.length <= 2) return parts.join('.')
  const secondLevel = parts.at(-2)!
  const twoPartTld = secondLevel.length <= 3 && parts.at(-1)!.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(secondLevel)
  return parts.slice(twoPartTld ? -3 : -2).join('.')
}

/**
 * Opens a regular browser window on `url` using the shared profile, so the
 * user can sign in to a site; the cookies are then used by yt-dlp and the scanner.
 * `onSite` is called with every site visited (to list "sites you are signed in to").
 */
export function openLoginWindow(url: string, userAgent: string, onSite: (site: string) => void, parent?: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 780,
    parent,
    title: 'Accedi',
    autoHideMenuBar: true,
    webPreferences: { session: webSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.webContents.setUserAgent(userAgent)
  // OAuth flows open popups: keep them in the same profile.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: webSession(), sandbox: true, contextIsolation: true } }
  }))
  win.webContents.on('did-create-window', (child) => child.webContents.setUserAgent(userAgent))
  const record = (_e: unknown, navUrl: string): void => {
    try {
      const u = new URL(navUrl)
      if (u.protocol === 'https:' || u.protocol === 'http:') onSite(siteOf(u.hostname))
    } catch {
      /* ignore */
    }
  }
  win.webContents.on('did-navigate', record)
  win.webContents.on('page-title-updated', (_e, title) => win.setTitle(`Accedi — ${title}`))
  void win.loadURL(url, { userAgent })
  return win
}

/** Signs out everywhere: removes cookies, storage and cache of the shared profile. */
export async function clearWebData(): Promise<void> {
  const ses = webSession()
  await ses.clearStorageData()
  await ses.clearCache()
}
