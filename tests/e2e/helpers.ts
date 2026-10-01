import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppState, Job } from '../../src/shared/types'

export const ROOT = resolve(__dirname, '../..')
const DEV_BIN = join(ROOT, '.dev-data', 'bin')

export interface LaunchOptions {
  userData?: string
  /** Copy the engine installed by the integration tests (skips the first-run download). */
  seedEngine?: boolean
  env?: Record<string, string>
}

/** Launches the built app (run `npm run build` first) with an isolated profile. */
export async function launchApp(opts: LaunchOptions = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'grabbit-e2e-'))
  if (opts.seedEngine && existsSync(DEV_BIN) && !existsSync(join(userData, 'bin'))) {
    cpSync(DEV_BIN, join(userData, 'bin'), { recursive: true, verbatimSymlinks: true })
  }
  const args = [join(ROOT, 'out/main/index.js')]
  // Containers run as root, where Chromium refuses to start without this flag.
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  const app = await electron.launch({
    args,
    env: { ...process.env, GRABBIT_USER_DATA: userData, ...opts.env } as Record<string, string>
  })
  const page = await app.firstWindow()
  return { app, page, userData }
}

export const getState = (page: Page): Promise<AppState> => page.evaluate(() => window.grabbit.getState())

/** Polls the job list until `predicate` holds for the job. */
export async function waitForJob(page: Page, id: string, predicate: (j: Job) => boolean, timeoutMs = 120_000): Promise<Job> {
  const started = Date.now()
  for (;;) {
    const job = (await getState(page)).jobs.find((j) => j.id === id)
    if (job && predicate(job)) return job
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for job ${id}: ${JSON.stringify(job)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}
