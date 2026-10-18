// @vitest-environment jsdom
/** Mount the real Client plugin through Cordis and its public Gateway namespace services. */
import { Context } from '@deepseek-ai/cordis'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubscriptionAttemptId, SubscriptionPromptId } from '../src/ids.ts'
import * as client from '../src/client/index.ts'
import type { AuthState } from '../src/auth.ts'
import type { SubscriptionCardInjected } from '../src/client/SubscriptionCard.tsx'

it('uses ordered stream state through its injected namespace and removes the stream before unmounting', async () => {
  const ctx = new Context()
  const view: AuthState = { accounts: [{ provider: 'openai', connected: false }, { provider: 'openai-codex', connected: false }] }
  let controls: SubscriptionCardInjected | undefined
  const requests: { endpoint: string; payload: unknown }[] = []
  const frames: Array<AuthState | Error> = []
  let wake: (() => void) | undefined
  const pendingStart = Promise.withResolvers<{ ok: true; value: AuthState }>()
  let activeStreams = 0
  const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
    requests.push({ endpoint, payload })
    if (endpoint === 'chatgptSubscription/start') return pendingStart.promise
    if (endpoint === 'chatgptSubscription/cancel') return { ok: true, value: undefined }
    return { ok: true, value: view }
  })
  ctx.provide('connection', {
    interactions: 'answer', isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    start: () => ({ stop() {} }), registerGenerationSource: () => () => {},
    rpc: {
      call,
      async *open(_channel: string, endpoint: string, payload: unknown, signal: AbortSignal) {
        requests.push({ endpoint, payload })
        activeStreams++
        try {
          yield view
          while (!signal.aborted) {
            const frame = frames.shift()
            if (frame instanceof Error) throw frame
            if (frame !== undefined) { yield frame; continue }
            await new Promise<void>(resolve => {
              const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; resolve() }
              wake = finish
              if (signal.aborted) finish()
              else signal.addEventListener('abort', finish, { once: true })
            })
          }
        } finally { activeStreams-- }
      },
    },
  })
  ctx.provide('locale', { register: () => () => {} })
  ctx.provide('slots', {
    inject: (_name: string, setup: () => () => void) => setup(),
    register: (options: { inject: () => SubscriptionCardInjected }) => {
      controls = options.inject()
      return () => {}
    },
  })
  try {
    await ctx.plugin(Registry)
    await ctx.plugin(Gateway)
    const fiber = ctx.plugin(client)
    await fiber
    await vi.waitFor(() => {
      expect(controls?.hooks.subscription.getSnapshot()).toEqual({ view, failed: false })
    })
    expect(ctx.typert.remotes.list()).toHaveLength(6)
    expect(requests[0]).toMatchObject({ endpoint: 'chatgptSubscription/watch', payload: { args: { owner: expect.any(String) } } })
    if (controls === undefined) throw new Error('The provider controls were not registered')
    await controls.retry()
    await vi.waitFor(() => expect(requests.filter(request => request.endpoint === 'chatgptSubscription/watch')).toHaveLength(2))
    expect(call).not.toHaveBeenCalled()
    const starting = controls.start('openai')
    await vi.waitFor(() => expect(requests.some(request => request.endpoint === 'chatgptSubscription/start')).toBe(true))
    const ready: AuthState = { ...view, attempt: {
      id: brandString<SubscriptionAttemptId>('attempt'), provider: 'openai', state: 'running',
      notice: { message: 'Continue', url: 'https://auth.openai.com/authorize' },
      prompt: { id: brandString<SubscriptionPromptId>('prompt'), kind: 'secret', message: 'Paste callback' },
    } }
    frames.push(ready)
    wake?.()
    await vi.waitFor(() => expect(controls?.hooks.subscription.getSnapshot().view).toEqual(ready))
    pendingStart.resolve({ ok: true, value: { ...view, attempt: {
      id: ready.attempt!.id, provider: 'openai', state: 'running',
    } } })
    await starting
    expect(controls.hooks.subscription.getSnapshot().view).toEqual(ready)
    frames.push(new Error('The logical stream failed'))
    wake?.()
    await vi.waitFor(() => expect(controls?.hooks.subscription.getSnapshot().failed).toBe(true))
    await controls.retry()
    await vi.waitFor(() => expect(controls?.hooks.subscription.getSnapshot().failed).toBe(false))
    await fiber.dispose()
    expect(activeStreams).toBe(0)
    expect(ctx.typert.remotes.list()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
