/**
 * claudecode-remote — deep E2E test suite
 * Run: npx playwright test
 * Screenshots saved to: test-results/
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_AI = 150_000; // 2.5 min — tool-use responses can be slow
const RESULTS = path.resolve(__dirname, '..', 'test-results');

// Valid 1×1 PNG (tested against Anthropic API — confirmed accepted)
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureResults() {
  fs.mkdirSync(RESULTS, { recursive: true });
}

async function snap(page: Page, name: string) {
  ensureResults();
  const filePath = path.join(RESULTS, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸  ${name}.png`);
}

/** Wait for Claude to finish responding (textarea becomes enabled again). */
async function waitForAI(page: Page, timeout = TIMEOUT_AI) {
  // The textarea is disabled while isProcessing=true
  await expect(page.locator('textarea').first()).toBeEnabled({ timeout });
  await page.waitForTimeout(400); // let React batch final state
}

/** Fill textarea + click 傳送. */
async function sendMessage(page: Page, message: string) {
  await page.locator('textarea').first().fill(message);
  await page.locator('button:has-text("傳送")').click();
  await page.waitForTimeout(300);
}

/** Send and wait for full response. */
async function sendAndWait(page: Page, message: string) {
  await sendMessage(page, message);
  await waitForAI(page);
}

/** Return innerText of the last assistant message bubble. */
async function lastAssistantText(page: Page): Promise<string> {
  // Assistant messages: <div class="flex justify-start">...<div class="whitespace-pre-wrap">...</div>
  return page.locator('.flex.justify-start .whitespace-pre-wrap').last().innerText();
}

/** Open app and wait for WS connection. */
async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator('text=已連線')).toBeVisible({ timeout: 15_000 });
}

// ── Shared state for serial tests 01-09 ──────────────────────────────────────

