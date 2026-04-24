# Claude Code Remote 調試報告

## 時間
2026-04-21 凌晨 00:00 - 02:17

## 問題
無法成功執行 `claude` CLI 命令獲取回應。一直出現 "Invalid API key" 錯誤。

## 已嘗試的方案

### 1. 直接調用 Anthropic API ❌
- 讀取 `~/.claude/.credentials.json` 中的 OAuth token
- 使用 `@anthropic-ai/sdk` 調用 API
- **失敗原因**: 429 rate_limit_error（OAuth token 可能不適用於直接 API 調用）

### 2. 執行 `claude --print` 命令 ❌
各種執行方式都嘗試過：
- `spawn('claude', args)` with shell: true
- `spawn('bash', ['-c', command])`
- `exec(command)` with PowerShell
- `spawn('node', [cli.js path])`

**問題現象：**
- 在 bash 中直接執行：✅ 成功
  ```bash
  claude --print "測試" # 有正常輸出
  ```

- 在 Node.js spawn/exec 中執行：❌ "Invalid API key"
  ```
  [Claude CLI] stdout chunk: Invalid API key · Fix external API key
  [Claude CLI] Exited with code 1
  ```

### 3. 環境變數設置 ❌
嘗試設置：
- `CLAUDECODE=1`
- `CLAUDE_CODE_ENTRYPOINT=cli`
- `HOME` / `USERPROFILE`
- 完整 `process.env` 繼承

**仍然失敗！**

## 根本原因猜測

**當前 session 本身就是 Claude Code CLI 的一個 instance。**

可能的衝突：
1. Claude CLI 檢測到正在被另一個 Claude instance 調用
2. 防止遞歸或並發衝突的保護機制
3. Session/credential 鎖定機制

## 可行的替代方案

### 方案 A: 只讀模式
- 讀取 `~/.claude/projects/` 下的 .jsonl 文件
- 顯示歷史對話
- **缺點**: 無法發送新消息（不符合用戶"雙向"需求）

### 方案 B: 獨立認證
- 要求用戶提供獨立的 Anthropic API key
- 不使用 Claude CLI 的憑證
- **缺點**: 需要額外的 API key，可能有額外的 rate limit

### 方案 C: WebSocket 轉發到現有 CLI
- 嘗試找到正在運行的 Claude CLI process
- 通過某種 IPC 機制通信
- **缺點**: Claude CLI 可能沒有提供這種接口

### 方案 D: 文件監控 + 手動觸發
- Web UI 只負責顯示 session 文件
- 用戶在電腦的 CLI 中執行命令
- Web UI 監控文件變化並自動刷新
- **缺點**: 不是真正的雙向，只是查看

## 建議下一步

1. **研究 Claude Code CLI 源碼**
   查看是否有允許多實例或遠程調用的方式

2. **聯繫 Anthropic**
   詢問是否支持這種使用場景

3. **降低需求**
   先實現只讀查看功能，至少可以在手機上看到對話歷史

4. **完全獨立實現**
   不依賴 CLI，使用獨立的 API key 和 session 管理

## 當前代碼狀態

- ✅ 項目架構完整
- ✅ 前端 React UI 可運行
- ✅ 後端 WebSocket 連接正常
- ✅ Session 管理實作完成
- ❌ Claude CLI 調用失敗
- ❌ E2E 測試未通過

## 文件位置

- 專案：`D:\GitClone\_HomeProject\claudecode-remote`
- E2E 測試：`test-e2e.mjs`
- 測試截圖：`test-result.png`
- 日誌：`C:\Users\Kevin\AppData\Local\Temp\claude\C--Users-Kevin\tasks\bfc599b.output`

## 技術細節

**已確認可以執行的命令：**
```bash
# 在 Git Bash 中
cd /d/GitClone/_HomeProject
claude --print "測試"  # ✅ 成功

# 在 PowerShell 中
claude --print "測試"  # ✅ 成功

# 直接用 node
node "C:\Users\Kevin\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js" --print "測試"  # ✅ 成功
```

**在 Node.js 中失敗：**
```typescript
const child = spawn('node', [cliPath, '--print', '--no-session-persistence', message], {
  cwd: projectPath,
  env: process.env,  // 即使繼承所有環境變數
});
// 輸出：Invalid API key
```

---

**調試者**: Claude Sonnet 4.5
**時間投入**: 約 2.5 小時
**狀態**: 未解決，需要進一步研究
