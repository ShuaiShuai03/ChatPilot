import type { MessageRole } from '../../conversation/types';

const TURN_TEST_ID = /^conversation-turn-(\d+)$/;

export function asMessageRole(value: string | null): MessageRole | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

export function getAuthoritativeRole(element: HTMLElement): MessageRole | null {
  return asMessageRole(element.getAttribute('data-turn'));
}

export function getTurnIndex(element: HTMLElement): number {
  const nodes: Element[] = [element, ...Array.from(element.querySelectorAll('[data-testid]'))];

  for (const node of nodes) {
    const value = node.getAttribute('data-testid');
    const match = value?.match(TURN_TEST_ID);
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }

  const closest = element.closest('[data-testid]');
  const match = closest?.getAttribute('data-testid')?.match(TURN_TEST_ID);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function addAttributeValue(ids: string[], node: Element, attribute: string): void {
  const value = node.getAttribute(attribute)?.trim();
  if (value && !ids.includes(value)) {
    ids.push(value);
  }
}

function candidateBlocks(element: HTMLElement, role: MessageRole | null): Element[] {
  const blocks = [
    ...(element.matches('[data-message-author-role]') ? [element] : []),
    ...Array.from(element.querySelectorAll('[data-message-author-role]')),
  ]
    .filter((block) => !isAttributeHidden(block));
  if (!role) {
    return blocks;
  }
  return blocks.filter((block) => block.getAttribute('data-message-author-role') === role);
}

function isAttributeHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const folded: Element | null = current.closest('details:not([open])');
    if (folded && folded !== current && !current.closest('summary')) return true;
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return true;
    }
    const style = current.getAttribute('style')?.toLowerCase() ?? '';
    if (/(?:^|;)\s*display\s*:\s*none\b/.test(style)
      || /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style)) {
      return true;
    }
    const view = current.ownerDocument.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const computed = view.getComputedStyle(current);
        if (computed.display === 'none' || computed.visibility === 'hidden') {
          return true;
        }
      } catch {
        // A lightweight DOM implementation may not support style resolution.
      }
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Returns stable identity aliases in priority order. A caller can choose the
 * first value as the current identity and retain the rest for reconciliation.
 */
export function getMessageIds(element: HTMLElement): string[] {
  const role = getAuthoritativeRole(element);
  const blocks = candidateBlocks(element, role);
  const ids: string[] = [];

  for (const block of blocks) {
    addAttributeValue(ids, block, 'data-message-id');
  }

  const outerShell = element.closest('[data-turn-id-container], [data-turn-id]');
  const containers: Element[] = [
    ...(outerShell ? [outerShell] : []),
    element,
    ...blocks,
  ];
  for (const container of containers) {
    addAttributeValue(ids, container, 'data-turn-id-container');
    addAttributeValue(ids, container, 'data-turn-id');
  }

  const turnNode = element.matches('[data-testid]')
    ? element
    : element.closest('[data-testid]') ?? element.querySelector('[data-testid]');
  if (turnNode) {
    const testId = turnNode.getAttribute('data-testid');
    if (testId && TURN_TEST_ID.test(testId) && !ids.includes(testId)) {
      ids.push(testId);
    }
  }

  return ids;
}
