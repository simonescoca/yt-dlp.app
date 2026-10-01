import { execFile } from 'node:child_process'
import type { Prober } from './sniffer'

/** Reads duration and size of a remote media file with ffprobe (only the headers are fetched). */
export function ffprobeProber(ffprobePath: string): Prober {
  return (url, headers) =>
    new Promise((resolve) => {
      const headerLines = Object.entries(headers)
        .filter(([k]) => k.toLowerCase() !== 'user-agent')
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')
      const args = ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration:stream=width,height']
      if (headers['User-Agent']) args.push('-user_agent', headers['User-Agent'])
      if (headerLines) args.push('-headers', headerLines)
      args.push('-rw_timeout', '10000000', url)
      execFile(ffprobePath, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null)
        try {
          const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { width?: number; height?: number }[] }
          const v = j.streams?.find((s) => s.width && s.height)
          const d = Number(j.format?.duration)
          resolve({ duration: Number.isFinite(d) ? d : null, width: v?.width ?? null, height: v?.height ?? null })
        } catch {
          resolve(null)
        }
      })
    })
}
