import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { parseTurn, getMessageIds } from '../src/adapters/chatgpt/parser';
import type { MessageRecord } from '../src/conversation/types';

function fixture(name: string): HTMLElement {
  const source = readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
  const { document } = parseHTML(source);
  const section = document.querySelector('section');
  if (!section) {
    throw new Error(`Fixture ${name} does not contain a turn section.`);
  }
  return section as unknown as HTMLElement;
}

function parsed(name: string): MessageRecord {
  const record = parseTurn(fixture(name));
  if (!record) {
    throw new Error(`Fixture ${name} did not parse.`);
  }
  return record;
}

describe('ChatGPT DOM turn parser', () => {
  it('keeps visible semantic content while omitting controls', () => {
    const record = parsed('normal.html');

    expect(record).toMatchObject({
      id: 'assistant-normal',
      turnId: 'turn-normal',
      role: 'assistant',
      index: 2,
    });
    expect(record.text).toContain('部署结果');
    expect(record.text).not.toContain('复制');
    expect(record.text).not.toContain('You said');
    expect(record.text).not.toContain('ChatGPT said');
    expect(record.markdown).toContain('[运行报告](https://example.test/report)');
    expect(record.markdown).toContain('> 变更已完成。');
    expect(record.preview.length).toBeLessThanOrEqual(100);
    expect(getMessageIds(fixture('normal.html'))).toEqual([
      'assistant-normal',
      'turn-normal',
      'conversation-turn-2',
    ]);
  });

  it('creates a safe language-tagged fence for code containing a nested fence', () => {
    const record = parsed('code.html');

    expect(record.markdown).toContain('````python');
    expect(record.markdown).toContain('print("```")');
    expect(record.markdown).not.toContain('Copy');
    expect(record.text.match(/print/g)?.length).toBe(2);
    expect(record.text).toContain('  print("done")');
  });

  it('preserves GFM tables, images, links, and attachment-only user turns', () => {
    expect(parsed('table.html').markdown).toContain('| 项目 | 状态 |');
    expect(parsed('table.html').markdown).toContain('| --- | --- |');

    const images = parsed('images.html');
    expect(images.markdown).toContain('![系统拓扑图](https://example.test/diagram.png)');
    expect(images.markdown).toContain('[操作手册](https://example.test/manual.pdf)');

    const attachment = parsed('attachments.html');
    expect(attachment).toMatchObject({ id: 'user-attachment', role: 'user' });
    expect(attachment.text).toBe('计划.xlsx');
    expect(attachment.markdown).toContain('[计划.xlsx](https://example.test/files/计划.xlsx)');
  });

  it('uses one semantic math representation and ignores folded reasoning', () => {
    const math = parsed('math.html');
    expect(math.text).toContain('$E = mc^2$');
    expect(math.text).not.toContain('E = mc²');

    const reasoning = parsed('reasoning.html');
    expect(reasoning.text).toContain('裁剪但可见的正文');
    expect(reasoning.text).toContain('最终答案。');
    expect(reasoning.text).not.toContain('不应导出');
    expect(reasoning.text).not.toContain('隐藏的辅助文本');
    expect(reasoning.text).not.toContain('不可见答案');
  });

  it('merges matching assistant blocks in DOM order and returns aliases', () => {
    const turn = fixture('multiple-assistant-blocks.html');
    const record = parseTurn(turn);
    if (!record) {
      throw new Error('Multiple assistant blocks did not parse.');
    }

    expect(record.id).toBe('assistant-part-one');
    expect(record.text).toBe('第一段回答。\n第二段回答。');
    expect(record.text).not.toContain('不属于这轮');
    expect(getMessageIds(turn)).toEqual([
      'assistant-part-one',
      'assistant-part-two',
      'turn-multi',
      'conversation-turn-9',
    ]);
  });

  it('uses a text hash only when stable DOM identifiers are absent', () => {
    const { document } = parseHTML(
      '<section><div data-message-author-role="assistant">无标识回答</div></section>',
    );
    const turn = document.querySelector('section') as unknown as HTMLElement;
    const record = parseTurn(turn);

    expect(record).not.toBeNull();
    expect(record?.id).toMatch(/^assistant:[0-9a-f]{16}$/);
    expect(record?.index).toBe(0);
  });

  it('uses the standalone message identifier and its outer turn alias', () => {
    const { document } = parseHTML(
      '<div data-turn-id-container="outer-turn"><section data-testid="conversation-turn-12"><div data-message-author-role="assistant" data-message-id="inner-message">独立消息</div></section></div>',
    );
    const message = document.querySelector('[data-message-id]') as unknown as HTMLElement;
    const record = parseTurn(message);

    expect(record).toMatchObject({
      id: 'inner-message',
      turnId: 'outer-turn',
      role: 'assistant',
      text: '独立消息',
    });
    expect(getMessageIds(message)).toEqual(['inner-message', 'outer-turn', 'conversation-turn-12']);
  });

  it('does not guess a role when visible message blocks conflict', () => {
    const { document } = parseHTML(
      '<section><div data-message-author-role="user">问题</div><div data-message-author-role="assistant">回答</div></section>',
    );
    const turn = document.querySelector('section') as unknown as HTMLElement;

    expect(parseTurn(turn)).toBeNull();
  });

  it('preserves TeX escaping and display math without exposing a folded reasoning block', () => {
    const { document } = parseHTML(String.raw`<section data-turn="assistant">
      <details><summary>Reasoning</summary><div data-message-author-role="assistant" data-message-id="hidden-reasoning">never export this</div></details>
      <div data-message-author-role="assistant" data-message-id="visible-final"><span class="katex-display"><span class="katex"><span aria-hidden="true">visual duplicate</span><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">\frac{x_1}{y_2}</annotation></semantics></math></span></span></span></div>
      </section>`);
    const record = parseTurn(document.querySelector('section') as unknown as HTMLElement);
    expect(record?.id).toBe('visible-final');
    expect(record?.markdown).toBe('$$\n\\frac{x_1}{y_2}\n$$');
    expect(record?.text).not.toContain('never export');
    expect(record?.markdown).not.toContain('visual duplicate');
  });

  it('keeps headerless tables and cell pipes valid in Markdown', () => {
    const { document } = parseHTML('<section data-turn="assistant"><div data-message-author-role="assistant"><table><tbody><tr><td>a|b</td><td>first<br>second</td></tr></tbody></table></div></section>');
    const record = parseTurn(document.querySelector('section') as unknown as HTMLElement);
    expect(record?.markdown).toContain('|  |  |\n| --- | --- |');
    expect(record?.markdown).toContain('a\\|b');
    expect(record?.markdown).toContain('first<br>second');
  });

  it('does not manufacture active image sources or unsafe links while normalizing content', () => {
    const { document } = parseHTML('<section data-turn="assistant"><div data-message-author-role="assistant"><img alt="diagram" src="https://example.test/img.png"><a href="javascript:alert(1)">unsafe link</a><span data-attachment-name="notes.txt"></span></div></section>');
    const record = parseTurn(document.querySelector('section') as unknown as HTMLElement);
    expect(record?.markdown).toContain('![diagram](https://example.test/img.png)');
    expect(record?.markdown).not.toContain('javascript:');
    expect(record?.text).toContain('notes.txt');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://example.test/img.png');
  });
});
