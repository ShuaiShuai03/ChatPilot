import { zh } from '../ui/zh';
import { UserMessageNavigator } from '../adapters/chatgpt/user-navigation';
import { ConversationIndex } from './index';
import { ConversationStore } from './store';
import type { ChatPilotController, ConversationSnapshot, ExportFormat, ExportMode, UserNavigationDirection } from './types';
import type { Settings } from '../settings';
import { observeConversation } from '../adapters/chatgpt/observer';
import { CurrentMessageTracker, getScrollRoot } from '../adapters/chatgpt/navigator';
import { ConversationMaterializer } from '../adapters/chatgpt/materializer';
import { exportMarkdown } from '../export/markdown';
import { exportJSON } from '../export/json';
import { exportText } from '../export/text';
import { selectMessages } from '../export/scope';
import { downloadFile, exportFilename } from '../export/download';

export function conversationKey(url: URL): string {
  const id = url.pathname.match(/\/c\/([^/]+)/)?.[1];
  return id ? `conversation:${id}` : `new:${url.pathname}`;
}

function findRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('main #thread, #thread') ?? document.querySelector<HTMLElement>('main');
}

/** Owns the browser lifetime. UI only receives the public controller interface. */
export class ConversationController implements ChatPilotController {
  readonly store = new ConversationStore();
  private index?: ConversationIndex;
  private tracker?: CurrentMessageTracker;
  private materializer?: ConversationMaterializer;
  private userNavigator?: UserMessageNavigator;
  private stopContent?: () => void;
  private lifetimeObserver?: MutationObserver;
  private bootstrapObserver?: MutationObserver;
  private transitionObserver?: MutationObserver;
  private transitionTimer?: ReturnType<typeof setTimeout>;
  private operation?: AbortController;
  private key = conversationKey(new URL(location.href));
  private generation = 0;
  private disposed = false;
  private transition?: { root: HTMLElement; shells: Set<string>; hadRecords: boolean; ambiguous: boolean };
  private submittedPrompt?: { root: HTMLElement; ids: Set<string>; at: number };

  constructor(private settings: Settings) {}

  start(): void {
    document.addEventListener('submit', this.recordComposerIntent, true);
    document.addEventListener('click', this.recordComposerIntent, true);
    document.addEventListener('keydown', this.recordComposerIntent, true);
    if (this.settings.navigatorEnabled) this.findAndAttach();
  }

  private recordComposerIntent = (event: Event): void => {
    if (!this.key.startsWith('new:') || !this.index) return;
    const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (!target || target.closest('chatpilot-ui')) return;
    const composer = '#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]';
    const form = target.closest('form');
    const keyboard = event instanceof KeyboardEvent && event.key === 'Enter' && !event.shiftKey && !event.isComposing && Boolean(target.closest(composer));
    const submit = event.type === 'submit' && Boolean(form?.querySelector(composer));
    const send = event.type === 'click' && Boolean(target.closest('[data-testid="send-button"],button[type="submit"]')) && Boolean(form?.querySelector(composer));
    if (keyboard || submit || send) this.submittedPrompt = {
      root: this.index.root, ids: new Set(this.store.records.keys()), at: Date.now(),
    };
    // Any later unrelated control interaction invalidates the inferred promotion intent.
    else this.submittedPrompt = undefined;
  };

  setSettings(settings: Settings): void {
    const enabledBefore = this.settings.navigatorEnabled;
    this.settings = settings;
    if (enabledBefore === settings.navigatorEnabled) return;
    if (settings.navigatorEnabled) this.findAndAttach();
    else { this.generation++; this.detach(); this.stopLifetime(); this.store.reset(); }
  }

  private shellIds(root: HTMLElement): Set<string> {
    return new Set([...root.querySelectorAll('[data-turn-id-container],[data-turn-id]')]
      .map(element => element.getAttribute('data-turn-id-container') ?? element.getAttribute('data-turn-id'))
      .filter((id): id is string => Boolean(id) && id !== 'client-created-root'));
  }

