/** A tiny test harness for code that must run in Electron's main process. */
import { app } from 'electron'

type TestFn = () => Promise<void> | void
const tests: { name: string; fn: TestFn }[] = []
const hooks: { before: TestFn[]; after: TestFn[] } = { before: [], after: [] }

export const test = (name: string, fn: TestFn): void => void tests.push({ name, fn })
export const before = (fn: TestFn): void => void hooks.before.push(fn)
export const after = (fn: TestFn): void => void hooks.after.push(fn)

export function run(): void {
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => undefined) // keep running between tests
  void app.whenReady().then(async () => {
    let failed = 0
    try {
      for (const h of hooks.before) await h()
      for (const t of tests) {
        const started = Date.now()
        try {
          await t.fn()
          console.log(`  ✓ ${t.name} (${Date.now() - started} ms)`)
        } catch (err) {
          failed++
          console.log(`  ✗ ${t.name} (${Date.now() - started} ms)\n    ${(err as Error).stack ?? err}`)
        }
      }
    } catch (err) {
      failed++
      console.log(`  ✗ setup failed: ${(err as Error).stack ?? err}`)
    } finally {
      for (const h of hooks.after) await Promise.resolve(h()).catch(() => undefined)
    }
    console.log(`\n  ${tests.length - failed}/${tests.length} passed`)
    app.exit(failed ? 1 : 0)
  })
}
