import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
} from '@playwright/test';

import { chatGptFixture } from './fixture';

const extensionPath = resolve(process.cwd(), '.output/chrome-mv3');
const fixtureUrl = (path = '/c/a') => `https://chatgpt.com${path}`;

let context: BrowserContext;
const blockedRequests: string[] = [];

function navigatorRoot(page: Page) {
  // Playwright locators pierce the open content-script shadow root.
  return page.getByTestId('chatpilot-root');
}

async function openNavigator(page: Page) {
  const root = navigatorRoot(page);
  await expect(root).toBeVisible();
  await root.getByRole('button', { name: '打开 ChatPilot' }).click();
  await expect(root.getByRole('region', { name: 'ChatPilot 对话导航' })).toBeVisible();
  return root;
}

async function openConversation(path = '/c/a'): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixtureUrl(path), { waitUntil: 'domcontentloaded' });
  return page;
}

async function materialize(page: Page) {
  const root = navigatorRoot(page);
  await root.getByRole('button', { name: '加载完整对话' }).click();
  await expect.poll(() => root.getByTestId('chatpilot-message').count(), { timeout: 12_000 }).toBe(12);
  await expect(root.getByRole('button', { name: '加载完整对话' })).toBeVisible({ timeout: 12_000 });
}

async function readDownload(download: Download): Promise<string> {
  const file = await download.path();
  if (!file) throw new Error('The export download has no local file path.');
  return readFile(file, 'utf8');
}

async function exportContent(page: Page): Promise<string> {
  const button = navigatorRoot(page).getByRole('button', { name: '导出' });
  await expect(button).toBeEnabled({ timeout: 12_000 });
  const download = page.waitForEvent('download');
  await button.click();
  const content = await readDownload(await download);
  await expect(button).toBeEnabled({ timeout: 12_000 });
  return content;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      await route.continue();
      return;
    }
    if (url.hostname === 'chatgpt.com' && request.resourceType() === 'document') {
      const conversation = url.pathname === '/' ? 'new' : url.pathname.endsWith('/b') ? 'b' : 'a';
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: chatGptFixture({ conversation }),
      });
      return;
    }
    blockedRequests.push(request.url());
    await route.abort();
  });
});

test.afterAll(async () => {
  if (context) await context.close();
});

test('manifest requests only storage and declares a local ChatGPT content script', async () => {
  const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8')) as {
    manifest_version?: number;
    host_permissions?: string[];
    web_accessible_resources?: Array<{ matches: string[]; resources: string[] }>;
    permissions?: string[];
    content_scripts?: Array<{ matches?: string[]; js?: string[]; css?: string[] }>;
    background?: unknown;
    externally_connectable?: unknown;
  };

  expect(manifest.permissions).toEqual(['storage']);
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.host_permissions ?? []).toEqual([]);
  expect(manifest.web_accessible_resources?.every(resource => resource.matches.length === 1 && resource.matches[0] === 'https://chatgpt.com/*')).toBe(true);
  expect(manifest.background).toBeUndefined();
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.content_scripts).toHaveLength(1);
  expect(manifest.content_scripts?.[0]?.matches).toEqual(['https://chatgpt.com/*']);
  expect((manifest.content_scripts?.[0]?.js ?? []).every((asset) => !/^https?:/u.test(asset))).toBe(true);
  expect((manifest.content_scripts?.[0]?.css ?? []).every((asset) => !/^https?:/u.test(asset))).toBe(true);
});

test('loads the extension rail, indexes ordered roles, searches complete text, and navigates', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);

  await expect(root.getByText('5 条消息 · 已选 0 条')).toBeVisible();
  await materialize(page);
  await expect(root.getByText('12 条消息 · 已选 0 条')).toBeVisible();
  await expect(root.getByRole('button', { name: '跳转到我的第 1 条消息', exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: '跳转到ChatGPT的第 12 条消息', exact: true })).toBeVisible();

  const search = root.getByLabel('搜索消息');
  await search.fill('needle-full-body');
  await expect(root.getByTestId('chatpilot-message')).toHaveCount(1);
  await expect(root.getByRole('button', { name: '跳转到我的第 9 条消息', exact: true })).toBeVisible();
  await search.fill('');

  const target = root.getByRole('button', { name: '跳转到ChatGPT的第 12 条消息', exact: true });
  await target.click();
  await expect(target.locator('xpath=ancestor::li')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => page.locator('[data-fixture-slot="12"] section').evaluate((node) => {
    const feed = document.querySelector('#conversation-feed')?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return Boolean(feed && rect.top >= feed.top && rect.bottom <= feed.bottom);
  })).toBe(true);

  await page.close();
});

