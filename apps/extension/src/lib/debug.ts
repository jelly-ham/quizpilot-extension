/**
 * Opt-in debug log (Settings.debug): each step of a run, kept in chrome.storage.session so the
 * options page can copy it without DevTools. Cleared when the browser closes.
 */

export interface DebugEntry {
  /** epoch ms */
  t: number;
  event: string;
  data?: unknown;
}

export type Log = (event: string, data?: unknown) => void;

const KEY = 'debugLog';
const MAX_ENTRIES = 400;
const MAX_ENTRY_CHARS = 8_000;

/** API keys never belong in a log that users paste into bug reports. */
const redact = (s: string) => s.replace(/\b(sk|key|ts)-[\w-]{12,}/g, '$1-…');

// Writes are read-modify-write; chain them so concurrent calls don't drop entries.
let queue = Promise.resolve();

function append(entry: DebugEntry) {
  queue = queue
    .then(async () => {
      const log = ((await chrome.storage.session.get(KEY))[KEY] as DebugEntry[] | undefined) ?? [];
      log.push(entry);
      await chrome.storage.session.set({ [KEY]: log.slice(-MAX_ENTRIES) });
    })
    .catch(() => {});
}

/** A logger for one run; a no-op unless debugging is on. */
export function logger(enabled: boolean): Log {
  if (!enabled) return () => {};
  return (event, data) => {
    let json = data === undefined ? undefined : redact(JSON.stringify(data));
    if (json && json.length > MAX_ENTRY_CHARS) json = `${json.slice(0, MAX_ENTRY_CHARS)}…(已截断)`;
    console.debug('[QuizPilot]', event, data);
    append({
      t: Date.now(),
      event,
      ...(json === undefined ? {} : { data: JSON.parse(safeJson(json)) }),
    });
  };
}

/** Truncated JSON isn't parseable; keep it as a string then. */
function safeJson(json: string): string {
  try {
    JSON.parse(json);
    return json;
  } catch {
    return JSON.stringify(json);
  }
}

export async function getDebugLog(): Promise<DebugEntry[]> {
  return ((await chrome.storage.session.get(KEY))[KEY] as DebugEntry[] | undefined) ?? [];
}

export async function clearDebugLog() {
  await chrome.storage.session.remove(KEY);
}

/** Version plus build (dev number, commit) when the build has one. */
export const buildLabel = () => {
  const m = chrome.runtime.getManifest();
  return m.version_name ?? m.version;
};

/** The site of the most recent run in the log, for a report's subject line. */
export function lastSite(entries: DebugEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const url = (entries[i]!.data as { url?: unknown } | undefined)?.url;
    if (typeof url === 'string') {
      try {
        return new URL(url).host;
      } catch {
        // not a URL; keep looking
      }
    }
  }
  return '';
}

/** Keeps the newest lines of a formatted log within `max` characters (the header stays). */
export function trimLog(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const head = lines.slice(0, 4);
  const tail: string[] = [];
  let size = head.join('\n').length + 40;
  for (let i = lines.length - 1; i >= 4; i--) {
    size += lines[i]!.length + 1;
    if (size > max) break;
    tail.unshift(lines[i]!);
  }
  return [...head, `…(${lines.length - 4 - tail.length} earlier lines omitted)`, ...tail].join(
    '\n',
  );
}

/** Plain text for pasting into a bug report. */
export function formatDebugLog(entries: DebugEntry[]): string {
  const head = [
    `QuizPilot ${buildLabel()}`,
    navigator.userAgent,
    `导出时间 ${new Date().toISOString()}`,
    '',
  ];
  const lines = entries.map((e) => {
    const time =
      new Date(e.t).toTimeString().slice(0, 8) + `.${String(e.t % 1000).padStart(3, '0')}`;
    return e.data === undefined
      ? `${time} ${e.event}`
      : `${time} ${e.event} ${JSON.stringify(e.data)}`;
  });
  return [...head, ...lines].join('\n');
}
