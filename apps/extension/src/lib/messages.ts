import type { AnswerError } from '@quizpilot/shared';
import type { ApiError } from './api';
import { t } from './i18n';

/** User-facing text for an error from our API. Unknown codes fall back to the server message. */
export function apiErrorMessage(e: ApiError): string {
  switch (e.code) {
    case 'insufficient_credits':
      return t('err_insufficient', {
        required: String(e.body.required ?? '?'),
        balance: String(e.body.balance ?? 0),
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
      return t('acc_paymentsSoon');
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