test('selection controls support all, clear, roles, and a manual record', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  await materialize(page);

  const controls = root.locator('.chatpilot-selection-controls');
  await controls.getByRole('button', { name: '全选' }).click();
  await expect(root.getByRole('checkbox', { checked: true })).toHaveCount(12);
  await controls.getByRole('button', { name: '清除' }).click();
  await expect(root.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await root.getByLabel('范围').selectOption('selected');
  await expect(root.getByRole('button', { name: '导出' })).toBeDisabled();
  await expect(root.getByText('请至少选择一条消息。')).toBeVisible();
  await root.getByLabel('范围').selectOption('all');
  await controls.getByRole('button', { name: '仅我的消息' }).click();
  await expect(root.getByRole('checkbox', { checked: true })).toHaveCount(6);
  await controls.getByRole('button', { name: '仅 ChatGPT 消息' }).click();
  await expect(root.getByRole('checkbox', { checked: true })).toHaveCount(6);
  await controls.getByRole('button', { name: '清除' }).click();
  await root.getByRole('checkbox', { name: '选择我的第 1 条消息', exact: true }).check();
  await expect(root.getByRole('checkbox', { checked: true })).toHaveCount(1);

  await page.close();
});

test('exports real Markdown, JSON, and text files for all supported scopes', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  await materialize(page);

  await root.getByLabel('格式').selectOption('md');
  await root.getByLabel('范围').selectOption('all');
  const markdown = await exportContent(page);
  expect(markdown).toContain('## 用户');
  expect(markdown).toContain('print("```")');
  expect(markdown).toContain('| 项目 | 状态 |');
  expect(markdown).toContain('$E = mc^2$');

  await root.getByLabel('格式').selectOption('json');
  await root.getByLabel('范围').selectOption('assistant');
  const json = JSON.parse(await exportContent(page)) as { messages: Array<{ role: string }> };
  expect(json.messages).toHaveLength(6);
  expect(json.messages.every((message) => message.role === 'assistant')).toBe(true);

  await root.locator('.chatpilot-selection-controls').getByRole('button', { name: '清除' }).click();
  await root.getByRole('checkbox', { name: '选择我的第 1 条消息', exact: true }).check();
  await root.getByLabel('格式').selectOption('txt');
  await root.getByLabel('范围').selectOption('selected');
  const text = await exportContent(page);
  expect(text).toContain('[用户]');
  expect(text).toContain('请给出部署计划。');
  expect(text).not.toContain('[ChatGPT]');

  await page.close();
});

test('materializes virtualized history and restores the current scroll anchor', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  await page.evaluate(() => (window.__chatpilotFixture as { scrollToTurn(number: number): void }).scrollToTurn(10));
  const before = await page.locator('#conversation-feed').evaluate((feed) => feed.scrollTop);

  await materialize(page);
  await expect(root.getByTestId('chatpilot-message')).toHaveCount(12);
  await expect.poll(() => page.locator('#conversation-feed').evaluate((feed) => feed.scrollTop)).toBeGreaterThanOrEqual(before - 240);
  await expect(page.locator('[data-turn-id-container="client-created-root"]')).toHaveCount(1);

  await page.close();
});

