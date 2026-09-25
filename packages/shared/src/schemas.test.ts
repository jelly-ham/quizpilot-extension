import { describe, expect, it } from 'vitest';
import { formatIssues, Question, ReadRequest, SolveRequest, splitOptionKey } from './index';

describe('Question', () => {
  it('accepts a single-choice question', () => {
    const q = Question.parse({
      id: 'q1',
      kind: 'single',
      stem: '1 + 1 = ?',
      options: [
        { key: 'A', text: '1' },
        { key: 'B', text: '2' },
      ],
    });
    expect(q.options).toHaveLength(2);
  });

  it('rejects choice questions without enough options', () => {
    const r = Question.safeParse({
      id: 'q1',
      kind: 'multi',
      stem: 'x',
      options: [{ key: 'A', text: 'a' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate option keys', () => {
    const r = Question.safeParse({
      id: 'q1',
      kind: 'single',
      stem: 'x',
      options: [
        { key: 'A', text: 'a' },
        { key: 'A', text: 'b' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts fill questions without options', () => {
    expect(
      Question.safeParse({ id: 'q2', kind: 'fill', stem: 'Capital of France: ___', blanks: 1 })
        .success,
    ).toBe(true);
  });
});

describe('SolveRequest', () => {
  it('fills default prefs', () => {
    const r = SolveRequest.parse({
      pageUrl: 'https://example.com/quiz',
      questions: [{ id: 'q1', kind: 'judge', stem: 'The sky is blue.' }],
    });
    expect(r.prefs).toEqual({ provider: 'auto', allowEscalation: false });
  });

  it('rejects an empty question list', () => {
    expect(SolveRequest.safeParse({ pageUrl: 'https://example.com', questions: [] }).success).toBe(
      false,
    );
  });
});

describe('vision fields', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('defaults source to dom', () => {
    expect(Question.parse({ id: 'q', kind: 'judge', stem: 's' }).source).toBe('dom');
  });

  it('rejects non-image data URLs', () => {
    const r = Question.safeParse({
      id: 'q',
      kind: 'judge',
      stem: 's',
      images: [{ id: 'i', dataUrl: 'data:text/html;base64,PHA+' }],
    });
    expect(r.success).toBe(false);
  });

  it('requires images on needsVision questions in a solve request', () => {
    const base = { pageUrl: 'https://example.com' };
    const q = { id: 'q', kind: 'judge', stem: 'Is the triangle isosceles?', needsVision: true };
    expect(SolveRequest.safeParse({ ...base, questions: [q] }).success).toBe(false);
    expect(
      SolveRequest.safeParse({
        ...base,
        questions: [{ ...q, images: [{ id: 'fig', dataUrl: png }] }],
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate question ids in a solve request', () => {
    const q = { id: 'q', kind: 'judge', stem: 's' };
    expect(
      SolveRequest.safeParse({ pageUrl: 'https://example.com', questions: [q, q] }).success,
    ).toBe(false);
  });

  it('accepts a read request', () => {
    expect(
      ReadRequest.safeParse({ pageUrl: 'https://example.com', image: png, hint: 'Unit 3' }).success,
    ).toBe(true);
  });
});

describe('text helpers', () => {
  it('splitOptionKey reads common option labels', () => {
    expect(splitOptionKey('B. 4')).toEqual({ key: 'B', text: '4' });
    expect(splitOptionKey('(c) cat')).toEqual({ key: 'C', text: 'cat' });
    expect(splitOptionKey('（D）狗')).toEqual({ key: 'D', text: '狗' });
    expect(splitOptionKey('B.')).toEqual({ key: 'B', text: '' });
    expect(splitOptionKey('4')).toBeNull();
  });

  it('formatIssues joins paths and messages', () => {
    const r = SolveRequest.safeParse({ pageUrl: 'nope', questions: [] });
    expect(r.success).toBe(false);
    expect(formatIssues(r.error!)).toMatch(/^pageUrl: .+; questions: .+/);
  });
});
