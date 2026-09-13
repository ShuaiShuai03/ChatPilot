import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import type { MessageRecord, MessageRole } from '../../conversation/types';
import { hash } from '../../utils/hash';
import { asMessageRole, getAuthoritativeRole, getMessageIds, getTurnIndex } from './selectors';

export { getMessageIds } from './selectors';

const CONTROL_SELECTOR = [
  'button',
  'nav',
  'form',
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'link',
  'svg',
  '[role="button"]',
  '[data-message-controls]',
  '[data-testid*="toolbar" i]',
  '[data-testid*="copy" i]',
  '[data-testid*="regenerate" i]',
].join(',');

function computedStyle(element: HTMLElement): CSSStyleDeclaration | null {
  const view = element.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') {
    return null;
  }

  try {
    return view.getComputedStyle(element);
  } catch {
    return null;
  }
}

function isHidden(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
    return true;
  }

  const style = computedStyle(element);
  if (style?.display === 'none' || style?.visibility === 'hidden') {
    return true;
  }

  const inlineStyle = element.getAttribute('style')?.toLowerCase() ?? '';
  return /(?:^|;)\s*display\s*:\s*none\b/.test(inlineStyle)
    || /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(inlineStyle);
}

function isVisible(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (isHidden(current) || isClosedDetailsDescendant(current)) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function resolveRole(element: HTMLElement): MessageRole | null {
  const rootRole = getAuthoritativeRole(element);
  if (rootRole) {
    return rootRole;
  }

  const roles = new Set<MessageRole>();
  const nodes = [
    ...(element.matches('[data-message-author-role]') ? [element] : []),
    ...Array.from(element.querySelectorAll<HTMLElement>('[data-message-author-role]')),
  ];
  for (const node of nodes) {
    if (!isVisible(node)) {
      continue;
    }
    const role = asMessageRole(node.getAttribute('data-message-author-role'));
    if (role) {
      roles.add(role);
    }
  }

  return roles.size === 1 ? [...roles][0] ?? null : null;
}

function removeNodes(root: HTMLElement, selector: string): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    node.remove();
  }
}

function mathSource(element: HTMLElement): string | null {
  return element.getAttribute('alttext')?.trim()
    ?? element.getAttribute('data-tex')?.trim()
    ?? element.getAttribute('data-latex')?.trim()
    ?? element.querySelector('annotation[encoding*="tex" i]')?.textContent?.trim()
    ?? element.querySelector<HTMLElement>('[class*="sr-only" i], .assistive-mml')?.textContent?.trim()
    ?? null;
}

function captureVisibleMath(source: HTMLElement, clone: HTMLElement): void {
  const sourceNodes = [source, ...Array.from(source.querySelectorAll<HTMLElement>('*'))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))];

  for (let index = 0; index < sourceNodes.length; index++) {
    const original = sourceNodes[index];
    const copied = cloneNodes[index];
    if (!original || !copied || isHidden(original)) {
      continue;
    }
    const isMath = original.localName === 'math'
      || /(?:katex|mathjax)/i.test(original.className);
    if (!isMath) {
      continue;
    }
    const tex = mathSource(original);
    if (tex) {
      copied.setAttribute('data-chatpilot-math', tex);
      if (original.getAttribute('display') === 'block' || /(?:katex-display|MathJax_Display|(?:^|\s)display(?:\s|$))/i.test(original.className)) {
        copied.setAttribute('data-chatpilot-math-block', 'true');
      }
    }
  }
}

function isClosedDetailsDescendant(element: HTMLElement): boolean {
  const details = element.closest('details:not([open])');
  return Boolean(details && element !== details && !element.closest('summary'));
}

function removeOriginallyHidden(source: HTMLElement, clone: HTMLElement): void {
  const sourceNodes = Array.from(source.querySelectorAll<HTMLElement>('*'));
  const cloneNodes = Array.from(clone.querySelectorAll<HTMLElement>('*'));
  for (let index = 0; index < sourceNodes.length; index++) {
    const original = sourceNodes[index];
    const copied = cloneNodes[index];
    if (original && copied && (isHidden(original) || isClosedDetailsDescendant(original) || original.matches(CONTROL_SELECTOR))) {
      copied.remove();
    }
  }
}

function normalizeMath(root: HTMLElement): void {
  for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>('[data-chatpilot-math]'))]) {
    const tex = node.getAttribute('data-chatpilot-math')?.trim();
    if (!tex) {
      continue;
    }
    const delimiter = node.getAttribute('data-chatpilot-math-block') === 'true' ? '$$' : '$';
    const text = delimiter === '$$' ? `$$\n${tex}\n$$` : `$${tex}$`;
    const formula = root.ownerDocument.createElement('span');
    formula.setAttribute('data-chatpilot-formula', text);
    formula.textContent = text;
    node.replaceWith(formula);
  }
}

function flattenNestedPre(root: HTMLElement): void {
  for (const outer of Array.from(root.querySelectorAll<HTMLElement>('pre'))) {
    const inner = outer.querySelector<HTMLElement>('pre');
    if (inner) {
      outer.replaceWith(inner);
    }
  }
}

