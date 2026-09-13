import type { ConversationIndex, TurnSlot } from './index';
import type { MessageRecord, UserNavigationDirection } from '../../conversation/types';
import { ConversationMaterializer, MATERIALIZATION_LIMITS, waitForBody } from './materializer';
import { CurrentMessageTracker, scrollToMessage } from './navigator';

/** Unknown slots are candidates until the shared parser establishes their role. */
export function userCandidates<T extends { record?: MessageRecord }>(slots: readonly T[], reference: number, direction: UserNavigationDirection): T[] {
  const candidates = slots.filter((slot, position) => (direction === 'previous' ? position < reference : position > reference)
    && (!slot.record || slot.record.role === 'user'));
  return direction === 'previous' ? candidates.reverse() : candidates;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const inExtension = (event: Event) => event.composedPath().some(node => node instanceof Element && node.localName === 'chatpilot-ui');
const navigationKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

/** Adapter-owned cursor and bounded scrolling. No content is parsed outside ConversationIndex. */
export class UserMessageNavigator {
  private cursor?: { id: string; top: number };
  private completeWithoutShells = false;
  private disposed = false;
  private navigating = false;
  private refreshing = false;
  private frame?: number;
  private unsubscribeIndex: () => void;
  private unsubscribeStore: () => void;

  constructor(private index: ConversationIndex, private scrollRoot: HTMLElement, private tracker: CurrentMessageTracker,
    private materializer: ConversationMaterializer) {
    this.unsubscribeIndex = index.subscribe(() => { this.completeWithoutShells = false; this.refresh(); });
    let previous = index.store.getSnapshot();
    this.unsubscribeStore = index.store.subscribe(() => {
      const next = index.store.getSnapshot();
      const changed = next.currentId !== previous.currentId || next.messages !== previous.messages;
      previous = next;
      if (changed) this.refresh();
    });
    scrollRoot.addEventListener('wheel', this.manualMovement, { passive: true });
    scrollRoot.addEventListener('touchstart', this.manualMovement, { passive: true });
    scrollRoot.addEventListener('pointerdown', this.manualMovement, { passive: true });
    document.addEventListener('keydown', this.manualMovement, true);
    this.refresh();
  }

  private manualMovement = (event: Event): void => {
    if (inExtension(event) || (event instanceof KeyboardEvent && !navigationKeys.includes(event.key))) return;
    this.cursor = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.refresh(); });
  };

  private reference(slots: readonly TurnSlot[]): number {
    if (this.cursor && Math.abs(this.scrollRoot.scrollTop - this.cursor.top) <= 4) {
      const slot = this.index.getSlot(this.cursor.id);
      const position = slot ? slots.indexOf(slot) : -1;
      if (position >= 0) return position;
    }
    this.cursor = undefined;
    if (this.scrollRoot.scrollHeight - this.scrollRoot.clientHeight - this.scrollRoot.scrollTop <= 4) return slots.length;
    const readingLine = this.scrollRoot.getBoundingClientRect().top + this.scrollRoot.clientHeight * 0.23;
    let preceding = -1;
    for (let position = 0; position < slots.length; position++) {
      const slot = slots[position]!;
      if (!slot.anchor.isConnected) continue;
      const rect = slot.anchor.getBoundingClientRect();
      if (rect.top <= readingLine) preceding = position;
      if (rect.top <= readingLine && rect.bottom > readingLine) return position;
    }
    return preceding;
  }

  refresh(): void {
    if (this.disposed || this.navigating || this.refreshing) return;
    this.refreshing = true;
    try {
      const slots = this.index.orderedSlots();
      const reference = this.reference(slots);
      const uncertain = slots.length > 0 && !slots.some(slot => slot.persistentShell) && !this.completeWithoutShells;
      this.index.store.setUserNavigation(uncertain || userCandidates(slots, reference, 'previous').length > 0,
        uncertain || userCandidates(slots, reference, 'next').length > 0);
    } finally { this.refreshing = false; }
  }

  async navigate(target: string | UserNavigationDirection, signal: AbortSignal, smooth: boolean,
    onProgress: (message: string) => void, directional: boolean): Promise<void> {
    const { index, scrollRoot, tracker } = this;
    const initialSlots = index.orderedSlots();
    const initialReference = this.reference(initialSlots);
    const pivot = initialSlots[initialReference];
    const originalTop = scrollRoot.scrollTop;
    const originalSlot = pivot ?? initialSlots.find(slot => slot.anchor.isConnected && slot.anchor.getBoundingClientRect().bottom > scrollRoot.getBoundingClientRect().top);
    const originalOffset = originalSlot?.anchor.getBoundingClientRect().top;
    const wasAtBottom = scrollRoot.scrollHeight - scrollRoot.clientHeight - originalTop <= 4;
    const originalCursor = this.cursor;
    const savedStyles = ['scroll-behavior', 'scroll-snap-type', 'overflow-anchor'].map(property => ({
      property, value: scrollRoot.style.getPropertyValue(property), priority: scrollRoot.style.getPropertyPriority(property),
    }));
    const interruption = new AbortController();
    const combined = AbortSignal.any([signal, interruption.signal]);
    const timer = setTimeout(() => interruption.abort('timeout'), MATERIALIZATION_LIMITS.duration);
    let userMoved = false;
    let succeeded = false;
    let targetId: string | undefined;
    let moves = 0;
    const interrupt = (event: Event) => {
      if (inExtension(event) || (event instanceof KeyboardEvent && !navigationKeys.includes(event.key))) return;
      userMoved = true;
      interruption.abort('user-moved');
    };
    const check = () => {
      if (combined.aborted || !index.active || !index.root.isConnected || moves > MATERIALIZATION_LIMITS.moves) {
        throw new Error(userMoved ? '你已移动会话，定位已停止。' : interruption.signal.reason === 'timeout' || moves > MATERIALIZATION_LIMITS.moves
          ? '定位超时，请稍后重试。' : '定位已取消。');
      }
    };
    scrollRoot.addEventListener('wheel', interrupt, { passive: true });
    scrollRoot.addEventListener('touchstart', interrupt, { passive: true });
    scrollRoot.addEventListener('pointerdown', interrupt, { passive: true });
    document.addEventListener('keydown', interrupt, true);
    this.navigating = true;
    tracker.pause(true);
    for (const [property, value] of [['scroll-behavior', 'auto'], ['scroll-snap-type', 'none'], ['overflow-anchor', 'none']]) {
      scrollRoot.style.setProperty(property!, value!, 'important');
    }
    const load = async (slot: TurnSlot): Promise<HTMLElement> => {
      check();
      if (!slot.body?.isConnected || !slot.record) {
        if (!slot.anchor.isConnected) throw new Error('消息尚未加载，请先加载完整会话。');
        onProgress('正在加载附近的消息…');
        moves++;
        scrollToMessage(slot.anchor, false);
        const body = await waitForBody(index, slot, combined);
        check();
        if (!body) throw new Error('这条消息暂时无法加载，请稍后重试。');
      }
      return slot.body!;
    };
    try {
      check();
      index.reconcile();
      let destination: TurnSlot | undefined;
      if (directional) {
        if (!initialSlots.some(slot => slot.persistentShell) && !this.completeWithoutShells) {
          const result = await this.materializer.collect({ signal: combined, onProgress });
          check();
          tracker.pause(true);
          if (!result.complete) throw new Error(result.reason);
          this.completeWithoutShells = true;
        }
        const visited = new Set<string>();
        while (!destination) {
          check();
          const slots = index.orderedSlots();
          const reference = pivot ? slots.findIndex(slot => slot.key === pivot.key) : initialReference < 0 ? -1 : slots.length;
          if (pivot && reference < 0) throw new Error('当前消息已变化，请重新定位。');
          const candidate = userCandidates(slots, reference, target as UserNavigationDirection).find(slot => !visited.has(slot.key));
          if (!candidate) {
            onProgress(target === 'previous' ? '已到达第一条我的消息。' : '已到达最后一条我的消息。');
            return;
          }
          visited.add(candidate.key);
          if (!candidate.record) await load(candidate);
          if (candidate.record?.role === 'user') destination = candidate;
        }
      } else {
        this.cursor = undefined;
        destination = index.getSlot(target);
      }
      if (!destination) throw new Error('这条消息已不可用，请重新建立索引。');
      const expectedId = destination.record?.id;
      const body = await load(destination);
      check();
      if (expectedId && index.resolveId(expectedId) !== destination.record?.id) throw new Error('消息已变化，请重试。');
      moves++;
      scrollToMessage(body, smooth);
      const deadline = Date.now() + MATERIALIZATION_LIMITS.stepWait;
      let lastTop = scrollRoot.scrollTop;
      let stableAt = Date.now();
      while (Date.now() < deadline) {
        await pause(40);
        check();
        if (Math.abs(scrollRoot.scrollTop - lastTop) > 0.5) { lastTop = scrollRoot.scrollTop; stableAt = Date.now(); }
        if (Date.now() - stableAt >= 160) break;
      }
      if (Date.now() - stableAt < 160) throw new Error('滚动尚未完成，请重试。');
      index.reconcile();
      check();
      targetId = destination.record?.id;
      if (!targetId || !index.getElement(targetId)?.isConnected) throw new Error('这条消息暂时无法加载，请稍后重试。');
      this.cursor = { id: targetId, top: scrollRoot.scrollTop };
      succeeded = true;
    } finally {
      clearTimeout(timer);
      if (!succeeded && index.active && index.root.isConnected) {
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop, behavior: 'instant' });
        if (!userMoved) {
          if (wasAtBottom) {
            // Virtualized bodies can change the height on the next animation frame.
            // Keep the bottom anchor until that remount has settled, within one step.
            const restoreDeadline = Date.now() + MATERIALIZATION_LIMITS.stepWait;
            let height = scrollRoot.scrollHeight;
            let stableSince = Date.now();
            do {
              scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'instant' });
              await pause(40);
              if (!index.active || !index.root.isConnected || userMoved) break;
              if (height !== scrollRoot.scrollHeight) { height = scrollRoot.scrollHeight; stableSince = Date.now(); }
            } while (Date.now() < restoreDeadline && Date.now() - stableSince < MATERIALIZATION_LIMITS.quiet);
          }
          else if (originalSlot?.anchor.isConnected && originalOffset !== undefined) {
            originalSlot.anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
            await pause(60);
            if (!userMoved && index.active && originalSlot.anchor.isConnected) scrollRoot.scrollBy({ top: originalSlot.anchor.getBoundingClientRect().top - originalOffset, behavior: 'instant' });
          } else scrollRoot.scrollTo({ top: originalTop, behavior: 'instant' });
          this.cursor = !userMoved && originalCursor ? { ...originalCursor, top: scrollRoot.scrollTop } : undefined;
        } else this.cursor = undefined;
      }
      scrollRoot.removeEventListener('wheel', interrupt);
      scrollRoot.removeEventListener('touchstart', interrupt);
      scrollRoot.removeEventListener('pointerdown', interrupt);
      document.removeEventListener('keydown', interrupt, true);
      for (const { property, value, priority } of savedStyles) {
        if (value) scrollRoot.style.setProperty(property, value, priority);
        else scrollRoot.style.removeProperty(property);
      }
      this.navigating = false;
      if (index.active) {
        tracker.pause(false);
        if (succeeded && targetId) index.store.setCurrent(targetId);
        this.refresh();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cursor = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.unsubscribeIndex(); this.unsubscribeStore();
    this.scrollRoot.removeEventListener('wheel', this.manualMovement);
    this.scrollRoot.removeEventListener('touchstart', this.manualMovement);
    this.scrollRoot.removeEventListener('pointerdown', this.manualMovement);
    document.removeEventListener('keydown', this.manualMovement, true);
  }
}
