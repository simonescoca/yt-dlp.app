import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMedia, MEDIA_DIR } from '../fixtures/media'
import { startFixtureServer, type FixtureServer } from '../fixtures/server'
import { getState, launchApp, ROOT, waitForJob } from './helpers'

let server: FixtureServer

test.beforeAll(async () => {
  ensureMedia()
  server = await startFixtureServer([join(ROOT, 'tests/fixtures/pages'), MEDIA_DIR, join(ROOT, 'node_modules/hls.js/dist')])
})
test.afterAll(async () => server?.close())

test('core pipeline through IPC: direct stream, scanned page, settings persistence', async () => {
  const out = mkdtempSync(join(tmpdir(), 'grabbit-dl-'))
  const { app, page, userData } = await launchApp({ seedEngine: true })
  await page.evaluate((folder) => window.grabbit.updateSettings({ folder }), out)

  // 1. A stream yt-dlp understands directly (generic extractor).
  const j1 = await page.evaluate((url) => window.grabbit.addDownload(url), `${server.origin}/hls/master.m3u8`)
  const done1 = await waitForJob(page, j1.id, (j) => ['completed', 'failed'].includes(j.status))
  expect(done1.error).toBeNull()
  expect(done1.filePath).toBe(join(out, 'master.mp4'))
  expect(existsSync(done1.filePath!)).toBe(true)

  // 2. A page yt-dlp cannot read: the scanner finds the HLS stream played by hls.js.
  const j2 = await page.evaluate((url) => window.grabbit.addDownload(url, { mode: 'audio' }), `${server.origin}/hls.html`)
  const done2 = await waitForJob(page, j2.id, (j) => ['completed', 'failed'].includes(j.status))
  expect(done2.error).toBeNull()
  expect(done2.source).toBe('sniffer')
  expect(done2.filePath).toBe(join(out, 'Diretta HLS (hls.js).mp3'))

  // 3. Settings and history survive a restart.
  await app.close()
  expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).folder).toBe(out)
  const second = await launchApp({ userData })
  const state = await getState(second.page)
  expect(state.settings.folder).toBe(out)
  expect(state.jobs.map((j) => j.status)).toEqual(['completed', 'completed'])
  await second.app.close()
})
