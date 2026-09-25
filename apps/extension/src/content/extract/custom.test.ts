import { beforeEach, describe, expect, it } from 'vitest';
import { BILIBILI_QUIZ } from '../../test/bilibili';
import { mount, testLayout } from '../../test/dom';
import { fillAnswers, isChecked } from '../fill/fill';
import { extractGeneric } from './generic';

const extract = () => extractGeneric(document, testLayout);
const summary = () =>
  extract().map(({ question: q }) => ({
    kind: q.kind,
    stem: q.stem,
    options: q.options?.map((o) => `${o.key}:${o.text}`),
  }));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('custom div options', () => {
  it('reads Vue-style question cards with keyed options', () => {
    mount(`
      <div class="quiz">
        <div class="question-item">
          <div class="question-title">1. 下列哪个是哺乳动物？</div>
          <div class="answers">
            <div class="answer-item">A. 鲸鱼</div><div class="answer-item">B. 鲨鱼</div>
            <div class="answer-item">C. 海龟</div><div class="answer-item">D. 章鱼</div>
          </div>
        </div>
        <div class="question-item">
          <div class="question-title">2. 以下哪些是质数？（多选）</div>
          <div class="answers">
            <div class="answer-item">A. 2</div><div class="answer-item">B. 4</div><div class="answer-item">C. 5</div>
          </div>
        </div>
      </div>`);
    expect(summary()).toEqual([
      {
        kind: 'single',
        stem: '1. 下列哪个是哺乳动物？',
        options: ['A:鲸鱼', 'B:鲨鱼', 'C:海龟', 'D:章鱼'],
      },
      { kind: 'multi', stem: '2. 以下哪些是质数？（多选）', options: ['A:2', 'B:4', 'C:5'] },
    ]);
  });

  it('keeps sibling stems apart (stem <p> followed by its option list)', () => {
    mount(`
      <section>
        <p>1、水的化学式是什么？</p>
        <ul><li style="cursor:pointer">H2O</li><li style="cursor:pointer">CO2</li></ul>
        <p>2、太阳从哪边升起？</p>
        <ul><li style="cursor:pointer">东</li><li style="cursor:pointer">西</li></ul>
      </section>`);
    expect(summary()).toEqual([
      { kind: 'single', stem: '1、水的化学式是什么？', options: ['A:H2O', 'B:CO2'] },
      { kind: 'single', stem: '2、太阳从哪边升起？', options: ['A:东', 'B:西'] },
    ]);
  });

  it('detects true/false custom options and nested clickable spans once', () => {
    mount(`
      <div class="q"><div class="t">地球是太阳系中最大的行星。</div>
        <div class="opts">
          <div class="opt" style="cursor:pointer"><span class="dot"></span><span>正确</span></div>
          <div class="opt" style="cursor:pointer"><span class="dot"></span><span>错误</span></div>
        </div></div>`);
    expect(summary()).toEqual([
      { kind: 'judge', stem: '地球是太阳系中最大的行星。', options: ['A:正确', 'B:错误'] },
    ]);
  });

  it('ignores tabs, pagination, product grids and menus', () => {
    mount(`
      <div class="tabs"><div class="tab-item" style="cursor:pointer">推荐</div><div class="tab-item" style="cursor:pointer">热门</div><div class="tab-item" style="cursor:pointer">动态</div></div>
      <div class="pager"><span class="page-item" style="cursor:pointer">1</span><span class="page-item" style="cursor:pointer">2</span><span class="page-item" style="cursor:pointer">3</span></div>
      <h3>热门推荐</h3>
      <div class="grid"><div class="card" style="cursor:pointer">新款耳机</div><div class="card" style="cursor:pointer">机械键盘</div></div>
      <nav><div class="answer-item">A. 首页</div><div class="answer-item">B. 我的</div></nav>`);
    expect(extract()).toEqual([]);
  });

  it('does not treat search and comment boxes as blanks', () => {
    mount(`
      <div><p>站内搜索一下吧</p><input type="text" placeholder="搜索你感兴趣的视频"></div>
      <div><p>发表你的看法</p><textarea placeholder="发一条友善的评论"></textarea></div>`);
    expect(extract()).toEqual([]);
  });

  it('fills custom options by clicking them', async () => {
    mount(`
      <div class="question-item"><div class="question-title">1. 选出正确答案？</div>
        <div class="answers"><div class="answer-item">A. 甲</div><div class="answer-item">B. 乙</div></div></div>`);
    const items = [...document.querySelectorAll('.answer-item')];
    // Typical Vue behaviour: clicking marks the chosen option with a class.
    items.forEach((el) =>
      el.addEventListener('click', () =>
        items.forEach((x) => x.classList.toggle('selected', x === el)),
      ),
    );
    const [q] = extract();
    await fillAnswers(
      [{ anchor: q!.anchor, answer: { id: 'q1', kind: 'single', model: 'm', choice: 'B' } }],
      {
        humanize: false,
      },
    );
    expect(items.map(isChecked)).toEqual([false, true]);
  });
});

