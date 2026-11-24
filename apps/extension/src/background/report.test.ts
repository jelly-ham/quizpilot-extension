import { RunReport, type Question } from '@quizpilot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, postVerdicts } from '../lib/api';
import type { Entry } from './merge';
import { buildRunReport, sendVerdicts, sourceOf, type ReportInput } from './report';

vi.mock('../lib/api', async (load) => ({
  ...(await load<typeof import('../lib/api')>()),
  postRunReport: vi.fn(async () => ({ ok: true })),
  postVerdicts: vi.fn(),
}));

afterEach(() => {
  vi.mocked(postVerdicts).mockReset();
  vi.useRealTimers();
});

const entry = (id: string, over: Partial<Entry> = {}, q: Partial<Question> = {}): Entry => ({
  id,
  frameId: 0,
  localId: id,
  question: {
    id,
    kind: 'single',
    stem: 'Which is two?',
    options: [
      { key: 'A', text: 'one' },
      { key: 'B', text: 'two' },
    ],
    source: 'dom',
    ...q,
  },
  status: 'ok',
  fillable: true,
  visionChecked: false,
  tags: [],
  ...over,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  runId: crypto.randomUUID(),
  pageUrl: 'https://quiz.example.com/q',
  mode: 'page',
  tier: 'fast',
  via: 'generic',
  version: '0.1.6',
  entries: [
    entry('f0-q1'),
    entry('f0-q2', { status: 'incomplete', visionChecked: true }),
    entry('f0-q3', { status: 'figure', visionChecked: true }),
  ],
  answers: {
    'f0-q1': { id: 'f0-q1', kind: 'single', choice: 'B', confidence: 0.8, model: 'm1' },
    'f0-q3': { id: 'f0-q3', kind: 'single', choice: 'A', reviewed: true, model: 'm2' },
  },
  errors: { 'f0-q2': 'unreadable_options' },
  fills: {
    'f0-q1': { ok: true },
    'f0-q3': { ok: false, reason: 'answer is not one of the options' },
  },
  share: false,
  ...over,
});

describe('buildRunReport', () => {
  it('describes each question without its text', () => {
    const r = buildRunReport(input())!;
    expect(RunReport.safeParse(r).success).toBe(true);
    expect(r.questions).toEqual([
      {
        qid: 'f0-q1',
        kind: 'single',
        source: 'dom',
        status: 'ok',
        model: 'm1',
        confidence: 0.8,
        answered: true,
        fill: 'ok',
      },
      {
        qid: 'f0-q2',
        kind: 'single',
        source: 'screenshot',
        status: 'incomplete',
        answered: false,
        error: 'unreadable_options',
        fill: 'none',
      },
      {
        qid: 'f0-q3',
        kind: 'single',
        source: 'figure',
        status: 'figure',
        model: 'm2',
        reviewed: true,
        answered: true,
        fill: 'failed',
        fillReason: 'answer is not one of the options',
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('Which is two?');
  });

  it('adds the question, options and answer only when sharing is on', () => {
    const r = buildRunReport(input({ share: true }))!;
    expect(RunReport.safeParse(r).success).toBe(true);
    expect(r.questions[0]!.content).toEqual({
      stem: 'Which is two?',
      options: [
        { key: 'A', text: 'one' },
        { key: 'B', text: 'two' },
      ],
      answer: { choice: 'B' },
    });
    expect(r.questions[1]!.content).not.toHaveProperty('answer');
  });

  it('cuts long text to what the server accepts', () => {
    const long = 'x'.repeat(9000);
    const r = buildRunReport(
      input({ share: true, entries: [entry('f0-q1', {}, { stem: long })], fills: {} }),
    )!;
    expect(RunReport.safeParse(r).success).toBe(true);
    expect(r.questions[0]!.content!.stem).toHaveLength(4000);
  });

  it('is null for a run without questions', () => {
    expect(buildRunReport(input({ entries: [] }))).toBeNull();
  });

  it('sends the page origin only, and nothing for pages without one', () => {
    const r = buildRunReport(input({ pageUrl: 'https://quiz.example.com/exam/1?sid=123#q2' }))!;
    expect(r.pageUrl).toBe('https://quiz.example.com');
    expect(buildRunReport(input({ pageUrl: 'about:blank' }))).toBeNull();
  });
});

describe('sourceOf', () => {
  it('tells region and whole-page screenshots apart', () => {
    const shot = entry('shot-1', { fillable: false, visionChecked: true, status: 'incomplete' });
    expect(sourceOf(shot, 'region')).toBe('region');
    expect(sourceOf(shot, 'fullshot')).toBe('fullshot');
  });
});

describe('sendVerdicts', () => {
  const verdicts = [{ id: 'q1', verdict: 'changed' as const, picked: ['A'] }];

  it('maps frame-local ids to run ids', async () => {
    vi.mocked(postVerdicts).mockResolvedValue({ ok: true });
    await sendVerdicts('run-1', 2, verdicts);
    expect(postVerdicts).toHaveBeenCalledWith('run-1', {
      verdicts: [{ qid: 'f2-q1', verdict: 'changed', picked: ['A'] }],
    });
  });

  it('retries while the run is not stored yet, and stops on other errors', async () => {
    vi.useFakeTimers();
    const missing = new ApiError(404, 'not_found', 'not found');
    vi.mocked(postVerdicts).mockRejectedValueOnce(missing).mockResolvedValueOnce({ ok: true });
    const done = sendVerdicts('run-2', 0, verdicts);
    await vi.runAllTimersAsync();
    await done;
    expect(postVerdicts).toHaveBeenCalledTimes(2);

    vi.mocked(postVerdicts)
      .mockReset()
      .mockRejectedValue(new ApiError(429, 'rate_limited', ''));
    await sendVerdicts('run-3', 0, verdicts);
    expect(postVerdicts).toHaveBeenCalledTimes(1);
  });
});