test('tracks reading independently of navigator clicks and restores position on Cancel', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  await materialize(page);
  await page.evaluate(() => {
    const feed = document.querySelector<HTMLElement>('#conversation-feed')!;
    const shell = document.querySelector<HTMLElement>('[data-fixture-slot="4"]')!;
    feed.scrollTop += shell.getBoundingClientRect().top - feed.getBoundingClientRect().top - 130;
  });
  const current = root.getByRole('button', { name: '跳转到ChatGPT的第 4 条消息', exact: true }).locator('xpath=ancestor::li');
  await expect(current).toHaveAttribute('aria-current', 'true');
  const before = await page.locator('#conversation-feed').evaluate(feed => ({ top: feed.scrollTop, style: feed.getAttribute('style') }));
  await root.getByRole('button', { name: '加载完整对话' }).click();
  await root.getByRole('button', { name: '取消', exact: true }).click();
  await expect(root.getByRole('alert')).toContainText('加载已取消');
  await expect.poll(() => page.locator('#conversation-feed').evaluate(feed => feed.scrollTop)).toBeCloseTo(before.top, 0);
  expect(await page.locator('#conversation-feed').getAttribute('style') || null).toBe(before.style || null);
  await page.close();
});

test('reconciles SPA root replacement, streaming text, and branch identity changes', async () => {
  const page = await openConversation('/c/a');
  const root = await openNavigator(page);
  const downloads: Download[] = [];
  page.on('download', download => downloads.push(download));
  await root.getByRole('button', { name: '导出', exact: true }).click();
  await expect(root.getByRole('button', { name: '取消', exact: true })).toBeVisible();

  await page.evaluate(() => (window.__chatpilotFixture as { setPath(next: string): void }).setPath('b'));
  await expect(root.getByText('0 条消息 · 已选 0 条')).toBeVisible();
  await page.evaluate(() => (window.__chatpilotFixture as { setPath(next: string): void }).setPath('c'));
  await expect.poll(() => page.url()).toContain('/c/c');
  await expect(root.getByText('0 条消息 · 已选 0 条')).toBeVisible();
  await expect(root.getByRole('button', { name: '导出', exact: true })).toBeDisabled();
  // The intermediate B render arrives after the browser URL already became C.
  await page.evaluate(() => (window.__chatpilotFixture as { renderConversationData(next: string): void }).renderConversationData('b'));
  await expect(root.getByRole('alert')).toContainText('多次切换了会话');
  await expect(root.getByText('0 条消息 · 已选 0 条')).toBeVisible();
  await page.evaluate(() => (window.__chatpilotFixture as { renderConversationData(next: string): void }).renderConversationData('c'));
  await expect(root.getByText('0 条消息 · 已选 0 条')).toBeVisible();
  await root.getByRole('button', { name: '重新索引当前对话' }).click();
  await expect(root.getByText('5 条消息 · 已选 0 条')).toBeVisible();
  expect(downloads).toHaveLength(0);
  await root.getByLabel('格式').selectOption('json');
  const recovered = JSON.parse(await exportContent(page)) as { url: string; messages: Array<{ id: string }> };
  expect(recovered.url).toBe(fixtureUrl('/c/c'));
  expect(recovered.messages).toHaveLength(12);
  expect(recovered.messages.every(message => message.id.startsWith('c-message-'))).toBe(true);

  await page.evaluate(() => (window.__chatpilotFixture as { scrollToTurn(number: number): void }).scrollToTurn(12));
  await page.evaluate(() => (window.__chatpilotFixture as { stream(number: number, suffix: string): void }).stream(12, ' 流式更新'));
  await root.getByLabel('搜索消息').fill('流式更新');
  await expect(root.getByTestId('chatpilot-message')).toHaveCount(1);
  await root.getByLabel('搜索消息').fill('');

  await page.evaluate(() => (window.__chatpilotFixture as { replaceBranch(number: number): void }).replaceBranch(12));
  await expect(root.getByText('分支替换后的答案。')).toBeVisible();

  await page.evaluate(() => (window.__chatpilotFixture as { replaceConversation(next: string): void }).replaceConversation('new'));
  await expect.poll(() => page.url()).toBe(fixtureUrl('/'));
  await expect(root.getByText('5 条消息 · 已选 0 条')).toBeVisible();
  await page.evaluate(() => (window.__chatpilotFixture as { replaceConversation(next: string): void }).replaceConversation('c'));
  await expect.poll(() => page.url()).toBe(fixtureUrl('/c/c'));
  await expect(root.getByText('5 条消息 · 已选 0 条')).toBeVisible();
  await page.close();
});

