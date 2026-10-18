/** ChatGPT sign-in controls rendered inside the existing provider card. */
import { useId, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { AuthState, SubscriptionProvider, SubscriptionPrompt, SubscriptionLogoutResult } from '../auth.ts'
import type { SubscriptionAttemptId, SubscriptionPromptId } from '../ids.ts'
import type { SubscriptionKey } from './locales.ts'
import { actionErrorKey, errorKey } from './errors.ts'
import css from './SubscriptionCard.module.css'

/** Client-owned transport state; OAuth credentials never enter this snapshot. */
export interface SubscriptionSnapshot {
  view: AuthState | undefined
  failed: boolean
}

/** Host actions and observable source bound by the slot renderer. */
export interface SubscriptionCardInjected {
  hooks: { subscription: HostObservable<SubscriptionSnapshot> }
  start(provider: SubscriptionProvider): Promise<void>
  answer(attemptId: SubscriptionAttemptId, promptId: SubscriptionPromptId, value: string): Promise<void>
  cancel(attemptId: SubscriptionAttemptId): Promise<void>
  logout(provider: SubscriptionProvider): Promise<SubscriptionLogoutResult>
  retry(): Promise<void>
}

/** Provider owner, localization, and callbacks supplied through the slot. */
export type SubscriptionCardProps = PropsRuntime<'settings.models.provider-card'>
  & PropsLocale<'chatgpt-subscription'> & InjectFace<SubscriptionCardInjected>

interface PromptProps {
  prompt: SubscriptionPrompt
  busy: boolean
  t: (key: SubscriptionKey) => string
  submit(value: string): Promise<void>
}

function Prompt({ prompt, busy, t, submit }: PromptProps) {
  const [value, setValue] = useState('')
  const id = useId()
  if (prompt.kind === 'select') return <div className={css.prompt}>
    <span>{prompt.message || t('choose')}</span>
    <div className={css.actions}>
      {prompt.options?.map(option => <Button key={option.id} variant="outline" disabled={busy}
        onClick={() => { void submit(option.id) }}>{option.label}</Button>)}
    </div>
  </div>
  return <form className={css.prompt} onSubmit={event => {
    event.preventDefault()
    const answer = value
    setValue('')
    void submit(answer)
  }}>
    <label className={css.field} htmlFor={id}>
      <span>{prompt.message || t('callback')}</span>
      <Input id={id} className={css.input} type="password" value={value}
        autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32768}
        aria-describedby={`${id}-hint`} disabled={busy}
        onChange={event => { setValue(event.target.value) }} />
    </label>
    <p id={`${id}-hint`} className={css.hint}>{t('callbackHint')}</p>
    <div className={css.actions}>
      <Button variant="outline" type="submit" disabled={busy || value.trim() === ''}>{t('submit')}</Button>
    </div>
  </form>
}

/** Render a sign-in flow for an OpenAI route, leaving every other card untouched. */
export function SubscriptionCard(props: SubscriptionCardProps) {
  const { t, provider, configured, keyConfigured, useSubscription } = props
  const { view, failed } = useSubscription(value => value)
  const [busy, setBusy] = useState(false)
  const [actionFailure, setActionFailure] = useState<SubscriptionKey | undefined>()
  const [localSignOut, setLocalSignOut] = useState(false)
  const route = provider.provider
  if (route !== 'openai' && route !== 'openai-codex') return null
  const account = view?.accounts.find(entry => entry.provider === route)
  const needsSignIn = account?.error === 'INVALID_CREDENTIAL'
  const statusFailed = failed || account?.error === 'STORAGE_FAILED'
  const attempt = view?.attempt?.provider === route ? view.attempt : undefined
  const prompt = attempt?.prompt
  const active = attempt?.state === 'running'
  const connected = account?.connected === true
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setActionFailure(undefined)
    setLocalSignOut(false)
    try { await action() } catch (error) { setActionFailure(actionErrorKey(error)) } finally { setBusy(false) }
  }
  const status = view === undefined ? t(statusFailed ? 'statusUnknown' : 'loading') : active ? t(attempt.notice?.url === undefined ? 'completing' : 'waiting')
    : needsSignIn ? t('reconnect') : connected ? t('connected') : t('signedOut')
  const title = t(route === 'openai-codex' ? 'titleLegacy' : 'title')
  return <section className={css.section} aria-label={title} aria-busy={busy || view === undefined && !statusFailed}>
    <div className={css.row}>
      <div className={css.copy}>
        <span className={css.title}>{title}</span>
        <p className={css.status} role="status">{status}</p>
      </div>
      <div className={css.actions}>
        {active
          ? <Button variant="outline" disabled={busy} onClick={() => { void run(() => props.cancel(attempt.id)) }}>{t('cancel')}</Button>
          : <>
            <Button variant={connected ? 'outline' : 'primary'} disabled={busy || view === undefined || statusFailed}
              onClick={() => { void run(() => props.start(route)) }}>{t(busy ? 'signingIn' : 'signIn')}</Button>
            {connected && <Button variant="ghost" disabled={busy} onClick={() => {
              void run(async () => {
                const result = await props.logout(route)
                setLocalSignOut(result.remoteRevocation !== 'confirmed')
              })
            }}>{t('signOut')}</Button>}
          </>}
      </div>
    </div>
    {active && attempt.notice?.url !== undefined && <a className={css.link} href={attempt.notice.url}
      target="_blank" rel="noopener noreferrer">{t('openBrowser')}</a>}
    {active && attempt.notice?.code !== undefined && <p className={css.status}>
      {t('code')}: <code className={css.code}>{attempt.notice.code}</code>
    </p>}
    {active && prompt !== undefined && <Prompt key={prompt.id} prompt={prompt} t={t} busy={busy}
      submit={value => run(() => props.answer(attempt.id, prompt.id, value))} />}
    {connected && !configured && <p className={css.hint}>{t('saveProvider')}</p>}
    {connected && keyConfigured && <p className={css.hint}>{t('keyOverride')}</p>}
    {localSignOut && <p className={css.hint} role="status">{t('localSignOut')}</p>}
    {(actionFailure !== undefined || attempt?.state === 'failed') && <p className={css.error} role="alert">{t(actionFailure ?? errorKey(attempt?.error))}</p>}
    {statusFailed && <div className={css.row}>
      <p className={css.error} role="alert">{t('loadFailed')}</p>
      <Button variant="outline" disabled={busy} onClick={() => { void run(props.retry) }}>{t('retry')}</Button>
    </div>}
  </section>
}
