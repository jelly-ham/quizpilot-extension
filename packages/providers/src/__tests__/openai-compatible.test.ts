import { describe, expect, it } from 'vitest';
import { listModels, createOpenAICompatibleProvider, extractJson } from '../openai-compatible';
import { chatReply, fakeFetch, json, fill, judge, noRetry, PNG, q, single } from './helpers';

const llm = (fetch: ReturnType<typeof fakeFetch>, vision = false) =>
  createOpenAICompatibleProvider({
    id: 'llm',
    baseURL: 'https://api.example.com/v1/',
    model: 'gpt-test',
    apiKey: 'sk-x',
    vision,
    pricing: { inputMicroUsdPerMTok: 2_500_000, outputMicroUsdPerMTok: 10_000_000 },
    fetch,
    retry: noRetry,
  });

describe('OpenAI-compatible solve', () => {
  it('sends a JSON-mode chat request and normalizes answers', async () => {
    const fetch = fakeFetch(
      chatReply({
        answers: [
          { id: 's', choice: 'B.', confidence: 0.9 },
          { id: 'j', bool: '错' },
          { id: 'f', text: 'Paris' },
        ],
      }),
    );
    const out = await llm(fetch).solve([single('s'), judge('j'), fill('f')]);

    const req = fetch.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
    expect(req.body).toMatchObject({
      model: 'gpt-test',
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    expect(req.body.messages[0].role).toBe('system');
    expect(typeof req.body.messages[1].content).toBe('string');

    expect(out.errors).toEqual([]);
    expect(out.answers).toEqual([
      { id: 's', kind: 'single', model: 'gpt-test', choice: 'B', confidence: 0.9 },
      { id: 'j', kind: 'judge', model: 'gpt-test', bool: false },
      { id: 'f', kind: 'fill', model: 'gpt-test', text: ['Paris'] },
    ]);
    // 100 × $2.5/M + 20 × $10/M = $0.00045
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20, costMicroUsd: 450 });
  });

  it('reports skipped and malformed answers per question', async () => {
    const fetch = fakeFetch(chatReply({ answers: [{ id: 's', choice: 'Z' }] }));
    const out = await llm(fetch).solve([single('s'), judge('j')]);
    expect(out.answers).toEqual([]);
    expect(out.errors.map((e) => [e.id, e.code])).toEqual([
      ['s', 'invalid_response'],
      ['j', 'invalid_response'],
    ]);
  });

  it('accepts JSON wrapped in a code fence', async () => {
    const fetch = fakeFetch(chatReply('Sure!\n```json\n{"answers":[{"id":"j","bool":true}]}\n```'));
    const out = await llm(fetch).solve([judge('j')]);
    expect(out.answers[0]!.bool).toBe(true);
  });

  it('throws when the reply is not the expected JSON', async () => {
    const fetch = fakeFetch(chatReply('I cannot help with that.'));
    await expect(llm(fetch).solve([single('s')])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('omits Authorization without a key and response_format with jsonMode off', async () => {
    const fetch = fakeFetch(chatReply({ answers: [{ id: 's', choice: 'A' }] }));
    const local = createOpenAICompatibleProvider({
      id: 'local',
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen',
      jsonMode: false,
      fetch,
      retry: noRetry,
    });
    await local.solve([single('s')]);
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined();
    expect(fetch.calls[0]!.body.response_format).toBeUndefined();
  });

  it('turns off hidden reasoning on OpenRouter only, unless asked for', async () => {
    const make = (baseURL: string, reasoning?: boolean) => {
      const fetch = fakeFetch(chatReply({ answers: [{ id: 's', choice: 'A' }] }));
      const p = createOpenAICompatibleProvider({
        id: 'x',
        baseURL,
        model: 'm',
        apiKey: 'k',
        ...(reasoning === undefined ? {} : { reasoning }),
        fetch,
        retry: noRetry,
      });
      return { p, fetch };
    };
    const or = make('https://openrouter.ai/api/v1');
    await or.p.solve([single('s')]);
    expect(or.fetch.calls[0]!.body.reasoning).toEqual({ enabled: false });

    const thinking = make('https://openrouter.ai/api/v1', true);
    await thinking.p.solve([single('s')]);
    expect(thinking.fetch.calls[0]!.body.reasoning).toBeUndefined();

    const other = make('https://api.deepseek.com/v1');
    await other.p.solve([single('s')]);
    expect(other.fetch.calls[0]!.body.reasoning).toBeUndefined();
  });

  it('drops the reasoning switch for models that require reasoning, and remembers it', async () => {
    const refusal = json(
      {
        error: {
          message: 'Reasoning is mandatory for this endpoint and cannot be disabled.',
          code: 400,
        },
      },
      400,
    );
    const ok = chatReply({ answers: [{ id: 's', choice: 'A' }] });
    const fetch = fakeFetch(refusal, ok, ok);
    const p = createOpenAICompatibleProvider({
      id: 'x',
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'm',
      apiKey: 'k',
      fetch,
      retry: noRetry,
    });
    const first = await p.solve([single('s')]);
    expect(first.answers).toHaveLength(1);
    expect(fetch.calls.map((c) => c.body.reasoning)).toEqual([{ enabled: false }, undefined]);
    await p.solve([single('s')]);
    expect(fetch.calls[2]!.body.reasoning).toBeUndefined();
  });

  it('refuses needsVision questions without vision support', async () => {
    const fetch = fakeFetch(chatReply({ answers: [] }));
    const v = q({
      id: 'v',
      kind: 'judge',
      stem: 's',
      needsVision: true,
      images: [{ id: 'i', dataUrl: PNG }],
    });
    const out = await llm(fetch).solve([v]);
    expect(fetch.calls).toHaveLength(0);
    expect(out.errors[0]!.code).toBe('needs_vision');
  });

  it('attaches images for needsVision questions', async () => {
    const fetch = fakeFetch(chatReply({ answers: [{ id: 'v', bool: true }] }));
    const v = q({
      id: 'v',
      kind: 'judge',
      stem: 'Is AB = AC?',
      needsVision: true,
      images: [{ id: 'fig', dataUrl: PNG }],
    });
    await llm(fetch, true).solve([v]);
    const content = fetch.calls[0]!.body.messages[1].content;
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: PNG } });
  });
});

