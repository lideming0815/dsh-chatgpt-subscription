/** Offline login and teardown checks with per-test credentials and filesystem roots. */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubscriptionClientId } from '../src/ids.ts'
const ONE = brandString<SubscriptionClientId>('one')
const TWO = brandString<SubscriptionClientId>('two')
import { SubscriptionAuth } from '../src/auth.ts'
import type { AuthState, SubscriptionAuthOptions, SubscriptionLoginInput } from '../src/auth.ts'

function deferred<T>() { return Promise.withResolvers<T>() }
const issued: OAuthCredential = { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 4_000_000_000_000, clientId: 'private-client', scopes: ['chatgpt.tokens.use.direct'] }
const grant = (token: OAuthCredential = issued): CredentialRecord => ({ kind: 'grant', payload: token })

class Store {
  readonly records = new Map<CredentialKey, CredentialRecord>()
  private readonly queues = new Map<CredentialKey, Promise<unknown>>()
  beforeCommit?: () => Promise<void>
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(this.records.get(key)) }
  private enqueue<T>(key: CredentialKey, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(operation)
    this.queues.set(key, result.then(() => undefined, () => undefined))
    return result
  }
  modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    return this.enqueue(key, async () => {
      const next = await mutate(this.records.get(key))
      if (next !== undefined) { await this.beforeCommit?.(); this.records.set(key, structuredClone(next)) }
      return this.records.get(key)
    })
  }
  deleteRecord(key: CredentialKey): Promise<void> { return this.enqueue(key, async () => { this.records.delete(key) }) }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
