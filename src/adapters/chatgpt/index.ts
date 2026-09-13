import { parseTurn, getMessageIds } from './parser';
import { ConversationStore, type IdentityChange } from '../../conversation/store';
import type { MessageRecord } from '../../conversation/types';

const TURN = '[data-testid^="conversation-turn-"]';
const SHELL = '[data-turn-id-container]';
const SENTINEL = 'client-created-root';

export interface TurnSlot {
  key: string;
  anchor: HTMLElement;
  body?: HTMLElement;
  record?: MessageRecord;
  aliases: string[];
  persistentShell: boolean;
  ordinal: number;
}

function isElement(node: Node): node is HTMLElement { return node.nodeType === 1; }

/** Adapter-owned source index. No feature is allowed to parse the host DOM independently. */
export class ConversationIndex {
  readonly elements = new Map<string, HTMLElement>();
  readonly shells = new Map<string, HTMLElement>();
  readonly slots = new Map<string, TurnSlot>();
  private recordSlots = new Map<string, TurnSlot>();
  private identityAliases = new Map<string, string>();
  private dirty = new Set<HTMLElement>();
  private structuralDirty = false;
  private committedOrder = '';
  private listeners = new Set<() => void>();
  private weakKeys = new WeakMap<HTMLElement, string>();
  private nextWeakKey = 0;
  private nextOrdinal = 0;
  private disposed = false;
  version = 0;
  lastMutationAt = Date.now();

  constructor(readonly root: HTMLElement, readonly store: ConversationStore) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize(): void { this.discover(this.root); this.flush(); }

  private anchorFor(element: HTMLElement): HTMLElement {
    let anchor = element;
    let candidate: HTMLElement | null = element;
    const id = element.getAttribute('data-turn-id-container') ?? element.closest(SHELL)?.getAttribute('data-turn-id-container');
    if (id) {
      while (candidate && this.root.contains(candidate)) {
        if (candidate.getAttribute('data-turn-id-container') === id) anchor = candidate;
        candidate = candidate.parentElement;
      }
    }
    return anchor;
  }

  private slotKey(anchor: HTMLElement): string {
    const stable = anchor.getAttribute('data-turn-id-container') ?? anchor.getAttribute('data-turn-id') ?? anchor.getAttribute('data-testid');
    if (stable) return stable;
    let key = this.weakKeys.get(anchor);
    if (!key) { key = `anonymous-slot-${++this.nextWeakKey}`; this.weakKeys.set(anchor, key); }
    return key;
  }

