import { describe, expect, it } from 'vitest';
import { lastSite, trimLog } from './debug';

describe('lastSite', () => {
  it('takes the host of the newest entry with a URL', () => {
    expect(
      lastSite([
        { t: 1, event: '开始', data: { url: 'https://a.com/x' } },
        { t: 2, event: '开始', data: { url: 'https://www.jxedt.com/mnks/' } },
        { t: 3, event: '完成', data: { 结果: 'ok' } },
      ]),
    ).toBe('www.jxedt.com');
    expect(lastSite([{ t: 1, event: 'x' }])).toBe('');
  });
});

describe('trimLog', () => {
  it('keeps the header and the newest lines', () => {
    const head = ['QuizPilot 0.1.0', 'UA', '导出时间 x', ''];
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const text = [...head, ...body].join('\n');
    expect(trimLog(text, text.length)).toBe(text);
    const out = trimLog(text, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.startsWith(head.join('\n'))).toBe(true);
    expect(out.endsWith('line 99')).toBe(true);
    expect(out).toMatch(/earlier lines omitted/);
  });
});
