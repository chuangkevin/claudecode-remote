import { chromium } from 'playwright';

async function testClaudeCodeRemote() {
  console.log('🚀 Starting E2E test...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. 打開頁面
    console.log('📱 Opening http://localhost:9224...');
    await page.goto('http://localhost:9224');
    await page.waitForTimeout(2000);

    // 2. 等待連線
    console.log('🔌 Waiting for WebSocket connection...');
    const connected = await page.locator('text=已連線').waitFor({ timeout: 5000 });
    console.log('✅ WebSocket connected');

    // 3. 發送測試消息
    console.log('💬 Sending test message...');
    const input = page.locator('textarea');
    await input.fill('你好，請用一句話介紹你自己');

    const sendButton = page.locator('button:has-text("傳送")');
    await sendButton.click();
    console.log('✅ Message sent');

    // 4. 等待回應（延長等待時間）
    console.log('⏳ Waiting for response...');
    await page.waitForTimeout(30000);  // 等待 30 秒

    // 5. 檢查是否有回應
    const messages = await page.locator('.whitespace-pre-wrap').count();
    console.log(`📝 Found ${messages} message(s)`);

    if (messages >= 2) {
      // 取得最後一條消息（助手的回應）
      const lastMessage = await page.locator('.whitespace-pre-wrap').last().textContent();
      console.log('📨 Last message:', lastMessage?.substring(0, 100) + '...');

      if (lastMessage && lastMessage.length > 10 && !lastMessage.includes('錯誤') && !lastMessage.includes('exited')) {
        console.log('\n✅ ✅ ✅ 測試成功！Web UI 可以正常對話！\n');
        return true;
      } else {
        console.log('\n❌ 回應內容有錯誤\n');
        return false;
      }
    } else {
      console.log('\n❌ 沒有收到回應\n');
      return false;
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    await page.screenshot({ path: 'test-result.png' });
    console.log('📸 Screenshot saved to test-result.png');
    await browser.close();
  }
}

// 執行測試
testClaudeCodeRemote().then(success => {
  process.exit(success ? 0 : 1);
});
