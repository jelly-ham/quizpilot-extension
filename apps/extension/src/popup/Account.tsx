import {
  formatQuestions,
  formatQuestionsLeft,
  SolveTier,
  type CreditPack,
} from '@quizpilot/shared';
import { useEffect, useState } from 'preact/hooks';
import {
  ApiError,
  createCheckout,
  getAuth,
  getMe,
  getPacks,
  getSignupGrant,
  logout,
  startEmailLogin,
  verifyEmailLogin,
  type AuthState,
  type Me,
  type SignupGrant,
} from '../lib/api';
import { apiErrorMessage } from '../lib/messages';
import { t } from '../lib/i18n';
import type { RuntimeMessage } from '../lib/protocol';

const GOOGLE_ENABLED = !!import.meta.env.VITE_GOOGLE_CLIENT_ID;

/**
 * Login state for paid mode; `onReady` tells the parent whether solving is possible. Amounts are
 * shown as questions of `tier`, the answer mode picked in the popup.
 */
export function Account({ tier, onReady }: { tier: SolveTier; onReady(ready: boolean): void }) {
  const [auth, setAuth] = useState<AuthState | null | undefined>(undefined);

  useEffect(() => {
    getAuth().then(setAuth);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'auth' in changes)
        setAuth((changes.auth!.newValue as AuthState | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => onReady(!!auth), [auth]);

  if (auth === undefined) return null;
  return auth ? <Wallet auth={auth} tier={tier} /> : <Login />;
}

function Wallet({ auth, tier }: { auth: AuthState; tier: SolveTier }) {
  const [me, setMe] = useState<Me | null>(null);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [grant, setGrant] = useState<SignupGrant | null>(null);

  useEffect(() => {
    getSignupGrant().then(setGrant);
    getMe().then(setMe, (e) => setError(describe(e)));
    getPacks().then(
      (r) => setPacks(r.packs),
      () => {},
    );
  }, [auth.user.id]);

  async function buy(pack: CreditPack) {
    setBusy(pack.id);
    setError('');
    try {
      const { url } = await createCheckout(pack.id);
      await chrome.tabs.create({ url });
      window.close();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="account wallet">
      <div class="account-row">
        <span class="email" title={auth.user.email}>
          {auth.user.email}
        </span>
        <button class="link" onClick={() => logout()}>
          {t('acc_logout')}
        </button>
      </div>
      <div class="balance">
        <span class="balance-num mono">{me ? formatQuestionsLeft(me.balance, tier) : '—'}</span>
        <span class="muted">{t('acc_questions', { tier: t(`tier_${tier}`) })}</span>
        {me?.user.status === 'frozen' && <span class="warn">{t('acc_frozen')}</span>}
      </div>
      {packs.length > 0 && (
        <div class="packs">
          {packs.map((p) => (
            <button class="pack" disabled={busy !== null} onClick={() => buy(p)}>
              <strong>${(p.priceCents / 100).toFixed(0)}</strong>
              {busy === p.id ? (
                <span>{t('acc_redirecting')}</span>
              ) : (
                SolveTier.options.map((m) => (
                  <span class={m === tier ? 'current' : ''}>
                    {t('acc_packTier', { tier: t(`tier_${m}`), n: formatQuestions(p.credits, m) })}
                  </span>
                ))
              )}
            </button>
          ))}
        </div>
      )}
      {grant && (
        <p class="muted">
          {grant.credits > 0
            ? t('grant_ok', {
                n: formatQuestions(grant.credits),
                m: formatQuestions(grant.credits, 'accurate'),
              })
            : t(`grant_${grant.reason ?? 'daily_cap'}`)}
        </p>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

function Login() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  const send = () =>
    run(async () => {
      const r = await startEmailLogin(email);
      setStep('code');
      if (r.devCode) {
        setDevCode(r.devCode);
        setCode(r.devCode);
      }
    });

  const verify = () => run(async () => void (await verifyEmailLogin(email, code)));

  const google = () =>
    run(async () => {
      const r = (await chrome.runtime.sendMessage({
        type: 'qp:google-login',
      } satisfies RuntimeMessage)) as {
        ok: boolean;
        error?: string;
      };
      if (!r.ok) throw new Error(r.error);
    });

  return (
    <section class="account card">
      {step === 'email' ? (
        <form class="login" onSubmit={(e) => (e.preventDefault(), send())}>
          <label for="qp-email">{t('acc_email')}</label>
          <input
            id="qp-email"
            name="email"
            type="email"
            autocomplete="username"
            enterKeyHint="send"
            placeholder="you@example.com"
            value={email}
            required
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
          <button class="primary" disabled={busy || !email}>
            {t('acc_sendCode')}
          </button>
        </form>
      ) : (
        <form class="login" onSubmit={(e) => (e.preventDefault(), verify())}>
          <label for="qp-code">{t('acc_codeLabel', { email })}</label>
          <input
            id="qp-code"
            name="code"
            autocomplete="one-time-code"
            inputMode="numeric"
            enterKeyHint="done"
            pattern="\d{6}"
            placeholder={t('acc_codePlaceholder')}
            maxLength={6}
            required
            value={code}
            autoFocus
            onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
          />
          <button class="primary" disabled={busy || code.length !== 6}>
            {t('acc_login')}
          </button>
          <button type="button" class="link" onClick={() => setStep('email')}>
            {t('acc_changeEmail')}
          </button>
        </form>
      )}
      {devCode && <p class="muted">{t('acc_devCode', { code: devCode })}</p>}
      {GOOGLE_ENABLED && step === 'email' && (
        <button class="secondary" disabled={busy} onClick={google}>
          {t('acc_google')}
        </button>
      )}
      {error && <p class="error">{error}</p>}
      <p class="muted">{t('acc_grant')}</p>
    </section>
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiError)
    return e.code === 'bad_request' ? t('acc_invalidEmail') : apiErrorMessage(e);
  if (e instanceof TypeError) return t('acc_offline');
  return (e as Error).message;
}
