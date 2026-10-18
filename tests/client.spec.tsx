// @vitest-environment jsdom
/** Subscription controls keep login input outside the model and persisted UI state. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubscriptionAttemptId, SubscriptionPromptId } from '../src/ids.ts'
import type { SubscriptionCardProps, SubscriptionSnapshot } from '../src/client/SubscriptionCard.tsx'
import { SubscriptionCard } from '../src/client/SubscriptionCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function props(snapshot: SubscriptionSnapshot): SubscriptionCardProps {
  return {
    provider: { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    configured: true,
    keyConfigured: false,
    t: key => en[key],
    useSubscription: selector => selector(snapshot),
    start: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    logout: vi.fn(async () => ({ remoteRevocation: 'confirmed' as const })),
    retry: vi.fn(async () => undefined),
  }
}

describe('subscription provider controls', () => {
  it('offers login only for the two OpenAI routes and keeps loading disabled', () => {
    const input = props({ view: undefined, failed: false })
    const view = render(<SubscriptionCard {...input} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.signIn }).disabled).toBe(true)
    view.rerender(<SubscriptionCard {...input} provider={{ ...input.provider, provider: 'anthropic' }} />)
    expect(screen.queryByRole('region', { name: en.title })).toBeNull()
  })

  it.each(['openai', 'openai-codex'] as const)('starts the selected %s route directly', async provider => {
    const input = props({ view: { accounts: [{ provider, connected: false }] }, failed: false })
    input.provider = { ...input.provider, provider }
    render(<SubscriptionCard {...input} />)
    expect(screen.getByRole('region', { name: provider === 'openai-codex' ? en.titleLegacy : en.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    await waitFor(() => expect(input.start).toHaveBeenCalledWith(provider))
  })

  it('masks callback input, clears it before sending, and forgets it when a prompt changes', async () => {
    const snapshot: SubscriptionSnapshot = {
      view: {
        accounts: [{ provider: 'openai', connected: false }],
        attempt: {
          id: brandString<SubscriptionAttemptId>('attempt'), provider: 'openai', state: 'running',
          notice: { message: 'Continue', url: 'https://auth.openai.com/authorize' },
          prompt: { id: brandString<SubscriptionPromptId>('prompt-1'), kind: 'secret', message: 'Paste callback' },
        },
      },
      failed: false,
    }
    const input = props(snapshot)
    const mounted = render(<SubscriptionCard {...input} />)
    const field = screen.getByLabelText<HTMLInputElement>('Paste callback')
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('off')
    fireEvent.change(field, { target: { value: 'http://127.0.0.1/auth/callback?code=sensitive' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    expect(field.value).toBe('')
    await waitFor(() => expect(input.answer).toHaveBeenCalledWith('attempt', 'prompt-1', 'http://127.0.0.1/auth/callback?code=sensitive'))
    fireEvent.change(field, { target: { value: 'unsent' } })
    const next = props({ ...snapshot, view: { ...snapshot.view!, attempt: {
      ...snapshot.view!.attempt!, prompt: { id: brandString<SubscriptionPromptId>('prompt-2'), kind: 'secret', message: 'New callback' },
    } } })
    mounted.rerender(<SubscriptionCard {...next} />)
    expect(screen.getByLabelText<HTMLInputElement>('New callback').value).toBe('')
    expect(document.body.textContent).not.toContain('sensitive')
    const link = screen.getByRole<HTMLAnchorElement>('link', { name: en.openBrowser })
    expect(link.rel).toBe('noopener noreferrer')
  })

  it('keeps a connection visible on failure and offers retry without exposing error details', async () => {
    const input = props({ view: { accounts: [{ provider: 'openai', connected: true }] }, failed: true })
    input.retry = vi.fn(async () => { throw new Error('secret upstream details') })
    render(<SubscriptionCard {...input} />)
    expect(screen.getByText(en.connected)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(screen.getByText(en.actionFailed)).toBeTruthy())
    expect(document.body.textContent).not.toContain('secret upstream details')
  })

  it('ends the loading announcement when the first status read fails', () => {
    render(<SubscriptionCard {...props({ view: undefined, failed: true })} />)
    expect(screen.getByRole('region', { name: en.title }).getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe(en.statusUnknown)
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it('reports local disconnection when the issuer did not confirm revocation', async () => {
    const input = props({ view: { accounts: [{ provider: 'openai', connected: true }] }, failed: false })
    input.logout = vi.fn(async () => ({ remoteRevocation: 'unconfirmed' as const }))
    render(<SubscriptionCard {...input} />)
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    await waitFor(() => expect(screen.getByText(en.localSignOut)).toBeTruthy())
    expect(input.logout).toHaveBeenCalledWith('openai')
  })

  it('asks to reconnect an invalid saved grant without treating ordinary token expiry as failure', () => {
    const input = props({ view: { accounts: [{ provider: 'openai', connected: false, error: 'INVALID_CREDENTIAL' }] }, failed: false })
    const mounted = render(<SubscriptionCard {...input} />)
    expect(screen.getByText(en.reconnect)).toBeTruthy()
    const expired = props({ view: { accounts: [{ provider: 'openai', connected: true, expiresAt: 1 }] }, failed: false })
    mounted.rerender(<SubscriptionCard {...expired} />)
    expect(screen.getByText(en.connected)).toBeTruthy()
    expect(screen.queryByText(en.reconnect)).toBeNull()
  })

  it('explains an already-running login using the fixed failure code', async () => {
    const input = props({ view: { accounts: [{ provider: 'openai', connected: false }] }, failed: false })
    input.start = vi.fn(async () => { throw { code: 'chatgpt-subscription/rejected', details: { reason: 'LOGIN_BUSY' }, message: 'sensitive response' } })
    render(<SubscriptionCard {...input} />)
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(en.loginBusy))
    expect(document.body.textContent).not.toContain('sensitive response')
  })
})
