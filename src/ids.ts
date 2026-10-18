/** Opaque identities for browser-owned subscription authorization attempts. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One browser plugin instance; never persisted with credentials. */
export type SubscriptionClientId = Branded<'chatgpt-subscription.client'>
/** One pending or completed provider authorization. */
export type SubscriptionAttemptId = Branded<'chatgpt-subscription.attempt'>
/** One unanswered question within an authorization. */
export type SubscriptionPromptId = Branded<'chatgpt-subscription.prompt'>
