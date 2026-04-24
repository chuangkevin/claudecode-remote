# Web-based Claude Code — MVP 規格

## 目標

創建一個 web 版 Claude Code，支援在多裝置上開發程式。

## 階段規劃

### Phase 1: 基礎架構（1-2 週）

**後端 Server：**
- [ ] HTTP server (Express/Fastify)
- [ ] WebSocket 連線（即時通訊）
- [ ] Claude API 整合
- [ ] Session 資料讀寫（.jsonl 格式）
- [ ] 基本的工具系統架構

**前端：**
- [ ] React app 基本結構
- [ ] 對話 UI（訊息列表）
- [ ] 輸入框和送出
- [ ] WebSocket 連線

### Phase 2: 核心工具（2-3 週）

**必要工具實作：**
- [ ] `Bash`: 執行 shell 指令
- [ ] `Read`: 讀取檔案
- [ ] `Write`: 寫入檔案
- [ ] `Edit`: 編輯檔案（字串替換）
- [ ] `Grep`: 搜尋檔案內容
- [ ] `Glob`: 搜尋檔案名稱

**工具執行流程：**
```
User Input → Claude API → Tool Calls → Server 執行 → 結果返回 → Claude API → Response
```

### Phase 3: Session 管理（1 週）

- [ ] 列出所有 sessions
- [ ] 切換 session
- [ ] 建立新 session
- [ ] Session metadata（summary, messageCount 等）
- [ ] 與 Claude Code CLI 的 sessions 相容

### Phase 4: 進階功能（2-3 週）

- [ ] 檔案瀏覽器
- [ ] 程式碼高亮
- [ ] Git 整合
- [ ] 權限管理
- [ ] 多使用者支援（可選）

## 技術細節

### Session 格式相容性

使用與 Claude Code 相同的格式：

```jsonl
{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"..."}
{"parentUuid":null,"isSidechain":false,"attachment":{...},...}
```

### 工具呼叫範例

```typescript
// Server 端處理工具呼叫
async function handleToolCall(tool: ToolCall) {
  switch (tool.name) {
    case "bash":
      return execShell(tool.input.command);
    case "read_file":
      return fs.readFileSync(tool.input.file_path, "utf8");
    case "write_file":
      return fs.writeFileSync(tool.input.file_path, tool.input.content);
    // ...
  }
}
```

### 安全性考量

- [ ] 工具執行權限檢查
- [ ] 路徑限制（只能存取特定目錄）
- [ ] 指令白名單（Bash）
- [ ] API Key 管理

## 預估工作量

- **Phase 1**: 40-60 小時
- **Phase 2**: 60-80 小時
- **Phase 3**: 20-30 小時
- **Phase 4**: 60-80 小時

**總計**: 180-250 小時（約 1-2 個月全職開發）

## 立即可開始的工作

1. 建立專案結構（monorepo: backend + frontend）
2. 設定 TypeScript + build system
3. 實作基本的 HTTP server
4. 整合 Claude API（簡單的對話，無工具）
5. 建立簡單的 React UI

---

**問題討論：**
1. 是否要完全相容 Claude Code 的所有功能？還是先做核心功能？
2. 安全性要求？（單使用者 vs 多使用者）
3. 部署方式？（本地 vs 遠端 server）