describe('bilibili newbie quiz (from a user debug log)', () => {
  it('reads only the question: no search box, no header, the mascot is not a figure', () => {
    mount(BILIBILI_QUIZ);
    const found = extract();
    expect(found.map((e) => [e.status, e.reason])).toEqual([['ok', undefined]]);
    const q = found[0]!.question;
    expect(q.options?.map((o) => o.text)).toEqual(['低热量且健康的食品', '需要快速制作的食品']);
    expect(q.stem).toContain('“低卡美食”通常指什么？');
    expect(q.stem).not.toContain('第 8/100 题');
  });

  it('still treats an image before the question text as a figure', () => {
    mount(`
      <div class="card">
        <img src="chart.png" width="300" height="200">
        <div class="title">上图中哪一年的销量最高？</div>
        <div class="item" style="cursor:pointer">A. 2019</div>
        <div class="item" style="cursor:pointer">B. 2020</div>
      </div>`);
    expect(extract().map((e) => e.status)).toEqual(['figure']);
  });
});

describe('options that are buttons (englishgrammar.org, from a user debug log)', () => {
  it('reads the option text inside <button> options', () => {
    mount(`
      <div class="egx-question">
        <div class="egx-q-title"><span class="egx-q-num">1</span>
          <span class="egx-q-title-text">If the audit confirms the error, the chief executive will have to ............</span></div>
        <div class="egx-options">
          <button class="egx-option"><span>bite the bullet</span></button>
          <button class="egx-option"><span>jump the gun</span></button>
        </div>
      </div>`);
    const found = extract();
    expect(found.map((e) => e.status)).toEqual(['ok']);
    expect(found[0]!.question.options?.map((o) => o.text)).toEqual([
      'bite the bullet',
      'jump the gun',
    ]);
  });
});

describe('sites from the 2026-09-24 test round', () => {
  const runoob = (picked: string) => `
    <div class="quiz-card">
      <p>第 1 题 / 共 20 题</p>
      <div class="q-title">HTML 的全称是什么？</div>
      <div class="options">
        ${[
          'Hyper Text Markup Language',
          'Hyperlinks and Text Markup Language',
          'Home Tool Markup Language',
        ]
          .map(
            (t, i) =>
              `<div class="option${i === 0 ? ` ${picked}` : ''}" style="cursor:pointer"><div class="letter">${'ABC'[i]}</div><div>${t}</div></div>`,
          )
          .join('')}
      </div>
    </div>`;

  it('runoob: letter badges become keys, and a picked option stays in its group', () => {
    for (const picked of ['', 'selected correct']) {
      mount(runoob(picked));
      const found = extract();
      expect(found).toHaveLength(1);
      expect(found[0]!.question.stem).toContain('HTML 的全称是什么？');
      expect(found[0]!.question.options?.map((o) => `${o.key}:${o.text}`)).toEqual([
        'A:Hyper Text Markup Language',
        'B:Hyperlinks and Text Markup Language',
        'C:Home Tool Markup Language',
      ]);
    }
  });

  it('驾校一点通: letter answer buttons are folded into the question they answer', () => {
    mount(`
      <div class="exam">
        <div class="question">(判断题)1、机动车仪表板上如图所示指示灯亮，提示发电机向蓄电池充电。</div>
        <ul class="opts"><li class="opt">A、正确</li><li class="opt">B、错误</li></ul>
        <div class="answer-bar"><span>请选择：</span>
          <span class="btn" id="ka" style="cursor:pointer">A</span><span class="btn" id="kb" style="cursor:pointer">B</span>
        </div>
      </div>`);
    const found = extract();
    expect(found).toHaveLength(1);
    const q = found[0]!;
    expect(q.question.options?.map((o) => o.text)).toEqual(['正确', '错误']);
    expect(q.anchor.type === 'choice' && q.anchor.options.map((o) => o.control.id)).toEqual([
      'ka',
      'kb',
    ]);
  });
});