  private register(element: HTMLElement, changed = false): void {
    if (!this.root.contains(element) || element.getAttribute('data-turn-id-container') === SENTINEL) return;
    const anchor = this.anchorFor(element);
    if (anchor.getAttribute('data-turn-id-container') === SENTINEL) return;
    const body = anchor.matches(TURN) ? anchor : anchor.querySelector<HTMLElement>(TURN) ?? undefined;
    const key = this.slotKey(anchor);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { key, anchor, aliases: [], persistentShell: anchor !== body && anchor.hasAttribute('data-turn-id-container'), ordinal: this.nextOrdinal++ };
      this.slots.set(key, slot);
      this.structuralDirty = true;
    }
    if (slot.anchor !== anchor) this.structuralDirty = true;
    slot.anchor = anchor;
    if (body) {
      if (slot.body !== body) this.structuralDirty = true;
      if (changed || slot.body !== body || !slot.record) this.dirty.add(body);
      slot.body = body;
    } else if (slot.body) {
      this.structuralDirty = true;
    }
    this.shells.set(key, anchor);
  }

  private discover(element: HTMLElement): void {
    if (element.matches(`${SHELL},${TURN}`)) this.register(element);
    for (const candidate of element.querySelectorAll<HTMLElement>(`${SHELL},${TURN}`)) this.register(candidate);
  }

  applyMutations(mutations: MutationRecord[]): boolean {
    if (this.disposed) return false;
    let relevant = false;
    for (const mutation of mutations) {
      const target = isElement(mutation.target) ? mutation.target : mutation.target.parentElement;
      const turn = target?.closest<HTMLElement>(TURN);
      if (turn && this.root.contains(turn)) { this.register(turn, true); relevant = true; }
      else if (target?.matches(SHELL)) { this.register(target, true); relevant = true; }
      for (const node of mutation.addedNodes) if (isElement(node) && (node.matches(`${TURN},${SHELL}`) || node.querySelector(`${TURN},${SHELL}`))) {
        this.discover(node);
        relevant = true;
      }
      for (const node of mutation.removedNodes) if (isElement(node) && (node.matches(`${TURN},${SHELL}`) || node.querySelector(`${TURN},${SHELL}`))) {
        this.structuralDirty = true;
        relevant = true;
      }
    }
    if (relevant) { this.version++; this.lastMutationAt = Date.now(); }
    return relevant;
  }

  /** Explicit reconciliation is reserved for initialization, materialization and root replacement. */
  reconcile(): void {
    if (this.disposed) return;
    this.discover(this.root);
    if (this.hasDetachedSlots() || this.orderSignature() !== this.committedOrder) this.structuralDirty = true;
    this.flush();
  }

  flush(): void {
    if (this.disposed || (!this.structuralDirty && this.dirty.size === 0)) return;
    const changes: IdentityChange[] = [];
    for (const [key, slot] of this.slots) {
      if (!this.root.contains(slot.anchor)) {
        this.shells.delete(key);
        if (slot.persistentShell) { this.slots.delete(key); continue; }
      }
      if (slot.body && !this.root.contains(slot.body)) slot.body = undefined;
    }

    const sorted = this.orderedSlots();
    const claimed = new Set<string>();
    const isOwnedByAnotherSlot = (id: string, current: TurnSlot): boolean => sorted.some(
      (slot) => slot !== current && slot.record?.id === id,
    );
    const allocateFallbackId = (base: string, slot: TurnSlot): string => {
      const current = slot.record;
      const suffix = current
        && slot.aliases.length === 0
        && current.id.startsWith(`${current.role}:`)
        ? current.id.match(/:(\d+)$/)?.[1]
        : undefined;
      const preferred = suffix ? `${base}:${suffix}` : base;
      if (!claimed.has(preferred) && !isOwnedByAnotherSlot(preferred, slot)) {
        return preferred;
      }
      for (let occurrence = 2; ; occurrence++) {
        const candidate = `${base}:${occurrence}`;
        if (!claimed.has(candidate) && !isOwnedByAnotherSlot(candidate, slot)) {
          return candidate;
        }
      }
    };
    for (const slot of sorted) {
      if (!slot.body || !this.dirty.has(slot.body)) {
        if (slot.record) claimed.add(slot.record.id);
        continue;
      }
      const parsed = parseTurn(slot.body);
      if (!parsed) { slot.record = undefined; slot.aliases = []; continue; }
      const ids = getMessageIds(slot.body);
      const fallback = ids.length === 0;
      if (fallback) {
        parsed.id = allocateFallbackId(parsed.id, slot);
      }
      if (slot.record && slot.record.id !== parsed.id) {
        // A content-only hash change is the same message; changing a stable message ID is a different answer.
        const fromFallback = slot.aliases.length === 0 && slot.record.id.startsWith(`${slot.record.role}:`);
        changes.push({ from: slot.record.id, to: parsed.id, preserveSelection: fromFallback });
        if (fromFallback) {
          this.identityAliases.delete(parsed.id);
          this.identityAliases.set(slot.record.id, parsed.id);
        }
      }
      slot.record = parsed;
      slot.aliases = ids;
      claimed.add(parsed.id);
    }
    this.dirty.clear();
    this.elements.clear();
    this.recordSlots.clear();
    const messages: MessageRecord[] = [];
    const seen = new Set<string>();
    sorted.forEach((slot, position) => {
      if (!slot.record) return;
      const record = { ...slot.record, index: position + 1 };
      slot.record = record;
      if (seen.has(record.id)) return;
      seen.add(record.id);
      messages.push(record);
      this.recordSlots.set(record.id, slot);
      for (const alias of slot.aliases) this.recordSlots.set(alias, slot);
      if (slot.body && this.root.contains(slot.body)) this.elements.set(record.id, slot.body);
    });
    this.store.commit(messages, changes);
    this.structuralDirty = false;
    this.committedOrder = this.orderSignature();
    this.listeners.forEach(listener => listener());
  }

  private hasDetachedSlots(): boolean {
    return [...this.slots.values()].some((slot) => (slot.persistentShell && !this.root.contains(slot.anchor))
      || Boolean(slot.body && !this.root.contains(slot.body)));
  }

  private orderSignature(): string {
    return this.orderedSlots().map((slot) => slot.key).join('\u0000');
  }

  orderedSlots(): TurnSlot[] {
    return [...this.slots.values()].sort((a, b) => {
      if (a.anchor === b.anchor) return 0;
      if (this.root.contains(a.anchor) && this.root.contains(b.anchor)) {
        const relation = a.anchor.compareDocumentPosition(b.anchor);
        return relation & 4 ? -1 : 1;
      }
      const aNumber = Number(a.body?.getAttribute('data-testid')?.match(/(\d+)$/)?.[1]);
      const bNumber = Number(b.body?.getAttribute('data-testid')?.match(/(\d+)$/)?.[1]);
      return Number.isFinite(aNumber) && Number.isFinite(bNumber) ? aNumber - bNumber : a.ordinal - b.ordinal;
    });
  }

  resolveId(id: string): string {
    const seen = new Set<string>();
    while (this.identityAliases.has(id) && !seen.has(id)) { seen.add(id); id = this.identityAliases.get(id)!; }
    return id;
  }
  getSlot(id: string): TurnSlot | undefined { return this.recordSlots.get(this.resolveId(id)); }
  getElement(id: string): HTMLElement | undefined { return this.elements.get(this.resolveId(id)); }
  get pending(): boolean { return this.dirty.size > 0; }
  get active(): boolean { return !this.disposed; }

  pruneUnseen(keys: ReadonlySet<string>): void {
    for (const [key, slot] of this.slots) {
      if (!keys.has(key) && !this.root.contains(slot.anchor)) {
        this.slots.delete(key);
        this.structuralDirty = true;
      }
    }
    this.flush();
  }

  isGenerating(): boolean {
    return Boolean(this.root.querySelector('[data-is-streaming="true"],[data-message-status="streaming"],[aria-busy="true"]')
      ?? this.root.ownerDocument.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"]'));
  }

  dispose(): void {
    this.disposed = true;
    this.dirty.clear();
    this.listeners.clear();
    this.elements.clear();
    this.shells.clear();
    this.slots.clear();
    this.recordSlots.clear();
    this.identityAliases.clear();
  }
}
