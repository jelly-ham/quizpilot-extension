import { loginWithGoogleToken } from '../lib/api';
import { t } from '../lib/i18n';

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

/** Google sign-in via launchWebAuthFlow (works in any Chromium, signed into Chrome or not). */
export async function googleLogin(): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error(t('err_googleNotConfigured'));
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email',
    nonce,
    prompt: 'select_account',
  }).toString();
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error(t('err_loginCancelled'));
  const idToken = new URLSearchParams(new URL(redirect).hash.slice(1)).get('id_token');
  if (!idToken) throw new Error(t('err_googleNoToken'));
  await loginWithGoogleToken(idToken, nonce);
}
