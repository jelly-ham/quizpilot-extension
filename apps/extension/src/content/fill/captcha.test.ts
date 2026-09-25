import { beforeEach, describe, expect, it } from 'vitest';
import { mount, testLayout } from '../../test/dom';
import { findCaptcha } from './captcha';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findCaptcha', () => {
  it('finds a visible GeeTest box', () => {
    mount(`<div class="geetest_panel" width="320" height="400"><div>请完成下方验证</div></div>`);
    expect(findCaptcha(document, testLayout)).toBe('geetest_panel');
  });

  it('ignores hidden and tiny challenge stubs', () => {
    mount(`
      <div class="geetest_holder" hidden width="320" height="400"></div>
      <div id="captcha-badge" width="20" height="10"></div>`);
    expect(findCaptcha(document, testLayout)).toBeNull();
  });

  it('finds a verification dialog by its text', () => {
    mount(`<div role="dialog">安全验证：请拖动滑块完成拼图</div>`);
    expect(findCaptcha(document, testLayout)).toContain('安全验证');
  });

  it('is quiet on an ordinary quiz page', () => {
    mount(`<div class="question">1. 2 + 2 = ?</div><div class="modal">答题规则</div>`);
    expect(findCaptcha(document, testLayout)).toBeNull();
  });
});
