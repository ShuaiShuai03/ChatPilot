import type { ConversationSnapshot } from '../conversation/types';
import { zh } from '../ui/zh';

function displayTitle(title: string): string {
  return title.trim() || zh.defaultConversationTitle;
}

/** Exports a plain-text transcript suitable for viewing in any text editor. */
export function exportText(snapshot: ConversationSnapshot): string {
  const turns = snapshot.messages.map((message) => {
    const role = message.role === 'user' ? zh.userExportRole : 'ChatGPT';
    return `[${role}]\n${message.text}`;
  });

  if (turns.length === 0) {
    return `${displayTitle(snapshot.title)}\n`;
  }

  return `${displayTitle(snapshot.title)}\n\n${turns.join('\n\n---\n\n')}\n`;
}
