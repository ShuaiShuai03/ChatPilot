import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { chatGptFixture } from './fixture';

let context: BrowserContext;
let page: Page;
test.beforeEach(async () => {
  const extension = resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (url.hostname === 'chatgpt.com' && request.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: chatGptFixture() });
    return route.abort();
  });
  page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('https://chatgpt.com/c/a');
  await expect(page.getByRole('button', { name: '上一条我的消息', exact: true })).toBeVisible();
});
test.afterEach(async () => { await context?.close(); });

async function jump(direction: 'previous' | 'next', number: number) {
  const arrow = page.getByRole('button', { name: direction === 'previous' ? '上一条我的消息' : '下一条我的消息', exact: true });
  await expect(arrow).toBeEnabled({ timeout: 5000 });
  await arrow.click();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0, { timeout: 6000 });
  const target = page.locator(`[data-fixture-slot="${number}"] section`);
  await expect(target).toBeAttached();
  await expect.poll(() => target.evaluate(node => {
    const root = document.querySelector('#conversation-feed')!.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return rect.bottom > root.top && rect.top < root.bottom;
  })).toBe(true);
  const open = page.getByRole('button', { name: '打开 ChatPilot', exact: true });
  const wasCollapsed = await open.count() > 0;
  if (wasCollapsed) await open.click();
  await expect(page.getByRole('button', { name: `跳转到我的第 ${number} 条消息`, exact: true }).locator('xpath=ancestor::li')).toHaveAttribute('aria-current', 'true');
  if (wasCollapsed) await page.getByRole('button', { name: '关闭 ChatPilot', exact: true }).click();
}

test('jumps between user messages while collapsed, discovers missing history, and stops at boundaries', async () => {
  await expect(page.getByRole('button', { name: '下一条我的消息', exact: true })).toBeDisabled();
  for (const number of [11, 9, 7, 5, 3, 1]) await jump('previous', number);
  await expect(page.getByRole('button', { name: '上一条我的消息', exact: true })).toBeDisabled();
  for (const number of [3, 5, 7, 9, 11]) await jump('next', number);
  await expect(page.getByRole('button', { name: '下一条我的消息', exact: true })).toBeDisabled();
});

test('keeps navigation independent of search/selection and resets its position after a list click', async () => {
  await page.getByRole('button', { name: '打开 ChatPilot', exact: true }).click();
  await page.getByRole('button', { name: '加载完整对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0, { timeout: 10000 });
  await page.getByRole('button', { name: '跳转到ChatGPT的第 8 条消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0, { timeout: 5000 });
  await jump('previous', 7);
  await page.getByRole('checkbox', { name: '选择我的第 7 条消息', exact: true }).check();
  await page.getByLabel('搜索消息').fill('needle-full-body');
  await page.getByRole('button', { name: '下一条我的消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole('button', { name: '跳转到我的第 9 条消息', exact: true }).locator('xpath=ancestor::li')).toHaveAttribute('aria-current', 'true');
  await page.getByLabel('搜索消息').fill('');
  await expect(page.getByRole('checkbox', { name: '选择我的第 7 条消息', exact: true })).toBeChecked();
});

test('serializes smooth navigation, supports cancellation while collapsed, and clears state on SPA navigation', async () => {
  const up = page.getByRole('button', { name: '上一条我的消息', exact: true });
  const before = await page.locator('#conversation-feed').evaluate(element => element.scrollTop);
  await up.click();
  await expect(up).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('取消');
  await expect.poll(() => page.locator('#conversation-feed').evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
  await jump('previous', 11);
  await page.evaluate(() => (window.__chatpilotFixture as { replaceConversation(next: string): void }).replaceConversation('b'));
  await expect(page.getByRole('button', { name: '下一条我的消息', exact: true })).toBeDisabled();
  await jump('previous', 11);
  await expect(page.locator('[data-message-id="b-message-11"]')).toBeAttached();
});

test('reanchors after manual reading movement and respects reduced motion', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await jump('previous', 11);
  const feed = page.locator('#conversation-feed');
  await feed.dispatchEvent('wheel', { deltaY: -600 });
  await page.evaluate(() => {
    const feed = document.querySelector<HTMLElement>('#conversation-feed')!;
    const shell = document.querySelector<HTMLElement>('[data-fixture-slot="8"]')!;
    feed.scrollTop += shell.getBoundingClientRect().top - feed.getBoundingClientRect().top - feed.clientHeight * 0.23 + 30;
  });
  await expect(page.locator('[data-fixture-slot="8"] section')).toBeAttached();
  await jump('previous', 7);
  await jump('next', 9);
});

test('keeps arrows outside the panel at desktop widths in light and dark mode', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const expanded of [false, true]) {
        if (expanded) await page.getByRole('button', { name: '打开 ChatPilot', exact: true }).click();
        const up = page.getByRole('button', { name: '上一条我的消息', exact: true });
        await expect(up).toHaveAttribute('title', '上一条我的消息');
        const upBox = (await up.boundingBox())!;
        const downBox = (await page.getByRole('button', { name: '下一条我的消息', exact: true }).boundingBox())!;
        expect(upBox.width).toBe(36); expect(upBox.height).toBe(36);
        expect(upBox.y).toBeGreaterThanOrEqual(64);
        expect(downBox.y + downBox.height).toBeLessThanOrEqual(788);
        expect(upBox.x + upBox.width).toBeLessThanOrEqual(width - 16);
        if (expanded) {
          const panelBox = (await page.locator('.chatpilot-panel').boundingBox())!;
          expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(upBox.x - 8);
          await page.screenshot({ path: `test-results/chatpilot-${colorScheme}-${width}.png` });
          await page.getByRole('button', { name: '关闭 ChatPilot', exact: true }).click();
        }
      }
    }
  }
});

test('ignores rapid extra clicks and cancels an in-flight jump on SPA replacement', async () => {
  const up = page.getByRole('button', { name: '上一条我的消息', exact: true });
  await up.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(up).toBeDisabled();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0, { timeout: 5000 });
  await page.getByRole('button', { name: '打开 ChatPilot', exact: true }).click();
  await expect(page.getByRole('button', { name: '跳转到我的第 11 条消息', exact: true }).locator('xpath=ancestor::li')).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: '关闭 ChatPilot', exact: true }).click();
  await up.click();
  await expect(up).toBeDisabled();
  await page.evaluate(() => (window.__chatpilotFixture as { replaceConversation(next: string): void }).replaceConversation('b'));
  await expect(page.getByRole('button', { name: '下一条我的消息', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await jump('previous', 11);
  await expect(page.locator('[data-message-id="b-message-11"]')).toBeAttached();
});
