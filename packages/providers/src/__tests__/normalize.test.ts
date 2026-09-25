import { describe, expect, it } from 'vitest';
import { InvalidAnswer, normalizeAnswer } from '../normalize';
import { fill, judge, multi, q, single } from './helpers';

describe('normalizeAnswer', () => {
  it('matches option keys loosely and by unique text', () => {
    expect(normalizeAnswer(single('s'), { choice: '(b)' }, 'm').choice).toBe('B');
    expect(normalizeAnswer(single('s'), { choice: '4' }, 'm').choice).toBe('B');
    expect(() => normalizeAnswer(single('s'), { choice: 'E' }, 'm')).toThrow(InvalidAnswer);
  });

  it('keeps multi answers in page order, deduplicated', () => {
    expect(normalizeAnswer(multi('m'), { choices: ['C', 'A', 'a'] }, 'm').choices).toEqual([
      'A',
      'C',
    ]);
    expect(() => normalizeAnswer(multi('m'), { choices: [] }, 'm')).toThrow(InvalidAnswer);
  });

  it('reads booleans in several languages', () => {
    expect(normalizeAnswer(judge('j'), { bool: '正确' }, 'm').bool).toBe(true);
    expect(normalizeAnswer(judge('j'), { bool: 'False' }, 'm').bool).toBe(false);
    expect(() => normalizeAnswer(judge('j'), { bool: 'maybe' }, 'm')).toThrow(InvalidAnswer);
  });

  it('checks the number of blanks', () => {
    expect(normalizeAnswer(fill('f', 2), { text: ['a', 'b'] }, 'm').text).toEqual(['a', 'b']);
    expect(() => normalizeAnswer(fill('f', 2), { text: 'a' }, 'm')).toThrow(/expected 2 blanks/);
  });

  it('joins essay paragraphs and clamps confidence', () => {
    const essay = q({ id: 'e', kind: 'essay', stem: 'Discuss.' });
    expect(normalizeAnswer(essay, { text: ['p1', 'p2'], confidence: 3 }, 'm')).toEqual({
      id: 'e',
      kind: 'essay',
      model: 'm',
      text: 'p1\np2',
      confidence: 1,
    });
  });
});
