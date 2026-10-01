import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMedia, MEDIA_DIR } from '../fixtures/media'
import { startFixtureServer, type FixtureServer } from '../fixtures/server'
import { launchApp, ROOT } from './helpers'

const SHOTS = join(ROOT, 'docs', 'screenshots')
let server: FixtureServer
let app: ElectronApplication
let page: Page
let out: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ensureMedia()
  server = await startFixtureServer([join(ROOT, 'tests/fixtures/pages'), MEDIA_DIR, join(ROOT, 'node_modules/hls.js/dist')])
  out = mkdtempSync(join(tmpdir(), 'grabbit-ui-'))
  ;({ app, page } = await launchApp({ seedEngine: true }))
  await page.evaluate((folder) => window.grabbit.updateSettings({ folder, language: 'it' }), out)
  await expect(page.getByText('Pronto quando vuoi')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await server?.close()
})

const card = (title: string | RegExp) => page.getByTestId('job').filter({ hasText: title })

async function download(url: string): Promise<void> {
  await page.getByTestId('url-input').fill(url)
  await page.getByTestId('download-button').click()
  await expect(page.getByTestId('url-input')).toHaveValue('')
}

test('empty state, Italian UI, defaults mp4 / Download', async () => {
  await expect(page.getByTestId('format-picker')).toHaveText('MP4')
  await expect(page.getByTestId('mode-video')).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: join(SHOTS, '01-vuoto.png') })
})

test('rejects text that is not a link', async () => {
  await page.getByTestId('url-input').fill('ciao mamma')
  await page.getByTestId('download-button').click()
  await expect(page.getByRole('alert')).toContainText('non sembra un link valido')
  await page.getByTestId('url-input').fill('')
})

test('pasting a link anywhere fills the box', async () => {
  await page.locator('body').click({ position: { x: 5, y: 300 } })
  await page.evaluate((url) => {
    const dt = new DataTransfer()
    dt.setData('text', `guarda qui ${url} !`)
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  }, `${server.origin}/video.mp4`)
  await expect(page.getByTestId('url-input')).toHaveValue(`${server.origin}/video.mp4`)
  await page.getByTestId('url-input').fill('')
})

test('downloads a video with progress, then offers open / show in folder', async () => {
  await download(`${server.origin}/slow/video.mp4`)
  const c = card('video')
  await expect(c.locator('[role=progressbar]')).toBeVisible({ timeout: 30_000 })
  await expect(c).toContainText('%')
  await page.screenshot({ path: join(SHOTS, '02-download-in-corso.png') })
  await expect(c).toHaveAttribute('data-status', 'completed', { timeout: 90_000 })
  await expect(c).toContainText('Completato')
  await expect(c.getByRole('button', { name: 'Mostra nella cartella' })).toBeVisible()
  expect(existsSync(join(out, 'video.mp4'))).toBe(true)
})

test('audio only: format picker lists audio formats, downloads M4A', async () => {
  await page.getByTestId('mode-audio').click()
  await expect(page.getByTestId('format-picker')).toHaveText('MP3')
  await page.getByTestId('format-picker').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '03-formati-audio.png') })
  await page.getByRole('menuitemradio', { name: /M4A/ }).click()
  await expect(page.getByTestId('format-picker')).toHaveText('M4A')
  await download(`${server.origin}/dash/manifest.mpd`)
  await expect(card('manifest')).toHaveAttribute('data-status', 'completed', { timeout: 60_000 })
  expect(existsSync(join(out, 'manifest.m4a'))).toBe(true)
  await page.getByTestId('mode-video').click()
})

test('playlist: dialog, choose which videos, saved in a sub-folder', async () => {
  await download(`${server.origin}/two.html`)
  const dialog = page.getByRole('dialog', { name: 'Questo link contiene una playlist' })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toContainText('Due video · 2 video')
  await expect(page.getByTestId('playlist-single')).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, '04-playlist.png') })
  await page.getByTestId('playlist-pick').click()
  await dialog.getByRole('checkbox').nth(1).uncheck()
  await dialog.getByRole('button', { name: 'Scarica 1 video' }).click()
  await expect(dialog).toBeHidden()
  await expect(card('Due video (1)')).toHaveAttribute('data-status', 'completed', { timeout: 60_000 })
  expect(readdirSync(join(out, 'Due video'))).toEqual(['01 - Due video (1).mp4'])
})

test('page scanner: several videos found → the user chooses', async () => {
  await download(`${server.origin}/two-js.html`)
  const dialog = page.getByRole('dialog', { name: 'Ho trovato più video in questa pagina' })
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog.locator('.option')).toHaveCount(2)
  await page.screenshot({ path: join(SHOTS, '05-scelta-flusso.png') })
  await dialog.locator('.option', { hasText: '1:10' }).click()
  const c = card('Due video creati da JavaScript')
  await expect(c).toHaveAttribute('data-status', 'completed', { timeout: 60_000 })
  await expect(c).toContainText('trovato nella pagina')
  expect(existsSync(join(out, 'Due video creati da JavaScript.mp4'))).toBe(true)
})

test('a page without video fails with a clear message and next steps', async () => {
  await download(`${server.origin}/nothing.html`)
  const c = card('Nessun video qui')
  await expect(c).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
  await expect(c).toContainText('Non ho trovato un video in questa pagina.')
  await expect(c.getByRole('button', { name: 'Apri la pagina' })).toBeVisible()
  await c.getByRole('button', { name: 'Dettagli' }).click()
  await expect(c.locator('.job-error-raw')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '06-errore.png') })
})

test('cancel a running download', async () => {
  await download(`${server.origin}/slow/long2.mp4`)
  const c = card('long2')
  await expect(c).toHaveAttribute('data-status', 'downloading', { timeout: 30_000 })
  await c.getByRole('button', { name: 'Annulla' }).click()
  await expect(c).toHaveAttribute('data-status', 'cancelled')
  await expect(c.getByRole('button', { name: 'Riprova' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '07-lista.png') })
})

test('settings: language, theme, engine versions', async () => {
  await page.getByTestId('open-settings').click()
  const s = page.getByTestId('settings')
  await expect(s).toBeVisible()
  for (const id of ['yt-dlp', 'deno', 'ffmpeg']) await expect(s.getByTestId(`component-${id}`)).not.toContainText('non installato')
  await page.waitForTimeout(400) // slide-in animation
  await page.screenshot({ path: join(SHOTS, '08-impostazioni.png') })
  await s.getByLabel('Tema').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await s.getByLabel('Lingua').selectOption('en')
  await expect(s.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await s.getByText('Site sign-in').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOTS, '09-impostazioni-scuro-en.png') })
  await s.getByLabel('Language').selectOption('it')
  await page.keyboard.press('Escape')
  await expect(s).toBeHidden()
  await page.screenshot({ path: join(SHOTS, '10-lista-scuro.png') })
})

test('clear finished downloads', async () => {
  await page.getByRole('button', { name: 'Svuota completati' }).click()
  await expect(page.getByText('Pronto quando vuoi')).toBeVisible()
})
