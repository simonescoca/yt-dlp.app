import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { EnginePaths } from '../engine/components'

export interface EngineContext {
  paths: EnginePaths
  /** Netscape cookies file exported from the in-app browser (login), if any. */
  cookiesFile?: string | null
}

/** Arguments every yt-dlp invocation gets: isolated config, our ffmpeg and Deno. */
export function baseArgs(ctx: EngineContext): string[] {
  const args = [
    '--ignore-config',
    '--no-js-runtimes',
    '--js-runtimes',
    `deno:${ctx.paths.deno}`,
    '--ffmpeg-location',
    ctx.paths.ffmpegDir,
    '--encoding',
    'utf-8'
  ]
  if (ctx.cookiesFile) args.push('--cookies', ctx.cookiesFile)
  return args
}

export interface RunOptions {
  signal?: AbortSignal
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Keep the whole stdout in the result (off for downloads, which print a lot). */
  collectStdout?: boolean
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  cancelled: boolean
}

const STDERR_KEEP = 64 * 1024

/** Runs yt-dlp; cancelling the signal kills it together with its children (ffmpeg). */
export function runYtdlp(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', cancelled: true })
      return
    }
    const child = spawn(exe, args, {
      windowsHide: true,
      // Own process group on macOS/Linux, so that cancel also stops ffmpeg.
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let cancelled = false

    const out = createInterface({ input: child.stdout })
    out.on('line', (line) => {
      if (opts.collectStdout) stdout += line + '\n'
      opts.onStdoutLine?.(line)
    })
    const err = createInterface({ input: child.stderr })
    err.on('line', (line) => {
      stderr += line + '\n'
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP)
      opts.onStderrLine?.(line)
    })

    const onAbort = (): void => {
      cancelled = true
      killTree(child.pid)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    // 'close' (not 'exit') fires after stdout/stderr are fully read.
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, cancelled })
    })
  })
}

export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3000).unref()
}
