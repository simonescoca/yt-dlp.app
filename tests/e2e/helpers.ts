import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface LaunchOptions {
  userData?: string
  env?: Record<string, string>
}

/** Launches the built app (run `npm run build` first) with an isolated profile. */
export async function launchApp(opts: LaunchOptions = {}): Promise<ElectronApplication> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'grabbit-e2e-'))
  const args = [resolve(__dirname, '../../out/main/index.js')]
  // Containers run as root, where Chromium refuses to start without this flag.
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  return electron.launch({
    args,
    env: { ...process.env, GRABBIT_USER_DATA: userData, ...opts.env } as Record<string, string>
  })
}
