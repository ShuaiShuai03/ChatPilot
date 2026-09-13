import type { ConversationView, MessageRecord, MessageRole } from './types';

export interface IdentityChange { from: string; to: string; preserveSelection: boolean }

/** The only message collection consumed by navigation, search, selection and export. */
export class ConversationStore {
  readonly records = new Map<string, MessageRecord>();
  private listeners = new Set<() => void>();
  private view: ConversationView = {
    messages: [], selectedIds: new Set(), currentId: null,
    busy: false, progress: '', error: null, needsReindex: false,
    userNavigation: { canPrevious: false, canNext: false },
  };

  getSnapshot = (): ConversationView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<ConversationView>): void {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach(listener => listener());
  }

  commit(messages: MessageRecord[], changes: IdentityChange[] = []): void {
    const selectedIds = new Set(this.view.selectedIds);
    let currentId = this.view.currentId;
    for (const { from, to, preserveSelection } of changes) {
      if (selectedIds.delete(from) && preserveSelection) selectedIds.add(to);
      if (currentId === from) currentId = preserveSelection ? to : null;
    }
    this.records.clear();
    for (const record of messages) this.records.set(record.id, record);
    for (const id of selectedIds) if (!this.records.has(id)) selectedIds.delete(id);
    if (currentId && !this.records.has(currentId)) currentId = null;
    this.publish({ messages: [...this.records.values()], selectedIds, currentId });
  }

  toggleSelection = (id: string): void => {
    if (!this.records.has(id)) return;
    const selectedIds = new Set(this.view.selectedIds);
    if (!selectedIds.delete(id)) selectedIds.add(id);
    this.publish({ selectedIds });
  };

  select = (mode: 'all' | 'none' | MessageRole): void => {
    this.publish({ selectedIds: new Set(this.view.messages
      .filter(message => mode === 'all' || message.role === mode)
      .map(message => message.id)) });
  };

  setCurrent(id: string | null): void {
    if (id === this.view.currentId) return;
    this.publish({ currentId: id });
  }

  setOperation(busy: boolean, progress = ''): void { this.publish({ busy, progress }); }
  setError(error: string | null): void { this.publish({ error }); }
  setUserNavigation(canPrevious: boolean, canNext: boolean): void {
    if (this.view.userNavigation.canPrevious === canPrevious && this.view.userNavigation.canNext === canNext) return;
    this.publish({ userNavigation: { canPrevious, canNext } });
  }
  requireReindex(error = '加载期间多次切换了会话。请打开目标会话，然后在此重新建立索引。'): void {
    this.publish({ needsReindex: true, error });
  }

  reset(): void {
    this.records.clear();
    this.publish({ messages: [], selectedIds: new Set(), currentId: null, busy: false, progress: '', error: null, needsReindex: false,
      userNavigation: { canPrevious: false, canNext: false } });
  }
}
