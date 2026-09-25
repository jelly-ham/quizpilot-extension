import {
  capabilitiesOf,
  createProvider,
  DEFAULT_ESCALATION_THRESHOLD,
  defaultRouting,
  jevEndpoint,
  listModels,
  ProviderConfig,
  ProviderSetup,
  testProvider,
} from '@quizpilot/providers';
import { formatIssues } from '@quizpilot/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, getAuth, getUsage, sendDebugReport, type UsageHistory } from '../lib/api';
import {
  buildLabel,
  clearDebugLog,
  formatDebugLog,
  getDebugLog,
  lastSite,
  trimLog,
} from '../lib/debug';
import { t } from '../lib/i18n';
import { Logo, Wordmark } from '../lib/Logo';
import { apiErrorMessage } from '../lib/messages';
import { getSettings, updateSettings, type Settings } from '../lib/settings';
import { getShortcuts, openShortcutSettings } from '../lib/shortcuts';
import { originPattern, PRESETS, uniqueId, type Preset } from './presets';

type TestState =
  { status: 'testing' } | { status: 'ok'; text: string } | { status: 'error'; text: string };

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string>('');

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);
  if (!settings) return null;

  const patch = async (p: Partial<Settings>) => {
    setSettings(await updateSettings(p));
    flash(t('opt_saved'));
  };
  const flash = (text: string) => {
    setSaved(text);
    setTimeout(() => setSaved(''), 1800);
  };

  const sections = [
    ['mode', t('modeLabel')],
    settings.mode === 'byok' ? ['models', t('opt_models')] : ['history', t('opt_history')],
    ['answering', t('opt_answering')],
    ['shortcuts', t('shortcuts')],
    ['debug', t('opt_debug')],
  ] as const;

  return (
    <div class="layout">
      <nav class="side" aria-label={t('opt_nav')}>
        <a class="side-brand" href="#mode">
          <Logo size={30} />
          <Wordmark />
        </a>
        <ul>
          {sections.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
        <span class="side-version mono">{buildLabel()}</span>
      </nav>

      <main class="page">
        <h1>{t('opt_title')}</h1>

        <section class="card" id="mode">
          <h2>{t('modeLabel')}</h2>
          <div class="choices">
            <Choice
              checked={settings.mode === 'byok'}
              onSelect={() => patch({ mode: 'byok' })}
              title={t('mode_byok')}
              hint={t('opt_byokHint')}
            />
            <Choice
              checked={settings.mode === 'paid'}
              onSelect={() => patch({ mode: 'paid' })}
              title={t('mode_paid')}
              hint={t('opt_paidHint')}
            />
          </div>
        </section>

        {settings.mode === 'byok' ? (
          <ByokSection
            settings={settings}
            onSaved={(s) => {
              setSettings(s);
              flash(t('opt_modelsSaved'));
            }}
          />
        ) : (
          <History />
        )}

        <section class="card" id="answering">
          <h2>{t('opt_answering')}</h2>
          <Toggle
            label={t('opt_humanize')}
            hint={t('opt_humanizeHint')}
            checked={settings.humanize}
            onChange={(v) => patch({ humanize: v })}
          />
          <Toggle
            label={t('opt_review')}
            hint={t('opt_reviewHint')}
            checked={settings.allowEscalation}
            onChange={(v) => patch({ allowEscalation: v })}
          />
        </section>

        <ShortcutsSection />

        <DebugSection
          enabled={settings.debug}
          onToggle={(v) => patch({ debug: v })}
          onDone={flash}
        />

        {saved && (
          <div class="toast" role="status">
            {saved}
          </div>
        )}
      </main>
    </div>
  );
}

