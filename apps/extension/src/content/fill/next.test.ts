import { beforeEach, describe, expect, it } from 'vitest';
import { mount, testLayout } from '../../test/dom';
import { findNext } from './next';

const found = () => {
  const r = findNext(document, testLayout);
  return r && { kind: r.kind, label: r.label };
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findNext', () => {
  it('finds a next-question button, pressing the outermost element', () => {
    mount(`<p>1. 题目</p><button class="btn"><span>下一题</span></button>`);
    const r = findNext(document, testLayout);
    expect(r?.kind).toBe('next');
    expect(r?.kind === 'next' && r.el.tagName).toBe('BUTTON');
  });

  it('accepts clickable divs but not plain text', () => {
    mount(`<p>点击下一题继续</p><div class="go">下一题 →</div>`);
    expect(found()).toBeNull();
    mount(`<div class="go" style="cursor:pointer">下一题 →</div>`);
    expect(found()).toEqual({ kind: 'next', label: '下一题 →' });
  });

  it('skips disabled buttons and site navigation', () => {
    mount(`
      <nav><a href="/p2">下一页</a></nav>
      <button disabled>下一题</button>
      <div class="next is-disabled" style="cursor:pointer">下一题</div>`);
    expect(found()).toBeNull();
  });

  it('reports a submit-only page instead of pressing submit', () => {
    mount(`<p>最后一题</p><button>提交试卷</button>`);
    expect(found()).toEqual({ kind: 'submit', label: '提交试卷' });
  });

  it('prefers next over submit when both exist', () => {
    mount(`<button>下一题</button><button>交卷</button>`);
    expect(found()?.kind).toBe('next');
  });

  it('matches labels with arrows and symbols, and icon buttons by aria-label', () => {
    mount(`<button class="w3-btn">Next ❯</button>`);
    expect(found()).toEqual({ kind: 'next', label: 'Next ❯' });
    mount(`<button aria-label="下一题"><svg></svg></button>`);
    expect(found()).toEqual({ kind: 'next', label: '下一题' });
  });

  it('ignores site pagination', () => {
    mount(`<ul class="pager"><li><a href="?page=1">next ›</a></li></ul>`);
    expect(found()).toBeNull();
  });
});