function safeUrl(value: string | null, base: string, image = false): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value, base || 'https://chatgpt.com/');
    if (!['https:', 'http:', ...(image ? [] : ['mailto:'])].includes(parsed.protocol)) return null;
    return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : parsed.href;
  } catch { return null; }
}

/** Copy content without creating image/media requests or executable event attributes. */
function copyContent(source: HTMLElement): HTMLElement {
  const clone = source.ownerDocument.createElement(source.localName);
  const retained = new Set(['class', 'title', 'alt', 'download', 'start', 'type', 'checked', 'colspan', 'rowspan', 'align',
    'display', 'encoding', 'alttext', 'data-tex', 'data-latex', 'data-attachment-name', 'data-attachment-id']);
  for (const attribute of Array.from(source.attributes)) if (retained.has(attribute.name)) clone.setAttribute(attribute.name, attribute.value);
  if (source.localName === 'a') {
    const href = safeUrl(source.getAttribute('href'), source.ownerDocument.baseURI);
    if (href) clone.setAttribute('href', href);
  }
  if (source.localName === 'img') {
    const src = safeUrl(source.getAttribute('src'), source.ownerDocument.baseURI, true);
    // Keep the source only as inert data; even detached <img src> can initiate a request.
    if (src) clone.setAttribute('data-chatpilot-image-src', src);
  }
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 1) clone.append(copyContent(child as HTMLElement));
    else if (child.nodeType === 3) clone.append(source.ownerDocument.createTextNode(child.textContent ?? ''));
  }
  return clone;
}

function cleanClone(element: HTMLElement): HTMLElement {
  const clone = copyContent(element);
  captureVisibleMath(element, clone);
  removeOriginallyHidden(element, clone);
  removeNodes(clone, CONTROL_SELECTOR);
  flattenNestedPre(clone);
  normalizeMath(clone);
  for (const attachment of [clone, ...clone.querySelectorAll<HTMLElement>('[data-attachment-name]')]) {
    if (!attachment.textContent?.trim() && attachment.hasAttribute('data-attachment-name')) attachment.textContent = attachment.getAttribute('data-attachment-name');
  }
  return clone;
}

function messageRoots(element: HTMLElement, role: MessageRole): HTMLElement[] {
  const candidates = [
    ...(element.getAttribute('data-message-author-role') === role ? [element] : []),
    ...Array.from(element.querySelectorAll<HTMLElement>(`[data-message-author-role="${role}"]`)),
  ].filter(isVisible);

  return candidates.filter((candidate) => !candidates.some(
    (other) => other !== candidate && other.contains(candidate),
  ));
}

function attachmentRoots(element: HTMLElement, contentRoots: readonly HTMLElement[]): HTMLElement[] {
  const candidates = Array.from(element.querySelectorAll<HTMLElement>(
    '[data-attachment-name], [data-attachment-id], a[download]',
  )).filter((candidate) => isVisible(candidate)
    && !contentRoots.some((root) => root.contains(candidate)));

  return candidates.filter((candidate) => !candidates.some(
    (other) => other !== candidate && other.contains(candidate),
  ));
}

function buildContent(element: HTMLElement, role: MessageRole): HTMLElement {
  const content = element.ownerDocument.createElement('div');
  const roots = messageRoots(element, role);
  for (const root of roots) {
    content.append(cleanClone(root));
  }
  for (const attachment of attachmentRoots(element, roots)) {
    content.append(cleanClone(attachment));
  }
  return content;
}