/** The manifest commands with their current keys; Chrome owns the binding UI. */
function ShortcutsSection() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    void getShortcuts().then(setKeys);
    // Keys may be changed in Chrome's page while this one stays open.
    const onFocus = () => void getShortcuts().then(setKeys);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  const rows: [string, string][] = [
    ['solve-page', t('solvePage')],
    ['solve-assist', t('cmd_assist')],
    ['solve-auto', t('cmd_auto')],
    ['solve-region', t('solveRegion')],
    ['stop-run', t('cmd_stop')],
    ['relearn-page', t('relearnPage')],
  ];
  return (
    <section class="card" id="shortcuts">
      <div class="card-head">
        <h2>{t('shortcuts')}</h2>
        <button class="ghost small" onClick={() => void openShortcutSettings()}>
          {t('sc_edit')}
        </button>
      </div>
      <p class="muted">{t('sc_intro')}</p>
      <dl class="shortcuts">
        {rows.map(([name, label]) => (
          <div class="shortcut" key={name}>
            <dt>{label}</dt>
            <dd>
              {keys[name] ? <kbd>{keys[name]}</kbd> : <span class="muted">{t('sc_notSet')}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ByokSection({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
}) {
  const [providers, setProviders] = useState<ProviderConfig[]>(settings.byok.providers);
  const [routing, setRouting] = useState(settings.byok.routing);
  const [adding, setAdding] = useState<Preset | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [error, setError] = useState('');

  const draft: ProviderSetup = { providers, routing: defaultRouting(providers, routing) };
  const idsThat = (cap: 'freeText' | 'vision') =>
    providers.filter((p) => capabilitiesOf(p)[cap]).map((p) => p.id);
  const textIds = idsThat('freeText');
  const visionIds = idsThat('vision');

  async function save() {
    setError('');
    const parsed = ProviderSetup.safeParse(draft);
    if (!parsed.success) {
      setError(formatIssues(parsed.error, '；'));
      return;
    }
    // Must run inside the click gesture, before any other await.
    const granted = await chrome.permissions.request({
      origins: [...new Set(providers.map(originPattern))],
    });
    if (!granted) {
      setError(t('opt_needPermission'));
      return;
    }
    onSaved(await updateSettings({ byok: parsed.data }));
  }

  async function test(config: ProviderConfig) {
    const granted = await chrome.permissions.request({ origins: [originPattern(config)] });
    if (!granted)
      return setTests((cur) => ({
        ...cur,
        [config.id]: { status: 'error', text: t('opt_noPermission') },
      }));
    setTests((cur) => ({ ...cur, [config.id]: { status: 'testing' } }));
    const r = await testProvider(createProvider(config, { retry: { retries: 0 } }));
    setTests((cur) => ({
      ...cur,
      [config.id]: r.ok
        ? { status: 'ok', text: t('opt_testOk', { model: r.model, ms: r.latencyMs }) }
        : { status: 'error', text: `${r.error.code}: ${r.error.message}` },
    }));
  }

  return (
    <section class="card" id="models">
      <h2>{t('opt_models')}</h2>
      <p class="muted">{t('opt_modelsIntro')}</p>

      {providers.length === 0 && <p class="empty">{t('opt_noModels')}</p>}
      {providers.map((p, i) => (
        <ProviderRow
          key={p.id}
          config={p}
          test={tests[p.id]}
          onChange={(next) => setProviders(providers.map((x, j) => (j === i ? next : x)))}
          onRemove={() => setProviders(providers.filter((_, j) => j !== i))}
          onTest={() => test(p)}
        />
      ))}

      {adding ? (
        <AddProvider
          preset={adding}
          takenIds={providers.map((p) => p.id)}
          onCancel={() => setAdding(null)}
          onAdd={(c) => {
            setProviders([...providers, c]);
            setAdding(null);
          }}
        />
      ) : (
        <div class="presets">
          {PRESETS.map((preset) => (
            <button class="chip" onClick={() => setAdding(preset)}>
              + {preset.label}
            </button>
          ))}
        </div>
      )}

      {providers.length > 0 && (
        <div class="routing">
          <h3>{t('opt_routing')}</h3>
          <RouteSelect
            label={t('opt_routeChoice')}
            value={draft.routing.choice}
            ids={providers.map((p) => p.id)}
            onChange={(v) => setRouting({ ...routing, choice: v })}
          />
          <RouteSelect
            label={t('opt_routeText')}
            value={draft.routing.text}
            ids={textIds}
            onChange={(v) => setRouting({ ...routing, text: v })}
          />
          <RouteSelect
            label={t('opt_routeVision')}
            value={draft.routing.vision}
            ids={visionIds}
            onChange={(v) => setRouting({ ...routing, vision: v })}
          />
          <RouteSelect
            label={t('opt_routeReview')}
            value={draft.routing.escalation?.provider}
            ids={textIds}
            autoLabel={t('opt_sameAsText')}
            onChange={(v) =>
              setRouting({
                ...routing,
                escalation: {
                  threshold: routing.escalation?.threshold ?? DEFAULT_ESCALATION_THRESHOLD,
                  ...(v ? { provider: v } : {}),
                },
              })
            }
          />
          <p class="muted">{t('opt_reviewIntro')}</p>
          <label class="field inline">
            <span>{t('opt_threshold')}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={routing.escalation?.threshold ?? DEFAULT_ESCALATION_THRESHOLD}
              onInput={(e) =>
                setRouting({
                  ...routing,
                  escalation: {
                    ...routing.escalation,
                    threshold: Number((e.target as HTMLInputElement).value),
                  },
                })
              }
            />
            <span class="muted">{t('opt_thresholdHint')}</span>
          </label>
        </div>
      )}

      {error && <p class="error">{error}</p>}
      <div class="row-end">
        <button class="primary" onClick={save}>
          {t('opt_saveModels')}
        </button>
      </div>
    </section>
  );
}

function ProviderRow(props: {
  config: ProviderConfig;
  test?: TestState;
  onChange(c: ProviderConfig): void;
  onRemove(): void;
  onTest(): void;
}) {
  const c = props.config;
  return (
    <div class="provider">
      <div class="provider-head">
        <strong>{c.id}</strong>
        <span class="muted">
          {c.type === 'jev'
            ? `Jev · ${jevEndpoint(c).model} · ${c.via === 'openrouter' ? 'OpenRouter' : 'TypeSafe'}`
            : `${c.model} · ${new URL(c.baseURL).host}`}
        </span>
        {c.type === 'openai-compatible' && c.vision && <span class="tag">{t('opt_vision')}</span>}
        <span class="spacer" />
        <button
          class="ghost small"
          onClick={props.onTest}
          disabled={props.test?.status === 'testing'}
        >
          {props.test?.status === 'testing' ? t('opt_testing') : t('opt_test')}
        </button>
        <button class="ghost small danger" onClick={props.onRemove}>
          {t('opt_delete')}
        </button>
      </div>
      {c.type === 'openai-compatible' && (
        <VisionCheck checked={!!c.vision} onChange={(vision) => props.onChange({ ...c, vision })} />
      )}
      {props.test && props.test.status !== 'testing' && (
        <p class={props.test.status === 'ok' ? 'ok' : 'error'}>{props.test.text}</p>
      )}
    </div>
  );
}

function AddProvider(props: {
  preset: Preset;
  takenIds: string[];
  onAdd(c: ProviderConfig): void;
  onCancel(): void;
}) {
  const { preset } = props;
  const [id, setId] = useState(uniqueId(preset.id, props.takenIds));
  const [baseURL, setBaseURL] = useState(preset.baseURL ?? '');
  const [model, setModel] = useState(preset.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [vision, setVision] = useState(!!preset.vision);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState<'idle' | 'busy' | string>('idle');

  /** Ask the service which models this key can use; they fill the Model field's suggestions. */
  async function fetchModels() {
    let origin: string;
    try {
      origin = `${new URL(baseURL).origin}/*`;
    } catch {
      return setListing(t('opt_listFailed', { msg: 'Base URL' }));
    }
    // Must run inside the click gesture, before any other await.
    if (!(await chrome.permissions.request({ origins: [origin] })))
      return setListing(t('opt_noPermission'));
    setListing('busy');
    try {
      const ids = await listModels(baseURL, apiKey || undefined, {
        ...(preset.headers ? { headers: preset.headers } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      setModels(ids);
      setListing(t('opt_modelsFound', { n: ids.length }));
      if (!model && ids.length) setModel(ids[0]!);
    } catch (e) {
      setListing(t('opt_listFailed', { msg: (e as Error).message }));
    }
  }

  function add() {
    const config: ProviderConfig =
      preset.type === 'jev'
        ? { type: 'jev', id, apiKey, via: preset.via ?? 'typesafe' }
        : {
            type: 'openai-compatible',
            id,
            baseURL,
            model,
            vision,
            ...(apiKey ? { apiKey } : {}),
            ...(preset.headers ? { headers: preset.headers } : {}),
            ...(preset.jsonMode === false ? { jsonMode: false } : {}),
          };
    const check = ProviderConfig.safeParse(config);
    if (!check.success) return setError(formatIssues(check.error, '；'));
    if (props.takenIds.includes(id)) return setError(t('opt_nameTaken'));
    props.onAdd(check.data);
  }

  return (
    <div class="provider adding">
      <div class="provider-head">
        <strong>{t('opt_addTitle', { label: preset.label })}</strong>
      </div>
      {preset.hint && <p class="muted">{preset.hint}</p>}
      <Field
        label={t('opt_name')}
        value={id}
        onInput={setId}
        placeholder={t('opt_namePlaceholder')}
      />
      {preset.type === 'openai-compatible' && (
        <>
          <Field label="Base URL" value={baseURL} onInput={setBaseURL} placeholder="https://…/v1" />
        </>
      )}
      <Field
        label="API Key"
        value={apiKey}
        onInput={setApiKey}
        type="password"
        placeholder={preset.keyless ? t('opt_keyOptional') : ''}
      />
      {preset.type === 'openai-compatible' && (
        <>
          <Field
            label={t('opt_model')}
            value={model}
            onInput={setModel}
            placeholder={t('opt_modelPlaceholder')}
            list={`models-${preset.id}`}
          />
          <datalist id={`models-${preset.id}`}>
            {models.map((m) => (
              <option value={m} />
            ))}
          </datalist>
          <div class="row-inline">
            <button
              class="ghost small"
              disabled={listing === 'busy' || (!apiKey && !preset.keyless)}
              onClick={fetchModels}
            >
              {listing === 'busy' ? t('opt_listingModels') : t('opt_listModels')}
            </button>
            {listing !== 'idle' && listing !== 'busy' && <span class="muted">{listing}</span>}
          </div>
        </>
      )}
      {preset.type === 'openai-compatible' && <VisionCheck checked={vision} onChange={setVision} />}
      {error && <p class="error">{error}</p>}
      <div class="row-end">
        <button class="ghost" onClick={props.onCancel}>
          {t('opt_cancel')}
        </button>
        <button class="primary" onClick={add}>
          {t('opt_add')}
        </button>
      </div>
    </div>
  );
}

function RouteSelect(props: {
  label: string;
  value?: string;
  ids: string[];
  /** What the empty choice means; defaults to "自动". */
  autoLabel?: string;
  onChange(v: string | undefined): void;
}) {
  return (
    <label class="field inline">
      <span>{props.label}</span>
      <select
        value={props.value ?? ''}
        onChange={(e) => props.onChange((e.target as HTMLSelectElement).value || undefined)}
      >
        <option value="">
          {props.ids.length ? (props.autoLabel ?? t('opt_auto')) : t('opt_noModelAvailable')}
        </option>
        {props.ids.map((id) => (
          <option value={id}>{id}</option>
        ))}
      </select>
    </label>
  );
}

function Field(props: {
  label: string;
  value: string;
  onInput(v: string): void;
  type?: string;
  placeholder?: string;
  /** id of a <datalist> with suggestions. */
  list?: string;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        list={props.list}
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value.trim())}
      />
    </label>
  );
}

function Choice(props: { checked: boolean; onSelect(): void; title: string; hint: string }) {
  return (
    <label class={`choice ${props.checked ? 'selected' : ''}`}>
      <input type="radio" checked={props.checked} onChange={props.onSelect} />
      <span class="choice-title">{props.title}</span>
      <span class="muted">{props.hint}</span>
    </label>
  );
}

function DebugSection(props: {
  enabled: boolean;
  onToggle(v: boolean): void;
  onDone(message: string): void;
}) {
  const [count, setCount] = useState(0);
  const refresh = async () => setCount((await getDebugLog()).length);

  useEffect(() => {
    void refresh();
    // New entries arrive from the service worker while this page is open.
    const onChange = (_: unknown, area: string) => area === 'session' && void refresh();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const copy = async () => {
    await navigator.clipboard.writeText(formatDebugLog(await getDebugLog()));
    props.onDone(t('opt_logCopied'));
  };
  const download = async () => {
    const blob = new Blob([formatDebugLog(await getDebugLog())], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quizpilot-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const clear = async () => {
    await clearDebugLog();
    await refresh();
    props.onDone(t('opt_logCleared'));
  };

  return (
    <section class="card" id="debug">
      <h2>{t('opt_debug')}</h2>
      <Toggle
        label={t('opt_debugLog')}
        hint={t('opt_debugHint')}
        checked={props.enabled}
        onChange={props.onToggle}
      />
      <div class="row-end">
        <span class="muted log-count">{t('opt_logCount', { n: count })}</span>
        <button class="small ghost" disabled={!count} onClick={copy}>
          {t('opt_copyLog')}
        </button>
        <button class="small ghost" disabled={!count} onClick={download}>
          {t('opt_downloadLog')}
        </button>
        <button class="small ghost" disabled={!count} onClick={clear}>
          {t('opt_clear')}
        </button>
      </div>
      <ReportForm count={count} />
    </section>
  );
}

/** Emails the debug log to support, so a misread site can be fixed. */
function ReportForm({ count }: { count: number }) {
  const [note, setNote] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<
    { s: 'idle' } | { s: 'sending' } | { s: 'sent' } | { s: 'error'; msg: string }
  >({ s: 'idle' });

  useEffect(() => {
    getAuth().then((a) => a && setContact((cur) => cur || a.user.email));
  }, []);

  async function send(e: Event) {
    e.preventDefault();
    setState({ s: 'sending' });
    try {
      const entries = await getDebugLog();
      await sendDebugReport({
        // The server takes up to 1.5M characters; keep the newest lines.
        log: trimLog(formatDebugLog(entries), 1_400_000),
        note,
        contact,
        site: lastSite(entries),
        version: buildLabel(),
      });
      setState({ s: 'sent' });
      setNote('');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? apiErrorMessage(err)
          : err instanceof TypeError
            ? t('acc_offline')
            : (err as Error).message;
      setState({ s: 'error', msg });
    }
  }

  return (
    <form class="report" onSubmit={send}>
      <h3>{t('rep_title')}</h3>
      <p class="muted">{t('rep_intro')}</p>
      <label class="field">
        <span>{t('rep_note')}</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={note}
          placeholder={t('rep_notePh')}
          onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <label class="field">
        <span>{t('rep_contact')}</span>
        <input
          type="email"
          autocomplete="email"
          value={contact}
          placeholder="you@example.com"
          onInput={(e) => setContact((e.target as HTMLInputElement).value.trim())}
        />
      </label>
      <p class="fine">{t('rep_privacy')}</p>
      <div class="row-end">
        <span class="log-count" role="status">
          {count === 0 && <span class="muted">{t('rep_enableFirst')}</span>}
          {state.s === 'sent' && <span class="ok">{t('rep_sent')}</span>}
          {state.s === 'error' && <span class="error">{t('rep_failed', { msg: state.msg })}</span>}
        </span>
        <button class="primary" disabled={!count || state.s === 'sending'}>
          {state.s === 'sending' ? t('rep_sending') : t('rep_send')}
        </button>
      </div>
    </form>
  );
}

function Toggle(props: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <label class="toggle">
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      <span>
        {props.label}
        <span class="muted block">{props.hint}</span>
      </span>
    </label>
  );
}

const ledgerLabel = (kind: UsageHistory['ledger'][number]['kind']) =>
  ({
    topup: t('led_topup'),
    grant: t('led_grant'),
    charge: t('led_charge'),
    refund: t('led_refund'),
  })[kind];

const PAGE_SIZE = 10;

/** Credits mode: the ledger and recent answering, each a table with its own pages. */
function History() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  useEffect(() => {
    getAuth().then((a) => setLoggedIn(!!a));
  }, []);

  const time = (ms: number) => new Date(ms).toLocaleString();
  return (
    <section class="card" id="history">
      <h2>{t('opt_history')}</h2>
      {loggedIn === false && <p class="muted">{t('opt_historyLogin')}</p>}
      {loggedIn && (
        <>
          <PagedTable
            only="ledger"
            head={
              <tr>
                <th>{t('th_time')}</th>
                <th>{t('th_type')}</th>
                <th class="num">{t('th_credits')}</th>
              </tr>
            }
            rows={(h) =>
              h.ledger.map((l) => (
                <tr>
                  <td>{time(l.created_at)}</td>
                  <td>{ledgerLabel(l.kind)}</td>
                  <td class={`num ${l.delta > 0 ? 'plus' : 'minus'}`}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </td>
                </tr>
              ))
            }
            total={(h) => h.ledgerTotal}
            empty={t('opt_noHistory')}
          />
          <h3>{t('opt_recent')}</h3>
          <PagedTable
            only="usage"
            head={
              <tr>
                <th>{t('th_time')}</th>
                <th>{t('th_site')}</th>
                <th>{t('th_model')}</th>
                <th class="num">{t('th_questions')}</th>
                <th class="num">{t('th_credits')}</th>
              </tr>
            }
            rows={(h) =>
              h.usage.map((u) => (
                <tr>
                  <td>{time(u.created_at)}</td>
                  <td>{u.page_host ?? '—'}</td>
                  <td>{u.model}</td>
                  <td class="num">{u.question_count}</td>
                  <td class="num">{u.credits}</td>
                </tr>
              ))
            }
            total={(h) => h.usageTotal}
            empty={t('opt_noHistory')}
          />
        </>
      )}
    </section>
  );
}

function PagedTable(props: {
  only: 'usage' | 'ledger';
  head: ComponentChildren;
  rows(h: UsageHistory): ComponentChildren[];
  total(h: UsageHistory): number | undefined;
  empty: string;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<UsageHistory | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getUsage(props.only, page * PAGE_SIZE, PAGE_SIZE).then(
      (h) => live && (setData(h), setError('')),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [page]);

  if (error) return <p class="error">{error}</p>;
  if (!data) return null;
  const rows = props.rows(data);
  if (rows.length === 0 && page === 0) return <p class="empty">{props.empty}</p>;
  const total = props.total(data);
  // Older servers send no total: allow "next" while a page comes back full.
  const pages = total !== undefined ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : undefined;
  const hasNext = pages !== undefined ? page + 1 < pages : rows.length === PAGE_SIZE;
  return (
    <>
      <div class="table-wrap">
        <table class="history">
          <thead>{props.head}</thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {(page > 0 || hasNext) && (
        <nav class="pager" aria-label={t('pg_label')}>
          <button class="ghost small" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {t('pg_prev')}
          </button>
          <span class="muted">
            {pages !== undefined
              ? t('pg_of', { page: page + 1, pages })
              : t('pg_page', { page: page + 1 })}
          </span>
          <button class="ghost small" disabled={!hasNext} onClick={() => setPage(page + 1)}>
            {t('pg_next')}
          </button>
        </nav>
      )}
    </>
  );
}

function VisionCheck(props: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      {t('opt_visionCheck')}
    </label>
  );
}
