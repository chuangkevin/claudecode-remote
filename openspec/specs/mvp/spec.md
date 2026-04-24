# claudecode-remote — 功能規格

## 目標

建立一個 Web 版 Claude Code 遠端介面，讓使用者在手機、平板、或任何瀏覽器上都能使用 Claude Code CLI 的完整能力，同時支援多任務並行執行（Dispatch-like）。

---

## Phase 1：基礎對話（✅ 完成）

### 後端
- [x] Fastify HTTP server + `@fastify/websocket`（port 9224）
- [x] Claude Code CLI 封裝（`--print --output-format stream-json --no-session-persistence`）
- [x] 對話歷史以文字前綴注入（繞過 Windows session lock bug）
- [x] WebSocket 協議：`ping/pong`、`resume`、`chat`、`chunk`、`done`、`error`
- [x] 記憶體 session store（`store.ts`）
- [x] 磁碟 JSONL 讀取（`session.ts`，供 resume 使用）
- [x] System prompt 設定（`/api/settings` GET/POST）

### 前端
- [x] React SPA（Vite + Tailwind CSS）
- [x] 深色主題對話 UI
- [x] 即時串流顯示（chunk-by-chunk）
- [x] WebSocket 自動重連（1.5s）+ iOS zombie WS 偵測
- [x] Session 側邊欄 + 切換

---

## Phase 2：圖片 + Session 管理（✅ 完成）

### 圖片上傳
- [x] 選圖後立刻 POST `/api/upload-image`（upload-on-select）
- [x] 單次解碼產生 AI 版（max 2048px JPEG）+ 縮圖（160px）
- [x] 上傳中顯示 spinner；成功顯示綠勾；失敗顯示紅色 `!`（不自動消失）
- [x] bodyLimit 25MB，防止手機大圖被截斷
- [x] 圖片縮圖持久化到 `StoredMessage.images`，resume 時帶回

### Session 管理
- [x] 側邊欄只列 claudecode-remote 建立的 session（不混入其他工具的 JSONL）
- [x] 透過 `sessionMeta.source = 'claudecode-remote'` 標記，server 重啟後仍可列出
- [x] Session **重命名**：✏ 按鈕 → inline 輸入，Enter/Esc 操作
- [x] Session **釘選**：📌 按鈕切換；釘選 session 排最上方
- [x] 名稱、釘選狀態持久化到 `~/.claude/claudecode-remote.json`（`settings.ts`）

### 測試
- [x] Playwright E2E：12 個情境（頁面載入 / 對話 / 工具呼叫 / 圖片 / session 切換 / 行動版 / 斷線重連 / 壓力測試）
- [x] WebSocket 整合測試：9 個情境

---

## Phase 3：Dispatch-like 多任務（🔲 規劃中）

### 核心概念

從主對話 spawn 子任務，每個子任務是一個獨立的 Claude Code CLI session，平行執行、互不干擾，完成後回報到主介面。

類比：Claude Code 的 `Task` 工具，但在 Web 介面中可見化每個子任務的進度。

### 功能規格

#### 子任務建立
- 使用者在主對話中輸入如：`/task 幫我重構 packages/server/src/claude.ts`
- 或 Claude 自己決定 spawn 子任務（tool call 方式）
- Server 建立新的 CLI process（新的 session ID）
- 子任務在 sidebar 顯示為縮進的子項目，帶有「執行中」spinner

#### 子任務管理
- `GET /api/tasks`：列出所有子任務及其狀態（pending / running / done / error）
- `POST /api/tasks`：建立新子任務（`{ parentSessionId, prompt, workDir? }`）
- `GET /api/tasks/:id/stream`：SSE 串流子任務輸出
- `DELETE /api/tasks/:id`：取消/終止子任務

#### 前端 UI
- 側邊欄：主 session 下方縮排顯示子任務列表，帶狀態 icon
- 點擊子任務：展開右側面板顯示該子任務的對話內容
- 子任務完成時：在主對話插入摘要訊息（可設定是否自動插入）
- 多個子任務可同時顯示（split-view 或 tab 方式）

#### 進度追蹤
- 子任務 status：`pending` / `running` / `done` / `error`
- 每個子任務顯示：開始時間、執行時長、最後一條訊息
- 主對話可以「等待所有子任務完成」再繼續

#### 資料模型

```typescript
interface Task {
  id: string;
  parentSessionId: string;
  prompt: string;           // 任務描述
  workDir?: string;         // 工作目錄（可與主 session 不同）
  status: 'pending' | 'running' | 'done' | 'error';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId: string;        // 對應的 CLI session ID
  messages: StoredMessage[];
  result?: string;          // 完成後的摘要
}
```

#### 技術實作要點
- 每個子任務 = 一個獨立的 `runClaude()` 呼叫，有自己的 session ID
- 子任務 CLI process 可平行執行（不受 session lock 影響，因為各自獨立 UUID）
- 子任務輸出透過 WS broadcast 到所有訂閱者
- 取消：`child.kill()` + 狀態更新
- 並行限制：可設定 MAX_PARALLEL_TASKS（建議 3-5）

### 實作順序

1. **後端 task store**（`task-store.ts`）：類似 `store.ts`，管理 Task 狀態
2. **REST API**：`/api/tasks` CRUD
3. **執行引擎**：`runTask()` 呼叫 `runClaude()`，結果寫回 task store
4. **WS 事件**：新增 `task-chunk`、`task-done`、`task-error` 事件類型
5. **前端 sidebar**：子任務列表 UI
6. **前端 task panel**：子任務對話內容展示
7. **整合測試**：多任務並行 + 取消 + 超時

---

## 技術約束

- CLI 使用 `--no-session-persistence`：繞過 Windows session lock，不寫磁碟 JSONL
- Session 歷史以文字前綴注入（非多輪 messages 格式），因為 CLI 只接受 `user` type input
- 圖片在前端 canvas 縮放後才送 server（省流量、避免 iOS 記憶體爆炸）
- sessionMeta 持久化到 `~/.claude/claudecode-remote.json`（與 settings 合併）
