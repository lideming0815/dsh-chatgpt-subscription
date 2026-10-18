/** ChatGPT subscription login sessions and credential storage owned by this plugin instance. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AuthEvent, AuthPrompt, Credential, CredentialStore, LoginOptions, OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubscriptionClientId, SubscriptionAttemptId, SubscriptionPromptId } from './ids.ts'
export type { SubscriptionClientId, SubscriptionAttemptId, SubscriptionPromptId } from './ids.ts'

/** Provider IDs consumed by the existing pi-ai adapter. */
export type SubscriptionProvider = 'openai' | 'openai-codex'
/** Safe failure identities; provider exceptions and token responses never cross the wire. */
export type SubscriptionErrorCode = 'LOGIN_BUSY' | 'LOGIN_FAILED' | 'NOT_COMMITTED' | 'INVALID_CREDENTIAL' | 'INSTALLATION_ID_INVALID' | 'STORAGE_FAILED' | 'ATTEMPT_NOT_FOUND' | 'PROMPT_NOT_FOUND' | 'INVALID_ANSWER' | 'DISPOSED'
/** Stored subscription presence; an expired access token can still refresh normally. */
export interface SubscriptionAccount { provider: SubscriptionProvider; connected: boolean; expiresAt?: number; error?: SubscriptionErrorCode }
/** Provider-owned progress copy and browser instructions, private to the initiating client. */
export interface SubscriptionNotice { message: string; url?: string; code?: string }
/** One unanswered login question; the answer is never retained in public state. */
export interface SubscriptionPrompt { id: SubscriptionPromptId; kind: 'text' | 'secret' | 'select'; message: string; placeholder?: string; options?: readonly { id: string; label: string }[] }
/** The initiating client's latest attempt, including its terminal result. */
export interface SubscriptionAttempt { id: SubscriptionAttemptId; provider: SubscriptionProvider; state: 'running' | 'succeeded' | 'cancelled' | 'failed'; notice?: SubscriptionNotice; prompt?: SubscriptionPrompt; error?: SubscriptionErrorCode }
/** Credential metadata and only the requesting client's login attempt. */
export interface AuthState { accounts: readonly SubscriptionAccount[]; attempt?: SubscriptionAttempt }
/** Local logout always completes before issuer revocation is attempted. */
export interface SubscriptionLogoutResult { remoteRevocation: 'confirmed' | 'unconfirmed' | 'not-supported' }
/** A safe operational failure whose code is suitable for localization. */
export class SubscriptionAuthError extends Error {
  constructor(readonly code: SubscriptionErrorCode) { super(code); this.name = 'SubscriptionAuthError' }
}
export { SubscriptionAuthError as SubscriptionError }

type Credentials = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>
/** Complete login operation; the injected variant supports deterministic offline tests. */
export interface SubscriptionLoginInput { provider: SubscriptionProvider; interaction: ProviderAuthInteraction; store: CredentialStore; options: LoginOptions }
/** Host dependencies; timeout overrides otherwise use fifteen minutes and fifteen seconds. */
export interface SubscriptionAuthOptions {
  credentials: Credentials
  installationIdPath: string
  loginTimeoutMs?: number
  revocationTimeoutMs?: number
  loginDriver?: (input: SubscriptionLoginInput) => Promise<void>
  revoke?: (credential: OAuthCredential, signal: AbortSignal) => Promise<void>
}

interface Attempt {
  owner: SubscriptionClientId
  view: SubscriptionAttempt
  controller: AbortController
  committing: boolean
  committed: boolean
  task: Promise<void>
  writes: Set<Promise<CredentialRecord | undefined>>
  answer?: { id: SubscriptionPromptId; resolve(value: string): void; reject(reason: unknown): void }
}
const PROVIDERS: readonly SubscriptionProvider[] = ['openai', 'openai-codex']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function credential(record: CredentialRecord | undefined, provider: SubscriptionProvider): Credential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') return { type: 'api_key', key: record.key, env: record.env === undefined ? undefined : { ...record.env } }
  const value = record.payload
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'oauth'
    || !('access' in value) || typeof value.access !== 'string' || value.access.trim().length === 0
    || !('refresh' in value) || typeof value.refresh !== 'string' || value.refresh.trim().length === 0
    || !('expires' in value) || typeof value.expires !== 'number' || !Number.isFinite(value.expires)) {
    throw new SubscriptionAuthError('INVALID_CREDENTIAL')
  }
  if (provider === 'openai' && (!('clientId' in value) || typeof value.clientId !== 'string' || value.clientId.trim().length === 0
    || !('scopes' in value) || !Array.isArray(value.scopes) || !value.scopes.every(scope => typeof scope === 'string')
    || !value.scopes.includes('chatgpt.tokens.use.direct'))) throw new SubscriptionAuthError('INVALID_CREDENTIAL')
  return { ...value, type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires }
}

