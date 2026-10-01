import assert from 'node:assert/strict'
import { app, session } from 'electron'
import { browserUserAgent, sniffPage } from '../../src/main/sniffer/sniffer'
import { run, test } from './harness'

// Real-world pages (network). Run with GRABBIT_NET_TESTS=1.
const enabled = process.env['GRABBIT_NET_TESTS'] === '1'

if (enabled) {
  test('hls.js demo page: finds the public test stream', async () => {
    const r = await sniffPage({
      url: 'https://hlsjs.video-dev.org/demo/',
      session: session.fromPartition('real-test'),
      userAgent: browserUserAgent(app.userAgentFallback),
      timeoutMs: 30_000,
      log: (m) => console.log('   ', m)
    })
    console.log('    best:', r.best?.url, r.best?.height, r.best?.duration)
    assert.ok(r.best, 'nothing found')
    assert.equal(r.best.kind, 'hls')
  })
}

run()
