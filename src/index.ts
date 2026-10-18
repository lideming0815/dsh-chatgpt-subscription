/** ChatGPT subscription sign-in for the existing pi-ai model adapter. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-credentials'
import { SubscriptionAuth, SubscriptionError } from './auth.ts'
import type { AuthState, SubscriptionLogoutResult, SubscriptionProvider } from './auth.ts'
import type { SubscriptionAttemptId, SubscriptionClientId, SubscriptionPromptId } from './ids.ts'

export type { AuthState, SubscriptionLogoutResult, SubscriptionProvider } from './auth.ts'

/** Persistent host identity and bounded authorization operations. */
export interface Config {
  /** UUID file shared by this installation; defaults to the Harness home. */
  installationIdPath?: string
  /** Maximum duration of one browser sign-in, in milliseconds. */
  loginTimeoutMs: number
  /** Maximum wait for issuer revocation after local sign-out, in milliseconds. */
  revocationTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatgptSubscriptionController: ChatgptSubscriptionService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Subscription operation failed; credentials remain on the Host. */
    'chatgpt-subscription/rejected': { readonly reason: string }
  }
}

/** Authenticated, display-safe operations for the model-card extension. */
export class ChatgptSubscriptionService extends TypertRemoteService {
  static inject = ['credentials']
  static Config: z<Config> = z.object({
    installationIdPath: z.string(),
    loginTimeoutMs: z.number().min(1000).default(900000),
    revocationTimeoutMs: z.number().min(1000).default(15000),
  })

  private readonly auth: SubscriptionAuth
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Host context carrying the existing credential store.
   * @param config - installation identity location and operation timeouts.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'chatgptSubscriptionController', { namespace: 'chatgptSubscription' })
    this.auth = new SubscriptionAuth({
      credentials: ctx.credentials,
      installationIdPath: config.installationIdPath ?? join(resolveDshHome(), '.chatgpt-subscription-host-id'),
      loginTimeoutMs: config.loginTimeoutMs,
      revocationTimeoutMs: config.revocationTimeoutMs,
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.auth.dispose()
    }, 'ChatGPT subscription: authorization lifetime')
  }

  /**
   * @param owner - private browser-instance identifier.
   * @returns credential presence and only this browser's authorization prompts.
   */
  @Remote
  status(owner: SubscriptionClientId): Promise<AuthState> {
    this.validateOwner(owner)
    return this.operation(() => this.auth.status(owner))
  }

  /**
   * @param owner - private browser-instance identifier.
   * @param provider - existing pi-ai provider receiving the grant.
   * @returns initial state of this browser's sign-in attempt.
   */
  @Remote
  start(owner: SubscriptionClientId, provider: SubscriptionProvider): Promise<AuthState> {
    this.validateOwner(owner)
    return this.operation(() => this.auth.start(owner, provider))
  }

  /**
   * @param owner - browser instance that started the attempt.
   * @param attemptId - active attempt identity.
   * @param promptId - currently displayed question identity.
   * @param value - answer held only for this authorization exchange.
   * @returns the latest safe authorization state.
   */
  @Remote
  answer(owner: SubscriptionClientId, attemptId: SubscriptionAttemptId, promptId: SubscriptionPromptId, value: string): Promise<AuthState> {
    this.validateOwner(owner)
    return this.operation(() => this.auth.answer(owner, attemptId, promptId, value))
  }

  /**
   * @param owner - browser instance that started the attempt.
   * @param attemptId - sign-in attempt to withdraw.
   * @returns after cancellation settles and cannot commit credentials later.
   */
  @Remote
  cancel(owner: SubscriptionClientId, attemptId: SubscriptionAttemptId): Promise<void> {
    this.validateOwner(owner)
    return this.operation(() => this.auth.cancel(owner, attemptId))
  }

  /**
   * @param owner - browser instance requesting sign-out.
   * @param provider - OAuth record to remove without changing API keys.
   * @returns whether remote revocation was confirmed after local removal.
   */
  @Remote
  logout(owner: SubscriptionClientId, provider: SubscriptionProvider): Promise<SubscriptionLogoutResult> {
    this.validateOwner(owner)
    return this.operation(() => this.auth.logout(owner, provider))
  }

  /**
   * @param owner - private browser-instance identifier.
   * @param signal - authenticated carrier subscription lifetime.
   * @returns current state and subsequent login or credential changes.
   */
  @Remote({ mode: 'stream' })
  async *watch(owner: SubscriptionClientId, signal: AbortSignal): AsyncIterable<AuthState> {
    this.validateOwner(owner)
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    const stopAuth = this.auth.subscribe(changed)
    const stopCredentials = this.ctx.on('credentials/record-updated', (key) => {
      if (key === 'llm-pi-ai/openai' || key === 'llm-pi-ai/openai-codex') changed()
    })
    combined.addEventListener('abort', changed, { once: true })
    try {
      while (!combined.aborted) {
        if (dirty) {
          dirty = false
          yield await this.operation(() => this.auth.status(owner))
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stopAuth()
      stopCredentials()
      combined.removeEventListener('abort', changed)
    }
  }

  private validateOwner(owner: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner)) {
      throw new RemoteError('chatgpt-subscription/rejected', 'Invalid browser identifier.', { reason: 'invalid-owner' })
    }
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      const reason = error instanceof SubscriptionError ? error.code : 'storage-failed'
      throw new RemoteError('chatgpt-subscription/rejected', 'The subscription operation could not be completed.', { reason })
    }
  }
}

export default ChatgptSubscriptionService