describe('OpenAI-compatible robustness', () => {
  it('retries once when the reply is broken JSON, billing both attempts', async () => {
    // Seen from deepseek-v4.1-flash: a full-width colon inside the key breaks the structure.
    const fetch = fakeFetch(
      chatReply('{"answers：[{": null, "id": "f", "text": ["北京", "上海"]}'),
      chatReply({ answers: [{ id: 'f', text: ['北京', '上海'] }] }),
    );
    const out = await llm(fetch).solve([fill('f', 2)]);
    expect(fetch.calls).toHaveLength(2);
    expect(out.answers[0]!.text).toEqual(['北京', '上海']);
    expect(out.usage.inputTokens).toBe(200);
  });

  it('uses the cost OpenRouter reports', async () => {
    const fetch = fakeFetch(
      json({
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ message: { content: '{"answers":[{"id":"j","bool":true}]}' } }],
        usage: { prompt_tokens: 78, completion_tokens: 128, cost: 0.00006468 },
      }),
    );
    const out = await llm(fetch).solve([judge('j')]);
    expect(out.usage.costMicroUsd).toBe(65);
  });
});

describe('OpenAI-compatible read', () => {
  it('is only available with vision', () => {
    expect(llm(fakeFetch()).read).toBeUndefined();
    expect(llm(fakeFetch(), true).read).toBeTypeOf('function');
  });

  it('turns a screenshot into vision questions, dropping unusable ones', async () => {
    const fetch = fakeFetch(
      chatReply({
        questions: [
          {
            kind: 'single',
            stem: '1+1=?',
            options: [
              { key: 'A', text: '1' },
              { key: 'B', text: '2' },
            ],
          },
          { kind: 'judge', stem: 'The figure shows a right triangle.', needsVision: true },
          { kind: 'single', stem: 'broken, no options' },
        ],
      }),
    );
    const out = await llm(fetch, true).read!({
      pageUrl: 'https://example.com',
      image: PNG,
      hint: 'Unit 3',
    });

    const content = fetch.calls[0]!.body.messages[1].content;
    expect(content[0].text).toContain('Page hint: Unit 3');
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: PNG } });
    expect(out.questions).toEqual([
      expect.objectContaining({ id: 'v1', source: 'vision', kind: 'single' }),
      expect.objectContaining({ id: 'v2', source: 'vision', needsVision: true }),
    ]);
  });

  it('sends a screenshot shared by several questions only once', async () => {
    const fetch = fakeFetch(
      chatReply({
        answers: [
          { id: 'a', bool: true },
          { id: 'b', bool: false },
        ],
      }),
    );
    const shot = [{ id: 'shot', dataUrl: PNG }];
    await llm(fetch, true).solve([
      q({ id: 'a', kind: 'judge', stem: 'x', needsVision: true, images: shot }),
      q({ id: 'b', kind: 'judge', stem: 'y', needsVision: true, images: shot }),
    ]);
    const parts = fetch.calls[0]!.body.messages[1].content;
    expect(parts.filter((p: { type: string }) => p.type === 'image_url')).toHaveLength(1);
    expect(parts).toContainEqual({ type: 'text', text: 'Image "shot" for questions "a", "b":' });
  });

  it('returns an empty list when the page has no questions', async () => {
    const fetch = fakeFetch(chatReply({ questions: [] }));
    await expect(
      llm(fetch, true).read!({ pageUrl: 'https://example.com', image: PNG }),
    ).resolves.toMatchObject({
      questions: [],
    });
  });

  it('fails when nothing usable comes back', async () => {
    const fetch = fakeFetch(chatReply({ questions: [{ nonsense: true }] }));
    await expect(
      llm(fetch, true).read!({ pageUrl: 'https://example.com', image: PNG }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('extractJson', () => {
  it('handles plain, fenced and embedded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(extractJson('no json')).toBeUndefined();
  });
});

describe('OpenAI-compatible mark (set-of-marks)', () => {
  const marks = [
    { id: 1, tag: 'div', text: '1. 下列哪个是哺乳动物？' },
    { id: 2, tag: 'span', text: '鲸鱼' },
    { id: 3, tag: 'span', text: '鲨鱼' },
    { id: 4, tag: 'input', text: '' },
  ];

  it('sends the numbered list with the screenshot and keeps only real numbers', async () => {
    const fetch = fakeFetch(
      chatReply({
        questions: [
          { kind: 'single', stem: 1, options: [2, 3, 3, 99] },
          { kind: 'fill', stem: 1, inputs: [4] },
          { kind: 'single', stem: 42, options: [2, 3] }, // invented stem
          { kind: 'single', stem: 1, options: [2] }, // one option is not a choice question
        ],
      }),
    );
    const out = await llm(fetch, true).mark!({ pageUrl: 'https://example.com', image: PNG, marks });
    const content = fetch.calls[0]!.body.messages[1].content;
    expect(content[0].text).toContain('[2] span: 鲸鱼');
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: PNG } });
    expect(out.questions).toEqual([
      { kind: 'single', stem: 1, options: [2, 3], inputs: [] },
      { kind: 'fill', stem: 1, options: [], inputs: [4] },
    ]);
  });

  it('is only available with vision', () => {
    expect(llm(fakeFetch()).mark).toBeUndefined();
  });
});

describe('listModels', () => {
  it('reads OpenAI-style and Ollama-style lists, sorted and de-duplicated', async () => {
    const fetch = fakeFetch(
      Response.json({
        data: [{ id: 'b-model' }, { id: 'a-model' }],
        models: [{ name: 'a-model' }],
      }),
    );
    expect(await listModels('https://api.example.com/v1/', 'k', { fetch })).toEqual([
      'a-model',
      'b-model',
    ]);
    expect(fetch.calls[0]!.url).toBe('https://api.example.com/v1/models');
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer k');
  });

  it("adds Anthropic's own auth headers", async () => {
    const fetch = fakeFetch(Response.json({ data: [{ id: 'claude-haiku-4-5' }] }));
    await listModels('https://api.anthropic.com/v1', 'sk-ant', { fetch });
    expect(fetch.calls[0]!.headers['x-api-key']).toBe('sk-ant');
    expect(fetch.calls[0]!.headers['anthropic-version']).toBeDefined();
  });

  it('reports a bad key as an auth error', async () => {
    const fetch = fakeFetch(new Response('no', { status: 401 }));
    await expect(listModels('https://api.example.com/v1', 'bad', { fetch })).rejects.toMatchObject({
      code: 'auth',
    });
  });
});