async function installationId(path: string): Promise<string> {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    if (!UUID.test(value)) throw new SubscriptionAuthError('INSTALLATION_ID_INVALID')
    return value
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const id = randomUUID()
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${id}\n`, { flag: 'wx', mode: 0o600 })
  try {
    try { await link(temporary, path) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  } finally { await unlink(temporary) }
  const value = (await readFile(path, 'utf8')).trim()
  if (!UUID.test(value)) throw new SubscriptionAuthError('INSTALLATION_ID_INVALID')
  return value
}

async function login(input: SubscriptionLoginInput): Promise<void> {
  const provider = input.provider === 'openai' ? openaiProvider() : openaiCodexProvider()
  const oauth = provider.auth.oauth
  if (oauth === undefined) throw new SubscriptionAuthError('LOGIN_FAILED')
  // Await the provider's cleanup before cancellation releases its callback listener.
  const issued = await oauth.login(input.interaction, input.options)
  await input.store.modify(input.provider, async () => issued, { signal: input.interaction.signal })
}

async function revoke(issued: OAuthCredential, signal: AbortSignal): Promise<void> {
  if (typeof issued.clientId !== 'string' || issued.clientId.length === 0) throw new Error('REVOCATION_UNAVAILABLE')
  const discovery = await fetch('https://auth.openai.com/.well-known/openid-configuration', { signal, redirect: 'error' })
  if (!discovery.ok) throw new Error('REVOCATION_UNAVAILABLE')
  const metadata: unknown = await discovery.json()
  if (typeof metadata !== 'object' || metadata === null || !('revocation_endpoint' in metadata)
    || typeof metadata.revocation_endpoint !== 'string') throw new Error('REVOCATION_UNAVAILABLE')
  const endpoint = new URL(metadata.revocation_endpoint)
  if (endpoint.origin !== 'https://auth.openai.com' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('REVOCATION_UNAVAILABLE')
  const response = await fetch(endpoint, {
    method: 'POST', signal, redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: issued.refresh, token_type_hint: 'refresh_token', client_id: issued.clientId }),
  })
  if (response.status !== 200) throw new Error('REVOCATION_UNCONFIRMED')
}

/** Owns pending questions, admitted credential writes, and cancellation through quiescent disposal. */
export class SubscriptionAuth {
  private readonly attempts = new Map<SubscriptionClientId, Attempt>()
  private readonly listeners = new Set<() => void>()
  private readonly loggingOut = new Set<SubscriptionProvider>()
  private readonly operations = new Set<Promise<SubscriptionLogoutResult>>()
  private closed = false
  constructor(private readonly options: SubscriptionAuthOptions) {}

  /** Observe state transitions; returned disposer detaches only this listener. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private changed(): void { for (const listener of this.listeners) listener() }
  private assertOpen(): void { if (this.closed) throw new SubscriptionAuthError('DISPOSED') }

  /** Return credential metadata and the attempt belonging to this client. */
  async status(owner: SubscriptionClientId): Promise<AuthState> {
    const accounts = await Promise.all(PROVIDERS.map(async (provider): Promise<SubscriptionAccount> => {
      let stored: Credential | undefined
      try { stored = credential(await this.options.credentials.readRecord(recordKeyFor(provider)), provider) }
      catch (error) { return { provider, connected: false, error: error instanceof SubscriptionAuthError ? error.code : 'STORAGE_FAILED' } }
      return { provider, connected: stored?.type === 'oauth', ...stored?.type === 'oauth' ? { expiresAt: stored.expires } : {} }
    }))
    const attempt = this.attempts.get(owner)?.view
    return { accounts, ...attempt === undefined ? {} : { attempt: structuredClone(attempt) } }
  }

  /** Start one provider login; another client cannot replace a running attempt. */
  async start(owner: SubscriptionClientId, provider: SubscriptionProvider): Promise<AuthState> {
    this.assertOpen()
    if (this.loggingOut.has(provider) || [...this.attempts.values()].some(attempt => attempt.view.state === 'running' && (attempt.view.provider === provider || attempt.owner === owner))) {
      throw new SubscriptionAuthError('LOGIN_BUSY')
    }
    const attempt: Attempt = {
      owner, view: { id: brandString<SubscriptionAttemptId>(randomUUID()), provider, state: 'running' }, controller: new AbortController(),
      committing: false, committed: false, task: Promise.resolve(), writes: new Set(),
    }
    this.attempts.set(owner, attempt)
    const completion = Promise.withResolvers<void>()
    attempt.task = completion.promise
    void this.run(attempt).then(completion.resolve, completion.reject)
    this.changed()
    return this.status(owner)
  }

  private async run(attempt: Attempt): Promise<void> {
    const timeout = setTimeout(() => { if (!attempt.committing) attempt.controller.abort() }, this.options.loginTimeoutMs ?? 15 * 60 * 1000)
    timeout.unref()
    try {
      const id = attempt.view.provider === 'openai' ? await installationId(this.options.installationIdPath) : undefined
      attempt.controller.signal.throwIfAborted()
      const store = this.store(attempt)
      await (this.options.loginDriver ?? login)({
        provider: attempt.view.provider,
        store,
        interaction: {
          signal: attempt.controller.signal,
          notify: event => this.notice(attempt, event),
          prompt: async prompt => this.prompt(attempt, prompt),
        },
        options: { agentName: 'DeepSeek Harness', ...id === undefined ? {} : { getDeviceId: () => id } },
      })
      if (!attempt.committed) throw new SubscriptionAuthError('NOT_COMMITTED')
      attempt.view.state = attempt.controller.signal.aborted && !attempt.committing ? 'cancelled' : 'succeeded'
    } catch (error) {
      attempt.view.state = attempt.controller.signal.aborted ? 'cancelled' : 'failed'
      if (attempt.view.state === 'failed') attempt.view.error = error instanceof SubscriptionAuthError ? error.code : 'LOGIN_FAILED'
    } finally {
      clearTimeout(timeout)
      await Promise.allSettled(attempt.writes)
      attempt.answer?.reject(new SubscriptionAuthError('PROMPT_NOT_FOUND'))
      attempt.answer = undefined
      delete attempt.view.prompt
      delete attempt.view.notice
      this.changed()
    }
  }

  private store(attempt: Attempt): CredentialStore {
    const key = recordKeyFor(attempt.view.provider)
    return {
      read: async () => credential(await this.options.credentials.readRecord(key), attempt.view.provider),
      list: async () => [],
      modify: async (_id, mutate, options) => {
        options?.signal?.throwIfAborted()
        attempt.controller.signal.throwIfAborted()
        let writing: Credential | undefined
        const write = this.options.credentials.modifyRecord(key, async (current) => {
          options?.signal?.throwIfAborted()
          attempt.controller.signal.throwIfAborted()
          attempt.committing = true
          let previous: Credential | undefined
          try { previous = credential(current, attempt.view.provider) }
          catch (error) {
            // A new login replaces a malformed saved grant; request-time reads still reject it.
            if (!(error instanceof SubscriptionAuthError && error.code === 'INVALID_CREDENTIAL')) throw error
          }
          const next = await mutate(previous)
          writing = next
          if (next?.type === 'oauth') credential({ kind: 'grant', payload: next }, attempt.view.provider)
          return next === undefined ? undefined : next.type === 'oauth'
            ? { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) }
            : { kind: 'api-key', key: next.key, env: next.env }
        })
        attempt.writes.add(write)
        try {
          const stored = credential(await write, attempt.view.provider)
          if (writing?.type === 'oauth' && stored?.type === 'oauth' && writing.access === stored.access && writing.refresh === stored.refresh) attempt.committed = true
          return stored
        }
        finally { attempt.writes.delete(write) }
      },
      delete: async () => { throw new SubscriptionAuthError('STORAGE_FAILED') },
    }
  }

  private notice(attempt: Attempt, event: AuthEvent): void {
    if (attempt.controller.signal.aborted || attempt.view.state !== 'running') return
    switch (event.type) {
      case 'auth_url': attempt.view.notice = { message: event.instructions ?? 'Continue in your browser.', url: event.url }; break
      case 'device_code': attempt.view.notice = { message: 'Enter this code in your browser.', url: event.verificationUri, code: event.userCode }; break
      case 'progress': case 'info': attempt.view.notice = { message: event.message }; break
      default: attempt.view.notice = { message: 'Signing in.' }
    }
    this.changed()
  }

  private prompt(attempt: Attempt, prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal === undefined ? attempt.controller.signal : AbortSignal.any([attempt.controller.signal, prompt.signal])
    signal.throwIfAborted()
    if (attempt.answer !== undefined) throw new SubscriptionAuthError('LOGIN_FAILED')
    const id = brandString<SubscriptionPromptId>(randomUUID())
    attempt.view.prompt = {
      id, kind: prompt.type === 'manual_code' ? 'text' : prompt.type, message: prompt.message,
      ...'placeholder' in prompt && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {},
      ...prompt.type === 'select' ? { options: prompt.options.map(({ id: option, label }) => ({ id: option, label })) } : {},
    }
    return new Promise<string>((resolve, reject) => {
      const finish = (value: string | undefined, error?: unknown): void => {
        signal.removeEventListener('abort', aborted)
        if (attempt.answer?.id === id) { attempt.answer = undefined; delete attempt.view.prompt }
        this.changed()
        if (value === undefined) reject(error)
        else resolve(value)
      }
      const aborted = (): void => { finish(undefined, signal.reason) }
      attempt.answer = { id, resolve: value => { finish(value) }, reject: error => { finish(undefined, error) } }
      signal.addEventListener('abort', aborted, { once: true })
      this.changed()
    })
  }

  private owned(owner: SubscriptionClientId, id: SubscriptionAttemptId): Attempt {
    const attempt = this.attempts.get(owner)
    if (attempt?.view.id !== id) throw new SubscriptionAuthError('ATTEMPT_NOT_FOUND')
    return attempt
  }

  /** Answer only a currently pending question owned by this client. */
  async answer(owner: SubscriptionClientId, attemptId: SubscriptionAttemptId, promptId: SubscriptionPromptId, value: string): Promise<AuthState> {
    this.assertOpen()
    const attempt = this.owned(owner, attemptId)
    if (attempt.answer?.id !== promptId) throw new SubscriptionAuthError('PROMPT_NOT_FOUND')
    const prompt = attempt.view.prompt
    if (value.length === 0 || value.length > 32_768 || (prompt?.kind === 'select' && !prompt.options?.some(option => option.id === value))) throw new SubscriptionAuthError('INVALID_ANSWER')
    attempt.answer.resolve(value)
    return this.status(owner)
  }

  /** Cancel before a credential write starts; admitted writes finish before returning. */
  async cancel(owner: SubscriptionClientId, attemptId: SubscriptionAttemptId): Promise<void> {
    const attempt = this.owned(owner, attemptId)
    if (!attempt.committing) attempt.controller.abort()
    await attempt.task
  }

  /** Clear the local record, then report whether issuer revocation was confirmed. */
  logout(owner: SubscriptionClientId, provider: SubscriptionProvider): Promise<SubscriptionLogoutResult> {
    this.assertOpen()
    if (this.loggingOut.has(provider)) return Promise.reject(new SubscriptionAuthError('LOGIN_BUSY'))
    const running = [...this.attempts.values()].find(attempt => attempt.view.provider === provider && attempt.view.state === 'running')
    if (running !== undefined && running.owner !== owner) return Promise.reject(new SubscriptionAuthError('LOGIN_BUSY'))
    this.loggingOut.add(provider)
    const operation = this.logoutProvider(running, provider)
    this.operations.add(operation)
    const settled = (): void => { this.loggingOut.delete(provider); this.operations.delete(operation) }
    void operation.then(settled, settled)
    return operation
  }

  private async logoutProvider(running: Attempt | undefined, provider: SubscriptionProvider): Promise<SubscriptionLogoutResult> {
    if (running !== undefined) await this.cancel(running.owner, running.view.id)
    let stored: Credential | undefined
    const key = recordKeyFor(provider)
    try {
      await this.options.credentials.modifyRecord(key, async (current) => { stored = credential(current, provider); return undefined })
      if (stored?.type === 'oauth') await this.options.credentials.deleteRecord(key)
    } catch { throw new SubscriptionAuthError('STORAGE_FAILED') }
    this.changed()
    if (provider === 'openai-codex') return { remoteRevocation: 'not-supported' }
    if (stored?.type !== 'oauth') return { remoteRevocation: 'unconfirmed' }
    try {
      await (this.options.revoke ?? revoke)(stored, AbortSignal.timeout(this.options.revocationTimeoutMs ?? 15_000))
      return { remoteRevocation: 'confirmed' }
    } catch { return { remoteRevocation: 'unconfirmed' } }
  }

  /** Withdraw prompts and await all credential mutations and logout operations before releasing dependencies. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const attempt of this.attempts.values()) if (!attempt.committing) attempt.controller.abort()
    await Promise.allSettled([...this.attempts.values()].map(attempt => attempt.task))
    await Promise.allSettled(this.operations)
    this.attempts.clear()
    this.listeners.clear()
  }
}
