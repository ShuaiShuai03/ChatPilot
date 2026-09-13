import type { ConversationIndex, TurnSlot } from '../../conversation';
import type { CurrentMessageTracker } from './navigator';
import type { MessageRecord } from '../../conversation/types';

export type MaterializationResult =
  | { complete: true; settled: true; messages: MessageRecord[]; collectedAt: string }
  | { complete: false; settled: boolean; reason: string };

export interface MaterializationOptions {
  signal: AbortSignal;
  selectedIds?: ReadonlySet<string>;
  onProgress: (message: string) => void;
}

export const MATERIALIZATION_LIMITS = { duration: 60_000, moves: 500, stepWait: 1_500, quiet: 160 } as const;

function pause(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** This polling exists only during an explicit, bounded navigation/materialization operation. */
export async function waitForBody(index: ConversationIndex, slot: TurnSlot, signal: AbortSignal): Promise<HTMLElement | undefined> {
  const deadline = Date.now() + MATERIALIZATION_LIMITS.stepWait;
  while (Date.now() < deadline && !signal.aborted && index.active && index.root.isConnected) {
    index.reconcile();
    if (slot.body?.isConnected && slot.record) return slot.body;
    await pause(40);
  }
  return undefined;
}

export class ConversationMaterializer {
  constructor(private index: ConversationIndex, private scrollRoot: HTMLElement, private tracker: CurrentMessageTracker) {}

  async collect(options: MaterializationOptions): Promise<MaterializationResult> {
    const { index, scrollRoot, tracker } = this;
    const { signal, onProgress, selectedIds } = options;
    const startedAt = Date.now();
    const originalTop = scrollRoot.scrollTop;
    const wasAtBottom = Math.abs(scrollRoot.scrollHeight - scrollRoot.clientHeight - originalTop) < 4;
    const currentId = index.store.getSnapshot().currentId;
    const originalSlot = (currentId ? index.getSlot(currentId) : undefined)
      ?? index.orderedSlots().find(slot => slot.body && slot.body.getBoundingClientRect().bottom > scrollRoot.getBoundingClientRect().top);
    const anchorOffset = originalSlot?.anchor.getBoundingClientRect().top;
    const savedStyles = ['scroll-behavior', 'scroll-snap-type', 'overflow-anchor'].map(property => ({
      property, value: scrollRoot.style.getPropertyValue(property), priority: scrollRoot.style.getPropertyPriority(property),
    }));
    const interaction = new AbortController();
    const operationSignal = AbortSignal.any([signal, interaction.signal]);
    let userMoved = false;
    let moves = 0;
    const seen = new Set<string>();
    const active = () => !signal.aborted && !interaction.signal.aborted && index.active && index.root.isConnected;
    const bounded = () => active() && moves <= MATERIALIZATION_LIMITS.moves && Date.now() - startedAt < MATERIALIZATION_LIMITS.duration;
    // Scroll events have no reliable user/programmatic provenance. ChatGPT can
    // correct virtualized layout after our own movement, so cancel on input intent.
    const userInterrupt = (event: Event) => {
      if (event.composedPath().some(node => node instanceof Element && node.localName === 'chatpilot-ui')) return;
      userMoved = true;
      interaction.abort();
    };
    const navigationKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userInterrupt(event);
    };
    scrollRoot.addEventListener('wheel', userInterrupt, { passive: true });
    scrollRoot.addEventListener('touchstart', userInterrupt, { passive: true });
    scrollRoot.addEventListener('pointerdown', userInterrupt, { passive: true });
    document.addEventListener('keydown', navigationKey);
    tracker.pause(true);
    scrollRoot.style.setProperty('scroll-behavior', 'auto', 'important');
    scrollRoot.style.setProperty('scroll-snap-type', 'none', 'important');
    scrollRoot.style.setProperty('overflow-anchor', 'none', 'important');

    const quiet = async (): Promise<boolean> => {
      const deadline = Date.now() + MATERIALIZATION_LIMITS.stepWait;
      do {
        await pause(40);
        if (!bounded()) return false;
        index.reconcile();
        for (const slot of index.orderedSlots()) if (slot.anchor.isConnected && slot.record) seen.add(slot.key);
        if (!index.pending && Date.now() - index.lastMutationAt >= MATERIALIZATION_LIMITS.quiet) return true;
      } while (Date.now() < deadline);
      return false;
    };
    const move = async (top: number): Promise<boolean> => {
      if (!bounded()) return false;
      moves++;
      scrollRoot.scrollTo({ top, behavior: 'instant' });
      return quiet();
    };
    const failure = (reason: string): MaterializationResult => ({ complete: false, settled: !index.isGenerating(), reason });
    const cancellationReason = () => userMoved ? '你已移动会话，加载已停止。'
      : signal.aborted ? '加载已取消。' : '会话已变化或加载超时，请重试。';

    try {
      onProgress('正在检查会话…');
      index.reconcile();
      if (!index.slots.size) return failure('此页面没有可用的会话消息。');
      if (selectedIds?.size === 0) return failure('请至少选择一条消息。');
      let stablePasses = 0;
      let previousSignature = '';
      while (bounded()) {
        if (!selectedIds && !await move(0)) return failure(cancellationReason());
        index.reconcile();
        const slots = selectedIds
          ? [...selectedIds].map(id => index.getSlot(id)).filter((slot): slot is TurnSlot => Boolean(slot))
          : index.orderedSlots();
        if (selectedIds && slots.length !== selectedIds.size) return failure('所选消息已变化，请检查选择后重试。');
        const hasPersistentShells = slots.some(slot => slot.persistentShell);
        for (let position = 0; position < slots.length; position++) {
          if (!bounded()) return failure(cancellationReason());
          const slot = slots[position]!;
          onProgress(`正在加载消息 · ${position + 1} / ${slots.length}`);
          if (!slot.body?.isConnected || !slot.record) {
            if (!slot.anchor.isConnected) continue; // A shell-less virtual list is swept below.
            moves++;
            slot.anchor.scrollIntoView({ behavior: 'instant', block: 'center' });
            if (!await quiet()) return failure(cancellationReason());
            const body = await waitForBody(index, slot, operationSignal);
            if (!bounded()) return failure(cancellationReason());
            if (!body) return failure('部分消息无法加载，请在 ChatGPT 中滚动到对应位置后重试。');
          }
          if (slot.record) seen.add(slot.key);
        }
        if (!selectedIds && !hasPersistentShells) {
          // Compatibility path for DOMs that only expose bodies, without persistent turn shells.
          for (let top = 0; bounded(); top += Math.max(200, scrollRoot.clientHeight * 0.8)) {
            if (!await move(top)) return failure(cancellationReason());
            if (scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 4) break;
          }
        }
        if (!selectedIds && !await move(scrollRoot.scrollHeight)) return failure(cancellationReason());
        if (!await quiet()) return failure(cancellationReason());
        if (index.isGenerating()) return { complete: false, settled: false, reason: 'ChatGPT 仍在生成回答，请等待完成后再导出。' };
        const finalSlots = selectedIds ? [...selectedIds].map(id => index.getSlot(id)) : index.orderedSlots();
        if (finalSlots.some(slot => !slot?.record || !seen.has(slot.key))) {
          stablePasses = 0;
          continue;
        }
        const signature = finalSlots.map(slot => `${slot!.key}:${slot!.record!.id}:${slot!.record!.text}`).join('\u0000')
          + (selectedIds ? '' : `:${Math.round(scrollRoot.scrollHeight)}`);
        stablePasses = signature === previousSignature ? stablePasses + 1 : 0;
        previousSignature = signature;
        if (stablePasses >= 1) {
          if (!selectedIds) index.pruneUnseen(seen);
          return { complete: true, settled: true,
            messages: index.store.getSnapshot().messages
              .filter(message => !selectedIds || [...selectedIds].some(id => index.resolveId(id) === message.id))
              .map(message => ({ ...message })),
            collectedAt: new Date().toISOString() };
        }
      }
      return failure(cancellationReason());
    } finally {
      scrollRoot.removeEventListener('wheel', userInterrupt);
      scrollRoot.removeEventListener('touchstart', userInterrupt);
      scrollRoot.removeEventListener('pointerdown', userInterrupt);
      document.removeEventListener('keydown', navigationKey);
      // Don't pull the user back after manual scrolling, or scroll a new SPA conversation.
      if (!userMoved && index.active && index.root.isConnected) {
        if (wasAtBottom) scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'instant' });
        else if (originalSlot?.anchor.isConnected && anchorOffset !== undefined) {
          originalSlot.anchor.scrollIntoView({ behavior: 'instant', block: 'start' });
          await pause(60);
          if (index.active && originalSlot.anchor.isConnected) scrollRoot.scrollBy({
            top: originalSlot.anchor.getBoundingClientRect().top - anchorOffset, behavior: 'instant',
          });
        } else scrollRoot.scrollTo({ top: originalTop, behavior: 'instant' });
      }
      for (const { property, value, priority } of savedStyles) {
        if (value) scrollRoot.style.setProperty(property, value, priority);
        else scrollRoot.style.removeProperty(property);
      }
      if (index.active) tracker.pause(false);
      if (!userMoved && currentId && index.active && index.store.records.has(currentId)) index.store.setCurrent(currentId);
    }
  }
}
