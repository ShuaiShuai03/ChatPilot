import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import type { MessageRecord } from '../src/conversation/types';
import { ConversationIndex } from '../src/conversation';
import { ConversationStore } from '../src/conversation/store';
import type { ConversationMaterializer } from '../src/adapters/chatgpt/materializer';
import type { CurrentMessageTracker } from '../src/adapters/chatgpt/navigator';
import { UserMessageNavigator, userCandidates } from '../src/adapters/chatgpt/user-navigation';

const message = (id: string, role: 'user' | 'assistant', text = id) => ({
  record: { id, role, text, preview: text, index: 99 } satisfies MessageRecord,
});

function fallbackTurn(key: string, role: 'user' | 'assistant', text: string): string {
  return `<section data-testid="conversation-turn-${key}"><div data-message-author-role="${role}">${text}</div></section>`;
}

function rectangle(top: number, bottom: number): DOMRect {
  return {
    x: 0, y: top, width: 100, height: bottom - top,
    top, right: 100, bottom, left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function navigatorFixture(): HTMLElement {
  const { document } = parseHTML(`<html><body><main data-scroll-root>${[
    fallbackTurn('first', 'user', '第一条'),
    fallbackTurn('assistant', 'assistant', '中间回答'),
    fallbackTurn('second', 'user', '第二条'),
  ].join('')}</main></body></html>`);
  const view = document.defaultView;
  const root = document.querySelector('main');
  if (!view || !root) {
    throw new Error('Unable to construct navigation fixture.');
  }
  vi.stubGlobal('document', document);
  vi.stubGlobal('Element', view.Element);
  vi.stubGlobal('KeyboardEvent', view.KeyboardEvent);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  Object.defineProperty(root, 'getBoundingClientRect', { configurable: true, value: () => rectangle(0, 100) });
  Object.defineProperty(root, 'scrollTo', {
    configurable: true,
    value: (options: ScrollToOptions) => { root.scrollTop = options.top ?? root.scrollTop; },
  });
  Object.defineProperty(root, 'scrollBy', {
    configurable: true,
    value: (options: ScrollToOptions) => { root.scrollTop += options.top ?? 0; },
  });
  const styles = new Map<string, string>();
  Object.defineProperty(root, 'style', {
    configurable: true,
    value: {
      getPropertyValue: (property: string) => styles.get(property) ?? '',
      getPropertyPriority: () => '',
      setProperty: (property: string, value: string) => { styles.set(property, value); },
      removeProperty: (property: string) => { styles.delete(property); },
    } as unknown as CSSStyleDeclaration,
  });
  return root as unknown as HTMLElement;
}

function positionTurns(root: HTMLElement, positions: Readonly<Record<string, number>>): void {
  for (const turn of Array.from(root.querySelectorAll<HTMLElement>('section'))) {
    const key = turn.getAttribute('data-testid');
    const top = key ? positions[key] : undefined;
    if (top === undefined) {
      throw new Error(`Missing geometry for ${key ?? 'unknown turn'}.`);
    }
    Object.defineProperty(turn, 'getBoundingClientRect', {
      configurable: true,
      value: () => rectangle(top, top + 48),
    });
    Object.defineProperty(turn, 'scrollIntoView', {
      configurable: true,
      value: () => { root.scrollTop = top; },
    });
  }
}

function mutation(target: Node): MutationRecord {
  return { type: 'characterData', target, addedNodes: [], removedNodes: [] } as unknown as MutationRecord;
}

function navigator(index: ConversationIndex, root: HTMLElement): UserMessageNavigator {
  const tracker = { pause: vi.fn() } as unknown as CurrentMessageTracker;
  const materializer = {
    collect: vi.fn(async () => ({ complete: true, settled: true, messages: [], collectedAt: 'test' })),
  } as unknown as ConversationMaterializer;
  return new UserMessageNavigator(index, root, tracker, materializer);
}

async function finishNavigation(promise: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
  await promise;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('user-message directional candidates', () => {
  it('uses source order and skips assistant messages in either direction', () => {
    const slots = [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user'), message('a2', 'assistant'), message('u3', 'user')];
    expect(userCandidates(slots, 2, 'previous').map(slot => slot.record.id)).toEqual(['u1']);
    expect(userCandidates(slots, 2, 'next').map(slot => slot.record.id)).toEqual(['u3']);
    expect(userCandidates(slots, 3, 'previous')[0]?.record.id).toBe('u2');
    expect(userCandidates(slots, 3, 'next')[0]?.record.id).toBe('u3');
  });

  it('handles consecutive roles and duplicate-looking user messages without parity assumptions', () => {
    const slots = [message('u1', 'user', 'same'), message('u2', 'user', 'same'), message('a1', 'assistant'), message('a2', 'assistant'), message('u3', 'user')];
    expect(userCandidates(slots, 1, 'previous')[0]?.record.id).toBe('u1');
    expect(userCandidates(slots, 1, 'next')[0]?.record.id).toBe('u3');
  });

  it('does not bypass unknown slots between the reader and a cached user record', () => {
    const unknown = {};
    const slots = [message('u1', 'user'), unknown, message('a1', 'assistant'), message('u2', 'user')];
    expect(userCandidates(slots, 3, 'previous')[0]).toBe(unknown);
    expect(userCandidates(slots, 0, 'next')[0]).toBe(unknown);
  });

  it('treats bottom as after the last message and never wraps at either boundary', () => {
    const slots = [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user'), message('a2', 'assistant')];
    expect(userCandidates(slots, slots.length, 'previous')[0]?.record.id).toBe('u2');
    expect(userCandidates(slots, slots.length, 'next')).toEqual([]);
    expect(userCandidates(slots, 0, 'previous')).toEqual([]);
    expect(userCandidates(slots, 2, 'next')).toEqual([]);
    expect(userCandidates(slots, -1, 'next')[0]?.record.id).toBe('u1');
    expect(userCandidates([], -1, 'previous')).toEqual([]);
  });

  it('continues directional navigation after a real fallback-ID streaming migration', async () => {
    vi.useFakeTimers();
    const root = navigatorFixture();
    positionTurns(root, {
      'conversation-turn-first': 100,
      'conversation-turn-assistant': 200,
      'conversation-turn-second': 300,
    });
    const store = new ConversationStore();
    const index = new ConversationIndex(root, store);
    index.initialize();
    const userNavigator = navigator(index, root);
    const originalId = store.getSnapshot().messages[0]?.id;
    if (!originalId) {
      throw new Error('Expected the first fallback user record.');
    }

    await finishNavigation(userNavigator.navigate(originalId, new AbortController().signal, false, vi.fn(), false));
    expect(store.getSnapshot().currentId).toBe(originalId);

    const text = root.querySelector('[data-testid="conversation-turn-first"] [data-message-author-role]')?.firstChild;
    if (!text) {
      throw new Error('Expected streaming text node.');
    }
    text.textContent = '第一条已更新';
    index.applyMutations([mutation(text)]);
    index.flush();
    const migratedId = store.getSnapshot().messages[0]?.id;
    expect(migratedId).not.toBe(originalId);
    expect(index.resolveId(originalId)).toBe(migratedId);

    await finishNavigation(userNavigator.navigate('next', new AbortController().signal, false, vi.fn(), true));
    expect(store.getSnapshot().currentId).toBe(store.getSnapshot().messages[2]?.id);

    userNavigator.dispose();
    index.dispose();
  });

  it('does not carry a cursor into a recreated navigator and index', async () => {
    vi.useFakeTimers();
    const root = navigatorFixture();
    positionTurns(root, {
      'conversation-turn-first': 100,
      'conversation-turn-assistant': 200,
      'conversation-turn-second': 300,
    });
    const firstStore = new ConversationStore();
    const firstIndex = new ConversationIndex(root, firstStore);
    firstIndex.initialize();
    const firstNavigator = navigator(firstIndex, root);
    const firstId = firstStore.getSnapshot().messages[0]?.id;
    if (!firstId) {
      throw new Error('Expected initial user record.');
    }
    await finishNavigation(firstNavigator.navigate(firstId, new AbortController().signal, false, vi.fn(), false));
    firstNavigator.dispose();
    firstIndex.dispose();

    // Keep the previous scrollTop, but make the reader line fall on the first
    // turn. A stale cursor from the disposed navigator would still point later.
    positionTurns(root, {
      'conversation-turn-first': 0,
      'conversation-turn-assistant': 200,
      'conversation-turn-second': 300,
    });
    const secondStore = new ConversationStore();
    const secondIndex = new ConversationIndex(root, secondStore);
    secondIndex.initialize();
    const secondNavigator = navigator(secondIndex, root);

    await finishNavigation(secondNavigator.navigate('previous', new AbortController().signal, false, vi.fn(), true));
    expect(secondStore.getSnapshot().currentId).toBeNull();

    secondNavigator.dispose();
    secondIndex.dispose();
  });
});
