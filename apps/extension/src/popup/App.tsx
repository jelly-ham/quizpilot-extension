import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { checkApiHealth } from '../lib/api';
import { buildLabel } from '../lib/debug';
import { t } from '../lib/i18n';
import { Logo, Wordmark } from '../lib/Logo';
import type { RunMode, RuntimeMessage } from '../lib/protocol';
import { getSettings, updateSettings, type Mode, type Settings } from '../lib/settings';
import { getShortcuts, openShortcutSettings } from '../lib/shortcuts';
import { Account } from './Account';

type ApiStatus = 'checking' | 'online' | 'offline';

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [api, setApi] = useState<ApiStatus>('checking');
  const [loggedIn, setLoggedIn] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    getSettings().then(setSettings);
    getShortcuts().then(setKeys);
    const ctrl = new AbortController();
    checkApiHealth(ctrl.signal).then((ok) => setApi(ok ? 'online' : 'offline'));
    return () => ctrl.abort();
  }, []);

  async function selectMode(next: Mode) {
    setSettings(await updateSettings({ mode: next }));
  }

  async function run(mode: RunMode) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.runtime.sendMessage({
      type: 'qp:run',
      mode,
      tabId: tab.id,
    } satisfies RuntimeMessage);
    window.close();
  }

  const mode = settings?.mode ?? null;
  const providers = settings?.byok.providers ?? [];
  const byokReady = providers.length > 0;
  const hasVision = providers.some((p) => p.type === 'openai-compatible' && p.vision);
  const ready = mode === 'byok' ? byokReady : mode === 'paid' && loggedIn;
  const noVision = mode === 'byok' && !hasVision;

  return (
    <main class="popup">
      <header class="header">
        <div class="brand">
          <Logo size={28} />
          <h1>
            <Wordmark />
          </h1>
        </div>
        {mode === 'paid' && (
          <span class={`pill status-${api}`} role="status">
            {t(`apiStatus_${api}`)}
          </span>
        )}
        {mode === 'byok' && (
          <span class="pill" title={t('mode_byok_hint')}>
            <LockIcon />
            {t('popup_local')}
          </span>
        )}
      </header>

      <fieldset class="mode" disabled={mode === null}>
        <legend class="sr-only">{t('modeLabel')}</legend>
        {(['byok', 'paid'] as const).map((m) => (
          <label key={m} class={mode === m ? 'selected' : ''} title={t(`mode_${m}_hint`)}>
            <input
              type="radio"
              name="mode"
              value={m}
              checked={mode === m}
              onChange={() => selectMode(m)}
            />
            {t(`mode_${m}`)}
          </label>
        ))}
      </fieldset>

      {mode === 'byok' &&
        (byokReady ? (
          <section class="card models">
            <div class="card-head">
              <span>{t('popup_models')}</span>
              <button class="link" onClick={() => chrome.runtime.openOptionsPage()}>
                {t('popup_change')}
              </button>
            </div>
            <ModelLine
              label={t('popup_choice')}
              id={settings!.byok.routing.choice ?? providers[0]!.id}
            />
            <ModelLine
              label={t('popup_text')}
              id={
                settings!.byok.routing.text ??
                (providers.find((p) => p.type !== 'jev') ?? providers[0]!).id
              }
            />
            <p class="fine">{t('popup_keyLocal')}</p>
          </section>
        ) : (
          <section class="card notice">
            <span>{t('byokNotConfigured')}</span>
            <button class="link" onClick={() => chrome.runtime.openOptionsPage()}>
              {t('openOptions')}
            </button>
          </section>
        ))}

      {mode === 'paid' && <Account onReady={setLoggedIn} />}

      <div class="actions">
        <button
          class="primary run"
          disabled={!ready}
          title={keys['solve-page'] ? t('ui_shortcut', { keys: keys['solve-page'] }) : undefined}
          onClick={() => run('page')}
        >
          <CheckIcon />
          <span>{t('solvePage')}</span>
          {keys['solve-page'] && <kbd>{keys['solve-page']}</kbd>}
        </button>
        <div class="list">
          <Action
            icon={<AssistIcon />}
            accent
            title={t('solveAssist')}
            desc={t('act_assistDesc')}
            hint={t('solveAssistHint')}
            keys={keys['solve-assist']}
            disabled={!ready}
            onClick={() => run('assist')}
          />
          <Action
            icon={<NextIcon />}
            title={t('solveAuto')}
            desc={t('act_autoDesc')}
            hint={t('solveAutoHint')}
            keys={keys['solve-auto']}
            disabled={!ready}
            onClick={() => run('auto')}
          />
          <Action
            icon={<RegionIcon />}
            title={t('solveRegion')}
            desc={noVision ? t('regionHint') : t('act_regionDesc')}
            keys={keys['solve-region']}
            disabled={!ready || noVision}
            onClick={() => run('region')}
          />
          <Action
            icon={<RelearnIcon />}
            title={t('relearnPage')}
            desc={noVision ? t('regionHint') : t('act_learnDesc')}
            hint={t('relearnHint')}
            keys={keys['relearn-page']}
            disabled={!ready || noVision}
            onClick={() => run('learn')}
          />
        </div>
        {mode === 'byok' && (
          <div class="upsell">
            <span>{t('popup_tryPaid')}</span>
            <button onClick={() => selectMode('paid')}>{t('popup_tryPaidBtn')}</button>
          </div>
        )}
      </div>

      <footer class="footer">
        <button class="link" onClick={() => chrome.runtime.openOptionsPage()}>
          {t('openOptions')}
        </button>
        <button class="link" onClick={() => void openShortcutSettings()}>
          {t('shortcuts')}
        </button>
        <span class="version mono" title={t('ui_version')}>
          {buildLabel()}
        </span>
      </footer>
    </main>
  );
}

function ModelLine({ label, id }: { label: string; id: string }) {
  return (
    <div class="model-line">
      <span class="dot" />
      <span class="model-role">{label}</span>
      <span class="mono">{id}</span>
    </div>
  );
}

function Action(props: {
  icon: ComponentChildren;
  accent?: boolean;
  title: string;
  desc: string;
  hint?: string;
  keys?: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button class="item" disabled={props.disabled} title={props.hint} onClick={props.onClick}>
      <span class={`item-icon ${props.accent ? 'accent' : ''}`}>{props.icon}</span>
      <span class="item-text">
        <span class="item-title">{props.title}</span>
        <span class="item-desc">{props.desc}</span>
      </span>
      {props.keys && <kbd>{props.keys}</kbd>}
    </button>
  );
}

const Icon = ({ children }: { children: ComponentChildren }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const CheckIcon = () => (
  <Icon>
    <path d="M5 12l4.5 4.5L19 7" />
  </Icon>
);
const AssistIcon = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </Icon>
);
const NextIcon = () => (
  <Icon>
    <path d="M5 12h12" />
    <path d="M13 6l6 6-6 6" />
  </Icon>
);
const RegionIcon = () => (
  <Icon>
    <path d="M4 8V5a1 1 0 011-1h3" />
    <path d="M16 4h3a1 1 0 011 1v3" />
    <path d="M20 16v3a1 1 0 01-1 1h-3" />
    <path d="M8 20H5a1 1 0 01-1-1v-3" />
  </Icon>
);
const RelearnIcon = () => (
  <Icon>
    <path d="M20 12a8 8 0 11-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </Icon>
);
const LockIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </svg>
);
