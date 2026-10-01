import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.webm': 'video/webm',
  '.json': 'application/json'
}

export interface RequestLog {
  url: string
  headers: IncomingMessage['headers']
}

export interface FixtureServer {
  origin: string
  requests: RequestLog[]
  close(): Promise<void>
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => boolean

/**
 * Static file server with Range support, serving `roots` (first match wins).
 * `handler` can answer special routes (returns true when it handled the request).
 * Paths under /protected/ require the cookie "session=ok" and a Referer header.
 */
export async function startFixtureServer(roots: string[], handler?: Handler, host = '127.0.0.1'): Promise<FixtureServer> {
  const requests: RequestLog[] = []
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    if (handler?.(req, res)) return
    const url = new URL(req.url ?? '/', 'http://x')
    let path = decodeURIComponent(url.pathname)
    if (path.startsWith('/protected/')) {
      if (!/(^|;\s*)session=ok/.test(req.headers.cookie ?? '') || !req.headers.referer) {
        res.writeHead(403).end('forbidden')
        return
      }
      path = path.slice('/protected'.length)
    }
    if (path.endsWith('/')) path += 'index.html'
    const file = roots.map((r) => join(r, normalize(path))).find((f) => f.startsWith(resolve(roots[0]!, '..')) && existsSync(f) && statSync(f).isFile())
    if (!file) {
      res.writeHead(404).end('not found')
      return
    }
    const size = statSync(file).size
    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      })
      if (req.method === 'HEAD') return void res.end()
      createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => server.listen(0, host, () => r()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://${host}:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}
