import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import * as parser from '../src/adapters/chatgpt/parser';
import { ConversationIndex } from '../src/conversation/index';
import { ConversationStore } from '../src/conversation/store';
import { hash } from '../src/utils/hash';

function turn(id: string, role: 'user' | 'assistant', text: string, messageId = id): string {
  return `<section data-testid="conversation-turn-${id}" data-turn="${role}" data-turn-id="turn-${id}"><div data-message-author-role="${role}" data-message-id="${messageId}">${text}</div></section>`;
}

function fallbackTurn(key: string, text: string): string {
  return `<section data-testid="conversation-turn-${key}"><div data-message-author-role="assistant">${text}</div></section>`;
}

function root(markup: string): HTMLElement {
  const { document } = parseHTML(`<main data-scroll-root>${markup}</main>`);
  const element = document.querySelector('main');
  if (!element) {
    throw new Error('Test markup did not create a source root.');
  }
  return element as unknown as HTMLElement;
}

function childListMutation(target: Node, addedNodes: readonly Node[] = [], removedNodes: readonly Node[] = []): MutationRecord {
  return {
    type: 'childList',
    target,
    addedNodes,
    removedNodes,
  } as unknown as MutationRecord;
}

function characterDataMutation(target: Node): MutationRecord {
  return { type: 'characterData', target, addedNodes: [], removedNodes: [] } as unknown as MutationRecord;
}

function initialized(markup: string): { source: HTMLElement; store: ConversationStore; index: ConversationIndex } {
  const source = root(markup);
  const store = new ConversationStore();
  const index = new ConversationIndex(source, store);
  index.initialize();
  return { source, store, index };
}

