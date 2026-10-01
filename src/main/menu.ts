import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * macOS needs a menu for the standard shortcuts (⌘C/⌘V/⌘Q...). On Windows the
 * menu bar is removed: text fields keep Ctrl+C/V, and users never stumble on
 * "Reload" or the developer tools.
 */
export function setupMenu(): void {
  if (process.platform !== 'darwin') {
    if (app.isPackaged) Menu.setApplicationMenu(null)
    return
  }
  app.setAboutPanelOptions({ applicationName: 'Grabbit', applicationVersion: app.getVersion(), copyright: '© 2026 Simone Scoca' })
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    ...(app.isPackaged ? [] : [{ role: 'viewMenu' } as MenuItemConstructorOptions]),
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
