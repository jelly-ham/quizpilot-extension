// Render the 1200x630 social (Open Graph) cards into apps/web/public/og-<lang>.png.
//
//   pnpm --filter @quizpilot/extension og            # every language below
//   pnpm --filter @quizpilot/extension og ja ko      # only some languages
//
// Latin brand fonts come from apps/web/public/fonts. CJK glyphs need a webfont:
// Noto Sans JP/KR/SC are downloaded once into .cache/og-fonts (git-ignored) and
// inlined as base64, so the render has no external requests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, '../web');
const pub = join(web, 'public');
const fontCache = join(root, '.cache/og-fonts');

const FAMILY = {
  latin: 'Space Grotesk',
  body: 'IBM Plex Sans',
  'zh-CN': 'Noto Sans SC',
  ja: 'Noto Sans JP',
  ko: 'Noto Sans KR',
};
const CJK_SRC = {
  'zh-CN': [
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-700-normal.woff2',
  ],
  ja: [
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff2',
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-700-normal.woff2',
  ],
  ko: [
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff2',
    'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-kr/files/noto-sans-kr-korean-700-normal.woff2',
  ],
};

const check = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';

const LANGS = {
  en: {
    tagline: 'AI study helper for practice questions on the web',
    bullets: [
      'Reads multiple choice, true/false, fill-in and short answer',
      'Assist mode marks the answer, you pick it yourself',
      'Choice questions go to Jev: fast and inexpensive',
    ],
    bar: 'StudyHub Practice',
    title: 'Chemistry Basics · Unit 3 Practice',
    sub: '5 questions · practice mode',
    q: [
      { text: 'Which of the following is a pure substance?', opts: ['Air', 'Sea water', 'Distilled water'], sel: [2] },
      { text: 'Which of these are chemical changes?', opts: ['Iron rusting', 'Ice melting', 'A candle burning'], sel: [0, 2], box: true },
      { text: 'A catalyst keeps the same mass before and after a reaction.', opts: ['True', 'False'], sel: [0] },
    ],
    tabs: ['Free', 'Credits'],
    tab: 1,
    balance: '38,420',
    unit: 'credits',
    packs: [['$3', '4,500'], ['$5', '10,000'], ['$10', '40,000'], ['$20', '110,000']],
    button: 'Solve this page (auto)',
    rows: ['Assist (mark answers only)', 'Continuous (auto next question)', 'Solve a selected area', 'Relearn this page layout'],
    foot: ['Settings', 'Shortcuts'],
    online: 'Online',
  },
  'zh-CN': {
    tagline: '网页练习题的 AI 学习助手',
    bullets: ['一键识别单选、多选、判断、填空和简答', '辅助答题：只标注答案，由你自己作答', '选择题交给 Jev 决策模型：快，而且便宜'],
    bar: '智学练习平台',
    title: '化学基础 · 第 3 单元练习',
    sub: '共 5 题 · 练习模式',
    q: [
      { text: '下列物质中，属于纯净物的是（　）', opts: ['空气', '海水', '蒸馏水'], sel: [2] },
      { text: '下列变化中，属于化学变化的是（多选）', opts: ['铁生锈', '冰融化', '蜡烛燃烧'], sel: [0, 2], box: true },
      { text: '催化剂在化学反应前后的质量和化学性质都不变。', opts: ['对', '错'], sel: [0] },
    ],
    tabs: ['免费版', '点数版'],
    tab: 1,
    balance: '38,420',
    unit: '点',
    packs: [['$3', '4,500 点'], ['$5', '10,000 点'], ['$10', '40,000 点'], ['$20', '110,000 点']],
    button: '解答本页（自动答题）',
    rows: ['辅助答题（仅标注答案）', '连续答题（自动下一题）', '框选区域解答', '重新识别本页结构'],
    foot: ['设置', '快捷键'],
    online: '服务在线',
  },
  ja: {
    tagline: 'ウェブの練習問題を解く AI・宿題ヘルパー',
    bullets: ['選択・正誤・穴埋め・記述に対応', 'アシストモードは答えをマーク、選ぶのは自分', '選択問題は Jev で高速・低コスト'],
    bar: '学習プラットフォーム',
    title: '化学基礎 · 第 3 単元 練習',
    sub: '全 5 問 · 練習モード',
    q: [
      { text: '次のうち、純粋な物質はどれ？', opts: ['空気', '海水', '蒸留水'], sel: [2] },
      { text: '化学変化にあたるものは？（複数選択）', opts: ['鉄のさび', '氷の融解', 'ロウソクの燃焼'], sel: [0, 2], box: true },
      { text: '触媒は反応の前後で質量が変わらない。', opts: ['正', '誤'], sel: [0] },
    ],
    tabs: ['無料', 'ポイント'],
    tab: 1,
    balance: '38,420',
    unit: 'ポイント',
    packs: [['$3', '4,500'], ['$5', '10,000'], ['$10', '40,000'], ['$20', '110,000']],
    button: 'このページを解答（自動）',
    rows: ['アシスト（答えをマーク）', '連続解答（自動で次へ）', '範囲を選んで解答', 'このページを再学習'],
    foot: ['設定', 'ショートカット'],
    online: 'オンライン',
  },
  ko: {
    tagline: '웹 연습문제를 푸는 AI · 숙제 도우미',
    bullets: ['객관식·참거짓·빈칸·주관식 지원', '어시스트 모드는 답만 표시, 선택은 직접', '객관식은 Jev로 빠르고 저렴하게'],
    bar: '학습 플랫폼',
    title: '화학 기초 · 3단원 연습',
    sub: '총 5문항 · 연습 모드',
    q: [
      { text: '다음 중 순물질은?', opts: ['공기', '바닷물', '증류수'], sel: [2] },
      { text: '화학 변화에 해당하는 것은? (복수 선택)', opts: ['철이 녹슮', '얼음이 녹음', '양초가 탐'], sel: [0, 2], box: true },
      { text: '촉매는 반응 전후에 질량이 변하지 않는다.', opts: ['참', '거짓'], sel: [0] },
    ],
    tabs: ['무료', '포인트'],
    tab: 1,
    balance: '38,420',
    unit: '포인트',
    packs: [['$3', '4,500'], ['$5', '10,000'], ['$10', '40,000'], ['$20', '110,000']],
    button: '이 페이지 풀기 (자동)',
    rows: ['어시스트 (답만 표시)', '연속 풀이 (자동 다음)', '영역 선택 풀이', '이 페이지 레이아웃 재학습'],
    foot: ['설정', '단축키'],
    online: '온라인',
  },
};

