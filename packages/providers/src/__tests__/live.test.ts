/**
 * Live accuracy check against the real Jev model through OpenRouter. Skipped unless a key is set:
 *   OPENROUTER_API_KEY=sk-or-... pnpm --filter @quizpilot/providers exec vitest run live
 */
import type { Answer } from '@quizpilot/shared';
import { describe, expect, it } from 'vitest';
import { createJevProvider } from '../jev';
import { createOpenAICompatibleProvider } from '../openai-compatible';
import { routeSolve } from '../router';
import { q } from './helpers';

// Read through globalThis: this package is typed for browsers and Workers, not Node.
const key = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .OPENROUTER_API_KEY;

const opts = (...texts: string[]) =>
  texts.map((text, i) => ({ key: String.fromCharCode(65 + i), text }));

/** Questions with known answers: [question, expected]. */
const CASES = [
  [
    q({ id: 's1', kind: 'single', stem: '2 + 2 = ?', options: opts('3', '4', '5', '22') }),
    { choice: 'B' },
  ],
  [
    q({
      id: 's2',
      kind: 'single',
      stem: '中国的首都是哪座城市？',
      options: opts('上海', '广州', '北京', '深圳'),
    }),
    { choice: 'C' },
  ],
  [
    q({
      id: 's3',
      kind: 'single',
      stem: '下列哪种动物是哺乳动物？',
      options: opts('鲨鱼', '鲸鱼', '海龟', '章鱼'),
    }),
    { choice: 'B' },
  ],
  [
    q({
      id: 's4',
      kind: 'single',
      stem: 'Which planet is known as the Red Planet?',
      options: opts('Venus', 'Jupiter', 'Mars', 'Saturn'),
    }),
    { choice: 'C' },
  ],
  [
    q({
      id: 's5',
      kind: 'single',
      stem: '光合作用主要发生在植物细胞的哪个结构中？',
      options: opts('线粒体', '叶绿体', '细胞核', '核糖体'),
    }),
    { choice: 'B' },
  ],
  [
    q({
      id: 's6',
      kind: 'single',
      stem: '《红楼梦》的作者是谁？',
      options: opts('罗贯中', '施耐庵', '吴承恩', '曹雪芹'),
    }),
    { choice: 'D' },
  ],
  [
    q({
      id: 's7',
      kind: 'single',
      stem: 'What is the derivative of x^2?',
      options: opts('x', '2x', 'x^2', '2'),
    }),
    { choice: 'B' },
  ],
  [
    q({
      id: 's8',
      kind: 'single',
      stem: 'H2O 的化学名称是？',
      options: opts('过氧化氢', '水', '氢气', '氧气'),
    }),
    { choice: 'B' },
  ],
  [
    q({
      id: 'm1',
      kind: 'multi',
      stem: '下列哪些是质数？',
      options: opts('2', '4', '7', '9', '11'),
    }),
    { choices: ['A', 'C', 'E'] },
  ],
  [
    q({
      id: 'm2',
      kind: 'multi',
      stem: 'Which of these are programming languages?',
      options: opts('Python', 'HTML', 'Rust', 'JPEG'),
    }),
    { choices: ['A', 'C'] },
  ],
  [
    q({
      id: 'm3',
      kind: 'multi',
      stem: '以下哪些属于可再生能源？',
      options: opts('太阳能', '煤炭', '风能', '石油', '水能'),
    }),
    { choices: ['A', 'C', 'E'] },
  ],
  [q({ id: 'j1', kind: 'judge', stem: '水在标准大气压下的沸点是 100°C。' }), { bool: true }],
  [q({ id: 'j2', kind: 'judge', stem: '太阳绕着地球转。' }), { bool: false }],
  [
    q({ id: 'j3', kind: 'judge', stem: 'The Pacific Ocean is the largest ocean on Earth.' }),
    { bool: true },
  ],
  [q({ id: 'j4', kind: 'judge', stem: '1 公里等于 100 米。' }), { bool: false }],
  [q({ id: 'j5', kind: 'judge', stem: 'DNA 的双螺旋结构由沃森和克里克提出。' }), { bool: true }],
] as const;

const correct = (a: Answer | undefined, want: (typeof CASES)[number][1]) => {
  if (!a) return false;
  if ('choice' in want) return a.choice === want.choice;
  if ('choices' in want) return JSON.stringify(a.choices) === JSON.stringify(want.choices);
  return a.bool === want.bool;
};

describe.skipIf(!key)('live Jev via OpenRouter', () => {
  it('answers a mixed quiz in one call with high accuracy', { timeout: 60_000 }, async () => {
    const cases = CASES;
    const jev = createJevProvider({ id: 'jev', apiKey: key!, via: 'openrouter' });
    const started = Date.now();
    const out = await jev.solve(cases.map(([question]) => question));
    const ms = Date.now() - started;

    const rows = cases.map(([question, want]) => {
      const a = out.answers.find((x) => x.id === question.id);
      return {
        id: question.id,
        ok: correct(a, want),
        got: a?.choice ?? a?.choices?.join(',') ?? a?.bool,
        want:
          'choice' in want ? want.choice : 'choices' in want ? want.choices.join(',') : want.bool,
        conf: a?.confidence?.toFixed(2),
      };
    });
    console.table(rows);
    const accuracy = rows.filter((r) => r.ok).length / rows.length;
    console.log(
      `accuracy ${(accuracy * 100).toFixed(0)}% · ${ms}ms · ${out.usage.inputTokens} input tokens · $${(out.usage.costMicroUsd / 1e6).toFixed(6)}`,
    );

    expect(out.errors).toEqual([]);
    expect(accuracy).toBeGreaterThanOrEqual(0.85);
  });
});

