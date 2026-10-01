import { expect, test } from '@playwright/test'
import { getState, launchApp } from './helpers'

test('the app starts and exposes its API', async () => {
  const { app, page } = await launchApp({ seedEngine: true })
  await expect(page).toHaveTitle('Grabbit')
  const state = await getState(page)
  expect(state.settings).toMatchObject({ mode: 'video', videoFormat: 'mp4', audioFormat: 'mp3', ytdlpChannel: 'nightly' })
  expect(state.settings.folder).toBe(state.info.defaultFolder)
  expect(state.components.map((c) => c.id)).toEqual(['yt-dlp', 'deno', 'ffmpeg'])
  await page.screenshot({ path: 'test-results/smoke.png' })
  await app.close()
})