describe('驾校一点通: the figure sits in a separate "图片信息" panel', () => {
  const page = (stem: string) => `
    <div class="exam">
      <div class="left">
        <div class="question">${stem}</div>
        <ul class="opts"><li class="opt">A、正确</li><li class="opt">B、错误</li></ul>
        <div class="fr aswer"><span>请选择：</span>
          <li style="cursor:pointer">A</li><li style="cursor:pointer">B</li></div>
        <div class="btn-wrap"><a class="btn next" href="javascript:">下一题</a></div>
      </div>
      <div class="q-detail"><div class="tit">图片信息</div>
        <img class="q-img" src="http://img.58cdn.com.cn/kaoshi_p/11121.jpg" width="300" height="200"></div>
    </div>`;

  it('uses it when the stem refers to a picture, and frames it in the screenshot', () => {
    mount(page('(判断题)19、这辆小型载客汽车驶离高速公路行车道的方法是正确的。'));
    const [q] = extract();
    expect(q!.status).toBe('figure');
    expect(q!.reason).toContain('outside the question');
    expect(q!.anchor.stemEls.map((e) => e.className)).toContain('q-img');
  });

  it('leaves text questions alone even when an image is on the page', () => {
    mount(page('(判断题)4、在道路上车辆发生故障、事故停车后，不按规定设置警告标志，一次记1分。'));
    expect(extract()[0]!.status).toBe('ok');
  });
});

describe('驾驶员考试网 (jsyks.com): options are bare <b> elements', () => {
  const PAGE = `
    <div class="Exam"><ul class="Content">
      <li id="LI1"><i onclick="gotoExam(1);">1</i><strong>已注册登记的机动车，改变机动车车身颜色的，机动车所有人应到登记地车辆管理所申请变更登记。</strong><b style="cursor:pointer">正确</b><b style="cursor:pointer">错误</b></li>
      <li id="LI2"><i onclick="gotoExam(2);">2</i><strong>距离交叉路口50米以内的路段不能停车。</strong><b class="sel" style="cursor:pointer">正确</b><b style="cursor:pointer">错误</b></li>
    </ul></div>`;

  it('reads each <li> as a true/false question, also once one is answered', () => {
    mount(PAGE);
    expect(summary()).toEqual([
      {
        kind: 'judge',
        stem: '1已注册登记的机动车，改变机动车车身颜色的，机动车所有人应到登记地车辆管理所申请变更登记。',
        options: ['A:正确', 'B:错误'],
      },
      {
        kind: 'judge',
        stem: '2距离交叉路口50米以内的路段不能停车。',
        options: ['A:正确', 'B:错误'],
      },
    ]);
  });

  it('picks the answer by clicking the <b>', async () => {
    mount(PAGE);
    const [q] = extract();
    let clicked = '';
    document.querySelectorAll('#LI1 b').forEach((b) =>
      b.addEventListener('click', () => {
        clicked = b.textContent!;
        b.classList.add('sel');
      }),
    );
    const { outcomes } = await fillAnswers(
      [{ anchor: q!.anchor, answer: { id: q!.question.id, kind: 'judge', bool: false } } as never],
      { humanize: false },
    );
    expect(clicked).toBe('错误');
    expect(outcomes[0]).toMatchObject({ ok: true });
  });

  it('takes the not-yet-loaded sign in the stem as the figure, not an image elsewhere', () => {
    mount(`
      <div class="Exam"><ul class="Content">
        <li id="LI6"><i>6</i><strong>这个标志表示硬路肩允许行驶路段开始。<u><img x06ffac7="MTg2"></u></strong><b style="cursor:pointer">正确</b><b style="cursor:pointer">错误</b></li>
      </ul></div>
      <div class="side"><img src="/sblog/avatar.png" width="144" height="144"></div>`);
    const [q] = extract();
    expect(q!.status).toBe('figure');
    expect(q!.reason).toContain('not loaded');
    expect(q!.anchor.stemEls.some((e) => e.matches('.side img'))).toBe(false);
  });
});
