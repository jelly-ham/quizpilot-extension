import type {
  CreditPack,
  MarkRequest,
  MarkResponse,
  ReadRequest,
  ReadResponse,
  SolveRequest,
  SolveResponse,
} from '@quizpilot/shared';
import { t, uiLang } from './i18n';

export const API_BASE = import.meta.env.VITE_API_BASE;

/** Error returned by our API: { error: code, message, ...extra }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- stored login

export interface AuthState {
  accessToken: string;
  /** epoch ms */
  accessExpiresAt: number;
  refreshToken: string;
  user: { id: string; email: string };
}

/** Whether a new account got the signup credits (see the Worker's auth/signup.ts). */
export interface SignupGrant {
  credits: number;
  reason?: 'disposable' | 'email_used' | 'device_used' | 'ip_limit' | 'daily_cap';
}

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user?: { id: string; email: string };
  /** Only on the login that created the account. */
  grant?: SignupGrant;
}

const INSTALL_KEY = 'installId';
const GRANT_KEY = 'signupGrant';

/** Random id kept for this install; the server limits signup credits per install. */
async function installId(): Promise<string> {
  const cur = (await chrome.storage.local.get(INSTALL_KEY))[INSTALL_KEY] as string | undefined;
  if (cur) return cur;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_KEY]: id });
  return id;
}

/** Kept until the user signs out, so the popup can say why a new account got no credits. */
export async function getSignupGrant(): Promise<SignupGrant | null> {
  return (
    ((await chrome.storage.local.get(GRANT_KEY))[GRANT_KEY] as SignupGrant | undefined) ?? null
  );
}

async function loggedIn(t: TokenResponse): Promise<AuthState> {
  if (t.grant) await chrome.storage.local.set({ [GRANT_KEY]: t.grant });
  return saveTokens(t, t.user!);
}

const AUTH_KEY = 'auth';
const LOCK = 'quizpilot-auth';
const SKEW_MS = 30_000;

export async function getAuth(): Promise<AuthState | null> {
  return ((await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] as AuthState | undefined) ?? null;
}

async function saveTokens(t: TokenResponse, user: AuthState['user']): Promise<AuthState> {
  const state: AuthState = {
    accessToken: t.accessToken,
    accessExpiresAt: Date.now() + t.expiresIn * 1000,
    refreshToken: t.refreshToken,
    user,
  };
  await chrome.storage.local.set({ [AUTH_KEY]: state });
  return state;
}

export async function clearAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

/**
 * Refresh tokens rotate, and replaying an old one revokes the session. The popup, options page and
 * service worker share one origin, so a Web Lock keeps them from refreshing at the same time.
 */
async function refresh(stale: string | null): Promise<AuthState | null> {
  return navigator.locks.request(LOCK, async () => {
    const cur = await getAuth();
    if (!cur) return null;
    // Another context refreshed while we waited.
    if (cur.accessToken !== stale && cur.accessExpiresAt - SKEW_MS > Date.now()) return cur;
    const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: cur.refreshToken }),
    });
    if (res.status === 401) {
      await clearAuth();
      return null;
    }
    if (!res.ok)
      throw new ApiError(res.status, 'refresh_failed', `refresh failed: HTTP ${res.status}`);
    return saveTokens((await res.json()) as TokenResponse, cur.user);
  });
}

async function accessToken(): Promise<string | null> {
  const cur = await getAuth();
  if (!cur) return null;
  if (cur.accessExpiresAt - SKEW_MS > Date.now()) return cur.accessToken;
  return (await refresh(cur.accessToken))?.accessToken ?? null;
}

// ---------------------------------------------------------------- requests

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = async (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });

  let token: string | null = null;
  if (opts.auth) {
    token = await accessToken();
    if (!token) throw new ApiError(401, 'not_logged_in', t('err_loginFirst'));
  }
  let res = await send(token);
  if (res.status === 401 && opts.auth) {
    token = (await refresh(token))?.accessToken ?? null;
    if (!token) throw new ApiError(401, 'not_logged_in', t('err_sessionExpired'));
    res = await send(token);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body.error ?? 'http_error'),
      String(body.message ?? body.error ?? `HTTP ${res.status}`),
      body,
    );
  }
  return body as T;
}

export interface DebugReport {
  log: string;
  note?: string;
  contact?: string;
  site?: string;
  version?: string;
}

/** Emails a debug log to support. Works signed out; signed in, support can reply to the account. */
export async function sendDebugReport(report: DebugReport): Promise<void> {
  const token = await accessToken().catch(() => null);
  const res = await fetch(`${API_BASE}/v1/support/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      String(body.error ?? 'http_error'),
      String(body.message ?? body.error ?? `HTTP ${res.status}`),
      body,
    );
  }
}

export async function checkApiHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/v1/health`, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- endpoints

export async function startEmailLogin(email: string): Promise<{ devCode?: string }> {
  return apiRequest('/v1/auth/email/start', { body: { email, lang: uiLang() } });
}

export async function verifyEmailLogin(email: string, code: string): Promise<AuthState> {
  const t = await apiRequest<TokenResponse>('/v1/auth/email/verify', {
    body: { email, code, installId: await installId() },
  });
  return loggedIn(t);
}

export async function loginWithGoogleToken(idToken: string, nonce: string): Promise<AuthState> {
  const t = await apiRequest<TokenResponse>('/v1/auth/google', {
    body: { idToken, nonce, installId: await installId() },
  });
  return loggedIn(t);
}

export async function logout() {
  const cur = await getAuth();
  await clearAuth();
  await chrome.storage.local.remove(GRANT_KEY);
  if (cur)
    await apiRequest('/v1/auth/logout', { body: { refreshToken: cur.refreshToken } }).catch(
      () => {},
    );
}

export interface Me {
  user: { id: string; email: string; status: 'active' | 'frozen' | 'deleted' };
  balance: number;
}

export const getMe = () => apiRequest<Me>('/v1/me', { auth: true });
/** paymentsEnabled is false while top-ups aren't open yet (absent on older servers: open). */
export const getPacks = () =>
  apiRequest<{ packs: CreditPack[]; paymentsEnabled?: boolean }>('/v1/billing/packs');
export const createCheckout = (packId: string) =>
  apiRequest<{ url: string }>('/v1/billing/checkout', {
    body: { packId, lang: uiLang() },
    auth: true,
  });
export const solveRemote = (req: SolveRequest, signal?: AbortSignal) =>
  apiRequest<SolveResponse>('/v1/solve', { body: req, auth: true, signal });
export const markRemote = (req: MarkRequest, signal?: AbortSignal) =>
  apiRequest<MarkResponse>('/v1/mark', { body: req, auth: true, signal });
export const readRemote = (req: ReadRequest, signal?: AbortSignal) =>
  apiRequest<ReadResponse>('/v1/read', { body: req, auth: true, signal });

export interface UsageHistory {
  usage: {
    request_id: string;
    provider: string;
    model: string;
    question_count: number;
    credits: number;
    page_host: string | null;
    created_at: number;
  }[];
  ledger: {
    kind: 'topup' | 'grant' | 'charge' | 'refund';
    delta: number;
    ref: string;
    created_at: number;
  }[];
  /** Rows in all, for paging (servers before paging leave these out). */
  usageTotal?: number;
  ledgerTotal?: number;
}

/** One page of one history list, newest first. */
export const getUsage = (only: 'usage' | 'ledger', offset = 0, limit = 10) =>
  apiRequest<UsageHistory>(`/v1/usage?only=${only}&offset=${offset}&limit=${limit}`, {
    auth: true,
  });
