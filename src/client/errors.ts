/** Translate fixed Host failure identities without presenting upstream exception text. */
import type { SubscriptionErrorCode } from '../auth.ts'
import type { SubscriptionKey } from './locales.ts'

/** @returns local copy for a known authorization failure. */
export function errorKey(code: SubscriptionErrorCode | undefined): SubscriptionKey {
  switch (code) {
    case 'LOGIN_BUSY': return 'loginBusy'
    case 'ATTEMPT_NOT_FOUND': case 'PROMPT_NOT_FOUND': case 'DISPOSED': return 'staleAttempt'
    case 'INVALID_ANSWER': return 'invalidAnswer'
    case 'STORAGE_FAILED': return 'storageFailed'
    case 'INSTALLATION_ID_INVALID': return 'installationFailed'
    case 'INVALID_CREDENTIAL': return 'reconnect'
    default: return 'signInFailed'
  }
}

/** @returns an actionable local message for the Remote error, or a generic retry message. */
export function actionErrorKey(error: unknown): SubscriptionKey {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'chatgpt-subscription/rejected'
    || !('details' in error) || typeof error.details !== 'object' || error.details === null || !('reason' in error.details)) return 'actionFailed'
  switch (error.details.reason) {
    case 'LOGIN_BUSY': case 'ATTEMPT_NOT_FOUND': case 'PROMPT_NOT_FOUND': case 'DISPOSED':
    case 'INVALID_ANSWER': case 'STORAGE_FAILED': case 'INSTALLATION_ID_INVALID': case 'INVALID_CREDENTIAL':
    case 'LOGIN_FAILED': case 'NOT_COMMITTED': return errorKey(error.details.reason)
    default: return 'actionFailed'
  }
}