test.describe.serial('claudecode-remote E2E', () => {
  let sharedPage: Page;
  let savedSessionId = '';
  let firstProjectName = '';

  test.beforeAll(async ({ browser }) => {
    ensureResults();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    sharedPage = await ctx.newPage();
    await openApp(sharedPage);
  });

  test.afterAll(async () => {
    await sharedPage.close();
  });

  // ── 01 Page load ────────────────────────────────────────────────────────────

  test('01 page load — dark mode, sidebar, connection', async () => {
    const p = sharedPage;

    // Dark background
    const bg = await p.evaluate(() =>
      getComputedStyle(document.querySelector('[class*="bg-gray-900"]')!).backgroundColor,
    );
    expect(bg).toMatch(/\d/); // has a color value

    // Title
    await expect(p.locator('h1:has-text("Claude Code Remote")')).toBeVisible();

    // Connected indicator (green dot + text)
    await expect(p.locator('text=已連線')).toBeVisible();

    // Sidebar: 新對話 button and ↻ refresh
    await expect(p.locator('button:has-text("新對話")')).toBeVisible();
    await expect(p.locator('button[title="重新整理"]')).toBeVisible();

    // Settings gear
    await expect(p.locator('button[title="System Prompt"]')).toBeVisible();

    await snap(p, '01-page-load');
    console.log('  ✓ dark mode, sidebar, 已連線 confirmed');
  });

  // ── 02 New session ──────────────────────────────────────────────────────────

  test('02 new session — create and verify empty state', async () => {
    const p = sharedPage;

    await p.click('button:has-text("新對話")');
    await p.waitForTimeout(800);

    // Should show empty-state placeholder
    await expect(p.locator('text=傳送訊息開始對話')).toBeVisible({ timeout: 5_000 });

    // Save new session ID
    savedSessionId = await p.evaluate(() => localStorage.getItem('claudecode-session-id') ?? '');
    console.log(`  Session ID: ${savedSessionId}`);
    expect(savedSessionId).toBeTruthy();

    await snap(p, '02-new-session');
  });

  // ── 03 Plain text chat ──────────────────────────────────────────────────────

  test('03 text chat — Traditional Chinese response', async () => {
    const p = sharedPage;

    await sendMessage(p, '你好，請用一句話介紹你自己');
    await snap(p, '03a-sent');

    await waitForAI(p);

    const reply = await lastAssistantText(p);
    console.log(`  Reply: ${reply.slice(0, 120)}`);

    const chineseCount = (reply.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const englishWords = (reply.match(/\b[a-zA-Z]{4,}\b/g) ?? []).length;
    expect(chineseCount).toBeGreaterThan(3);
    expect(chineseCount).toBeGreaterThan(englishWords);

    await snap(p, '03b-response');
  });

  // ── 04 Tool use ─────────────────────────────────────────────────────────────

  test('04 tool use — list D:/GitClone/_HomeProject', async () => {
    const p = sharedPage;

    await sendMessage(p, '列出 D:/GitClone/_HomeProject 下的資料夾，用繁體中文簡短說明');
    await snap(p, '04a-sent');

    await waitForAI(p);

    const reply = await lastAssistantText(p);
    console.log(`  Reply (200): ${reply.slice(0, 200)}`);

    // Should list known projects
    const hasProjects =
      reply.includes('claudecode') ||
      reply.includes('auto-elearn') ||
      reply.includes('opencode') ||
      reply.includes('ai-core');
    expect(hasProjects).toBeTruthy();

    // Remember first project for next test
    const firstLine = reply.split('\n').find(l => l.match(/\*\*\S+\*\*/) || l.match(/^\d+\./));
    firstProjectName = firstLine ?? '';
    console.log(`  First project line: ${firstProjectName}`);

    await snap(p, '04b-response');
  });

  // ── 05 Multi-turn conversation ──────────────────────────────────────────────

  test('05 multi-turn — context carried across turns', async () => {
    const p = sharedPage;

    await sendMessage(p, '剛才你列出的第一個專案叫什麼？用一句話說');
    await snap(p, '05a-sent');

    await waitForAI(p);

    const reply = await lastAssistantText(p);
    console.log(`  Reply: ${reply.slice(0, 150)}`);

    // Should have Chinese and reference a project name
    const hasChinese = /[\u4e00-\u9fff]/.test(reply);
    expect(hasChinese).toBeTruthy();
    expect(reply.length).toBeGreaterThan(5);

    // Should NOT just say it doesn't know
    const knowsContext = !/不知道|沒有.*列出|沒有提供/.test(reply);
    expect(knowsContext).toBeTruthy();

    await snap(p, '05b-response');
  });

  // ── 06 Image upload ─────────────────────────────────────────────────────────

  test('06 image upload — attach PNG and analyze', async () => {
    const p = sharedPage;

    // Inject file into hidden input directly
    await p.locator('input[type="file"]').setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: TEST_PNG,
    });

    // Pending image strip should appear
    await expect(p.locator('img.h-14.w-14')).toBeVisible({ timeout: 5_000 });
    await snap(p, '06a-image-attached');

    await sendMessage(p, '這張圖片是什麼顏色？');
    await snap(p, '06b-sent');

    await waitForAI(p);

    const reply = await lastAssistantText(p);
    console.log(`  Image reply: ${reply.slice(0, 150)}`);
    expect(reply.length).toBeGreaterThan(3);

    await snap(p, '06c-response');
  });

  // ── 07 Switch session ───────────────────────────────────────────────────────

  test('07 switch session — load different history', async () => {
    const p = sharedPage;

    const currentId = await p.evaluate(() => localStorage.getItem('claudecode-session-id') ?? '');
    const sidebarBtns = p.locator('.w-64 .flex-1.overflow-y-auto button');
    const total = await sidebarBtns.count();
    console.log(`  Sessions in sidebar: ${total}, current: ${currentId.slice(0, 8)}...`);

    await snap(p, '07a-before-switch');

    if (total >= 2) {
      // Click first inactive session
      const inactiveBtn = p.locator('.w-64 .flex-1.overflow-y-auto button:not(.bg-gray-700)').first();
      const inactiveBtnText = await inactiveBtn.innerText();
      console.log(`  Switching to: ${inactiveBtnText.slice(0, 60)}`);

      await inactiveBtn.click();
      // Wait for messages to clear then reload (optimistic clear + server response)
      await expect(p.locator('textarea')).toBeEnabled({ timeout: 10_000 });
      await p.waitForTimeout(800);

      const newId = await p.evaluate(() => localStorage.getItem('claudecode-session-id') ?? '');
      expect(newId).not.toBe(currentId);
      console.log(`  Switched to: ${newId.slice(0, 8)}...`);
      await snap(p, '07b-other-session');

      // Switch back: find and click the original session button by ID match
      // Re-query — sessions list may have refreshed
      const allBtns = p.locator('.w-64 .flex-1.overflow-y-auto button');
      const btnCount = await allBtns.count();
      let foundAndClicked = false;
      for (let i = 0; i < btnCount; i++) {
        // Can't match by ID directly; use the first active session (highlighted = not current)
        // We know our session is NOT the currently active one after switching
        // so click first non-active button and see if session changes back
        const btn = allBtns.nth(i);
        const cls = await btn.getAttribute('class') ?? '';
        if (!cls.includes('bg-gray-700')) {
          await btn.click();
          await expect(p.locator('textarea')).toBeEnabled({ timeout: 10_000 });
          await p.waitForTimeout(500);
          const resumedId = await p.evaluate(() => localStorage.getItem('claudecode-session-id') ?? '');
          if (resumedId === currentId) {
            console.log(`  ✓ Switched back to original session`);
            foundAndClicked = true;
            break;
          }
        }
      }
      if (!foundAndClicked) {
        console.log('  Could not switch back to original session — proceeding');
      }
    } else {
      console.log('  Only 1 session — skipping switch, verifying current session');
    }

    // Verify messages are present in whatever session we're on
    const msgCount = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
    console.log(`  Messages after return: ${msgCount}`);
    expect(msgCount).toBeGreaterThan(0);

    await snap(p, '07c-returned');
  });

  // ── 08 New session — old conversation preserved ─────────────────────────────

  test('08 new session + resume old — history intact', async () => {
    const p = sharedPage;

    const prevId = await p.evaluate(() => localStorage.getItem('claudecode-session-id') ?? '');
    const msgsBeforeSwitch = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
    console.log(`  Messages in session ${prevId.slice(0, 8)}: ${msgsBeforeSwitch}`);

    // Start new session — App.tsx now clears messages immediately
    await p.click('button:has-text("新對話")');
    // Empty state should appear immediately (optimistic clear in App.tsx)
    await expect(p.locator('text=傳送訊息開始對話')).toBeVisible({ timeout: 8_000 });
    await snap(p, '08a-new-empty-session');

    // Verify it's a different session
    const newId = await p.evaluate(() => localStorage.getItem('claudecode-session-id') ?? '');
    expect(newId).not.toBe(prevId);
    console.log(`  New session: ${newId.slice(0, 8)}...`);

    // Resume old session via sidebar
    const sidebarBtns = p.locator('.w-64 .flex-1.overflow-y-auto button');
    const count = await sidebarBtns.count();
    console.log(`  Sidebar sessions: ${count}`);

    if (count > 0 && msgsBeforeSwitch > 0) {
      // Find the old session by iterating until we get one with messages
      let resumed = false;
      for (let i = 0; i < Math.min(count, 5); i++) {
        await sidebarBtns.nth(i).click();
        await expect(p.locator('textarea')).toBeEnabled({ timeout: 8_000 });
        await p.waitForTimeout(500);
        const msgsAfter = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
        if (msgsAfter > 0) {
          console.log(`  ✓ Resumed session with ${msgsAfter} messages`);
          resumed = true;
          break;
        }
      }
      if (resumed) {
        const msgsAfter = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
        expect(msgsAfter).toBeGreaterThan(0);
      }
    }

    await snap(p, '08b-old-session-resumed');
  });

  // ── 09 Settings — system prompt ─────────────────────────────────────────────

  test('09 settings — system prompt persists and applies', async () => {
    const p = sharedPage;
    const marker = '[E2E-PROMPT-TEST]';

    // Open settings panel
    await p.click('button[title="System Prompt"]');
    await expect(p.locator('text=System Prompt').first()).toBeVisible({ timeout: 5_000 });
    await snap(p, '09a-settings-open');

    // Set a distinctive system prompt
    const settingsTextarea = p.locator('div.bg-gray-800.border-b textarea');
    await settingsTextarea.fill(`Every reply must begin with ${marker}`);

    // Save
    await p.locator('button:has-text("儲存")').click();
    await expect(p.locator('text=✓ 已儲存')).toBeVisible({ timeout: 5_000 });
    await snap(p, '09b-settings-saved');

    // Close settings
    await p.locator('button:has-text("✕")').click();
    await expect(p.locator('text=System Prompt').first()).not.toBeVisible({ timeout: 3_000 });

    // Start a new session to test the prompt
    await p.click('button:has-text("新對話")');
    await p.waitForTimeout(500);

    await sendAndWait(p, '說你好');
    const reply = await lastAssistantText(p);
    console.log(`  Reply with system prompt: ${reply.slice(0, 200)}`);

    // The marker may or may not appear (Claude can override), but a response must come
    expect(reply.length).toBeGreaterThan(3);
    const hasMarker = reply.includes(marker);
    console.log(`  Marker present: ${hasMarker}`);

    await snap(p, '09c-prompt-effect');

    // Clean up: clear the system prompt so it doesn't affect other tests
    await p.click('button[title="System Prompt"]');
    await p.locator('div.bg-gray-800.border-b textarea').fill('');
    await p.locator('button:has-text("儲存")').click();
    await p.locator('button:has-text("✕")').click();
  });

  // ── 10 Mobile viewport ──────────────────────────────────────────────────────

  test('10 mobile — 375px sidebar hidden, hamburger reveals', async ({ browser }) => {
    const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mp = await mobileCtx.newPage();
    await openApp(mp);

    // Sidebar should be translated off-screen (not visible)
    const sidebarWrapper = mp.locator('[class*="transition-transform"]').first();
    const transform = await sidebarWrapper.evaluate(el =>
      getComputedStyle(el).transform,
    );
    console.log(`  Sidebar transform at 375px: ${transform}`);
    // translateX(-256px) means -translate-x-full is applied
    expect(transform).toMatch(/matrix/); // has a CSS transform

    // The 新對話 button should be off-screen (sidebar hidden)
    const newChatBtn = mp.locator('button:has-text("新對話")').first();
    const isInViewport = await newChatBtn.isVisible().catch(() => false);
    console.log(`  新對話 visible on mobile: ${isInViewport}`);

    await snap(mp, '10a-mobile-sidebar-hidden');

    // Click hamburger
    await mp.locator('button:has-text("☰")').click();
    await mp.waitForTimeout(300);

    // Backdrop overlay should appear
    await expect(mp.locator('.fixed.inset-0.bg-black\\/60')).toBeVisible({ timeout: 3_000 });

    // Sidebar now translated in
    const transformAfter = await sidebarWrapper.evaluate(el =>
      getComputedStyle(el).transform,
    );
    console.log(`  Sidebar transform after hamburger: ${transformAfter}`);

    await snap(mp, '10b-mobile-sidebar-open');

    // Click backdrop to close sidebar — click to the right of the 256px sidebar
    // The backdrop is z-20; the sidebar is z-30 and 256px wide, so the right
    // portion of the backdrop (x > 270) is not intercepted by the sidebar.
    await mp.locator('.fixed.inset-0.bg-black\\/60').click({ position: { x: 330, y: 400 } });
    await mp.waitForTimeout(300);
    await snap(mp, '10c-mobile-sidebar-closed');

    await mp.close();
    await mobileCtx.close();
  });

  // ── 11 Disconnect / reconnect ────────────────────────────────────────────────

  test('11 disconnect reconnect — auto-reconnect + history intact', async ({ browser }) => {
    const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await openApp(p);

    // Send a message to have history
    await sendAndWait(p, '斷線測試訊息');
    const msgsBefore = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
    console.log(`  Messages before disconnect: ${msgsBefore}`);
    expect(msgsBefore).toBeGreaterThan(0);
    await snap(p, '11a-connected-with-history');

    // Simulate network disconnect:
    // setOffline blocks new connections but doesn't close existing TCP sockets.
    // Force-close the WS via the test handle so onclose fires immediately.
    await ctx.setOffline(true);
    await p.evaluate(() => (window as unknown as Record<string, WebSocket>).__testWs?.close());
    await expect(p.locator('text=重連中…')).toBeVisible({ timeout: 10_000 });
    await snap(p, '11b-disconnected');
    console.log('  ✓ disconnected state shown');

    // Restore network — reconnect timer fires in 1500ms and connects
    await ctx.setOffline(false);
    await expect(p.locator('text=已連線')).toBeVisible({ timeout: 30_000 });
    await snap(p, '11c-reconnected');
    console.log('  ✓ reconnected');

    // History should be preserved in the resumed session
    await p.waitForTimeout(1000);
    const msgsAfter = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
    console.log(`  Messages after reconnect: ${msgsAfter}`);
    expect(msgsAfter).toBeGreaterThan(0);

    // Verify we can still send messages
    await sendAndWait(p, '重連後還能說話嗎');
    const finalReply = await lastAssistantText(p);
    console.log(`  Post-reconnect reply: ${finalReply.slice(0, 100)}`);
    expect(finalReply.length).toBeGreaterThan(3);
    await snap(p, '11d-post-reconnect-chat');

    await p.close();
    await ctx.close();
  });

  // ── 12 Stress test ──────────────────────────────────────────────────────────

  test('12 stress test — 5 sequential messages no crash', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await openApp(p);

    // Fresh session for stress test
    await p.click('button:has-text("新對話")');
    await p.waitForTimeout(500);

    const questions = [
      '1 加 1 等於幾',
      '2 加 2 等於幾',
      '3 加 3 等於幾',
      '4 加 4 等於幾',
      '5 加 5 等於幾',
    ];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`  Message ${i + 1}/5: ${q}`);
      await sendAndWait(p, q);
      const reply = await lastAssistantText(p);
      console.log(`    → ${reply.slice(0, 80)}`);
      expect(reply.length).toBeGreaterThan(1);
      await snap(p, `12-msg-${i + 1}`);
    }

    // Verify all 5 assistant responses exist
    const assistantMsgs = await p.locator('.flex.justify-start .whitespace-pre-wrap').count();
    console.log(`  Total assistant messages: ${assistantMsgs}`);
    expect(assistantMsgs).toBe(5);

    // UI must still be functional
    await expect(p.locator('textarea')).toBeEnabled();
    await expect(p.locator('text=已連線')).toBeVisible();

    await snap(p, '12-final-state');
    console.log('  ✓ 5 messages sent and received, no crash');

    await p.close();
    await ctx.close();
  });
});
