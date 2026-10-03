import {
  formatQuestions,
  formatQuestionsLeft,
  type AnswerError,
  type SolveTier,
} from '@quizpilot/shared';
import type { ApiError } from './api';
import { t } from './i18n';

/**
 * User-facing text for an error from our API. Unknown codes fall back to the server message.
 * Amounts are shown as questions of `tier`, the mode the request ran in.
 */
export function apiErrorMessage(e: ApiError, tier: SolveTier = 'fast'): string {
  switch (e.code) {
    case 'insufficient_credits':
      return t('err_insufficient', {
        // The API counts credits; users see questions of the mode they picked.
        tier: t(`tier_${tier}`),
        required: e.body.required == null ? '?' : formatQuestions(Number(e.body.required), tier),
        balance: formatQuestionsLeft(Number(e.body.balance ?? 0), tier),
      });
    case 'not_logged_in':
    case 'unauthorized':
    case 'invalid_token':
    case 'invalid_session':
      return t('err_loginExpired');
    case 'account_frozen':
      return t('err_frozen');
    case 'rate_limited':
      return t('err_rateLimited');
    case 'invalid_code':
      return t('err_invalidCode');
    case 'too_many_attempts':
      return t('err_tooManyAttempts');
    case 'otp_cooldown':
      return t('err_otpCooldown', { s: String(e.body.retryAfter ?? 60) });
    case 'needs_vision':
      return t('err_serverVision');
    case 'billing_disabled':
      return t('err_billingUnavailable');
    default:
      return e.message;
  }
}

/** User-facing text for one question's failure. */
export function answerErrorMessage(e: AnswerError): string {
  switch (e.code) {
    case 'needs_vision':
      return t('err_needsVision');
    case 'unsupported':
      return t('err_unsupported');
    case 'auth':
      return t('err_auth');
    case 'rate_limit':
    case 'overloaded':
      return t('err_busy');
    case 'timeout':
      return t('err_timeout');
    default:
      return t('err_model', { msg: e.message });
  }
}
