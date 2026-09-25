import type { Answer } from '@quizpilot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, testLayout } from '../../test/dom';
import { extractGeneric } from '../extract/generic';
import { fillAnswers, isChecked } from './fill';

const noSleep = { humanize: false, sleep: async () => {} };

function setup(html: string) {
  mount(html);
  return extractGeneric(document, testLayout);
}

const answer = (id: string, a: Partial<Answer>): Answer => ({
  id,
  kind: 'single',
  model: 'm',
  ...a,
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('fillAnswers', () => {
  it('checks radios, syncs checkboxes and maps true/false to options', async () => {
    const [single, multi, judge] = setup(`
      <div><p>Single?</p><label><input type="radio" name="a">x</label><label><input type="radio" name="a">y</label></div>
      <div><p>Multi?</p><label><input type="checkbox" name="b">1</label><label><input type="checkbox" name="b" checked>2</label><label><input type="checkbox" name="b">3</label></div>
      <div><p>Judge?</p><label><input type="radio" name="c">正确</label><label><input type="radio" name="c">错误</label></div>`);
    const changes = vi.fn();
    document.addEventListener('change', changes);

    const { outcomes } = await fillAnswers(
      [
        { anchor: single!.anchor, answer: answer('q1', { choice: 'B' }) },
        { anchor: multi!.anchor, answer: answer('q2', { kind: 'multi', choices: ['A', 'C'] }) },
        { anchor: judge!.anchor, answer: answer('q3', { kind: 'judge', bool: false }) },
      ],
      noSleep,
    );

    expect(outcomes.every((o) => o.ok)).toBe(true);
    const inputs = [...document.querySelectorAll('input')].map((i) => i.checked);
    expect(inputs).toEqual([false, true, true, false, true, false, true]);
    expect(changes).toHaveBeenCalled();
  });

  it('writes text through the native setter so framework trackers see it', async () => {
    const [fill] = setup(
      `<p>Capital of France is <input type="text"> and of Italy is <input type="text">.</p>`,
    );
    const inputs = [...document.querySelectorAll('input')];
    // Mimic React: an instance-level value property that swallows direct assignment.
    const swallowed: string[] = [];
    Object.defineProperty(inputs[0]!, 'value', {
      configurable: true,
      get() {
        return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(
          this,
        );
      },
      set(v: string) {
        swallowed.push(v);
      },
    });
    const events: string[] = [];
    inputs[0]!.addEventListener('input', () => events.push('input'));

    await fillAnswers(
      [{ anchor: fill!.anchor, answer: answer('q1', { kind: 'fill', text: ['Paris', 'Rome'] }) }],
      noSleep,
    );

    expect(inputs.map((i) => i.value)).toEqual(['Paris', 'Rome']);
    expect(swallowed).toEqual([]);
    expect(events).toEqual(['input']);
  });

  it('types character by character when humanized', async () => {
    const [fill] = setup(`<p>Type the word here: <input type="text"></p>`);
    const inputs: string[] = [];
    document
      .querySelector('input')!
      .addEventListener('input', (e) => inputs.push((e.target as HTMLInputElement).value));
    await fillAnswers(
      [{ anchor: fill!.anchor, answer: answer('q1', { kind: 'fill', text: ['abc'] }) }],
      {
        humanize: true,
        sleep: async () => {},
      },
    );
    expect(inputs).toEqual(['a', 'ab', 'abc']);
  });

  it('selects options in a <select>', async () => {
    const [q] = setup(
      `<div><label for="s">Pick a number</label><select id="s"><option value="">请选择</option><option value="1">one</option><option value="2">two</option></select></div>`,
    );
    await fillAnswers([{ anchor: q!.anchor, answer: answer('q1', { choice: 'B' }) }], noSleep);
    expect(document.querySelector('select')!.value).toBe('2');
  });

  it('clicks ARIA radios', async () => {
    const [q] = setup(
      `<div><p>Pick a colour</p><div role="radiogroup"><div role="radio" aria-checked="false">red</div><div role="radio" aria-checked="false">blue</div></div></div>`,
    );
    const radios = [...document.querySelectorAll('[role=radio]')];
    radios.forEach((r) =>
      r.addEventListener('click', () =>
        radios.forEach((x) => x.setAttribute('aria-checked', String(x === r))),
      ),
    );
    await fillAnswers([{ anchor: q!.anchor, answer: answer('q1', { choice: 'B' }) }], noSleep);
    expect(radios.map(isChecked)).toEqual([false, true]);
  });

  it('undo restores the previous state', async () => {
    const [choice, text] = setup(`
      <div><p>Single?</p><label><input type="radio" name="a" checked>x</label><label><input type="radio" name="a">y</label></div>
      <p>Your answer here: <input type="text" value="draft"></p>`);
    const { undo } = await fillAnswers(
      [
        { anchor: choice!.anchor, answer: answer('q1', { choice: 'B' }) },
        { anchor: text!.anchor, answer: answer('q2', { kind: 'fill', text: ['final'] }) },
      ],
      noSleep,
    );
    undo();
    const [x, y, t] = [...document.querySelectorAll('input')];
    expect([x!.checked, y!.checked, t!.value]).toEqual([true, false, 'draft']);
  });

  it('reports answers that cannot be applied', async () => {
    const [q] = setup(
      `<div><p>Pick?</p><label><input type="radio" name="a">x</label><label><input type="radio" name="a">y</label></div>`,
    );
    const { outcomes } = await fillAnswers(
      [{ anchor: q!.anchor, answer: answer('q1', { kind: 'judge', bool: true }) }],
      noSleep,
    );
    expect(outcomes).toEqual([
      { id: 'q1', ok: false, reason: 'cannot map true/false to an option' },
    ]);
  });
});
