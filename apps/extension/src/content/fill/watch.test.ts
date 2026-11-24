import type { Answer } from '@quizpilot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, testLayout } from '../../test/dom';
import { extractGeneric } from '../extract/generic';
import { fillAnswers } from './fill';
import { AnswerWatch, suggested, WATCH_MS } from './watch';

const noSleep = { humanize: false, sleep: async () => {} };
const answer = (id: string, a: Partial<Answer>): Answer => ({
  id,
  kind: 'single',
  model: 'm',
  ...a,
});

function setup(html: string) {
  mount(html);
  return extractGeneric(document, testLayout);
}

const QUIZ = `
  <div id="q1"><p>Which is two?</p><label><input type="radio" name="a">one</label><label><input type="radio" name="a">two</label><label><input type="radio" name="a">three</label></div>
  <div id="q2"><p>Pick primes</p><label><input type="checkbox" name="b">2</label><label><input type="checkbox" name="b">3</label><label><input type="checkbox" name="b">4</label></div>`;

const inputs = () => [...document.querySelectorAll('input')];

beforeEach(() => {
  document.body.innerHTML = '';
});

async function filledWatch(share = false) {
  const [single, multi] = setup(QUIZ);
  await fillAnswers(
    [
      { anchor: single!.anchor, answer: answer('q1', { choice: 'B' }) },
      { anchor: multi!.anchor, answer: answer('q2', { kind: 'multi', choices: ['A', 'B'] }) },
    ],
    noSleep,
  );
  const send = vi.fn();
  const watch = new AnswerWatch('run-1', share, send, 0);
  // As the content script does: choice questions are compared with the answer given.
  watch.add('q1', single!.anchor, suggested(answer('q1', { choice: 'B' }), single!.anchor)!);
  watch.add(
    'q2',
    multi!.anchor,
    suggested(answer('q2', { kind: 'multi', choices: ['A', 'B'] }), multi!.anchor)!,
  );
  return { watch, send };
}

describe('AnswerWatch', () => {
  it('reports kept answers, a changed choice and a cleared one', async () => {
    const { watch, send } = await filledWatch();
    inputs()[2]!.click(); // q1: three instead of two
    inputs()[3]!.click(); // q2: untick 2
    inputs()[4]!.click(); // q2: untick 3, nothing left
    expect(watch.check(1)).toBe(false);
    watch.flush();
    watch.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual([
      { id: 'q1', verdict: 'changed' },
      { id: 'q2', verdict: 'cleared' },
    ]);
  });

  it('says which options the user ended up with only when sharing is on', async () => {
    const { watch, send } = await filledWatch(true);
    inputs()[0]!.click();
    watch.check(1);
    watch.flush();
    expect(send.mock.calls[0]![0]).toEqual([
      { id: 'q1', verdict: 'changed', picked: ['A'] },
      { id: 'q2', verdict: 'kept', picked: ['A', 'B'] },
    ]);
  });

  it('keeps the last verdict once a question leaves or its controls show another question', async () => {
    const { watch, send } = await filledWatch();
    inputs()[0]!.click(); // q1 changed…
    watch.check(1);
    document.getElementById('q1')!.remove(); // …then the page moved on
    // A quiz that reuses its inputs for the next question: new text, nothing ticked.
    document.querySelector('#q2 p')!.textContent = 'Next question';
    for (const i of inputs()) i.checked = false;
    expect(watch.check(2)).toBe(true);
    watch.flush();
    expect(send.mock.calls[0]![0]).toEqual([
      { id: 'q1', verdict: 'changed' },
      { id: 'q2', verdict: 'kept' },
    ]);
  });

  it('compares with the answer, so a page that settles after the fill is not a change', async () => {
    const [single] = setup(QUIZ);
    const send = vi.fn();
    const watch = new AnswerWatch('run-4', false, send, 0);
    // The site applies the click a tick later: nothing is checked yet when the watch starts.
    watch.add('q1', single!.anchor, suggested(answer('q1', { choice: 'B' }), single!.anchor)!);
    inputs()[1]!.checked = true;
    watch.check(1);
    watch.flush();
    expect(send.mock.calls[0]![0]).toEqual([{ id: 'q1', verdict: 'kept' }]);
  });

  it('does not read a class-only option under the pointer as picked', () => {
    mount(`<div><p>Pick one</p>
      <div class="opt sel" style="cursor:pointer">A. red</div>
      <div class="opt" style="cursor:pointer">B. blue</div></div>`);
    const [q] = extractGeneric(document, testLayout);
    expect(q!.anchor.type).toBe('choice');
    const send = vi.fn();
    const watch = new AnswerWatch('run-5', true, send, 0);
    watch.add('q1', q!.anchor, 'A');
    // Hovering B: the site's hover style adds the same class it uses for the chosen option.
    const anchor = q!.anchor;
    if (anchor.type !== 'choice') throw new Error('expected a choice question');
    const b = anchor.options[1]!.control;
    b.classList.add('active');
    vi.spyOn(b, 'matches').mockImplementation((sel: string) => sel === ':hover');
    watch.check(1);
    watch.flush();
    expect(send.mock.calls[0]![0]).toEqual([{ id: 'q1', verdict: 'kept', picked: ['A'] }]);
  });

  it('reports nothing once discarded (the user undid the fill)', async () => {
    const { watch, send } = await filledWatch();
    inputs()[0]!.click();
    watch.discard();
    watch.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('gives up after the watch period', async () => {
    const { watch } = await filledWatch();
    expect(watch.check(WATCH_MS + 1)).toBe(true);
  });

  it('assist mode: compares the user’s pick with the outlined suggestion', () => {
    const [single, multi] = setup(QUIZ);
    const send = vi.fn();
    const watch = new AnswerWatch('run-2', false, send, 0);
    const a1 = answer('q1', { choice: 'B' });
    const a2 = answer('q2', { kind: 'multi', choices: ['A', 'B'] });
    watch.add('q1', single!.anchor, suggested(a1, single!.anchor)!);
    watch.add('q2', multi!.anchor, suggested(a2, multi!.anchor)!);
    inputs()[1]!.click(); // q1: followed the suggestion
    watch.check(1);
    watch.flush(); // q2 never touched
    expect(send.mock.calls[0]![0]).toEqual([
      { id: 'q1', verdict: 'kept' },
      { id: 'q2', verdict: 'cleared' },
    ]);
  });

  it('notices edited text in blanks', async () => {
    const [blank] = setup(`<p>Capital of France: <input type="text"></p>`);
    await fillAnswers(
      [{ anchor: blank!.anchor, answer: answer('q1', { kind: 'fill', text: ['Paris'] }) }],
      noSleep,
    );
    const send = vi.fn();
    const watch = new AnswerWatch('run-3', true, send, 0);
    watch.add('q1', blank!.anchor);
    inputs()[0]!.value = 'Lyon';
    watch.check(1);
    watch.flush();
    // Typed text never leaves the page, even with sharing on.
    expect(send.mock.calls[0]![0]).toEqual([{ id: 'q1', verdict: 'changed' }]);
  });
});
