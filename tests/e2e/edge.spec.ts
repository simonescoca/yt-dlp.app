import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMedia, MEDIA_DIR } from '../fixtures/media'
import { startFixtureServer, type FixtureServer } from '../fixtures/server'
import { launchApp, ROOT } from './helpers'

let server: FixtureServer

test.beforeAll(async () => {
  ensureMedia()
  server = await startFixtureServer([join(ROOT, 'tests/fixtures/pages'), MEDIA_DIR])
})
test.afterAll(async () => server?.close())

test('first start without internet: clear banner, retry, jobs explain the problem', async () => {
  // A proxy that refuses every connection = offline for Chromium's network stack.
  const { app, page } = await launchApp({ args: ['--proxy-server=http://127.0.0.1:9'] })
  await page.evaluate(() => window.grabbit.updateSettings({ language: 'it' }))
  const banner = page.getByTestId('engine-banner')
  await expect(banner).toContainText('Non riesco a preparare il motore di download', { timeout: 60_000 })
  await expect(banner.getByRole('button', { name: 'Riprova' })).toBeVisible()
  await page.screenshot({ path: join(ROOT, 'docs/screenshots/11-offline.png') })
  await page.getByTestId('url-input').fill(`${server.origin}/video.mp4`)
  await page.getByTestId('download-button').click()
  const card = page.getByTestId('job').first()
  await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
  await expect(card).toContainText('Il motore di download non è pronto.')
  await app.close()
})

test('destination folder that cannot be written', async () => {
  // A "folder" inside a regular file can never be created (ENOTDIR), even as root.
  const file = join(mkdtempSync(join(tmpdir(), 'grabbit-ro-')), 'a-file.txt')
  writeFileSync(file, 'x')
  const { app, page } = await launchApp({ seedEngine: true })
  await page.evaluate((folder) => window.grabbit.updateSettings({ language: 'it', folder }), join(file, 'sub'))
  await page.getByTestId('url-input').fill(`${server.origin}/video.mp4`)
  await page.getByTestId('download-button').click()
  const card = page.getByTestId('job').first()
  await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
  await expect(card).toContainText('Non posso scrivere nella cartella scelta.')
  await app.close()
})

test('"Open the page": the user starts the video, the app finds it', async () => {
  const out = mkdtempSync(join(tmpdir(), 'grabbit-manual-'))
  const { app, page } = await launchApp({ seedEngine: true })
  await page.evaluate((folder) => window.grabbit.updateSettings({ language: 'it', folder }), out)
  await page.getByTestId('url-input').fill(`${server.origin}/manual.html`)
  await page.getByTestId('download-button').click()
  const card = page.getByTestId('job').first()
  await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })

  const popup = app.waitForEvent('window')
  await card.getByRole('button', { name: 'Apri la pagina' }).click()
  const win = await popup
  await expect(card).toContainText('Avvia il video nella finestra che si è aperta')
  await win.getByText('guarda ora').click()
  await win.waitForTimeout(2500)
  await win.close()

  const dialog = page.getByRole('dialog', { name: 'Ho trovato più video in questa pagina' })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.locator('.option').first().click()
  await expect(card).toHaveAttribute('data-status', 'completed', { timeout: 60_000 })
  expect(existsSync(join(out, 'Video da avviare a mano.mp4'))).toBe(true)
  await app.close()
})

test('sign-in window: sites are remembered, "sign out of all" forgets them', async () => {
  const { app, page } = await launchApp({ seedEngine: true })
  await page.evaluate(() => window.grabbit.updateSettings({ language: 'it' }))
  await page.getByTestId('open-settings').click()
  const settings = page.getByTestId('settings')
  await expect(settings).toContainText('Nessun accesso salvato.')
  const popup = app.waitForEvent('window')
  await settings.getByPlaceholder('oppure scrivi un indirizzo').fill(`${server.origin}/protected.html`)
  await settings.getByPlaceholder('oppure scrivi un indirizzo').press('Enter')
  const win = await popup
  await win.waitForLoadState()
  await win.close()
  await expect(settings.locator('.tag', { hasText: '127.0.0.1' })).toBeVisible()
  const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:grabbit-web').cookies.get({})).map((c) => c.name))
  expect(cookies).toContain('session')
  await settings.getByRole('button', { name: 'Esci da tutti i siti' }).click()
  await expect(settings).toContainText('Nessun accesso salvato.')
  const after = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:grabbit-web').cookies.get({})).length)
  expect(after).toBe(0)
  await app.close()
})

test.describe(() => {
  test.skip(process.env['GRABBIT_NET_TESTS'] !== '1', 'needs internet (GRABBIT_NET_TESTS=1)')
  test('first start online: the engine is downloaded with visible progress', async () => {
    const { app, page } = await launchApp()
    await page.evaluate(() => window.grabbit.updateSettings({ language: 'it' }))
    const banner = page.getByTestId('engine-banner')
    await expect(banner).toContainText('Preparazione del motore di download')
    await page.screenshot({ path: join(ROOT, 'docs/screenshots/00-primo-avvio.png') })
    await expect(banner).toBeHidden({ timeout: 300_000 })
    await expect(page.getByTestId('footer')).toContainText(/yt-dlp \d{4}\.\d{2}\.\d{2}/)
    const state = await page.evaluate(() => window.grabbit.getState())
    expect(state.components.every((c) => c.phase === 'ready' && c.version)).toBe(true)
    await app.close()
  })
})
