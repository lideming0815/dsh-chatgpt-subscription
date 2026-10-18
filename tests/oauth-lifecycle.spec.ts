/** The real OAuth flow must finish releasing its callback listener before cancellation settles. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('cancels an official login during callback startup without leaving a listening server', () => {
  const entry = new URL('../lib/index.js', import.meta.url).href
  const script = `
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
const { default: Subscription } = await import(${JSON.stringify(entry)})
const http = createRequire(import.meta.url)('node:http')
const original = http.createServer
const entering = Promise.withResolvers()
const release = Promise.withResolvers()
const bound = Promise.withResolvers()
const servers = []
http.createServer = (...args) => {
  const server = original(...args)
  servers.push(server)
  const listen = server.listen.bind(server)
  server.listen = (...values) => {
    if (values[0] !== 1455) return listen(...values)
    entering.resolve()
    void release.promise.then(() => listen(0, '127.0.0.1', () => {
      const callback = values.at(-1)
      if (typeof callback === 'function') callback()
      bound.resolve()
    }))
    return server
  }
  return server
}
syncBuiltinESMExports()
const directory = await mkdtemp(join(tmpdir(), 'dsh-official-cancel-'))
const ctx = new Context()
globalThis.fetch = async () => { throw new Error('This test forbids network requests') }
try {
  await ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
  await ctx.plugin(Subscription, { installationIdPath: join(directory, 'installation-id') })
  const service = ctx.chatgptSubscriptionController
  const owner = randomUUID()
  const state = await service.start(owner, 'openai')
  await entering.promise
  const cancelled = service.cancel(owner, state.attempt.id)
  release.resolve()
  await cancelled
  await bound.promise
  assert.equal(servers.filter(server => server.listening).length, 0, 'cancellation returned before OAuth released its callback listener')
  assert.equal((await service.status(owner)).accounts[0].connected, false)
} finally {
  await ctx.fiber.dispose()
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  })))
  http.createServer = original
  syncBuiltinESMExports()
  await rm(directory, { recursive: true, force: true })
}
`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
})
