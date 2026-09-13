export type MessageRole = 'user' | 'assistant';

export interface MessageRecord {
  id: string;
  turnId?: string;
  role: MessageRole;
  index: number;
  text: string;
  markdown?: string;
  preview: string;
}

export interface ConversationSnapshot {
  schemaVersion: 1;
  title: string;
  url: string;
  exportedAt: string;
  messages: MessageRecord[];
}

export type ExportFormat = 'md' | 'json' | 'txt';
export type ExportMode = 'all' | 'assistant' | 'selected';
export type UserNavigationDirection = 'previous' | 'next';

export interface ConversationView {
  messages: readonly MessageRecord[];
  selectedIds: ReadonlySet<string>;
  currentId: string | null;
  busy: boolean;
  progress: string;
  error: string | null;
  needsReindex: boolean;
  userNavigation: { canPrevious: boolean; canNext: boolean };
}

export interface ConversationUIStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConversationView;
  toggleSelection(id: string): void;
  select(mode: 'all' | 'none' | MessageRole): void;
}

export interface ChatPilotController {
  store: ConversationUIStore;
  navigate(id: string): Promise<void>;
  navigateUser(direction: UserNavigationDirection): Promise<void>;
  materialize(): Promise<void>;
  export(format: ExportFormat, mode: ExportMode): Promise<void>;
  cancel(): void;
  reindex(): void;
}
