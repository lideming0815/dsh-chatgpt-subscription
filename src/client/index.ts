/** Client companion mounted in the existing pi-ai provider settings cards. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import subscriptionRemote from 'dsh-chatgpt-subscription/remote'
import type { AuthState } from '../auth.ts'
import type { SubscriptionClientId } from '../ids.ts'
import { SubscriptionCard, type SubscriptionCardInjected, type SubscriptionSnapshot } from './SubscriptionCard.tsx'
import { en, zh } from './locales.ts'

/** Only base services are required before mounting this package's Remote contribution. */
export const inject = ['remote', 'slots', 'locale']

/** Register the subscription controls and dispose their Remote stream before unmounting its namespace. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(subscriptionRemote)
  const follow = ctx.inject(['remote.chatgptSubscription'], (ctx) => {
    ctx.effect(() => ctx.locale.register('chatgpt-subscription', { en, zh }), 'ChatGPT subscription: dictionaries')
    const owner = brandString<SubscriptionClientId>(crypto.randomUUID())
    let disposed = false
    let snapshot: SubscriptionSnapshot = { view: undefined, failed: false }
    const listeners = new Set<() => void>()
    const publish = (view: AuthState) => {
      if (disposed) return
      snapshot = { view, failed: false }
      for (const listener of listeners) listener()
    }
    const source = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const openStream = () => ctx.remote.$stream<AuthState>({
      name: 'chatgpt-subscription',
      open: signal => ctx.remote.chatgptSubscription.watch(owner, signal),
      ended: () => new Error('ChatGPT subscription status stream ended'),
    })
    let stream = openStream()
    ctx.effect(() => async () => {
      disposed = true
      const attempt = snapshot.view?.attempt
      if (attempt?.state === 'running') {
        try { await ctx.remote.chatgptSubscription.cancel(owner, attempt.id) }
        catch (_error) { /* A disconnected Host bounds the remaining attempt with its login timeout. */ }
      }
      await stream.dispose()
      listeners.clear()
    }, 'ChatGPT subscription: status stream')
    const consume = (current: typeof stream) => {
      void (async () => {
        for await (const frame of current) {
          publish(frame.value)
          frame.accept()
        }
      })().catch((_error: unknown) => {
        if (disposed || stream !== current) return
        snapshot = { ...snapshot, failed: true }
        for (const listener of listeners) listener()
      })
    }
    consume(stream)
    // An RPC reply can arrive after a newer watch frame; only the stream publishes state.
    const operations: SubscriptionCardInjected = {
      hooks: { subscription: source },
      async start(provider) {
        const result = await ctx.remote.chatgptSubscription.start(owner, provider)
        if (!result.ok) throw result.error
      },
      async answer(attemptId, promptId, value) {
        const result = await ctx.remote.chatgptSubscription.answer(owner, attemptId, promptId, value)
        if (!result.ok) throw result.error
      },
      async cancel(attemptId) {
        const result = await ctx.remote.chatgptSubscription.cancel(owner, attemptId)
        if (!result.ok) throw result.error
      },
      async logout(provider) {
        const result = await ctx.remote.chatgptSubscription.logout(owner, provider)
        if (!result.ok) throw result.error
        return result.value
      },
      async retry() {
        if (!snapshot.failed) { stream.restart(); return }
        const previous = stream
        await previous.dispose()
        if (disposed || stream !== previous) return
        stream = openStream()
        consume(stream)
      },
    }
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card', key: 'llm-pi-ai', locale: 'chatgpt-subscription', inject: () => operations,
    }, SubscriptionCard))
  })
  return async () => {
    await follow.dispose()
    await unmount()
  }
}