function fenceFor(code: string): string {
  const runs = code.match(/`+/g) ?? [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function toMarkdown(element: HTMLElement): string {
  const service = new TurndownService({
    codeBlockStyle: 'fenced',
    fence: '```',
    headingStyle: 'atx',
  });
  service.use(gfm);
  service.addRule('chatpilotMath', {
    filter: node => (node as HTMLElement).hasAttribute('data-chatpilot-formula'),
    replacement: (_content, node) => (node as HTMLElement).getAttribute('data-chatpilot-formula') ?? '',
  });
  service.addRule('chatpilotImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const image = node as HTMLElement;
      const alt = (image.getAttribute('alt') ?? '').replace(/([\\[\]])/g, '\\$1');
      const src = image.getAttribute('data-chatpilot-image-src')?.replace(/ /g, '%20').replace(/([()])/g, '\\$1');
      return src ? `![${alt}](${src})` : alt;
    },
  });
  service.addRule('chatpilotCodeBlock', {
    filter: 'pre',
    replacement(_content: string, node: Node): string {
      const pre = node as HTMLElement;
      const code = pre.querySelector('code');
      const source = code?.textContent ?? pre.textContent ?? '';
      const className = `${code?.className ?? ''} ${pre.className}`;
      const language = className.match(/(?:^|\s)language-([\w+-]+)/i)?.[1] ?? '';
      const fence = fenceFor(source);
      return `\n\n${fence}${language}\n${source.replace(/\n$/, '')}\n${fence}\n\n`;
    },
  });
  // A DOM-based rule preserves pipes/multiline cells and headerless tables in GFM,
  // and does not require the browser-only HTMLTableElement.rows property.
  service.addRule('chatpilotTable', {
    filter: 'table',
    replacement(_content, node): string {
      const rows = [...(node as HTMLElement).querySelectorAll('tr')]
        .filter(row => row.closest('table') === node)
        .map(row => [...row.children].filter(cell => cell.matches('th,td')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const line = (values: string[]) => `| ${Array.from({ length: width }, (_, index) => values[index] ?? '').join(' | ')} |`;
      const lines = rows.map(row => line(row.map(cell => service.turndown(cell as HTMLElement)
        .replace(/\|/g, '\\|').replace(/[ \t]*\n+[ \t]*/g, '<br>'))));
      if (!rows[0]?.every(cell => cell.localName === 'th')) lines.unshift(line([]));
      lines.splice(1, 0, line(Array.from({ length: width }, () => '---')));
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
  return service.turndown(element).trim();
}

type TextFragment =
  | { kind: 'text'; value: string }
  | { kind: 'break' }
  | { kind: 'pre'; value: string };

function textFragments(node: Node, fragments: TextFragment[]): void {
  if (node.nodeType === node.TEXT_NODE) {
    fragments.push({ kind: 'text', value: node.textContent ?? '' });
    return;
  }
  if (node.nodeType !== node.ELEMENT_NODE) {
    return;
  }

  const element = node as HTMLElement;
  const tag = element.localName.toLowerCase();
  const formula = element.getAttribute('data-chatpilot-formula');
  if (formula) {
    fragments.push({ kind: formula.startsWith('$$') ? 'pre' : 'text', value: formula });
    return;
  }
  if (tag === 'br') {
    fragments.push({ kind: 'break' });
    return;
  }
  if (tag === 'pre') {
    fragments.push({ kind: 'break' }, { kind: 'pre', value: element.textContent ?? '' }, { kind: 'break' });
    return;
  }
  if (tag === 'img') {
    const label = element.getAttribute('alt')?.trim() ?? element.getAttribute('data-attachment-name')?.trim();
    if (label) {
      fragments.push({ kind: 'text', value: label });
    }
    return;
  }
  if (tag === 'tr') {
    fragments.push({ kind: 'break' });
    const cells = Array.from(element.querySelectorAll(':scope > th, :scope > td'));
    cells.forEach((cell, index) => {
      if (index > 0) {
        fragments.push({ kind: 'text', value: ' | ' });
      }
      for (const child of Array.from(cell.childNodes)) {
        textFragments(child, fragments);
      }
    });
    fragments.push({ kind: 'break' });
    return;
  }

  const block = /^(address|article|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|h[1-6]|header|li|main|ol|p|section|table|tbody|thead|tfoot|ul)$/.test(tag);
  if (block) {
    fragments.push({ kind: 'break' });
  }
  for (const child of Array.from(element.childNodes)) {
    textFragments(child, fragments);
  }
  if (block) {
    fragments.push({ kind: 'break' });
  }
}

function toText(element: HTMLElement): string {
  const fragments: TextFragment[] = [];
  textFragments(element, fragments);

  const lines: string[] = [];
  let line = '';
  const flush = (): void => {
    const value = line.trim();
    if (value) {
      lines.push(value);
    }
    line = '';
  };
  for (const fragment of fragments) {
    if (fragment.kind === 'break') {
      flush();
    } else if (fragment.kind === 'pre') {
      flush();
      const code = fragment.value.replace(/\r\n?/g, '\n').replace(/\n$/, '');
      if (code) {
        lines.push(code);
      }
    } else {
      line += fragment.value.replace(/\s+/g, ' ');
    }
  }
  flush();
  return lines.join('\n');
}

function previewFor(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Parses one rendered ChatGPT turn without scrolling, expanding, or fetching. */
export function parseTurn(element: HTMLElement): MessageRecord | null {
  if (!isVisible(element)) {
    return null;
  }

  const role = resolveRole(element);
  if (!role) {
    return null;
  }

  const content = buildContent(element, role);
  const text = toText(content);
  const markdown = toMarkdown(content);
  const ids = getMessageIds(element);
  const id = ids[0] ?? `${role}:${hash(text)}`;
  const outerShell = element.closest('[data-turn-id], [data-turn-id-container]');
  const turnId = outerShell?.getAttribute('data-turn-id')?.trim()
    ?? outerShell?.getAttribute('data-turn-id-container')?.trim()
    ?? element.getAttribute('data-turn-id')?.trim()
    ?? element.getAttribute('data-turn-id-container')?.trim()
    ?? element.querySelector('[data-turn-id]')?.getAttribute('data-turn-id')?.trim()
    ?? element.querySelector('[data-turn-id-container]')?.getAttribute('data-turn-id-container')?.trim();

  return {
    id,
    ...(turnId ? { turnId } : {}),
    role,
    index: getTurnIndex(element),
    text,
    markdown,
    preview: previewFor(text),
  };
}
