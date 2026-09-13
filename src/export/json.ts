import type { ConversationSnapshot, MessageRecord } from '../conversation/types';
import { zh } from '../ui/zh';

interface ExportedMessage {
  id: string;
  turnId?: string;
  role: MessageRecord['role'];
  index: number;
  text: string;
  markdown?: string;
}

function exportMessage(message: MessageRecord): ExportedMessage {
  return {
    id: message.id,
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    role: message.role,
    index: message.index,
    text: message.text,
    ...(message.markdown === undefined ? {} : { markdown: message.markdown }),
  };
}

/** Exports canonical conversation data in a stable, portable JSON envelope. */
export function exportJSON(snapshot: ConversationSnapshot): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      title: snapshot.title.trim() || zh.defaultConversationTitle,
      url: snapshot.url,
      exportedAt: snapshot.exportedAt,
      messages: snapshot.messages.map(exportMessage),
    },
    null,
    2,
  )}\n`;
}
