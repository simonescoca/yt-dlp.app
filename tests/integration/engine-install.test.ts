import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ComponentManager } from '../../src/main/engine/components'
import { createNodeHttp } from '../../src/main/engine/http'
import { detectTarget } from '../../src/main/engine/sources'
import { DEV_BIN_DIR } from './env'


describe('real engine install (network)', () => {
  it('installs yt-dlp nightly, Deno and ffmpeg for this platform', async () => {
    const m = new ComponentManager({
      binDir: DEV_BIN_DIR,
      target: detectTarget(),
      http: createNodeHttp(),
      channel: () => 'nightly',
      log: (msg) => console.log(msg)
    })
    await m.init()
    await m.ensureInstalled()
    await m.checkForUpdates()
    const paths = m.getPaths()
    const version = execFileSync(paths.ytdlp, ['--version']).toString().trim()
    console.log('yt-dlp', version, m.getStates())
    expect(version).toMatch(/^\d{4}\.\d{2}\.\d{2}/)
    expect(execFileSync(paths.deno, ['--version']).toString()).toMatch(/^deno \d/)
    expect(execFileSync(join(paths.ffmpegDir, 'ffmpeg'), ['-hide_banner', '-version']).toString()).toMatch(/^ffmpeg version/)
  }, 600_000)
})
