import { beforeEach, describe, expect, it } from 'vitest';
import { mount, testLayout } from '../../test/dom';
import { extractGeneric } from './generic';

const extract = () => extractGeneric(document, testLayout);
const summary = () =>
  extract().map(({ question: q, status }) => ({
    kind: q.kind,
    stem: q.stem,
    ...(q.options ? { options: q.options.map((o) => `${o.key}:${o.text}`) } : {}),
    ...(q.blanks ? { blanks: q.blanks } : {}),
    status,
  }));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('extractGeneric', () => {
  it('reads a typical form with every question kind, in page order', () => {
    mount(`
      <form>
        <div class="q"><p>1. 2 + 2 = ?</p>
          <label><input type="radio" name="q1"> A. 3</label>
          <label><input type="radio" name="q1"> B. 4</label>
        </div>
        <div class="q"><p>2. Which are prime?</p>
          <label><input type="checkbox" name="q2[]"> 2</label>
          <label><input type="checkbox" name="q2[]"> 4</label>
          <label><input type="checkbox" name="q2[]"> 5</label>
        </div>
        <div class="q"><p>3. 水在标准大气压下 100°C 沸腾。</p>
          <label><input type="radio" name="q3">对</label><label><input type="radio" name="q3">错</label>
        </div>
        <p>4. 中国的首都是<input type="text">，最大的城市是<input type="text">。</p>
        <div><p>5. 简述光合作用的过程。</p><textarea rows="5"></textarea></div>
        <div><label for="s">6. 1 + 1 =</label>
          <select id="s"><option value="">请选择</option><option>1</option><option>2</option></select>
        </div>
      </form>`);

    expect(summary()).toEqual([
      { kind: 'single', stem: '1. 2 + 2 = ?', options: ['A:3', 'B:4'], status: 'ok' },
      { kind: 'multi', stem: '2. Which are prime?', options: ['A:2', 'B:4', 'C:5'], status: 'ok' },
      {
        kind: 'judge',
        stem: '3. 水在标准大气压下 100°C 沸腾。',
        options: ['A:对', 'B:错'],
        status: 'ok',
      },
      { kind: 'fill', stem: '4. 中国的首都是 ___ ，最大的城市是 ___ 。', blanks: 2, status: 'ok' },
      { kind: 'essay', stem: '5. 简述光合作用的过程。', status: 'ok' },
      { kind: 'single', stem: '6. 1 + 1 =', options: ['A:1', 'B:2'], status: 'ok' },
    ]);
  });

  it('finds the stem in a preceding sibling when options are in their own container', () => {
    mount(`
      <section>
        <h3>1、下列哪个是哺乳动物？</h3>
        <ul><li><input type="radio" name="a">鲸鱼</li><li><input type="radio" name="a">鲨鱼</li></ul>
        <h3>2、下列哪个是鸟类？</h3>
        <ul><li><input type="radio" name="b">蝙蝠</li><li><input type="radio" name="b">企鹅</li></ul>
      </section>`);
    expect(summary().map((q) => [q.stem, q.options])).toEqual([
      ['1、下列哪个是哺乳动物？', ['A:鲸鱼', 'B:鲨鱼']],
      ['2、下列哪个是鸟类？', ['A:蝙蝠', 'B:企鹅']],
    ]);
  });

  it('supports ARIA radio widgets and aria-labelledby', () => {
    mount(`
      <div class="question">
        <div class="title">Capital of France?</div>
        <div role="radiogroup">
          <div role="radio" aria-checked="false">Berlin</div>
          <div role="radio" aria-checked="false" aria-labelledby="paris"></div>
        </div>
        <span id="paris">Paris</span>
      </div>`);
    const [q] = summary();
    expect(q).toMatchObject({ kind: 'single', options: ['A:Berlin', 'B:Paris'] });
    expect(q!.stem).toContain('Capital of France?');
  });

  it('keeps page option labels like (C) and 1)', () => {
    mount(`<div><p>Pick one</p>
      <label><input type="radio" name="x">(C) cat</label><label><input type="radio" name="x">(D) dog</label></div>`);
    expect(summary()[0]!.options).toEqual(['C:cat', 'D:dog']);
  });

  it('turns KaTeX into TeX and image alts into text', () => {
    mount(`<div><p>求 <span class="katex"><annotation encoding="application/x-tex">x^2=4</annotation><span>x2=4</span></span> 的解，见 <img alt="数轴"></p>
      <label><input type="radio" name="m"> ±2</label><label><input type="radio" name="m"> 2</label></div>`);
    expect(summary()[0]!.stem).toBe('求 $x^2=4$ 的解，见 [图片: 数轴]');
  });

  it('flags questions that need a screenshot', () => {
    mount(`
      <div><p>图中三角形是什么三角形？<img src="t.png" width="300" height="200"></p>
        <label><input type="radio" name="f">直角</label><label><input type="radio" name="f">钝角</label></div>
      <div><p>选择正确的图形</p>
        <label><input type="radio" name="g"><img src="a.png"></label><label><input type="radio" name="g"><img src="b.png"></label></div>
      <div><p></p>
        <label><input type="radio" name="h">x</label><label><input type="radio" name="h">y</label></div>
      <div><label><input type="radio" name="i">yes</label><label><input type="radio" name="i">no</label></div>`);
    expect(extract().map((e) => [e.status, e.reason])).toEqual([
      ['figure', expect.stringMatching(/^question contains a figure/)],
      ['incomplete', 'option text missing'],
      ['incomplete', 'text looks obfuscated'],
      ['incomplete', 'stem text missing'],
    ]);
  });

  it('ignores login forms, search boxes, lone checkboxes, disabled and hidden controls', () => {
    mount(`
      <header><input type="text" placeholder="搜索"></header>
      <form><input type="text" name="user"><input type="password"></form>
      <label><input type="checkbox"> 我已阅读并同意</label>
      <div><p>Disabled</p><label><input type="radio" name="d" disabled>a</label><label><input type="radio" name="d" disabled>b</label></div>
      <div hidden><p>Hidden blank</p><input type="text"></div>`);
    expect(extract()).toEqual([]);
  });

  it('ignores fields asking for the user name (ProProfs nickname box)', () => {
    mount(`
      <div><h2>2. What first name or nickname would you like us to use?</h2>
        <input type="text" placeholder="Type first name or nickname" name="user_name_cert"></div>
      <div><p>考生姓名</p><input type="text" placeholder="请输入姓名"></div>
      <div><p>3. The capital of France is ____.</p><input type="text"></div>`);
    const found = summary();
    expect(found).toHaveLength(1);
    expect(found[0]!.stem).toMatch(/^3\. The capital of France/);
  });

  it('元贝驾考: answer feedback inside the option list is not the stem', () => {
    const page = (feedback: string) => `
      <dl><dt id="ExamTit"><b>1.</b>&nbsp;&nbsp;驾驶机动车应当随身携带哪种证件？</dt>
      <dd><ul id="ExamOpt">
        <li><input type="radio" name="ExamOpt" id="inA"><label for="inA">A、工作证</label></li>
        <li><input type="radio" name="ExamOpt" id="inB"><label for="inB">B、驾驶证</label></li>
        <li id="ExamOptDa">${feedback}</li>
      </ul></dd></dl>
      <div>共 2038 题 转到 <input type="text" value="1"> 题</div>`;
    mount(page(''));
    const before = summary();
    mount(
      page(
        '<i>&nbsp;标准答案：<strong>B</strong>&nbsp;</i><em>为什么是 B ?</em><br><a href="/down/">→→点击这里→看视频</a>',
      ),
    );
    expect(summary()).toEqual(before);
    expect(before).toHaveLength(1);
    expect(before[0]!.stem).toContain('驾驶机动车应当随身携带哪种证件');
    mount(page('<span>恭喜！回答正确:)</span> <em>为什么是 B ?</em>'));
    expect(summary()).toEqual(before);
  });

  it('keeps custom-styled radios whose input is hidden but label is visible', () => {
    mount(`<div><p>Styled</p>
      <input type="radio" name="s" id="s1" style="display:none"><label for="s1">One</label>
      <input type="radio" name="s" id="s2" style="display:none"><label for="s2">Two</label></div>`);
    expect(summary()[0]).toMatchObject({ kind: 'single', options: ['A:One', 'B:Two'] });
  });

  it('reads controls inside open shadow roots', () => {
    const host = mount('<quiz-card></quiz-card>').querySelector('quiz-card')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<div><p>Shadow question?</p>
      <label><input type="radio" name="z">yes</label><label><input type="radio" name="z">no</label></div>`;
    expect(summary()).toEqual([
      { kind: 'judge', stem: 'Shadow question?', options: ['A:yes', 'B:no'], status: 'ok' },
    ]);
  });
});
