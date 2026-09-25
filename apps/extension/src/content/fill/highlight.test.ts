import { beforeEach, describe, expect, it } from 'vitest';
import { mount, testLayout } from '../../test/dom';
import { extractGeneric } from '../extract/generic';
import { clearHighlights, highlightAnswers } from './highlight';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('highlightAnswers', () => {
  it('outlines the suggested option without clicking anything, and restores it', () => {
    mount(`
      <div class="q"><p>1. 2 + 2 = ?</p>
        <label id="a"><input type="radio" name="q1" value="a"> A. 3</label>
        <label id="b" style="outline: 1px dashed red"><input type="radio" name="q1" value="b"> B. 4</label>
      </div>`);
    let clicks = 0;
    document.addEventListener('click', () => clicks++, true);
    const [e] = extractGeneric(document, testLayout);
    const count = highlightAnswers([
      {
        answer: { id: e!.question.id, kind: 'single', choice: 'B', model: 'm' },
        anchor: e!.anchor,
      },
    ]);
    const b = document.getElementById('b')!;
    expect(count).toBe(1);
    expect(b.style.outline).toContain('#2f9e44');
    expect(document.getElementById('a')!.style.outline).toBe('');
    expect(clicks).toBe(0);
    expect([...document.querySelectorAll('input')].some((i) => i.checked)).toBe(false);

    clearHighlights();
    expect(b.style.outline).toBe('1px dashed red');
    expect(b.hasAttribute('title')).toBe(false);
  });

  it('marks an uncertain suggestion orange', () => {
    mount(`<div class="q"><p>1. 2 + 2 = ?</p>
      <label id="a"><input type="radio" name="q1"> 3</label><label><input type="radio" name="q1"> 4</label></div>`);
    const [e] = extractGeneric(document, testLayout);
    highlightAnswers([
      {
        answer: { id: 'q1', kind: 'single', choice: 'A', confidence: 0.4, model: 'm' },
        anchor: e!.anchor,
      },
    ]);
    const a = document.getElementById('a')!;
    expect(a.style.outline).toContain('#f08c00');
    expect(a.getAttribute('title')).toContain('把握不大');
    clearHighlights();
  });
});
