// BYOK end-to-end: user's own keys, called directly from the extension (mock endpoints).
import {
  assert,
  buildExtension,
  calls,
  extraRoutes,
  launch,
  main,
  openAndRun,
  ORIGIN,
  setSettings,
  startServer,
} from './harness.mjs';

const STEPS = `<!doctype html><meta charset="utf-8"><title>Steps</title>
<header><nav><div class="tab" style="cursor:pointer">首页</div><div class="tab" style="cursor:pointer">答题</div></nav></header>
<aside><p>你最喜欢哪个分区？</p><label><input type="radio" name="side" value="动画"> 动画</label><label><input type="radio" name="side" value="游戏"> 游戏</label></aside>
<main id="app"></main>
<script>
  window.picked = [];
  window.submitted = false;
  const qs = [
    { stem: '1. 2 + 2 = ?', options: ['3', '4'], button: null },
    { stem: '2. 法国的首都是？', options: ['London', 'Paris'], button: '下一题' },
    { stem: '3. 世界上最高的山峰是？', options: ['乔戈里峰', '珠穆朗玛峰'], button: '提交' },
  ];
  // ?feedback (runoob style): every question waits for "下一题", and answering appends
  // "回答正确。" under the question.
  const feedback = location.search.includes('feedback');
  if (feedback) qs[0].button = '下一题';
  let i = 0;
  function render() {
    const q = qs[i];
    const app = document.getElementById('app');
    app.innerHTML = '<div class="q"><p>' + q.stem + '</p>' +
      q.options.map((o) => '<label><input type="radio" name="q' + i + '" value="' + o + '"> ' + o + '</label>').join('') +
      '</div>' + (q.button ? '<button id="btn">' + q.button + '</button>' : '');
    app.querySelectorAll('input').forEach((el) =>
      el.addEventListener('change', () => {
        window.picked.push(el.value);
        if (feedback) {
          const note = document.createElement('p');
          note.textContent = '回答正确。';
          el.closest('.q').append(note);
          return;
        }
        // Q1 advances by itself, like many quiz sites.
        if (i === 0 && location.search.includes('captcha')) setTimeout(challenge, 300);
        else if (i === 0) setTimeout(() => { i++; render(); }, 300);
      }),
    );
    const btn = document.getElementById('btn');
    if (btn) btn.onclick = () => {
      if (q.button === '提交') { window.submitted = true; return; }
      i++; render();
    };
  }
  // ?captcha: a GeeTest-style box instead of moving on; the "user" completes it.
  function challenge() {
    const box = document.createElement('div');
    box.className = 'geetest_panel';
    box.style.cssText = 'position:fixed;top:100px;left:100px;width:320px;height:200px;background:#eee';
    box.innerHTML = '请完成验证 <button id="verify">验证</button>';
    document.body.append(box);
    box.querySelector('#verify').onclick = () => { box.remove(); i++; render(); };
  }
  render();
</script>`;

const MULTI = `<!doctype html><meta charset="utf-8"><title>Multi</title>
<style>button.opt { cursor: pointer }</style>
<div class="quiz">
  <div class="q"><span class="title">1. 标准大气压下水的沸点是？</span><div class="opts"><button class="opt">90 度</button><button class="opt">100 度</button></div></div>
  <div class="q"><span class="title">2. 法国的首都是？</span><div class="opts"><button class="opt">London</button><button class="opt">Paris</button></div></div>
  <div class="q"><span class="title">3. 中国最长的河流是？</span><div class="opts"><button class="opt">黄河</button><button class="opt">长江</button></div></div>
</div>
<script>
  document.querySelectorAll('button.opt').forEach((b) =>
    b.addEventListener('click', () => { b.textContent += ' ✓'; }),
  );
</script>`;

