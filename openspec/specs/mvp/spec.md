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

## Phase 3：Dispatch-like 多任務（✅ P0 完成 2026-04-25）

### 核心概念

Task dispatch 由 AI 自動決定 — 主 Claude CLI agent 在對話中透過 HTTP tool use 呼叫
`POST /api/tasks` 來 spawn 子任務。不提供手動派工 UI，以保持介面簡潔。

每個子任務運行在獨立的 git worktree，有自己的 CLI process，平行執行、互不干擾。

### 實際完成功能（P0）

#### 子任務建立與管理
- [x] `POST /api/tasks` — 建立任務 `{ repoPath?, prompt }`；超過 20 個回 429
- [x] `GET /api/tasks` — 列出所有任務及狀態
- [x] `DELETE /api/tasks/:id` — 取消執行中任務 + 刪除完成任務
- [x] `GET /api/tasks/:id/transcript` — 取得完整對話記錄
- [x] 並行上限：`MAX_CONCURRENT = 20`
- [x] 每個任務在目標 repo 下建立獨立 git worktree（`git worktree add`）
- [x] 完成後自動清理 worktree（`git worktree remove --force`）

#### WS 事件廣播
- [x] `task:created` — 任務建立時廣播給所有連線
- [x] `task:progress` — streaming 輸出（每次有新 chunk 即推送）
- [x] `task:done` — 任務完成
- [x] `task:error` — 任務失敗（含錯誤訊息）
- [x] `task:cancelled` — 任務被取消

#### 前端 UI
- [x] Sidebar 新增「📋 任務」tab，Running 任務數顯示 badge
- [x] TasksPanel：任務列表、狀態 icon（running spinner / done / error / cancelled）
- [x] 點擊任務展開完整對話記錄（含 streaming 即時顯示）
- [x] 取消（執行中）/ 刪除（已完成）按鈕
- [x] 任務完成 / 失敗時 toast 通知（右下角）

#### 資料持久化
- [x] SQLite `tasks` 表 + `task_messages` 表（`db.ts`）
- [x] Server 重啟後自動把殘留 `running` 狀態改為 `error`

#### 實際資料模型

```typescript
interface TaskInfo {
  id: string;
  repoPath: string;
  worktreeName: string | null;
  branchName: string | null;
  prompt: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  messages: TaskMessage[];
  streaming: string;
  createdAt: number;
  updatedAt: number;
}
```

### 設計決策（與原計劃不同之處）

| 原計劃 | 實際實作 | 原因 |
|---|---|---|
| `/task` slash command | 不實作，純 AI 派工 | 保持介面簡潔，dispatch 由 Claude 判斷 |
| SSE stream | WebSocket broadcast | 統一用現有 WS 連線，不增加新協議 |
| Sidebar 縮排子任務 | 獨立「任務」tab | 任務非 session 子項，tab 更清晰 |
| MAX 3-5 並行 | MAX 20 | 使用 worktree 隔離，不受 session lock 限制 |
| parentSessionId | 不追蹤 parent | 任務完全獨立，不需要關聯主 session |

---

## 技術約束

- CLI 使用 `--no-session-persistence`：繞過 Windows session lock，不寫磁碟 JSONL
- Session 歷史以文字前綴注入（非多輪 messages 格式），因為 CLI 只接受 `user` type input
- 圖片在前端 canvas 縮放後才送 server（省流量、避免 iOS 記憶體爆炸）
- sessionMeta 持久化到 `~/.claude/claudecode-remote.json`（與 settings 合併）