test('cancels a bounded materialization attempt after a wheel event', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  await page.evaluate(() => (window.__chatpilotFixture as { showUnrenderable(): void }).showUnrenderable());

  await root.getByRole('button', { name: '加载完整对话' }).click();
  await expect(root.getByRole('button', { name: '取消' })).toBeVisible();
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, 180);
  await expect(root.getByRole('button', { name: '加载完整对话' })).toBeVisible({ timeout: 4000 });
  await expect(root.getByRole('alert')).toContainText('你已移动会话');
  await page.close();
});

test('requires submission and continuous identities before preserving a new chat selection', async () => {
  const page = await openConversation('/');
  const root = await openNavigator(page);
  await root.getByRole('checkbox', { name: '选择ChatGPT的第 12 条消息', exact: true }).check();
  await page.getByRole('button', { name: 'Send synthetic prompt' }).click();
  await expect.poll(() => page.url()).toBe(fixtureUrl('/c/promoted'));
  await expect(root.getByText('6 条消息 · 已选 1 条')).toBeVisible();
  await expect(root.getByRole('checkbox', { name: '选择ChatGPT的第 12 条消息', exact: true })).toBeChecked();
  await page.close();

  const other = await openConversation('/');
  const otherRoot = await openNavigator(other);
  await otherRoot.getByRole('checkbox', { name: '选择ChatGPT的第 12 条消息', exact: true }).check();
  await other.evaluate(() => (window.__chatpilotFixture as { setPath(next: string): void }).setPath('other'));
  await expect(otherRoot.getByText('0 条消息 · 已选 0 条')).toBeVisible();
  await expect(otherRoot.getByRole('button', { name: '导出', exact: true })).toBeDisabled();
  await other.evaluate(() => (window.__chatpilotFixture as { renderCurrentConversation(): void }).renderCurrentConversation());
  await expect(otherRoot.getByText('5 条消息 · 已选 0 条')).toBeVisible();
  await other.close();
});

test('does not download a still-generating or unreachable conversation', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  const downloads: Download[] = [];
  page.on('download', download => downloads.push(download));
  await page.evaluate(() => {
    const stop = document.createElement('button');
    stop.dataset.testid = 'stop-button';
    stop.textContent = 'Stop generating';
    document.querySelector('#fixture-composer')!.append(stop);
  });
  await root.getByRole('button', { name: '导出', exact: true }).click();
  await expect(root.getByRole('alert')).toContainText('仍在生成回答', { timeout: 12_000 });
  expect(downloads).toHaveLength(0);
  await page.evaluate(() => {
    document.querySelector('[data-testid="stop-button"]')!.remove();
    (window.__chatpilotFixture as { showUnrenderable(): void }).showUnrenderable();
  });
  await root.getByRole('button', { name: '加载完整对话' }).click();
  await expect(root.getByRole('alert')).toContainText('部分消息无法加载', { timeout: 5000 });
  await expect(root.getByRole('button', { name: '取消' })).toHaveCount(0);
  expect(downloads).toHaveLength(0);
  await page.close();
});

