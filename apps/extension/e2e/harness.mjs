// Shared e2e harness: fixture quiz pages, mock Jev / OpenAI endpoints, extension build, and a
// Chromium that loads the extension.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserEnv } from '../scripts/chromium.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 47831;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const calls = { jev: 0, llm: 0, vision: 0, read: 0, mark: 0 };

// ---------------------------------------------------------------- fixture site + mock models

export const QUIZ = `<!doctype html><meta charset="utf-8"><title>Quiz</title>
<form id="quiz">
  <div class="q"><p>1. 2 + 2 = ?</p>
    <label><input type="radio" name="q1" value="a"> A. 3</label>
    <label><input type="radio" name="q1" value="b"> B. 4</label></div>
  <div class="q"><p>2. Which are prime?</p>
    <label><input type="checkbox" name="q2" value="2"> 2</label>
    <label><input type="checkbox" name="q2" value="4"> 4</label>
    <label><input type="checkbox" name="q2" value="5"> 5</label></div>
  <div class="q"><p>3. 水在标准大气压下 100°C 沸腾。</p>
    <label><input type="radio" name="q3" value="t">对</label><label><input type="radio" name="q3" value="f">错</label></div>
  <p>4. 中国的首都是<input type="text" name="cap">，最大的城市是<input type="text" name="big">。</p>
  <div><label for="s">5. 1 + 1 =</label>
    <select id="s" name="s"><option value="">请选择</option><option value="one">1</option><option value="two">2</option></select></div>
</form>
<iframe src="/frame.html" style="width:600px;height:160px"></iframe>
<div><p>7. 图中是什么形状？<img src="/shape.png" width="120" height="120"></p>
  <label><input type="radio" name="q7" value="circle">圆形</label>
  <label><input type="radio" name="q7" value="square">方形</label></div>`;

// No DOM text at all: the question is drawn on a canvas.
const CANVAS = `<!doctype html><meta charset="utf-8"><title>Canvas quiz</title>
<canvas id="c" width="500" height="200"></canvas>
<script>const x = document.getElementById('c').getContext('2d'); x.font = '28px sans-serif'; x.fillText('1 + 1 = ?   A. 1   B. 2', 20, 100);</script>`;

// 8x8 black PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEUAAAD///+l2Z/dAAAADklEQVQI12NgQAcMDAAAHAAB8S2QkQAAAABJRU5ErkJggg==',
  'base64',
);

const FRAME = `<!doctype html><meta charset="utf-8">
<div><p>6. Capital of France?</p>
  <label><input type="radio" name="q6" value="berlin">Berlin</label>
  <label><input type="radio" name="q6" value="paris">Paris</label></div>`;

const CORRECT = new Set(['4', '2', 'Paris', '珠穆朗玛峰', '长江', '100 度']);

// Options are bare divs with hashed classes: the generic reader finds nothing, so the extension
// has to learn the layout from a set-of-marks screenshot. Clicking marks an option "selected".
const HARD = `<!doctype html><meta charset="utf-8"><title>Hard quiz</title>
<style>.row{padding:4px;margin:2px 0;border:1px solid #ccc}.row.selected{background:#cfe}</style>
<div class="app_x9f2k1">
  ${[
    ['第一题', '世界上最高的山峰', ['珠穆朗玛峰', '乔戈里峰']],
    ['第二题', '中国最长的河流', ['黄河', '长江', '珠江']],
    ['第三题', '水的沸点（标准大气压）', ['90 度', '100 度']],
  ]
    .map(
      ([
        n,
        stem,
        opts,
      ]) => `<div class="qcard _a8f3k2"><div class="qcard-head css-1x2y3z"><span>${n}</span> ${stem}</div>
      <div class="qcard-body">${opts.map((o) => `<div class="row sc-a1b2c3"><i></i><span>${o}</span></div>`).join('')}</div></div>`,
    )
    .join('')}
</div>
<script>
  document.querySelectorAll('.qcard').forEach((card) => {
    const rows = [...card.querySelectorAll('.row')];
    rows.forEach((r) => r.addEventListener('click', () => rows.forEach((x) => x.classList.toggle('selected', x === r))));
  });
</script>`;

/** Mock set-of-marks labelling: find "第N题" stems and the option spans after them in the list. */
function mockMark(listText) {
  const marks = [...listText.matchAll(/^\[(\d+)\] (\w+): (.*)$/gm)].map((m) => ({
    id: Number(m[1]),
    text: m[3],
  }));
  const questions = [];
  for (const [i, m] of marks.entries()) {
    if (!/^第.题/.test(m.text)) continue;
    const options = [];
    for (const next of marks.slice(i + 1)) {
      if (/^第.题/.test(next.text)) break;
      if (next.text && !/^第.题$/.test(next.text)) options.push(next.id);
    }
    questions.push({ kind: 'single', stem: m.id, options });
  }
  return { questions };
}
const PRIMES = new Set(['2', '5']);

function mockJev(body) {
  calls.jev++;
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    if (q.type === 'choice') {
      const choice =
        Object.keys(q.criteria).find((k) => CORRECT.has(q.criteria[k])) ??
        Object.keys(q.criteria)[0];
      answers[key] = { type: 'choice', choice, confidence: 0.95 };
    } else if (q.instructions.statement) {
      answers[key] = { type: 'noul', noul: 0.97 };
    } else {
      const option = /\("(.*)"\)/.exec(q.instructions.task)?.[1];
      answers[key] = { type: 'noul', noul: PRIMES.has(option) ? 0.9 : 0.05 };
    }
  }
  return { model: 'jev-mock', answers, usage: { input_tokens: 100, output_tokens: 0 } };
}