// ---------------------------------------------------------------- multimodal LLM via OpenRouter

const LLM_MODEL = 'deepseek/deepseek-v4.1-flash';

async function fixture(name: string): Promise<string> {
  // node:fs through a string specifier: this package isn't typed for Node.
  const fs = (await import('node:fs/promises' as string)) as {
    readFile(p: URL): Promise<Uint8Array>;
  };
  const bytes = await fs.readFile(new URL(`./fixtures/${name}`, import.meta.url));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

const llm = () =>
  createOpenAICompatibleProvider({
    id: 'llm',
    baseURL: 'https://openrouter.ai/api/v1',
    model: LLM_MODEL,
    apiKey: key!,
    vision: true,
    timeoutMs: 120_000,
  });

const report = (
  label: string,
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number },
  ms: number,
) =>
  console.log(
    `${label}: ${ms}ms · ${usage.inputTokens} in / ${usage.outputTokens} out · $${(usage.costMicroUsd / 1e6).toFixed(6)}`,
  );

describe.skipIf(!key)(`live ${LLM_MODEL} via OpenRouter`, () => {
  it('answers fill-in and essay questions', { timeout: 120_000 }, async () => {
    const t = Date.now();
    const out = await llm().solve([
      q({ id: 'f1', kind: 'fill', stem: '中国的首都是 ___ ，最大的城市是 ___ 。', blanks: 2 }),
      q({ id: 'f2', kind: 'fill', stem: 'The chemical symbol for gold is ___.', blanks: 1 }),
      q({ id: 'e1', kind: 'essay', stem: '用一两句话解释什么是光合作用。' }),
    ]);
    report('text', out.usage, Date.now() - t);
    console.log(JSON.stringify(out.answers, null, 1), out.errors);
    expect(out.errors).toEqual([]);
    const byId = Object.fromEntries(out.answers.map((a) => [a.id, a]));
    expect(byId.f1!.text).toEqual(['北京', '上海']);
    expect(String(byId.f2!.text)).toMatch(/Au/);
    expect(String(byId.e1!.text).length).toBeGreaterThan(10);
  });

  it('transcribes a question from a screenshot', { timeout: 120_000 }, async () => {
    const t = Date.now();
    const out = await llm().read!({
      pageUrl: 'https://example.com',
      image: await fixture('text-question.png'),
    });
    report('read', out.usage, Date.now() - t);
    console.log(JSON.stringify(out.questions, null, 1));
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]).toMatchObject({ kind: 'single', source: 'vision' });
    expect(out.questions[0]!.stem).toContain('日本');
    expect(out.questions[0]!.options!.map((o) => o.text)).toEqual([
      '大阪',
      '京都',
      '东京',
      '名古屋',
    ]);
  });

  it('answers a question that needs the figure', { timeout: 120_000 }, async () => {
    const t = Date.now();
    const out = await llm().solve([
      q({
        id: 'g1',
        kind: 'single',
        stem: '5. 如图所示，求 x 的长度。',
        options: opts('5', '6', '7', '12'),
        needsVision: true,
        images: [{ id: 'figure', dataUrl: await fixture('figure-question.png') }],
      }),
    ]);
    report('vision', out.usage, Date.now() - t);
    console.log(JSON.stringify(out.answers), out.errors);
    expect(out.answers[0]?.choice).toBe('A');
  });

  it('routes a mixed quiz across Jev and the LLM', { timeout: 120_000 }, async () => {
    const providers = new Map([
      ['jev', createJevProvider({ id: 'jev', apiKey: key!, via: 'openrouter' })],
      ['llm', llm()],
    ]);
    const t = Date.now();
    const out = await routeSolve(
      [
        CASES[0]![0],
        CASES[8]![0],
        CASES[11]![0],
        q({ id: 'f1', kind: 'fill', stem: '一年有 ___ 个月。', blanks: 1 }),
      ],
      providers,
      { choice: 'jev', text: 'llm', vision: 'llm' },
      { provider: 'auto', allowEscalation: false },
    );
    console.log(
      `mixed: ${Date.now() - t}ms`,
      out.usage.map(
        (u) => `${u.provider}:${u.questionCount}q $${(u.costMicroUsd / 1e6).toFixed(6)}`,
      ),
    );
    expect(out.errors).toEqual([]);
    expect(out.answers.map((a) => a.id)).toEqual(['s1', 'm1', 'j1', 'f1']);
    expect(out.answers[3]!.text).toEqual(['12']);
    expect(out.usage.map((u) => u.provider).sort()).toEqual(['jev', 'llm']);
  });
});
