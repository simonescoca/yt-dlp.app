import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('the app starts and shows its window', async () => {
  const app = await launchApp()
  const win = await app.firstWindow()
  await expect(win.locator('h1')).toHaveText('Grabbit')
  await win.screenshot({ path: 'test-results/smoke.png' })
  await app.close()
})