test('persists popup settings and synchronizes them with the content script', async () => {
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  const item = manager.locator('extensions-item').filter({ hasText: 'ChatPilot' });
  await expect(item).toBeVisible({ timeout: 5000 });
  const id = await item.getAttribute('id');
  if (!id) throw new Error('Chrome did not register the built ChatPilot extension.');
  await manager.close();
  const popupUrl = `chrome-extension://${id}/popup.html`;
  let popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByLabel('启用导航器', { exact: true })).toBeEnabled();
  const page = await openConversation();
  const root = await openNavigator(page);
  await popup.getByLabel('平滑滚动', { exact: true }).uncheck();
  await expect(popup.locator('.popup-saved')).toHaveText('已保存');
  await popup.getByLabel('默认导出格式').selectOption('json');
  await expect(popup.locator('.popup-saved')).toHaveText('已保存');
  await expect(root.getByLabel('格式')).toHaveValue('json');
  await popup.getByLabel('默认导出范围').selectOption('assistant');
  await expect(popup.locator('.popup-saved')).toHaveText('已保存');
  await expect(root.getByLabel('范围')).toHaveValue('assistant');
  await popup.getByRole('slider').press('End');
  await expect(popup.locator('.popup-saved')).toHaveText('已保存');
  await expect.poll(async () => (await root.locator('.chatpilot-panel').boundingBox())?.width).toBe(420);
  await popup.getByLabel('启用导航器', { exact: true }).uncheck();
  await expect(root).toHaveCount(0);
  await popup.getByLabel('启用导航器', { exact: true }).check();
  await expect(navigatorRoot(page)).toBeVisible();
  await popup.close();
  popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByLabel('默认导出格式')).toHaveValue('json');
  await expect(popup.getByLabel('默认导出范围')).toHaveValue('assistant');
  await expect(popup.getByLabel('平滑滚动', { exact: true })).not.toBeChecked();
  await expect(popup.getByRole('slider')).toHaveValue('420');
  await popup.screenshot({ path: 'test-results/chatpilot-popup.png' });
  await popup.close();
  await page.close();
});

test('keeps the expanded panel clear of the synthetic header and composer at wide viewports', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);

  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = await root.locator('.chatpilot-panel').boundingBox();
    const header = await page.locator('#fixture-header').boundingBox();
    const composer = await page.locator('#fixture-composer').boundingBox();
    if (!panel || !header || !composer) throw new Error('Fixture or ChatPilot panel geometry is unavailable.');
    expect(panel.x + panel.width).toBeLessThanOrEqual(width - 15);
    expect(panel.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(panel.y + panel.height).toBeLessThanOrEqual(composer.y);
    if (width === 1280) await page.screenshot({ path: 'test-results/chatpilot-desktop-1280.png', fullPage: true });
  }

  expect(blockedRequests).toEqual([]);
  await page.close();
});

test('exports assistant messages despite delayed page-driven scroll correction', async () => {
  const page = await openConversation();
  const root = await openNavigator(page);
  await root.getByLabel('格式').selectOption('md');
  await root.getByLabel('范围').selectOption('assistant');
  await root.getByRole('checkbox', { name: '选择ChatGPT的第 12 条消息', exact: true }).check();
  // Emulate a virtualizer correcting the feed after ChatPilot's own scroll.
  // A scroll event alone does not establish that the user moved the page.
  await page.evaluate(() => {
    const feed = document.querySelector<HTMLElement>('#conversation-feed')!;
    feed.addEventListener('scroll', () => {
      setTimeout(() => { feed.scrollTop += 24; feed.dataset.corrected = 'true'; }, 135);
    }, { once: true });
  });
  const downloaded = page.waitForEvent('download', { timeout: 12000 });
  await root.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.locator('#conversation-feed')).toHaveAttribute('data-corrected', 'true');
  await expect(root.getByRole('alert')).toHaveCount(0);
  const content = await readDownload(await downloaded);
  expect(content.match(/^## ChatGPT/gm)).toHaveLength(6);
  expect(content).not.toContain('## 用户');
  expect(content).toContain('第一步：创建可回滚的备份。');
  expect(content).toContain('最后一个答案。');
  await page.close();
});

test('still cancels collection on touch, pointer, and navigation-key input', async () => {
  for (const input of ['touchstart', 'pointerdown', 'keydown']) {
    const page = await openConversation();
    const root = await openNavigator(page);
    await page.evaluate(() => (window.__chatpilotFixture as { showUnrenderable(): void }).showUnrenderable());
    await root.getByRole('button', { name: '加载完整对话', exact: true }).click();
    await expect(root.getByRole('button', { name: '取消', exact: true })).toBeVisible();
    if (input === 'keydown') await page.locator('body').press('PageUp');
    else await page.locator('#conversation-feed').dispatchEvent(input);
    await expect(root.getByRole('alert')).toContainText('你已移动会话', { timeout: 4000 });
    await expect(root.getByRole('button', { name: '取消', exact: true })).toHaveCount(0);
    await page.close();
  }
});