describe('ConversationIndex', () => {
  it('orders records by source shell, excludes its own sentinel, and counts unloaded shells', () => {
    const { store, index } = initialized([
      '<div data-turn-id-container="unloaded-shell"></div>',
      `<div data-turn-id-container="first-shell">${turn('1', 'user', '第一条', 'user-1')}</div>`,
      '<div data-turn-id-container="client-created-root">',
      turn('sentinel', 'assistant', '不应收录', 'sentinel-message'),
      '</div>',
      `<div data-turn-id-container="second-shell">${turn('2', 'assistant', '第二条', 'assistant-2')}</div>`,
    ].join(''));

    expect(store.getSnapshot().messages.map((message) => [message.id, message.index])).toEqual([
      ['user-1', 2],
      ['assistant-2', 3],
    ]);
    expect(index.slots.has('unloaded-shell')).toBe(true);
    expect(index.slots.has('client-created-root')).toBe(false);
  });

  it('retains a persistent shell record through virtualization and reparses its remount', () => {
    const { source, store, index } = initialized(
      `<div data-turn-id-container="shell-a">${turn('a', 'assistant', '旧内容', 'message-a')}</div>`,
    );
    const shell = source.querySelector('[data-turn-id-container="shell-a"]') as unknown as HTMLElement;
    const body = shell.querySelector('section') as unknown as HTMLElement;

    body.remove();
    index.applyMutations([childListMutation(shell, [], [body])]);
    index.flush();
    expect(store.getSnapshot().messages).toHaveLength(1);
    expect(index.getElement('message-a')).toBeUndefined();

    const { document } = parseHTML(turn('a', 'assistant', '新内容', 'message-a'));
    const remounted = document.querySelector('section') as unknown as HTMLElement;
    shell.append(remounted);
    index.applyMutations([childListMutation(shell, [remounted])]);
    index.flush();

    expect(store.getSnapshot().messages[0]).toMatchObject({ id: 'message-a', text: '新内容' });
    expect(index.getElement('message-a')).toBe(remounted);
  });

  it('does not notify on stable reconciliation and still reconciles virtualization changes', () => {
    const { source, store, index } = initialized(
      `<div data-turn-id-container="reconcile-shell">${turn('reconcile', 'assistant', '初始内容', 'reconcile-message')}</div>`,
    );
    const storeListener = vi.fn();
    const indexListener = vi.fn();
    const stopStore = store.subscribe(storeListener);
    const stopIndex = index.subscribe(indexListener);

    index.reconcile();
    index.reconcile();
    expect(storeListener).not.toHaveBeenCalled();
    expect(indexListener).not.toHaveBeenCalled();

    const shell = source.querySelector('[data-turn-id-container="reconcile-shell"]') as unknown as HTMLElement;
    const body = shell.querySelector('section') as unknown as HTMLElement;
    body.remove();
    index.reconcile();
    expect(store.getSnapshot().messages).toHaveLength(1);
    expect(index.getElement('reconcile-message')).toBeUndefined();
    expect(storeListener).toHaveBeenCalledTimes(1);
    expect(indexListener).toHaveBeenCalledTimes(1);

    const { document } = parseHTML(turn('reconcile', 'assistant', '重挂载内容', 'reconcile-message'));
    const remounted = document.querySelector('section') as unknown as HTMLElement;
    shell.append(remounted);
    index.reconcile();
    expect(store.getSnapshot().messages[0]).toMatchObject({ id: 'reconcile-message', text: '重挂载内容' });
    expect(storeListener).toHaveBeenCalledTimes(2);
    expect(indexListener).toHaveBeenCalledTimes(2);
    stopStore();
    stopIndex();
  });

  it('clears current and selection when a stable server message ID changes', () => {
    const { source, store, index } = initialized(turn('stable', 'assistant', '初稿', 'message-old'));
    store.toggleSelection('message-old');
    store.setCurrent('message-old');
    const body = source.querySelector('section') as unknown as HTMLElement;
    const message = body.querySelector('[data-message-id]') as unknown as HTMLElement;
    message.setAttribute('data-message-id', 'message-new');

    index.applyMutations([{ type: 'attributes', target: message, addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
    index.flush();

    expect(store.getSnapshot().messages[0]?.id).toBe('message-new');
    expect(store.getSnapshot().selectedIds.size).toBe(0);
    expect(store.getSnapshot().currentId).toBeNull();
  });

  it('preserves current and selection across a regular character-data update', () => {
    const { source, store, index } = initialized(turn('regular', 'assistant', '原始内容', 'message-regular'));
    store.toggleSelection('message-regular');
    store.setCurrent('message-regular');
    const text = source.querySelector('[data-message-id]')?.firstChild;
    if (!text) {
      throw new Error('Expected a text node.');
    }
    text.textContent = '更新内容';

    index.applyMutations([characterDataMutation(text)]);
    index.flush();

    expect(store.getSnapshot().messages[0]).toMatchObject({ id: 'message-regular', text: '更新内容' });
    expect([...store.getSnapshot().selectedIds]).toEqual(['message-regular']);
    expect(store.getSnapshot().currentId).toBe('message-regular');
  });

  it('migrates selection during a role-hash streaming rekey', () => {
    const { source, store, index } = initialized(
      '<section data-testid="conversation-turn-stream"><div data-message-author-role="assistant">流式初稿</div></section>',
    );
    const oldId = store.getSnapshot().messages[0]?.id;
    if (!oldId) {
      throw new Error('Expected a role-hash record.');
    }
    store.toggleSelection(oldId);
    store.setCurrent(oldId);
    const text = source.querySelector('[data-message-author-role]')?.firstChild;
    if (!text) {
      throw new Error('Expected a streaming text node.');
    }
    text.textContent = '流式终稿';

    index.applyMutations([characterDataMutation(text)]);
    index.flush();

    const newId = store.getSnapshot().messages[0]?.id;
    expect(newId).toMatch(/^assistant:[0-9a-f]{16}$/);
    expect(newId).not.toBe(oldId);
    expect([...store.getSnapshot().selectedIds]).toEqual([newId]);
    expect(store.getSnapshot().currentId).toBe(newId);
    expect(index.resolveId(oldId)).toBe(newId);
    expect(index.getSlot(oldId)?.record?.text).toBe('流式终稿');
  });

  it('reserves fallback IDs owned by later slots and keeps a suffix through repeated flushes and remounts', () => {
    const { source, store, index } = initialized([
      fallbackTurn('first', '流式初稿'),
      fallbackTurn('later', '相同终稿'),
    ].join(''));
    const oldId = store.getSnapshot().messages[0]?.id;
    if (!oldId) {
      throw new Error('Expected the first fallback record.');
    }
    store.toggleSelection(oldId);
    store.setCurrent(oldId);

    const first = source.querySelector('[data-testid="conversation-turn-first"]') as unknown as HTMLElement;
    const firstText = first.querySelector('[data-message-author-role]')?.firstChild;
    if (!firstText) {
      throw new Error('Expected first fallback text.');
    }
    firstText.textContent = '相同终稿';
    index.applyMutations([characterDataMutation(firstText)]);
    index.flush();

    const base = `assistant:${hash('相同终稿')}`;
    expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([`${base}:2`, base]);
    expect([...store.getSnapshot().selectedIds]).toEqual([`${base}:2`]);
    expect(store.getSnapshot().currentId).toBe(`${base}:2`);
    expect(index.resolveId(oldId)).toBe(`${base}:2`);

    index.flush();
    expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([`${base}:2`, base]);

    first.remove();
    index.applyMutations([childListMutation(source, [], [first])]);
    index.flush();
    const { document } = parseHTML(fallbackTurn('first', '相同终稿'));
    const remounted = document.querySelector('section') as unknown as HTMLElement;
    source.append(remounted);
    index.applyMutations([childListMutation(source, [remounted])]);
    index.flush();

    expect(new Set(store.getSnapshot().messages.map((message) => message.id))).toEqual(new Set([base, `${base}:2`]));
    expect([...store.getSnapshot().selectedIds]).toEqual([`${base}:2`]);
    expect(store.getSnapshot().currentId).toBe(`${base}:2`);
  });

  it('keeps duplicate-looking stable messages distinct and exposes multi-block aliases', () => {
    const { store, index } = initialized([
      turn('one', 'assistant', '相同文本', 'message-one'),
      turn('two', 'assistant', '相同文本', 'message-two'),
      '<section data-testid="conversation-turn-three" data-turn="assistant" data-turn-id="turn-three">',
      '<div data-message-author-role="assistant" data-message-id="part-one">第一段</div>',
      '<div data-message-author-role="assistant" data-message-id="part-two">第二段</div>',
      '</section>',
    ].join(''));

    expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([
      'message-one',
      'message-two',
      'part-one',
    ]);
    expect(index.getSlot('part-two')?.record?.id).toBe('part-one');
    expect(index.getElement('part-one')).toBeDefined();
    expect(index.getElement('part-two')).toBeUndefined();
  });

  it('drops stale records when their persistent branch shell is removed', () => {
    const { source, store, index } = initialized(
      `<div data-turn-id-container="branch-shell">${turn('branch', 'assistant', '分支内容', 'branch-message')}</div>`,
    );
    const shell = source.querySelector('[data-turn-id-container="branch-shell"]') as unknown as HTMLElement;
    shell.remove();

    index.applyMutations([childListMutation(source, [], [shell])]);
    index.flush();

    expect(store.getSnapshot().messages).toHaveLength(0);
    expect(index.slots.has('branch-shell')).toBe(false);
  });

  it('reparses only a mutated turn and ignores additions outside turns', () => {
    const spy = vi.spyOn(parser, 'parseTurn');
    const { source, index } = initialized([
      turn('first', 'assistant', '第一条', 'first-message'),
      turn('second', 'assistant', '第二条', 'second-message'),
    ].join(''));
    spy.mockClear();

    const firstText = source.querySelector('[data-message-id="first-message"]')?.firstChild;
    if (!firstText) {
      throw new Error('Expected first turn text.');
    }
    firstText.textContent = '第一条更新';
    index.applyMutations([characterDataMutation(firstText)]);
    index.flush();
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const adornment = source.ownerDocument.createElement('div');
    adornment.textContent = '非内容装饰';
    source.append(adornment);
    const versionBefore = index.version;
    const mutationTimeBefore = index.lastMutationAt;
    expect(index.applyMutations([childListMutation(source, [adornment])])).toBe(false);
    index.flush();
    expect(spy).not.toHaveBeenCalled();
    expect(index.version).toBe(versionBefore);
    expect(index.lastMutationAt).toBe(mutationTimeBefore);
    spy.mockRestore();
  });

  it('keeps repeated fallback-hash messages separate and their selections independent', () => {
    const { source, store, index } = initialized('<section data-testid="conversation-turn-first"><div data-message-author-role="assistant">same</div></section><section data-testid="conversation-turn-second"><div data-message-author-role="assistant">same</div></section>');
    const initial = store.getSnapshot().messages;
    expect(initial).toHaveLength(2);
    expect(initial[1]?.id).toBe(`${initial[0]?.id}:2`);
    const selected = initial[1]!.id;
    store.toggleSelection(selected);
    const text = source.querySelector('[data-testid="conversation-turn-second"] [data-message-author-role]')!.firstChild!;
    text.textContent = 'updated';
    index.applyMutations([characterDataMutation(text)]);
    index.flush();
    expect(store.getSnapshot().messages).toHaveLength(2);
    expect([...store.getSnapshot().selectedIds]).toEqual([index.resolveId(selected)]);
    expect(index.getSlot(selected)?.record?.text).toBe('updated');
  });
});
