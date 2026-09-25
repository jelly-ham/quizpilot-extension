import { Question, type QuestionInput } from '@quizpilot/shared';
import { describe, expect, it } from 'vitest';
import { formatAnswer, markUnverified, mergeVision, withFigure, type Entry } from './merge';

const q = (i: QuestionInput) => Question.parse(i);
const crop = 'data:image/jpeg;base64,AAAA';

const entry = (question: Question): Entry => ({
  id: question.id,
  frameId: 0,
  localId: 'q1',
  question,
  status: 'incomplete',
  fillable: true,
  visionChecked: false,
  tags: [],
});

const domChoice = entry(
  q({
    id: 'f0-q1',
    kind: 'single',
    stem: '（题干未识别）',
    options: [
      { key: 'A', text: '（无文字）' },
      { key: 'B', text: '（无文字）' },
    ],
  }),
);

describe('mergeVision', () => {
  it('takes vision text but keeps DOM option keys so the answer can be filled', () => {
    const read = q({
      id: 'v1',
      kind: 'single',
      stem: '哪个是正方形？',
      options: [
        { key: '1', text: '图一' },
        { key: '2', text: '图二' },
      ],
      source: 'vision',
    });
    const out = mergeVision(domChoice, read, crop);
    expect(out.fillable).toBe(true);
    expect(out.question).toMatchObject({
      id: 'f0-q1',
      stem: '哪个是正方形？',
      source: 'vision',
      options: [
        { key: 'A', text: '图一' },
        { key: 'B', text: '图二' },
      ],
    });
    expect(out.tags).toEqual(['截图识别']);
  });

  it('keeps checkbox questions multi-select and attaches the crop when a figure matters', () => {
    const dom = entry(
      q({
        id: 'f0-q2',
        kind: 'multi',
        stem: '?',
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
      }),
    );
    const read = q({
      id: 'v1',
      kind: 'single',
      stem: 'Which shapes are shaded?',
      options: [
        { key: 'A', text: 'left' },
        { key: 'B', text: 'right' },
      ],
      needsVision: true,
    });
    const out = mergeVision(dom, read, crop);
    expect(out.question).toMatchObject({
      kind: 'multi',
      needsVision: true,
      images: [{ id: 'crop', dataUrl: crop }],
    });
    expect(out.tags).toContain('看图作答');
  });

  it('falls back to display-only when shapes disagree', () => {
    const read = q({
      id: 'v1',
      kind: 'single',
      stem: 'x?',
      options: [
        { key: 'A', text: '1' },
        { key: 'B', text: '2' },
        { key: 'C', text: '3' },
      ],
    });
    const out = mergeVision(domChoice, read, crop);
    expect(out.fillable).toBe(false);
    expect(out.question.options).toHaveLength(3);
    expect(out.tags).toContain('仅显示答案');
  });

  it('keeps DOM blank count for fill questions', () => {
    const dom = entry(q({ id: 'f0-q3', kind: 'fill', stem: ' ___  ___', blanks: 2 }));
    const read = q({ id: 'v1', kind: 'fill', stem: '北京是 ___ 的首都，位于 ___ 部', blanks: 2 });
    const out = mergeVision(dom, read, crop);
    expect(out.question).toMatchObject({
      kind: 'fill',
      blanks: 2,
      stem: '北京是 ___ 的首都，位于 ___ 部',
    });
    expect(out.fillable).toBe(true);
  });

  it('marks unreadable results', () => {
    expect(mergeVision(domChoice, undefined, crop).tags).toEqual(['识别不完整']);
  });
});

describe('withFigure', () => {
  it('routes to a vision model with the crop attached', () => {
    const out = withFigure(domChoice, crop);
    expect(out.question).toMatchObject({
      needsVision: true,
      images: [{ id: 'figure', dataUrl: crop }],
    });
  });
});

describe('formatAnswer', () => {
  const single = q({
    id: 's',
    kind: 'single',
    stem: '?',
    options: [
      { key: 'A', text: '3' },
      { key: 'B', text: '4' },
    ],
  });
  it('renders each kind', () => {
    expect(formatAnswer(single, { id: 's', kind: 'single', model: 'm', choice: 'B' })).toBe('B. 4');
    expect(
      formatAnswer(q({ id: 'j', kind: 'judge', stem: '?' }), {
        id: 'j',
        kind: 'judge',
        model: 'm',
        bool: false,
      }),
    ).toBe('错误 ✗');
    expect(
      formatAnswer(q({ id: 'f', kind: 'fill', stem: '?' }), {
        id: 'f',
        kind: 'fill',
        model: 'm',
        text: ['a', 'b'],
      }),
    ).toBe('a；b');
  });
});

describe('markUnverified', () => {
  it('flags figure and incomplete questions that were not read from a screenshot', () => {
    expect(markUnverified({ ...domChoice, status: 'figure' }).tags).toEqual(['未看图，仅供参考']);
    expect(markUnverified(domChoice).tags).toEqual(['识别不完整']);
    expect(markUnverified({ ...domChoice, status: 'ok' }).tags).toEqual([]);
    expect(markUnverified(withFigure(domChoice, crop)).tags).toEqual(['看图作答']);
  });
});
