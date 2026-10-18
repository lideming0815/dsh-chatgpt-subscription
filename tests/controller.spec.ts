/** Real Cordis mounting and credential events without any account authorization requests. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatgptSubscriptionService from '../lib/index.js'
import type { AuthState } from '../src/auth.ts'
import type { SubscriptionAttemptId, SubscriptionClientId } from '../src/ids.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!() })
const issued = { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 4_000_000_000_000, clientId: 'private-client', scopes: ['chatgpt.tokens.use.direct'] }

async function boot() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-subscription-controller-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
  const fiber = ctx.plugin(ChatgptSubscriptionService, { installationIdPath: join(directory, 'installation-id') })
  await fiber
  const service = ctx.chatgptSubscriptionController
  const owner = brandString<SubscriptionClientId>(randomUUID())
  return { ctx, fiber, service, owner }
}

function watch(service: ChatgptSubscriptionService, owner: SubscriptionClientId) {
  const controller = new AbortController()
  const iterator = service.watch(owner, controller.signal)[Symbol.asyncIterator]()
  cleanups.push(async () => { controller.abort(); await iterator.return?.() })
  return iterator
}

async function nextWhere(iterator: AsyncIterator<AuthState>, predicate: (state: AuthState) => boolean): Promise<AuthState> {
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error('Subscription watch ended before the expected state')
    if (predicate(next.value)) return next.value
  }
}

describe('subscription controller', () => {
  it('mounts with real local credentials and streams committed grant presence without secrets', async () => {
    const { ctx, service, owner } = await boot()
    const iterator = watch(service, owner)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.accounts).toEqual([
      { provider: 'openai', connected: false }, { provider: 'openai-codex', connected: false },
    ])
    const updated = iterator.next()
    await ctx.credentials.modifyRecord(recordKeyFor('openai'), async () => ({ kind: 'grant', payload: issued }))
    const second = await updated
    expect(second.value?.accounts[0]).toEqual({ provider: 'openai', connected: true, expiresAt: issued.expires })
    expect(JSON.stringify(second.value)).not.toContain('private-')
    expect((await service.status(owner)).accounts[0].connected).toBe(true)
  })

  it('rejects malformed owner identities before exposing account state', async () => {
    const { service } = await boot()
    const owner = brandString<SubscriptionClientId>('private-invalid-owner')
    expect(() => service.status(owner)).toThrow('Invalid browser identifier.')
  })

  it('redacts storage and ownership failures on the actual Remote service methods', async () => {
    const { ctx, service, owner } = await boot()
    const unknownAttempt = brandString<SubscriptionAttemptId>('private-attempt')
    await expect(service.cancel(owner, unknownAttempt)).rejects.toMatchObject({
      code: 'chatgpt-subscription/rejected',
      message: 'The subscription operation could not be completed.',
      details: { reason: 'ATTEMPT_NOT_FOUND' },
    })
    await ctx.credentials.modifyRecord(recordKeyFor('openai'), async () => ({ kind: 'grant', payload: issued }))
    const failure = vi.spyOn(ctx.credentials, 'deleteRecord').mockRejectedValue(new Error('private-refresh private-callback'))
    try {
      await expect(service.logout(owner, 'openai')).rejects.toMatchObject({
        code: 'chatgpt-subscription/rejected',
        message: 'The subscription operation could not be completed.',
        details: { reason: 'STORAGE_FAILED' },
      })
    } finally { failure.mockRestore() }
    expect((await service.status(owner)).accounts[0].connected).toBe(true)
  })

  it('uses the real legacy method prompt and cancels on unload before any network request', async () => {
    const { ctx, fiber, service, owner } = await boot()
    const requests = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('This test must never send an authorization request'))
    try {
      const iterator = watch(service, owner)
      await iterator.next()
      await service.start(owner, 'openai-codex')
      const prompt = await nextWhere(iterator, state => state.attempt?.prompt !== undefined)
      expect(prompt.attempt?.prompt?.kind).toBe('select')
      expect(prompt.attempt?.prompt?.options?.map(option => option.id)).toEqual(['browser', 'device_code'])
      const end = iterator.next()
      await fiber.dispose()
      expect((await end).done).toBe(true)
      expect(await ctx.credentials.readRecord(recordKeyFor('openai-codex'))).toBeUndefined()
      expect(ctx.get('chatgptSubscriptionController')).toBeUndefined()
      expect(requests).not.toHaveBeenCalled()
    } finally { requests.mockRestore() }
  })

  it('finishes an idle state subscription when the plugin unloads while credentials remain available', async () => {
    const { ctx, fiber, service, owner } = await boot()
    const iterator = watch(service, owner)
    await iterator.next()
    const end = iterator.next()
    await fiber.dispose()
    expect((await end).done).toBe(true)
    expect(await ctx.credentials.listRecords()).toEqual([])
  })
})
