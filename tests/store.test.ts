import { describe, expect, it } from 'vitest';

import { ConversationStore } from '../src/conversation/store';
import type { MessageRecord } from '../src/conversation/types';

function record(id: string, role: MessageRecord['role'] = 'assistant'): MessageRecord {
  return { id, role, index: 1, text: id, markdown: id, preview: id };
}

describe('ConversationStore', () => {
  it('selects only canonical committed records for all supported modes', () => {
    const store = new ConversationStore();
    store.commit([record('user-1', 'user'), record('assistant-1'), record('assistant-2')]);

    store.select('assistant');
    expect([...store.getSnapshot().selectedIds]).toEqual(['assistant-1', 'assistant-2']);

    store.select('all');
    expect([...store.getSnapshot().selectedIds]).toEqual(['user-1', 'assistant-1', 'assistant-2']);

    store.select('none');
    expect(store.getSnapshot().selectedIds.size).toBe(0);
    store.toggleSelection('unknown-alias');
    expect(store.getSnapshot().selectedIds.size).toBe(0);
  });

  it('preserves selection and current message only for explicitly migratable identities', () => {
    const store = new ConversationStore();
    store.commit([record('assistant:old')]);
    store.toggleSelection('assistant:old');
    store.setCurrent('assistant:old');

    store.commit([record('assistant:new')], [
      { from: 'assistant:old', to: 'assistant:new', preserveSelection: true },
    ]);
    expect([...store.getSnapshot().selectedIds]).toEqual(['assistant:new']);
    expect(store.getSnapshot().currentId).toBe('assistant:new');

    store.commit([record('server-message')], [
      { from: 'assistant:new', to: 'server-message', preserveSelection: false },
    ]);
    expect(store.getSnapshot().selectedIds.size).toBe(0);
    expect(store.getSnapshot().currentId).toBeNull();
  });

  it('drops selections and current IDs that no longer belong to a committed record', () => {
    const store = new ConversationStore();
    store.commit([record('first'), record('second')]);
    store.toggleSelection('first');
    store.setCurrent('first');

    store.commit([record('second')]);

    expect(store.getSnapshot().messages.map((message) => message.id)).toEqual(['second']);
    expect(store.getSnapshot().selectedIds.size).toBe(0);
    expect(store.getSnapshot().currentId).toBeNull();
  });
});
