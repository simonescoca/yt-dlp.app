// Bundles tests/electron/*.etest.ts and runs each one inside Electron's main process.
// Usage: node scripts/run-electron-tests.mjs [filter]   (on Linux CI: xvfb-run -a node ...)
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electronPath from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'tests', 'electron')
const outDir = join(root, 'out', 'etest')
mkdirSync(outDir, { recursive: true })
const filter = process.argv[2] ?? ''
const files = readdirSync(dir).filter((f) => f.endsWith('.etest.ts') && f.includes(filter))
let failed = 0
for (const f of files) {
  const outfile = join(outDir, f.replace(/\.ts$/, '.cjs'))
  await build({
    entryPoints: [join(dir, f)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    external: ['electron'],
    alias: { '@shared': join(root, 'src/shared') },
    sourcemap: 'inline',
    logLevel: 'warning'
  })
  const args = [outfile]
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  console.log(`\n▶ ${f}`)
  const r = spawnSync(electronPath, args, { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } })
  if (r.status !== 0) failed++
}
process.exit(failed ? 1 : 0)
