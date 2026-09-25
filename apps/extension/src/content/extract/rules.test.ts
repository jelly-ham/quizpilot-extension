import { beforeEach, describe, expect, it } from 'vitest';
import { BILIBILI_QUIZ } from '../../test/bilibili';
import { mount, testLayout } from '../../test/dom';
import { extractGeneric, withAnswerKeys } from './generic';
import { applyRule, deriveRule, ruleKey, stableClasses, type RuleExample } from './rules';

/** Options are bare divs: no input, role, hand cursor, option-ish class or "A." label. */
const PAGE = `
  <div class="app_x9f2k1">
    <div class="qcard _a8f3k2">
      <div class="qcard-head css-1x2y3z"><span>第一题</span> 世界上最高的山峰</div>
      <div class="qcard-body"><div class="row sc-a1b2c3"><i></i><span>珠穆朗玛峰</span></div><div class="row sc-a1b2c3"><i></i><span>乔戈里峰</span></div></div>
    </div>
    <div class="qcard _a8f3k2">
      <div class="qcard-head css-1x2y3z"><span>第二题</span> 中国最长的河流</div>
      <div class="qcard-body"><div class="row sc-a1b2c3"><i></i><span>黄河</span></div><div class="row sc-a1b2c3"><i></i><span>长江</span></div><div class="row sc-a1b2c3"><i></i><span>珠江</span></div></div>
    </div>
    <div class="qcard _a8f3k2">
      <div class="qcard-head css-1x2y3z"><span>第三题</span> 水的沸点（标准大气压）</div>
      <div class="qcard-body"><div class="row sc-a1b2c3"><i></i><span>90 度</span></div><div class="row sc-a1b2c3"><i></i><span>100 度</span></div></div>
    </div>
  </div>`;

const cards = () => [...document.querySelectorAll('.qcard')];
/** What the vision model labels: the stem text and each option's text span. */
const example = (card: Element): RuleExample => ({
  stem: card.querySelector('.qcard-head')!,
  options: [...card.querySelectorAll('.row span')],
  blanks: [],
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('site rules', () => {
  it('the generic reader cannot read this page (the case rules are for)', () => {
    mount(PAGE);
    expect(extractGeneric(document, testLayout)).toEqual([]);
  });

  it('learns from two labelled questions and reads all three, including the unlabelled one', () => {
    mount(PAGE);
    const rule = deriveRule(cards().slice(0, 2).map(example), document, testLayout)!;
    expect(rule).not.toBeNull();
    // No framework hashes in the selectors.
    expect(JSON.stringify(rule)).not.toMatch(/_a8f3k2|css-1x2y3z|sc-a1b2c3|x9f2k1/);

    const read = applyRule(rule, document, testLayout)!;
    expect(read.map((e) => [e.question.stem, e.question.options?.map((o) => o.text)])).toEqual([
      ['第一题 世界上最高的山峰', ['珠穆朗玛峰', '乔戈里峰']],
      ['第二题 中国最长的河流', ['黄河', '长江', '珠江']],
      ['第三题 水的沸点（标准大气压）', ['90 度', '100 度']],
    ]);
    // Options click on the whole row, not the inner span.
    const first = read[0]!.anchor;
    expect(first.type === 'choice' && first.options[0]!.control.classList.contains('row')).toBe(
      true,
    );
  });

  it('learns text blanks', () => {
    mount(`
      <div class="paper">
        <section class="item"><div class="txt">北京是中国的</div><input class="ipt"></section>
        <section class="item"><div class="txt">一年有几个月</div><input class="ipt"></section>
      </div>`);
    const items = [...document.querySelectorAll('.item')];
    const rule = deriveRule(
      items.map((i) => ({
        stem: i.querySelector('.txt')!,
        options: [],
        blanks: [i.querySelector('input')!],
      })),
      document,
      testLayout,
    )!;
    const read = applyRule(rule, document, testLayout)!;
    expect(read.map((e) => [e.question.kind, e.question.stem, e.question.blanks])).toEqual([
      ['fill', '北京是中国的', 1],
      ['fill', '一年有几个月', 1],
    ]);
  });

  it('stops matching when the site changes', () => {
    mount(PAGE);
    const rule = deriveRule(cards().slice(0, 2).map(example), document, testLayout)!;
    mount(`<div class="new-layout"><h2>题目</h2><ul><li>a</li><li>b</li></ul></div>`);
    expect(applyRule(rule, document, testLayout)).toBeNull();
    expect(applyRule({ ...rule, question: '%%%' }, document, testLayout)).toBeNull();
  });

  it('keys rules by host and number-free path', () => {
    expect(ruleKey(new URL('https://www.bilibili.com/v/newbie/basic-1?score=0'))).toBe(
      'www.bilibili.com/v/newbie/*',
    );
    expect(ruleKey(new URL('https://exam.example.com/paper/123/q'))).toBe(
      'exam.example.com/paper/*/q',
    );
  });

  it('drops hashed and state classes', () => {
    const el = document.createElement('div');
    el.className = 'row is-active selected sc-a1b2c3 css-9zz _k2j3 option-item a8f3k2d q-2';
    expect(stableClasses(el)).toEqual(['row', 'option-item', 'q-2']);
  });

  it("learns B 站's class-less question card by the classed child it holds", () => {
    mount(BILIBILI_QUIZ);
    const reasons: string[] = [];
    const rule = deriveRule(
      [
        {
          stem: document.querySelector('.title-panel')!,
          options: [...document.querySelectorAll('.answer-text')],
          blanks: [],
        },
      ],
      document,
      testLayout,
      (r) => reasons.push(r),
    );
    expect(reasons).toEqual([]);
    expect(rule?.question).toBe('div:has(> .qa-header)');
    const found = applyRule(rule!, document, testLayout)!;
    expect(found.map((e) => e.question.options?.map((o) => o.text))).toEqual([
      ['低热量且健康的食品', '需要快速制作的食品'],
    ]);
  });
});

describe('驾校一点通: a learned rule still answers with the letter buttons', () => {
  // The rule the vision model produced on the real page (see the debug log of 2026-09-24).
  const rule = {
    question: '.kstm',
    stem: ':scope p.name',
    option: ':scope > div.option > p',
    version: 1 as const,
  };

  it('clicks "A"/"B" under 请选择, not the option text', () => {
    mount(`
      <div class="kstm">
        <p class="name">(判断题)1、行车中要文明驾驶，礼让行车。</p>
        <div class="option"><p>A：正确</p><p>B：错误</p></div>
      </div>
      <div class="aswer"><span>请选择：</span>
        <ul><li id="ka" style="cursor:pointer">A</li><li id="kb" style="cursor:pointer">B</li></ul>
      </div>
      <div class="btn-wrap"><a href="javascript:">上一题</a><a href="javascript:">下一题</a></div>`);
    const found = withAnswerKeys(applyRule(rule, document, testLayout)!, document, testLayout);
    expect(found).toHaveLength(1);
    const q = found[0]!;
    expect(q.question.options?.map((o) => o.text)).toEqual(['正确', '错误']);
    expect(q.anchor.type === 'choice' && q.anchor.options.map((o) => o.control.id)).toEqual([
      'ka',
      'kb',
    ]);
  });

  it('leaves rule questions alone when the page has no letter buttons', () => {
    mount(PAGE);
    const rule2 = deriveRule(cards().map(example), document, testLayout)!;
    const byRule = applyRule(rule2, document, testLayout)!;
    expect(withAnswerKeys(byRule, document, testLayout)).toEqual(byRule);
  });
});
