import type { ConversationSnapshot, MessageRecord } from '../conversation/types';
import { zh } from '../ui/zh';

const MARKDOWN_PUNCTUATION = /([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

function displayTitle(title: string): string {
  const singleLine = title.replace(/[\r\n]+/g, ' ').trim();
  return singleLine || zh.defaultConversationTitle;
}

function escapePlainText(text: string): string {
  return text.replace(MARKDOWN_PUNCTUATION, '\\$1');
}

function messageBody(message: MessageRecord): string {
  return message.markdown === undefined
    ? escapePlainText(message.text)
    : message.markdown;
}

/**
 * Exports a conversation as readable Markdown. Parsed Markdown is retained as
 * supplied; a plain-text fallback is escaped so it cannot create new syntax.
 */
export function exportMarkdown(snapshot: ConversationSnapshot): string {
  const parts = [`# ${escapePlainText(displayTitle(snapshot.title))}`];

  for (const message of snapshot.messages) {
    const role = message.role === 'user' ? zh.userExportRole : 'ChatGPT';
    parts.push(`## ${role}\n\n${messageBody(message)}`);
  }

  return `${parts.join('\n\n')}\n`;
}
