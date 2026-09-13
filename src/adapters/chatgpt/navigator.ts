import type { ConversationIndex } from '../../conversation';
import type { ConversationStore } from '../../conversation/store';

export function getScrollRoot(root: HTMLElement, anchor?: HTMLElement): HTMLElement {
  const start = anchor?.isConnected ? anchor.parentElement ?? root : root;
  const explicit = start.closest<HTMLElement>('[data-scroll-root]');
  if (explicit) return explicit;
  let ancestor: HTMLElement | null = start;
  while (ancestor && ancestor !== root.ownerDocument.body) {
    const style = getComputedStyle(ancestor);
    // A short/loading conversation still owns its future scroll container.
    if (/(auto|scroll)/.test(style.overflowY)) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return root.ownerDocument.scrollingElement as HTMLElement ?? root.ownerDocument.documentElement;
}

export class CurrentMessageTracker {
  private observer: IntersectionObserver;
  private observed = new Map<HTMLElement, string>();
  private visible = new Map<HTMLElement, IntersectionObserverEntry>();
  private unsubscribe: () => void;
  private paused = false;

  constructor(index: ConversationIndex, private store: ConversationStore, scrollRoot: HTMLElement) {
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) this.visible.set(entry.target as HTMLElement, entry);
        else this.visible.delete(entry.target as HTMLElement);
      }
      if (!this.paused) this.update();
    }, { root: scrollRoot === document.scrollingElement ? null : scrollRoot,
      rootMargin: '-12% 0px -65% 0px', threshold: [0, 0.01, 0.5, 1] });
    const sync = () => {
      const next = new Set(index.elements.values());
      for (const element of this.observed.keys()) if (!next.has(element)) {
        this.observer.unobserve(element);
        this.observed.delete(element);
        this.visible.delete(element);
      }
      for (const [id, element] of index.elements) {
        if (!this.observed.has(element)) this.observer.observe(element);
        this.observed.set(element, id);
      }
      if (!this.paused && this.store.getSnapshot().currentId && !index.elements.has(this.store.getSnapshot().currentId!)) this.update();
    };
    this.unsubscribe = index.subscribe(sync);
    sync();
  }

  private update(): void {
    const candidates = [...this.visible.entries()].filter(([element]) => element.isConnected && this.observed.has(element));
    candidates.sort((a, b) => {
      const aTop = a[1].intersectionRect.top;
      const bTop = b[1].intersectionRect.top;
      return aTop - bTop || (a[0].compareDocumentPosition(b[0]) & 4 ? -1 : 1);
    });
    this.store.setCurrent(candidates[0] ? this.observed.get(candidates[0][0]) ?? null : null);
  }

  pause(value: boolean): void { this.paused = value; if (!value) this.update(); }
  dispose(): void { this.unsubscribe(); this.observer.disconnect(); this.observed.clear(); this.visible.clear(); }
}

export function scrollViewportTop(root: HTMLElement): number {
  return root === root.ownerDocument.scrollingElement ? 0 : root.getBoundingClientRect().top + root.clientTop;
}

export function messageScrollTop(element: HTMLElement, root: HTMLElement): number {
  const top = root.scrollTop + element.getBoundingClientRect().top - scrollViewportTop(root) - root.clientHeight * 0.23;
  return Math.max(0, Math.min(top, root.scrollHeight - root.clientHeight));
}

export function scrollToMessage(element: HTMLElement, smooth: boolean, root: HTMLElement): void {
  // Move only the conversation, not every scrollable ancestor or the page viewport.
  root.scrollTo({ top: messageScrollTop(element, root),
    behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
}