function b64(file) {
  return readFileSync(file).toString('base64');
}

async function ensureCjk(code) {
  if (!CJK_SRC[code]) return [];
  mkdirSync(fontCache, { recursive: true });
  const files = [];
  for (const url of CJK_SRC[code]) {
    const dest = join(fontCache, url.split('/').pop());
    if (!existsSync(dest)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font download failed ${res.status}: ${url}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    files.push(dest);
  }
  return files;
}

function face(family, weight, file) {
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${b64(file)})}`;
}

function fontFaces(code, cjkFiles) {
  const faces = [
    face(FAMILY.latin, 700, join(pub, 'fonts/space-grotesk-latin-700-normal.woff2')),
    face(FAMILY.body, 400, join(pub, 'fonts/ibm-plex-sans-latin-400-normal.woff2')),
    face(FAMILY.body, 600, join(pub, 'fonts/ibm-plex-sans-latin-600-normal.woff2')),
  ];
  if (cjkFiles[0]) faces.push(face(FAMILY[code], 400, cjkFiles[0]));
  if (cjkFiles[1]) faces.push(face(FAMILY[code], 700, cjkFiles[1]));
  return faces.join('\n');
}

const css = `
:root{--navy:#1b2a4a;--on:#f5f2ea;--on2:#c9cfdb;--accent:#c4501a;--accent2:#f08a55;--card:#f3f5f9;--ink:#152238;--mut:#7a86a0;--line:#e7ebf3}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:var(--navy);color:var(--on);font-family:'IBM Plex Sans',var(--cjk),sans-serif;-webkit-font-smoothing:antialiased}
.stage{position:relative;width:1200px;height:630px}
.left{position:absolute;left:0;top:0;width:640px;height:100%;padding:70px 0 0 64px}
.logo{display:flex;align-items:center;gap:16px;margin-bottom:38px}
.logo svg{width:84px;height:84px;display:block}
.wordmark{font-family:'Space Grotesk',var(--cjk),sans-serif;font-weight:700;font-size:62px;letter-spacing:-.02em;color:#fff}
.wordmark b{color:var(--accent2)}
.tagline{font-size:29px;line-height:1.34;color:var(--on2);max-width:470px;margin-bottom:36px}
ul.bullets{list-style:none;padding:0;display:flex;flex-direction:column;gap:19px}
ul.bullets li{display:flex;gap:14px;font-size:24px;line-height:1.28;color:var(--on);max-width:520px}
ul.bullets svg{flex:0 0 auto;margin-top:3px;color:var(--accent2)}
.site{position:absolute;left:64px;bottom:50px;font-family:'Space Grotesk',var(--cjk),sans-serif;font-weight:700;font-size:21px;color:var(--accent2)}
.doc{position:absolute;top:74px;left:616px;width:560px;background:var(--card);border-radius:14px;padding:16px 22px 22px;box-shadow:0 26px 64px rgba(0,0,0,.38)}
.doc-bar{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:12.5px;font-weight:600;margin-bottom:15px}
.doc-bar i{width:9px;height:9px;border-radius:50%;background:#c9d0dd;display:inline-block}
.doc-title{font-family:'Space Grotesk',var(--cjk),sans-serif;font-size:22px;font-weight:700;color:var(--ink);line-height:1.25}
.doc-sub{font-size:12.5px;color:var(--mut);margin:4px 0 15px}
.q{background:#fff;border:1px solid var(--line);border-radius:9px;padding:11px 14px;margin-bottom:9px}
.q p{font-size:14px;color:var(--ink);margin-bottom:8px;line-height:1.4}
.opts{display:flex;gap:16px;flex-wrap:wrap}
.opt{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#4a5468}
.mark{width:14px;height:14px;border:1.5px solid #b9c2d4;display:inline-block;flex:0 0 auto}
.mark.r{border-radius:50%}
.mark.b{border-radius:3px}
.opt.sel .mark{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 2.5px #fff}
.opt.sel .mark.r{box-shadow:inset 0 0 0 3px #fff}
.opt.sel{color:var(--ink);font-weight:600}
.popup{position:absolute;top:60px;left:906px;width:264px;background:#fff;border-radius:14px;box-shadow:0 32px 74px rgba(0,0,0,.5);padding:12px;color:var(--ink)}
.pp-head{display:flex;align-items:center;gap:7px;font-family:'Space Grotesk',var(--cjk),sans-serif;font-weight:700;font-size:14.5px}
.pp-head svg{width:20px;height:20px}
.pp-online{margin-left:auto;font-size:10px;color:#2f7a4b;background:#eef7f1;border-radius:999px;padding:3px 8px}
.pp-tabs{display:flex;background:#eef1f6;border-radius:8px;padding:3px;margin:11px 0 12px}
.pp-tab{flex:1;text-align:center;padding:6px 0;border-radius:6px;color:#6b7280;font-weight:600;font-size:12px}
.pp-tab.on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.14)}
.pp-bal{background:var(--navy);color:#fff;border-radius:10px;padding:12px 13px;margin-bottom:11px}
.pp-bal .n{font-family:'Space Grotesk',var(--cjk),sans-serif;font-size:26px;font-weight:700}
.pp-bal .u{font-size:11px;color:var(--on2);margin-left:5px}
.pp-packs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:11px}
.pp-pack{background:var(--card);border-radius:7px;padding:6px 2px;text-align:center}
.pp-pack b{display:block;font-size:13px;color:var(--ink)}
.pp-pack span{font-size:8px;color:#8a93a5}
.pp-btn{background:var(--accent);color:#fff;text-align:center;border-radius:9px;padding:11px 4px;font-weight:700;font-size:13px;margin-bottom:9px}
.pp-row{display:flex;align-items:center;gap:9px;padding:7px 3px;border-top:1px solid #eef1f6}
.pp-row .ic{width:22px;height:22px;border-radius:6px;background:#eef1f6;flex:0 0 auto}
.pp-row .t{font-size:12px;font-weight:600;color:var(--ink);line-height:1.15}
.pp-foot{display:flex;gap:14px;font-size:11px;color:#8a93a5;padding-top:8px;border-top:1px solid #eef1f6}
`;

function card(code, data, cjkFiles) {
  const stack = `'${FAMILY.body}','${FAMILY.latin}','${FAMILY[code]}',sans-serif`;
  const questions = data.q
    .map((q) => {
      const opts = q.opts
        .map((o, i) => {
          const on = q.sel.includes(i) ? ' sel' : '';
          const shape = q.box ? 'b' : 'r';
          return `<span class="opt${on}"><i class="mark ${shape}"></i>${o}</span>`;
        })
        .join('');
      const hint = q.box ? ' <span style="color:#8a93a5">(multiple)</span>' : '';
      return `<div class="q"><p>${q.text}${hint}</p><div class="opts">${opts}</div></div>`;
    })
    .join('');
  const tabs = data.tabs
    .map((t, i) => `<span class="pp-tab${i === data.tab ? ' on' : ''}">${t}</span>`)
    .join('');
  const packs = data.packs
    .map(([p, c]) => `<div class="pp-pack"><b>${p}</b><span>${c}</span></div>`)
    .join('');
  const rows = data.rows
    .map((r) => `<div class="pp-row"><span class="ic"></span><span class="t">${r}</span></div>`)
    .join('');
  const bullets = data.bullets.map((b) => `<li>${check}<span>${b}</span></li>`).join('');
  const icon = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
  return `<!doctype html><html lang="${code}"><head><meta charset="utf-8"><style>
${fontFaces(code, cjkFiles)}
:root{--cjk:'${FAMILY[code]}'}
${css}
body{font-family:${stack}}
</style></head><body><div class="stage">
  <div class="left">
    <div class="logo">${icon}<span class="wordmark">Quiz<b>Pilot</b></span></div>
    <div class="tagline">${data.tagline}</div>
    <ul class="bullets">${bullets}</ul>
    <div class="site">quizpilot.link</div>
  </div>
  <div class="doc">
    <div class="doc-bar"><i></i><i></i><i></i><span>${data.bar}</span></div>
    <div class="doc-title">${data.title}</div>
    <div class="doc-sub">${data.sub}</div>
    ${questions}
  </div>
  <div class="popup">
    <div class="pp-head">${icon.replace('width="64" height="64" ', '')}<span>Quiz<b style="color:var(--accent)">Pilot</b></span><span class="pp-online">${data.online}</span></div>
    <div class="pp-tabs">${tabs}</div>
    <div class="pp-bal"><span class="n">${data.balance}</span><span class="u">${data.unit}</span></div>
    <div class="pp-packs">${packs}</div>
    <div class="pp-btn">${data.button}</div>
    ${rows}
    <div class="pp-foot"><span>${data.foot[0]}</span><span>${data.foot[1]}</span></div>
  </div>
</div></body></html>`;
}

const wanted = process.argv.slice(2);
const langs = wanted.length ? wanted : Object.keys(LANGS);
for (const code of langs) {
  const data = LANGS[code];
  if (!data) throw new Error(`unknown language: ${code}`);
  const cjkFiles = await ensureCjk(code);
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(card(code, data, cjkFiles), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const dest = join(pub, `og-${code}.png`);
  await page.screenshot({ path: dest });
  await browser.close();
  console.log(`wrote ${dest}`);
}
