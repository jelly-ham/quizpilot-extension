// Browser language picks the UI: English, Japanese and Korean get their locale everywhere.
import {
  assert,
  buildExtension,
  launch,
  main,
  ORIGIN,
  setSettings,
  startServer,
} from './harness.mjs';

await main('i18n', async () => {
  const dist = buildExtension('dist-e2e', ORIGIN);
  await startServer();
  const browser = await launch(dist, { lang: 'en-US' });
  try {
    await setSettings(browser.worker, {
      mode: 'byok',
      byok: {
        providers: [{ type: 'jev', id: 'jev', apiKey: 'k', baseURL: `${ORIGIN}/jev/v1` }],
        routing: { choice: 'jev' },
      },
    });
    assert.equal(
      await browser.worker.evaluate(() => chrome.i18n.getMessage('solvePage')),
      'Solve this page (auto)',
    );
    const popup = await browser.context.newPage();
    await popup.goto(`chrome-extension://${browser.extId}/src/popup/index.html`);
    const buttons = await popup.locator('.actions .item-title').allTextContents();
    console.log('popup buttons:', buttons);
    assert.ok(buttons.includes('Assist (mark answers only)'));
    assert.equal(await popup.getAttribute('html', 'lang'), 'en');

    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extId}/src/options/index.html`);
    await options.locator('h1').waitFor();
    assert.equal(await options.title(), 'QuizPilot settings');
    assert.equal(await options.locator('h2').first().textContent(), 'Mode');
    // Adding a model: "List models" fills the Model field's suggestions from the service.
    await options.click('button:has-text("Other OpenAI-compatible service")');
    await options.fill('input[placeholder="https://…/v1"]', `${ORIGIN}/llm/v1`);
    await options.fill('input[type=password]', 'k');
    await options.click('button:has-text("List models")');
    await options.locator('text=Found 2 models').waitFor({ timeout: 10_000 });
    assert.deepEqual(await options.$$eval('datalist option', (els) => els.map((e) => e.value)), [
      'mock-pro',
      'mock-vl',
    ]);
    await options.click('button:has-text("Cancel")');

    const text = await options.locator('main').textContent();
    assert.doesNotMatch(text, /[一-鿿]/, 'no Chinese left on the English options page');
  } finally {
    await browser.context.close();
  }

  // Japanese and Korean: their own text in the popup and options page, models tip included.
  for (const [lang, html, solve, mode, tip] of [
    ['ja', 'ja', 'このページを解答（自動入力）', 'モード', '高性能モデル'],
    ['ko', 'ko', '이 페이지 풀기 (자동 입력)', '모드', '고급 모델'],
  ]) {
    const b = await launch(dist, { lang });
    try {
      await setSettings(b.worker, {
        mode: 'byok',
        byok: {
          providers: [{ type: 'jev', id: 'jev', apiKey: 'k', baseURL: `${ORIGIN}/jev/v1` }],
          routing: { choice: 'jev' },
        },
      });
      assert.equal(await b.worker.evaluate(() => chrome.i18n.getMessage('solvePage')), solve);
      const popup = await b.context.newPage();
      await popup.goto(`chrome-extension://${b.extId}/src/popup/index.html`);
      assert.equal(await popup.getAttribute('html', 'lang'), html);
      const options = await b.context.newPage();
      await options.goto(`chrome-extension://${b.extId}/src/options/index.html`);
      await options.locator('h1').waitFor();
      assert.equal(await options.locator('h2').first().textContent(), mode);
      await options.locator('.tip', { hasText: tip }).waitFor();
      if (lang === 'ko') {
        const text = await options.locator('main').textContent();
        assert.doesNotMatch(text, /[一-鿿]/, 'no Chinese left on the Korean options page');
      }
    } finally {
      await b.context.close();
    }
  }
});