function mockLlm(body) {
  const reply = (content) => ({
    model: 'llm-mock',
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const user = body.messages[1].content;
  const parts = Array.isArray(user) ? user : [{ type: 'text', text: user }];
  const hasImage = parts.some((p) => p.type === 'image_url');

  if (body.messages[0].content.startsWith('You find quiz questions')) {
    calls.mark++;
    assert.ok(hasImage, 'mark request carries the screenshot');
    return reply(mockMark(parts[0].text));
  }
  if (body.messages[0].content.startsWith('You transcribe')) {
    calls.read++;
    assert.ok(hasImage, 'read request carries the screenshot');
    return reply({
      questions: [
        {
          kind: 'single',
          stem: '1 + 1 = ?',
          options: [
            { key: 'A', text: '1' },
            { key: 'B', text: '2' },
          ],
        },
      ],
    });
  }
  if (hasImage) calls.vision++;
  else calls.llm++;
  const answers = JSON.parse(parts[0].text).map((q) =>
    q.kind === 'fill'
      ? { id: q.id, text: ['北京', '上海'], confidence: 0.9 }
      : q.kind === 'single'
        ? { id: q.id, choice: 'B', confidence: 0.8 }
        : { id: q.id, text: 'n/a' },
  );
  return reply({ answers });
}

/** Swappable model mocks and extra routes (store screenshots use their own demo page). */
export const mocks = { jev: mockJev, llm: mockLlm };
export const extraRoutes = new Map();

export const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  // Ignore query strings so tests can open the same fixture in several distinct tabs.
  const path = new URL(req.url, ORIGIN).pathname;
  const send = (status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  if (path === '/quiz.html') return send(200, QUIZ, 'text/html; charset=utf-8');
  if (path === '/frame.html') return send(200, FRAME, 'text/html; charset=utf-8');
  if (path === '/canvas.html') return send(200, CANVAS, 'text/html; charset=utf-8');
  if (path === '/hard.html') return send(200, HARD, 'text/html; charset=utf-8');
  if (path === '/shape.png') return send(200, PNG, 'image/png');
  const extra = extraRoutes.get(path);
  if (extra) return send(200, extra.body, extra.type);
  if (path === '/favicon.ico') return send(204, '', 'image/x-icon');
  if (path === '/v1/health') return send(200, { ok: true });
  if (path === '/jev/v1/systemone') {
    // A question containing SLOW hangs, to test stopping a run mid-call.
    if (JSON.stringify(body).includes('SLOW')) await new Promise((r) => setTimeout(r, 60_000));
    return send(200, mocks.jev(body));
  }
  if (path === '/llm/v1/chat/completions' || path === '/or/v1/chat/completions')
    return send(200, mocks.llm(body));
  if (path === '/or/alpha/decisions') return send(200, mocks.jev(body));
  // OpenRouter's price lookup (USD per token), as the Worker reads it.
  const priced = path.match(/^\/or\/v1\/models\/(.+)\/endpoints$/);
  if (priced)
    return send(200, {
      data: {
        endpoints: [
          {
            pricing: priced[1].startsWith('typesafe/')
              ? { prompt: '0.000000042', completion: '0' }
              : { prompt: '0.0000003', completion: '0.0000012' },
          },
        ],
      },
    });
  if (path === '/llm/v1/models')
    return send(200, { data: [{ id: 'mock-vl' }, { id: 'mock-pro' }] });
  send(404, { error: 'not_found' });
});

// ---------------------------------------------------------------- helpers

export function startServer() {
  return new Promise((r) => server.listen(PORT, '127.0.0.1', r));
}

export function buildExtension(outDir, apiBase) {
  const dist = join(root, outDir);
  execSync(`pnpm exec vite build --outDir ${dist} --emptyOutDir`, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_BASE: apiBase, VITE_E2E: '1' },
  });
  return dist;
}

/** `lang` sets the browser UI language, which picks the extension's locale (zh_CN or en). */
export async function launch(dist, { lang = 'zh-CN' } = {}) {
  const context = await chromium.launchPersistentContext('', {
    // The default headless shell cannot load extensions; full Chromium in new headless mode can.
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--lang=${lang}`,
    ],
    // Linux Chromium takes its UI language from the environment.
    env: {
      ...browserEnv(),
      LANGUAGE: lang.replace('-', '_'),
      LANG: `${lang.replace('-', '_')}.UTF-8`,
    },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  worker.on('console', (m) => m.type() === 'error' && console.error('sw console:', m.text()));
  const extId = new URL(worker.url()).host;
  // Extension page used to send messages the way the popup does.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/src/options/index.html`);
  return { context, worker, extId, ext };
}

export async function setSettings(worker, settings) {
  await worker.evaluate(async (s) => {
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, ...s } });
  }, settings);
}

/** Open a fixture page and start the pipeline on it; returns the page and its panel status locator. */
export async function openAndRun({ context, worker, ext }, path, mode = 'page') {
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error('page console:', m.text()));
  await page.goto(`${ORIGIN}${path}`);
  await page.bringToFront();
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    `${ORIGIN}${path}`,
  );
  await ext.evaluate(
    (m) => chrome.runtime.sendMessage({ type: 'qp:run', mode: m.mode, tabId: m.tabId }),
    { mode, tabId },
  );
  return { page, status: page.locator('#quizpilot-root .status') };
}

export async function main(name, fn) {
  let failed = false;
  try {
    await fn();
    console.log(`e2e ${name}: all checks passed`);
  } catch (err) {
    failed = true;
    console.error(`e2e ${name} failed:`, err);
  }
  server.close();
  process.exit(failed ? 1 : 0);
}

export { assert };