async function fixture(options: Partial<Omit<SubscriptionAuthOptions, 'credentials' | 'installationIdPath'>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-subscription-'))
  const store = new Store()
  const path = join(directory, 'installation-id')
  const auth = new SubscriptionAuth({ credentials: store, installationIdPath: path, ...options })
  cleanups.push(async () => { await auth.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { auth, store, path }
}

function stateWhen(auth: SubscriptionAuth, owner: SubscriptionClientId, predicate: (state: AuthState) => boolean): Promise<AuthState> {
  return new Promise((resolve, reject) => {
    let done = false
    const check = async (): Promise<void> => {
      try {
        const state = await auth.status(owner)
        if (!done && predicate(state)) { done = true; unsubscribe(); resolve(state) }
      } catch (error) { if (!done) { done = true; unsubscribe(); reject(error) } }
    }
    const unsubscribe = auth.subscribe(() => { void check() })
    void check()
  })
}

async function persist(input: SubscriptionLoginInput, token: OAuthCredential = issued): Promise<void> {
  await input.store.modify(input.provider, async () => token, { signal: input.interaction.signal })
}

describe('subscription authorization', () => {
  it('passes a durable installation UUID and application name through real pi Models.login', async () => {
    const ids: string[] = []
    const { auth, store, path } = await fixture({ loginDriver: async (input) => {
      expect(input.options.agentName).toBe('DeepSeek Harness')
      ids.push(input.options.getDeviceId?.() ?? '')
      const models = createModels({ credentials: input.store })
      const provider = openaiProvider()
      models.setProvider({ ...provider, auth: { oauth: { name: 'offline', login: async () => issued, refresh: async current => current, toAuth: async value => ({ apiKey: value.access }) } } })
      await models.login('openai', 'oauth', input.interaction, input.options)
    } })
    await auth.start(ONE, 'openai')
    await stateWhen(auth, ONE, state => state.attempt?.state === 'succeeded')
    await auth.start(ONE, 'openai')
    const state = await stateWhen(auth, ONE, value => value.attempt?.state === 'succeeded')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids[1]).toBe(ids[0])
    expect((await readFile(path, 'utf8')).trim()).toBe(ids[0])
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(store.records.get(recordKeyFor('openai'))).toEqual(grant())
    expect(state.accounts[0]).toEqual({ provider: 'openai', connected: true, expiresAt: issued.expires })
    expect(JSON.stringify(state)).not.toContain('private-')
  })

  it('isolates browser URLs, codes and questions to the initiating client and rejects stale answers', async () => {
    const { auth } = await fixture({ loginDriver: async input => {
      input.interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize?state=private-state' })
      const answer = await input.interaction.prompt({ type: 'manual_code', message: 'Callback URL' })
      expect(answer).toBe('private-callback')
      await persist(input)
    } })
    await auth.start(ONE, 'openai-codex')
    const state = await stateWhen(auth, ONE, value => value.attempt?.prompt !== undefined)
    expect((await auth.status(TWO)).attempt).toBeUndefined()
    const attempt = state.attempt!
    expect(attempt.notice?.url).toContain('private-state')
    await expect(auth.answer(TWO, attempt.id, attempt.prompt!.id, 'private-callback')).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' })
    await expect(auth.cancel(TWO, attempt.id)).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' })
    await expect(auth.start(TWO, 'openai-codex')).rejects.toMatchObject({ code: 'LOGIN_BUSY' })
    await auth.answer(ONE, attempt.id, attempt.prompt!.id, 'private-callback')
    const completed = await stateWhen(auth, ONE, value => value.attempt?.state === 'succeeded')
    expect(completed.attempt?.notice).toBeUndefined()
    expect(completed.attempt?.prompt).toBeUndefined()
    expect(JSON.stringify(completed)).not.toContain('private-')
    await expect(auth.answer(ONE, attempt.id, attempt.prompt!.id, 'private-callback')).rejects.toMatchObject({ code: 'PROMPT_NOT_FOUND' })
  })

  it('cancels a queued login write before it can replace a credential', async () => {
    const locked = deferred<void>()
    const release = deferred<void>()
    const writing = deferred<void>()
    const { auth, store } = await fixture({ loginDriver: async input => { writing.resolve(); await persist(input) } })
    const blocking = store.modifyRecord(recordKeyFor('openai-codex'), async () => { locked.resolve(); await release.promise; return undefined })
    await locked.promise
    const state = await auth.start(ONE, 'openai-codex')
    await writing.promise
    const cancelled = auth.cancel(ONE, state.attempt!.id)
    release.resolve()
    await blocking
    await cancelled
    expect(store.records.size).toBe(0)
    expect((await auth.status(ONE)).attempt?.state).toBe('cancelled')
  })

  it('unloads only after an admitted credential write finishes', async () => {
    const admitted = deferred<void>()
    const release = deferred<void>()
    const { auth, store } = await fixture({ loginDriver: persist })
    store.beforeCommit = async () => { admitted.resolve(); await release.promise }
    await auth.start(ONE, 'openai-codex')
    await admitted.promise
    let disposed = false
    const disposal = auth.dispose().then(() => { disposed = true })
    expect(disposed).toBe(false)
    await expect(auth.start(TWO, 'openai')).rejects.toMatchObject({ code: 'DISPOSED' })
    release.resolve()
    await disposal
    expect(store.records.get(recordKeyFor('openai-codex'))).toEqual(grant())
    expect(disposed).toBe(true)
  })

  it('withdraws pending questions on cancel and unload and retains no late credentials', async () => {
    const { auth, store } = await fixture({ loginDriver: async input => {
      await input.interaction.prompt({ type: 'secret', message: 'Secret answer' })
      await persist(input)
    } })
    await auth.start(ONE, 'openai-codex')
    const first = await stateWhen(auth, ONE, state => state.attempt?.prompt !== undefined)
    await auth.cancel(ONE, first.attempt!.id)
    expect((await auth.status(ONE)).attempt?.prompt).toBeUndefined()
    await auth.start(ONE, 'openai-codex')
    await stateWhen(auth, ONE, state => state.attempt?.prompt !== undefined)
    await auth.dispose()
    expect(store.records.size).toBe(0)
  })

  it('does not expose exception text or invalid installation contents', async () => {
    const { auth, path } = await fixture({ loginDriver: async () => { throw new Error('private-access private-callback private-code') } })
    await auth.start(ONE, 'openai-codex')
    const failed = await stateWhen(auth, ONE, state => state.attempt?.state === 'failed')
    expect(failed.attempt?.error).toBe('LOGIN_FAILED')
    expect(JSON.stringify(failed)).not.toContain('private-')
    await writeFile(path, 'private-invalid-installation')
    await auth.start(ONE, 'openai')
    const invalid = await stateWhen(auth, ONE, state => state.attempt?.state === 'failed')
    expect(invalid.attempt?.error).toBe('INSTALLATION_ID_INVALID')
    expect(await readFile(path, 'utf8')).toBe('private-invalid-installation')
  })

  it('leaves API key records untouched when signing out a subscription', async () => {
    const { auth, store } = await fixture()
    const key = recordKeyFor('openai')
    store.records.set(key, { kind: 'api-key', key: 'private-api-key' })
    expect((await auth.status(ONE)).accounts[0].connected).toBe(false)
    await auth.logout(ONE, 'openai')
    expect(store.records.get(key)).toEqual({ kind: 'api-key', key: 'private-api-key' })
  })

  it('waits for an in-flight refresh, deletes its replacement, then revokes the latest token', async () => {
    const refreshing = deferred<void>()
    const release = deferred<void>()
    const revoked: string[] = []
    const { auth, store } = await fixture({ revoke: async token => { revoked.push(token.refresh) } })
    const key = recordKeyFor('openai')
    store.records.set(key, grant())
    const refresh = store.modifyRecord(key, async () => {
      refreshing.resolve()
      await release.promise
      return grant({ ...issued, refresh: 'private-refreshed' })
    })
    await refreshing.promise
    const loggedOut = auth.logout(ONE, 'openai')
    release.resolve()
    await refresh
    expect(await loggedOut).toEqual({ remoteRevocation: 'confirmed' })
    expect(revoked).toEqual(['private-refreshed'])
    expect(store.records.has(key)).toBe(false)
  })

  it('reports unconfirmed revocation after local removal and labels legacy logout local only', async () => {
    const { auth, store } = await fixture({ revoke: async () => { throw new Error('private-response') } })
    store.records.set(recordKeyFor('openai'), grant())
    store.records.set(recordKeyFor('openai-codex'), grant())
    expect(await auth.logout(ONE, 'openai')).toEqual({ remoteRevocation: 'unconfirmed' })
    expect(await auth.logout(ONE, 'openai-codex')).toEqual({ remoteRevocation: 'not-supported' })
    expect(store.records.size).toBe(0)
  })

  it('refuses to report success when the login driver committed no credential', async () => {
    const { auth, store } = await fixture({ loginDriver: async () => {} })
    await auth.start(ONE, 'openai-codex')
    const state = await stateWhen(auth, ONE, value => value.attempt?.state === 'failed')
    expect(state.attempt?.error).toBe('NOT_COMMITTED')
    expect(store.records.size).toBe(0)
  })

  it('isolates malformed saved grants and lets a new login replace them', async () => {
    const { auth, store } = await fixture({ loginDriver: persist })
    store.records.set(recordKeyFor('openai'), { kind: 'grant', payload: 'private-corruption' })
    store.records.set(recordKeyFor('openai-codex'), grant())
    const before = await auth.status(ONE)
    expect(before.accounts[0]).toEqual({ provider: 'openai', connected: false, error: 'INVALID_CREDENTIAL' })
    expect(before.accounts[1].connected).toBe(true)
    await auth.start(ONE, 'openai')
    const after = await stateWhen(auth, ONE, value => value.attempt?.state === 'succeeded')
    expect(after.accounts[0].connected).toBe(true)
    expect(after.accounts[0].error).toBeUndefined()
  })

  it('gives concurrent plugin instances the same atomically created installation UUID', async () => {
    const ids: string[] = []
    const driver = async (input: SubscriptionLoginInput) => { ids.push(input.options.getDeviceId!()); await persist(input) }
    const { auth, store, path } = await fixture({ loginDriver: driver })
    const other = new SubscriptionAuth({ credentials: store, installationIdPath: path, loginDriver: driver })
    cleanups.push(() => other.dispose())
    await Promise.all([auth.start(ONE, 'openai'), other.start(TWO, 'openai')])
    await Promise.all([
      stateWhen(auth, ONE, value => value.attempt?.state === 'succeeded'),
      stateWhen(other, TWO, value => value.attempt?.state === 'succeeded'),
    ])
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it.each([
    { ...issued, clientId: undefined },
    { ...issued, scopes: ['openid'] },
  ])('rejects an official grant without its issued client identity or direct-use scope', async invalid => {
    const { auth, store } = await fixture({ loginDriver: input => persist(input, invalid) })
    store.records.set(recordKeyFor('openai'), grant(invalid))
    expect((await auth.status(ONE)).accounts[0]).toEqual({ provider: 'openai', connected: false, error: 'INVALID_CREDENTIAL' })
    store.records.clear()
    await auth.start(ONE, 'openai')
    const state = await stateWhen(auth, ONE, value => value.attempt?.state === 'failed')
    expect(state.attempt?.error).toBe('INVALID_CREDENTIAL')
    expect(store.records.size).toBe(0)
  })

  it('discovers an issuer revocation endpoint and sends only the refresh token in its form', async () => {
    const { auth, store } = await fixture()
    store.records.set(recordKeyFor('openai'), grant())
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === 'https://auth.openai.com/.well-known/openid-configuration') {
        return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' })
      }
      expect(String(url)).toBe('https://auth.openai.com/oauth/revoke')
      expect(init?.redirect).toBe('error')
      expect(init?.method).toBe('POST')
      expect(String(init?.body)).toBe('token=private-refresh&token_type_hint=refresh_token&client_id=private-client')
      expect(String(init?.body)).not.toContain('private-access')
      return new Response(null, { status: 200 })
    })
    try {
      expect(await auth.logout(ONE, 'openai')).toEqual({ remoteRevocation: 'confirmed' })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(store.records.size).toBe(0)
    } finally { fetch.mockRestore() }
  })

  it('never sends the refresh token to a revocation endpoint outside the issuer origin', async () => {
    const { auth, store } = await fixture()
    store.records.set(recordKeyFor('openai'), grant())
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ revocation_endpoint: 'https://wrong.invalid/revoke' }))
    try {
      expect(await auth.logout(ONE, 'openai')).toEqual({ remoteRevocation: 'unconfirmed' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(store.records.size).toBe(0)
    } finally { fetch.mockRestore() }
  })
})