await main('byok', async () => {
  const dist = buildExtension('dist-e2e', ORIGIN);
  await startServer();
  const browser = await launch(dist);
  const { context } = browser;
  try {
    // The manifest `key` pins the ID to the one derived from extension-key.pub (when the checkout
    // has one; builds without it get a random ID).
    const { existsSync, readFileSync } = await import('node:fs');
    const pubFile = new URL('../extension-key.pub', import.meta.url);
    if (existsSync(pubFile)) {
      const { extensionId } = await import('../scripts/extension-key.mjs');
      const pub = readFileSync(pubFile, 'utf8').trim();
      assert.equal(browser.extId, extensionId(pub), 'extension id matches extension-key.pub');
    }

    await setSettings(browser.worker, {
      mode: 'byok',
      allowEscalation: false,
      humanize: false,
      debug: true,
      byok: {
        providers: [
          { type: 'jev', id: 'jev', apiKey: 'k', baseURL: `${ORIGIN}/jev/v1` },
          {
            type: 'openai-compatible',
            id: 'llm',
            baseURL: `${ORIGIN}/llm/v1`,
            model: 'mock',
            apiKey: 'sk-e2e-secret-0123456789abcdef',
            vision: true,
          },
        ],
        routing: { choice: 'jev', text: 'llm', vision: 'llm' },
      },
    });

    const { page: quiz, status } = await openAndRun(browser, '/quiz.html');
    await status.filter({ hasText: '已解答' }).waitFor({ timeout: 30_000 });
    console.log('panel:', await status.textContent());

    const checked = (sel) => quiz.locator(sel).isChecked();
    assert.equal(await checked('input[name=q1][value=b]'), true, 'single choice');
    assert.deepEqual(
      await quiz.$$eval('input[name=q2]', (els) => els.map((e) => e.checked)),
      [true, false, true],
      'multi choice',
    );
    assert.equal(await checked('input[name=q3][value=t]'), true, 'judge');
    assert.equal(await quiz.inputValue('input[name=cap]'), '北京', 'fill 1');
    assert.equal(await quiz.inputValue('input[name=big]'), '上海', 'fill 2');
    assert.equal(await quiz.inputValue('select[name=s]'), 'two', 'select');
    assert.equal(
      await quiz.frameLocator('iframe').locator('input[value=paris]').isChecked(),
      true,
      'iframe question',
    );
    assert.equal(
      await checked('input[name=q7][value=square]'),
      true,
      'figure question answered by the vision model',
    );
    assert.equal(
      await quiz.locator('#quizpilot-root .item').count(),
      7,
      'panel lists every question',
    );
    assert.equal(
      await quiz.locator('#quizpilot-root .tag', { hasText: '看图作答' }).count(),
      1,
      'figure question tagged',
    );
    assert.equal(
      calls.jev,
      1,
      'one batched Jev call for all text choice questions, iframe included',
    );
    // The fill and figure questions both route to `llm`, so they share one request (with the image).
    assert.equal(calls.vision, 1, 'one LLM call for the fill + figure questions');
    assert.equal(calls.llm, 0, 'no separate text-only LLM call');
    assert.equal(calls.read, 0, 'DOM text was complete; no screenshot transcription');

    await quiz.locator('#quizpilot-root button', { hasText: '撤销填写' }).click();
    await status.filter({ hasText: '已撤销' }).waitFor();
    assert.equal(await checked('input[name=q1][value=b]'), false, 'undo single');
    assert.equal(await quiz.inputValue('input[name=cap]'), '', 'undo fill');
    assert.equal(
      await quiz.frameLocator('iframe').locator('input[value=paris]').isChecked(),
      false,
      'undo iframe',
    );

    // Canvas page: nothing in the DOM, so the whole viewport is read by the vision model.
    const { page: canvas, status: canvasStatus } = await openAndRun(browser, '/canvas.html');
    await canvasStatus.filter({ hasText: '已解答' }).waitFor({ timeout: 30_000 });
    assert.equal(calls.read, 1, 'canvas page read from a screenshot');
    assert.equal(
      await canvas.locator('#quizpilot-root .answer').textContent(),
      'B. 2',
      'answer shown in the panel',
    );
    assert.equal(
      await canvas.locator('#quizpilot-root .tag', { hasText: '仅显示答案' }).count(),
      1,
      'display-only tag',
    );
    console.log('canvas panel:', await canvasStatus.textContent());

    // A page the generic reader can't parse: learn its layout from a set-of-marks screenshot once,
    // then reuse the stored rule without asking the model again.
    const selected = (p) => p.$$eval('.row.selected span', (els) => els.map((e) => e.textContent));
    const { page: hard, status: hardStatus } = await openAndRun(browser, '/hard.html');
    await hardStatus.filter({ hasText: '已解答' }).waitFor({ timeout: 30_000 });
    console.log('hard panel:', await hardStatus.textContent());
    assert.equal(calls.mark, 1, 'learned the layout with one set-of-marks call');
    assert.match(await hardStatus.textContent(), /已学习本站的题目结构/);
    assert.deepEqual(
      await selected(hard),
      ['珠穆朗玛峰', '长江', '100 度'],
      'answers clicked on bare div options',
    );
    const rules = await browser.worker.evaluate(
      async () => (await chrome.storage.local.get('siteRules')).siteRules,
    );
    assert.ok(rules['127.0.0.1:47831/hard.html'], 'rule stored for the page');
    assert.doesNotMatch(
      JSON.stringify(rules),
      /_a8f3k2|css-1x2y3z|sc-a1b2c3/,
      'no hashed classes in the rule',
    );

    const { page: hard2, status: hard2Status } = await openAndRun(browser, '/hard.html?again');
    await hard2Status.filter({ hasText: '已解答' }).waitFor({ timeout: 30_000 });
    console.log('hard panel (2nd visit):', await hard2Status.textContent());
    assert.equal(calls.mark, 1, 'second visit uses the stored rule, no model call');
    assert.match(await hard2Status.textContent(), /按本站读题规则/);
    assert.deepEqual(await selected(hard2), ['珠穆朗玛峰', '长江', '100 度']);

    // Continuous mode: one question at a time. Q1 moves on by itself once picked, Q2 needs the
    // "下一题" button, Q3 only has a submit button, which must never be pressed.
    extraRoutes.set('/steps.html', { body: STEPS, type: 'text/html; charset=utf-8' });
    const { page: steps, status: stepsStatus } = await openAndRun(browser, '/steps.html', 'auto');
    await stepsStatus.filter({ hasText: '已到最后一题' }).waitFor({ timeout: 90_000 });
    console.log('auto panel:', await stepsStatus.textContent());
    await steps.waitForFunction(() => window.picked.length === 3);
    assert.deepEqual(await steps.evaluate(() => window.picked), ['4', 'Paris', '珠穆朗玛峰']);
    assert.equal(await steps.evaluate(() => window.submitted), false, 'never submits');
    assert.match(await stepsStatus.textContent(), /共 3 轮/);
    const autoLog = await browser.worker.evaluate(
      async () => (await chrome.storage.session.get('debugLog')).debugLog,
    );
    assert.equal(
      autoLog.filter((e) => e.event === '跳过已处理的题目').length,
      2,
      'the static sidebar question is answered once, then skipped',
    );
    // Human pacing is off in these settings: no reading pause before answering.
    assert.ok(
      autoLog.filter((e) => e.event === '连续答题：作答前停顿').every((e) => e.data.ms === 0),
      'no reading pause without human pacing',
    );

    // Assist mode: answers are only outlined; the "user" clicks, and the next question is marked.
    const { page: as, status: asStatus } = await openAndRun(
      browser,
      '/steps.html?assist',
      'assist',
    );
    const outlined = () =>
      as.$$eval('#app label', (els) =>
        els.filter((l) => l.style.outline.includes('solid')).map((l) => l.textContent.trim()),
      );
    await asStatus.filter({ hasText: '已标出建议答案' }).waitFor({ timeout: 30_000 });
    await as.waitForTimeout(500);
    assert.deepEqual(await outlined(), ['4'], 'Q1 suggestion outlined');
    assert.deepEqual(await as.evaluate(() => window.picked), [], 'assist mode clicks nothing');
    await as.click('input[value="4"]');
    await as.locator('input[value="Paris"]').waitFor();
    await as.waitForFunction(() =>
      [...document.querySelectorAll('#app label')].some((l) => l.style.outline.includes('solid')),
    );
    assert.deepEqual(await outlined(), ['Paris'], 'Q2 marked after the page moved on');
    await as.click('input[value="Paris"]');
    await as.click('#btn');
    await as.locator('input[value="珠穆朗玛峰"]').waitFor();
    await as.waitForFunction(() =>
      [...document.querySelectorAll('#app label')].some((l) => l.style.outline.includes('solid')),
    );
    assert.deepEqual(await outlined(), ['珠穆朗玛峰']);
    await as.locator('#quizpilot-root .stop').click();
    await asStatus.filter({ hasText: '已停止辅助答题' }).waitFor({ timeout: 10_000 });
    assert.deepEqual(await outlined(), [], 'outlines removed on stop');
    assert.deepEqual(await as.evaluate(() => window.picked), ['4', 'Paris'], 'only user clicks');
    assert.equal(await as.locator('#quizpilot-root .primary').count(), 0, 'no fill button');
    console.log('assist panel:', await asStatus.textContent());

    // Assist on a page with all its questions at once (englishgrammar.org style: button options
    // that change when answered). Answering one keeps the others' outlines and the loop running.
    extraRoutes.set('/multi.html', { body: MULTI, type: 'text/html; charset=utf-8' });
    const { page: mp, status: mpStatus } = await openAndRun(browser, '/multi.html', 'assist');
    const mpOutlined = () =>
      mp.$$eval('button.opt', (els) =>
        els.filter((b) => b.style.outline.includes('solid')).map((b) => b.textContent.trim()),
      );
    await mpStatus.filter({ hasText: '已标出建议答案' }).waitFor({ timeout: 30_000 });
    assert.deepEqual(
      await mpOutlined(),
      ['100 度', 'Paris', '长江'],
      'button options read and marked',
    );
    await mp.click('button.opt >> text=100 度');
    await mp.waitForTimeout(3_000);
    assert.deepEqual(
      (await mpOutlined()).filter((t) => t !== '100 度 ✓'),
      ['Paris', '长江'],
      'other outlines kept after answering one',
    );
    assert.doesNotMatch(await mpStatus.textContent(), /结束/, 'assist still running');
    await mp.locator('#quizpilot-root .stop').click();
    await mpStatus.filter({ hasText: '已停止辅助答题' }).waitFor({ timeout: 10_000 });

    // Answer feedback added under the question is not a new question: each one answered once.
    const { page: fb, status: fbStatus } = await openAndRun(
      browser,
      '/steps.html?feedback',
      'auto',
    );
    await fbStatus.filter({ hasText: '已到最后一题' }).waitFor({ timeout: 90_000 });
    assert.deepEqual(await fb.evaluate(() => window.picked), ['4', 'Paris', '珠穆朗玛峰']);
    console.log('feedback panel:', await fbStatus.textContent());

    // Stop takes effect while a model call hangs: the call is aborted, the run ends at once.
    extraRoutes.set('/slow.html', {
      body: `<!doctype html><meta charset="utf-8"><div class="q"><p>1. SLOW 2 + 2 = ?</p>
        <label><input type="radio" name="s" value="a"> A. 3</label>
        <label><input type="radio" name="s" value="b"> B. 4</label></div>`,
      type: 'text/html; charset=utf-8',
    });
    const { status: slowStatus } = await openAndRun(browser, '/slow.html', 'auto');
    await slowStatus.filter({ hasText: '正在解答' }).waitFor({ timeout: 15_000 });
    const pressed = Date.now();
    await slowStatus.page().locator('#quizpilot-root .stop').click();
    await slowStatus.filter({ hasText: '已停止连续答题' }).waitFor({ timeout: 5_000 });
    console.log(`stopped a hanging call in ${Date.now() - pressed} ms`);

    // A verification challenge pauses the loop until the user completes it; it is never touched.
    const { page: cap, status: capStatus } = await openAndRun(
      browser,
      '/steps.html?captcha',
      'auto',
    );
    await capStatus.filter({ hasText: '检测到验证码' }).waitFor({ timeout: 30_000 });
    await cap.waitForTimeout(1_500);
    assert.equal(await cap.locator('.geetest_panel').count(), 1, 'challenge left alone');
    await cap.click('#verify');
    await capStatus.filter({ hasText: '已到最后一题' }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await cap.evaluate(() => window.picked), ['4', 'Paris', '珠穆朗玛峰']);
    console.log('captcha panel:', await capStatus.textContent());

    // The stop button ends the loop before anything is filled (during the human reading pause).
    await setSettings(browser.worker, { humanize: true });
    const { page: stop, status: stopStatus } = await openAndRun(
      browser,
      '/steps.html?stop',
      'auto',
    );
    await stopStatus.filter({ hasText: '正在作答' }).waitFor({ timeout: 30_000 });
    await stop.locator('#quizpilot-root .stop').click();
    await stopStatus.filter({ hasText: '已停止连续答题' }).waitFor({ timeout: 10_000 });
    assert.deepEqual(await stop.evaluate(() => window.picked), [], 'stopped before answering');
    await setSettings(browser.worker, { humanize: false });

    // Debug log: every step recorded, keys redacted.
    const log = await browser.worker.evaluate(
      async () => (await chrome.storage.session.get('debugLog')).debugLog,
    );
    const events = log.map((e) => e.event);
    for (const e of [
      '开始',
      '读题',
      '是否学习结构',
      '学习：模型标注',
      '学习：得到的规则',
      '答案',
      '填写',
      '完成',
    ])
      assert.ok(events.includes(e), `debug log has ${e}`);
    assert.doesNotMatch(JSON.stringify(log), /sk-e2e-secret/, 'no API key in the debug log');
    console.log(`debug log: ${log.length} entries`);

    // Updating the extension orphans the panel already on a page: its buttons must say to reload
    // the page instead of throwing "Extension context invalidated". Last: the worker handle dies.
    await browser.worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await quiz.waitForTimeout(1_000);
    await quiz.locator('#quizpilot-root .primary').click();
    await status.filter({ hasText: '请刷新页面' }).waitFor({ timeout: 5_000 });
    console.log('orphaned panel:', await status.textContent());
  } finally {
    await context.close();
  }
});
