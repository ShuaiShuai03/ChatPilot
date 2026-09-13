import { describe, expect, it } from 'vitest';

import type { ConversationSnapshot, MessageRecord } from '../src/conversation/types';
import { exportJSON } from '../src/export/json';
import { exportMarkdown } from '../src/export/markdown';
import { selectMessages } from '../src/export/scope';
import { exportText } from '../src/export/text';

const messages: MessageRecord[] = [
  {
    id: 'duplicate-looking',
    role: 'user' as const,
    index: 4,
    text: '# A heading\n- [x] `literal` *emphasis* > quote',
    preview: 'A heading',
  },
  {
    id: 'duplicate-looking-2',
    turnId: '',
    role: 'assistant' as const,
    index: 9,
    text: 'Rendered response',
    markdown: '```ts\nconst value = `kept`;\n```',
    preview: 'Rendered response',
  },
  {
    id: 'third',
    role: 'assistant' as const,
    index: 15,
    text: '第二个回答',
    preview: '第二个回答',
  },
];
messages.forEach((message) => Object.freeze(message));
Object.freeze(messages);

const snapshot: ConversationSnapshot = {
  schemaVersion: 1,
  title: '测试 / Conversation',
  url: 'https://chatgpt.com/c/example',
  exportedAt: '2026-09-12T08:09:10.123Z',
  messages,
};
Object.freeze(snapshot);

describe('selectMessages', () => {
  it('supports all three scopes while retaining original order and records', () => {
    expect(selectMessages(messages, 'all', new Set())).toEqual([...messages]);
    expect(selectMessages(messages, 'assistant', new Set())).toEqual([
      messages[1],
      messages[2],
    ]);
    expect(
      selectMessages(messages, 'selected', new Set(['third', 'duplicate-looking'])),
    ).toEqual([messages[0], messages[2]]);
  });

  it('accepts an empty selection without mutating frozen input', () => {
    const before = JSON.stringify(snapshot);

    expect(selectMessages(messages, 'selected', new Set())).toEqual([]);
    expect(exportMarkdown(snapshot)).toContain('## 用户');
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe('pure exporters', () => {
  it('preserves parsed Markdown and safely escapes the text fallback', () => {
    expect(exportMarkdown(snapshot)).toBe(
      '# 测试 \\/ Conversation\n\n'
        + '## 用户\n\n'
        + '\\# A heading\n\\- \\[x\\] \\`literal\\` \\*emphasis\\* \\> quote\n\n'
        + '## ChatGPT\n\n```ts\nconst value = `kept`;\n```\n\n'
        + '## ChatGPT\n\n第二个回答\n',
    );
  });

  it('writes a versioned JSON envelope containing canonical export fields', () => {
    const exported = JSON.parse(exportJSON(snapshot)) as {
      schemaVersion: number;
      title: string;
      url: string;
      exportedAt: string;
      messages: Array<Record<string, unknown>>;
    };

    expect(exported).toMatchObject({
      schemaVersion: 1,
      title: '测试 / Conversation',
      url: 'https://chatgpt.com/c/example',
      exportedAt: '2026-09-12T08:09:10.123Z',
    });
    expect(exported.messages).toEqual([
      {
        id: 'duplicate-looking',
        role: 'user',
        index: 4,
        text: '# A heading\n- [x] `literal` *emphasis* > quote',
      },
      {
        id: 'duplicate-looking-2',
        turnId: '',
        role: 'assistant',
        index: 9,
        text: 'Rendered response',
        markdown: '```ts\nconst value = `kept`;\n```',
      },
      {
        id: 'third',
        role: 'assistant',
        index: 15,
        text: '第二个回答',
      },
    ]);
  });

  it('makes a readable text transcript with turn separators', () => {
    expect(exportText(snapshot)).toBe(
      '测试 / Conversation\n\n'
        + '[用户]\n# A heading\n- [x] `literal` *emphasis* > quote\n\n---\n\n'
        + '[ChatGPT]\nRendered response\n\n---\n\n'
        + '[ChatGPT]\n第二个回答\n',
    );
  });

  it('uses the fallback title for valid empty conversations', () => {
    const empty: ConversationSnapshot = {
      schemaVersion: 1,
      title: '   ',
      url: '',
      exportedAt: '2026-09-12T08:09:10.123Z',
      messages: [],
    };

    expect(exportMarkdown(empty)).toBe('# ChatGPT 对话\n');
    expect(exportText(empty)).toBe('ChatGPT 对话\n');
    expect(JSON.parse(exportJSON(empty)).title).toBe('ChatGPT 对话');
  });
});