  onLocationChange(url: URL): void {
    // Navigation API also reports Blob downloads and external destinations.
    if (url.protocol !== 'https:' || url.origin !== location.origin) return;
    const nextKey = conversationKey(url);
    if (nextKey === this.key) return;
    const previousKey = this.key;
    this.key = nextKey;
    this.generation++;
    this.operation?.abort('conversation-changed');
    this.operation = undefined;
    this.store.setOperation(false);
    if (!this.settings.navigatorEnabled || this.disposed) return;
    const oldIndex = this.index;
    const submitted = this.submittedPrompt;
    this.submittedPrompt = undefined;
    // Only observed composer submission plus continuous stable identities proves a draft promotion.
    if (previousKey.startsWith('new:') && nextKey.startsWith('conversation:') && oldIndex && submitted
      && Date.now() - submitted.at < 30_000 && oldIndex.root === submitted.root && oldIndex.root === findRoot() && !this.transition) {
      oldIndex.reconcile();
      const continuous = [...submitted.ids].every(id => this.store.records.has(id));
      const newUser = [...this.store.records.values()].some(message => message.role === 'user'
        && !submitted.ids.has(message.id) && (oldIndex.getSlot(message.id)?.aliases.length ?? 0) > 0);
      if (continuous && newUser) {
        this.detach();
        this.findAndAttach();
        return;
      }
    }
    const ambiguous = Boolean(this.transition);
    this.transition = oldIndex ? {
      root: oldIndex.root, shells: this.shellIds(oldIndex.root), hadRecords: this.store.records.size > 0, ambiguous,
    } : this.transition;
    if (this.transition && ambiguous) this.transition.ambiguous = true;
    this.detach();
    this.store.reset();
    this.transitionObserver?.disconnect();
    this.transitionObserver = undefined;
    clearTimeout(this.transitionTimer);
    this.transitionTimer = undefined;
    if (this.transition?.ambiguous) { this.store.requireReindex(); return; }
    if (this.transition) {
      this.transitionObserver = new MutationObserver(() => this.findAndAttach());
      this.transitionObserver.observe(this.transition.root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-message-id', 'data-turn-id', 'data-testid'] });
      const generation = this.generation;
      this.transitionTimer = setTimeout(() => {
        if (generation === this.generation && this.transition) this.store.requireReindex('正在等待新会话。目标会话显示后，可在此重新建立索引。');
      }, 2000);
      this.findAndAttach();
    } else this.findAndAttach();
  }

  private findAndAttach(): void {
    if (this.disposed || !this.settings.navigatorEnabled) return;
    if (this.transition?.ambiguous) { this.store.requireReindex(); return; }
    if (this.index?.root.isConnected && !this.transition) return;
    const root = findRoot();
    if (!root) { this.waitForRoot(); return; }
    if (this.transition) {
      if (root === this.transition.root && this.transition.hadRecords) {
        const shells = this.shellIds(root);
        // Mounted bodies change during virtualization; persistent turn identities do not.
        // Without stable shells, same-root replacement cannot establish conversation ownership.
        if (!this.transition.shells.size || !shells.size || [...this.transition.shells].some(id => shells.has(id))) return;
      }
      this.transition = undefined;
      this.transitionObserver?.disconnect();
      this.transitionObserver = undefined;
      clearTimeout(this.transitionTimer);
      this.transitionTimer = undefined;
      this.store.reset();
    }
    this.bootstrapObserver?.disconnect();
    this.bootstrapObserver = undefined;
    this.detach();
    const index = new ConversationIndex(root, this.store);
    this.index = index;
    index.initialize();
    this.stopContent = observeConversation(index);
    const scrollRoot = getScrollRoot(root);
    this.tracker = new CurrentMessageTracker(index, this.store, scrollRoot);
    this.materializer = new ConversationMaterializer(index, scrollRoot, this.tracker);
    this.userNavigator = new UserMessageNavigator(index, scrollRoot, this.tracker, this.materializer);
    this.watchAncestry(root);
  }

  private watchAncestry(root: HTMLElement): void {
    this.lifetimeObserver?.disconnect();
    this.lifetimeObserver = new MutationObserver(() => {
      if (!root.isConnected) {
        this.generation++;
        this.detach();
        this.store.reset();
        this.findAndAttach();
      }
    });
    // Shallow observers on the ancestor chain detect replacement without watching every body mutation.
    let parent = root.parentElement;
    while (parent) { this.lifetimeObserver.observe(parent, { childList: true }); parent = parent.parentElement; }
  }

  private waitForRoot(): void {
    if (this.bootstrapObserver) return;
    this.bootstrapObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as HTMLElement;
        if (element.matches('main,#thread') || element.querySelector('main,#thread')) { this.findAndAttach(); return; }
      }
    });
    // Temporary bootstrap only; disconnected as soon as the conversation area appears.
    this.bootstrapObserver.observe(document.body, { childList: true, subtree: true });
  }

  private detach(): void {
    this.operation?.abort('conversation-changed');
    this.operation = undefined;
    this.stopContent?.();
    this.stopContent = undefined;
    this.userNavigator?.dispose();
    this.userNavigator = undefined;
    this.tracker?.dispose();
    this.tracker = undefined;
    this.index?.dispose();
    this.index = undefined;
    this.materializer = undefined;
  }

  private stopLifetime(): void {
    this.lifetimeObserver?.disconnect();
    this.bootstrapObserver?.disconnect();
    this.transitionObserver?.disconnect();
    clearTimeout(this.transitionTimer);
    this.transitionTimer = undefined;
    this.lifetimeObserver = undefined;
    this.bootstrapObserver = undefined;
    this.transitionObserver = undefined;
    this.transition = undefined;
    this.submittedPrompt = undefined;
  }

  cancel = (): void => { this.operation?.abort('cancelled'); };

  reindex = (): void => {
    if (!this.settings.navigatorEnabled || this.disposed) return;
    this.generation++;
    this.detach();
    this.stopLifetime();
    this.store.reset();
    this.findAndAttach();
  };

  navigate = async (id: string): Promise<void> => { await this.runNavigation(id, false); };
  navigateUser = async (direction: UserNavigationDirection): Promise<void> => { await this.runNavigation(direction, true); };

  private async runNavigation(target: string, directional: boolean): Promise<void> {
    const navigator = this.userNavigator;
    const index = this.index;
    if (!navigator || !index || this.operation || this.store.getSnapshot().needsReindex) return;
    if (conversationKey(new URL(location.href)) !== this.key) return;
    const operation = new AbortController();
    this.operation = operation;
    const generation = this.generation;
    this.store.setError(null);
    this.store.setOperation(true, '正在定位消息…');
    try {
      await navigator.navigate(target, operation.signal, this.settings.smoothScroll,
        message => { if (generation === this.generation) this.store.setOperation(true, message); }, directional);
    } catch (error) {
      if (generation === this.generation) this.store.setError(error instanceof Error ? error.message : '无法定位这条消息。');
    } finally {
      if (generation === this.generation && this.operation === operation) {
        this.operation = undefined;
        this.store.setOperation(false);
        navigator.refresh();
      }
    }
  }

  materialize = async (): Promise<void> => { await this.collectAndExport(); };
  export = async (format: ExportFormat, mode: ExportMode): Promise<void> => { await this.collectAndExport(format, mode); };

  private async collectAndExport(format?: ExportFormat, mode: ExportMode = 'all'): Promise<void> {
    const materializer = this.materializer;
    const index = this.index;
    if (this.operation) return;
    if (!index || !materializer) { this.store.setError('请先打开一个 ChatGPT 会话。'); return; }
    const operation = new AbortController();
    this.operation = operation;
    const generation = this.generation;
    const operationKey = this.key;
    const selectedIds = new Set(this.store.getSnapshot().selectedIds);
    this.store.setError(null);
    this.store.setOperation(true, '正在准备会话…');
    try {
      const result = await materializer.collect({ signal: operation.signal,
        ...(mode === 'selected' ? { selectedIds } : {}),
        onProgress: message => { if (generation === this.generation) this.store.setOperation(true, message); },
      });
      if (generation !== this.generation || !index.active) return;
      if (this.key !== operationKey || conversationKey(new URL(location.href)) !== operationKey) {
        this.store.setError('会话已切换，请等待加载完成后重试。');
        return;
      }
      if (!result.complete) { this.store.setError(result.reason); return; }
      if (operation.signal.aborted) { this.store.setError('加载已取消。'); return; }
      if (format) {
        const effectiveSelection = mode === 'selected' ? new Set(result.messages.map(message => message.id)) : selectedIds;
        const messages = selectMessages(result.messages, mode, effectiveSelection);
        if (messages.length === 0) { this.store.setError('当前导出范围内没有消息。'); return; }
        const snapshot: ConversationSnapshot = {
          schemaVersion: 1,
          title: document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim() || zh.defaultConversationTitle,
          url: `${location.origin}${location.pathname}`,
          exportedAt: result.collectedAt,
          messages,
        };
        const content = format === 'md' ? exportMarkdown(snapshot) : format === 'json' ? exportJSON(snapshot) : exportText(snapshot);
        const mimeType = format === 'md' ? 'text/markdown;charset=utf-8' : format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8';
        downloadFile(content, exportFilename(snapshot.title, snapshot.exportedAt, format), mimeType);
      }
    } catch (error) {
      if (generation === this.generation) this.store.setError(error instanceof Error ? error.message : '无法加载会话，请重试。');
    } finally {
      if (generation === this.generation && this.operation === operation) { this.operation = undefined; this.store.setOperation(false); }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    document.removeEventListener('submit', this.recordComposerIntent, true);
    document.removeEventListener('click', this.recordComposerIntent, true);
    document.removeEventListener('keydown', this.recordComposerIntent, true);
    this.detach(); this.stopLifetime(); this.store.reset();
  }
}
