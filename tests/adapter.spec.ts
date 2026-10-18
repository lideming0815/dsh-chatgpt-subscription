/** Subscription credentials consumed by the shipped pi-ai adapter through the real LLM runtime. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, expect, it } from 'vitest'
import { SubscriptionAuth } from '../src/auth.ts'
import type { SubscriptionClientId } from '../src/ids.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!() })

async function responsesServer() {
  const requests: { path: string; headers: IncomingHttpHeaders; body: unknown }[] = []
  const item = { type: 'message', id: 'msg_subscription', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'subscription-ready', annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: 'resp_subscription' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'subscription-ready' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: 'subscription-ready' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_subscription', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ]
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch (_error) { response.writeHead(400); response.end(); return }
      requests.push({ path: request.url ?? '', headers: request.headers, body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve() })
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock Responses server did not bind a TCP port')
  return { requests, baseURL: `http://127.0.0.1:${address.port}/v1` }
}

it('uses a saved subscription grant through the existing adapter, then stops requests after logout', async () => {
  const server = await responsesServer()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-subscription-adapter-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { openai: { baseURL: server.baseURL, models: [{ id: 'gpt-4.1' }] } } })
  const owner = brandString<SubscriptionClientId>(randomUUID())
  const committed = Promise.withResolvers<void>()
  const auth = new SubscriptionAuth({
    credentials: ctx.credentials,
    installationIdPath: join(directory, 'installation-id'),
    loginDriver: async ({ provider, store, interaction }) => {
      await store.modify(provider, async () => ({
        type: 'oauth', access: 'synthetic-subscription-access', refresh: 'synthetic-subscription-refresh',
        expires: 4_000_000_000_000, clientId: 'synthetic-issued-client', scopes: ['chatgpt.tokens.use.direct'],
      }), { signal: interaction.signal })
      committed.resolve()
    },
    revoke: async () => {},
  })
  cleanups.push(() => auth.dispose())
  await auth.start(owner, 'openai')
  await committed.promise
  expect((await auth.status(owner)).accounts[0].connected).toBe(true)
  const options = {
    provider: 'openai', model: 'gpt-4.1',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  expect(assembler.finish).toEqual({ kind: 'stop' })
  expect(assembler.message({ provider: 'openai', model: 'gpt-4.1' }).content).toEqual([{ type: 'text', text: 'subscription-ready' }])
  expect(server.requests).toHaveLength(1)
  expect(server.requests[0].path).toBe('/v1/responses')
  expect(server.requests[0].headers.authorization).toBe('Bearer synthetic-subscription-access')
  expect(server.requests[0].body).toMatchObject({ model: 'gpt-4.1', store: false, stream: true })

  expect(await auth.logout(owner, 'openai')).toEqual({ remoteRevocation: 'confirmed' })
  expect((await auth.status(owner)).accounts[0].connected).toBe(false)
  const after: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(options)) after.push(chunk)
  expect(after.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: 'Provider is not configured: openai', code: 'PI_AI_ERROR' } } })
  expect(server.requests).toHaveLength(1)
})
