# claudecode-remote

Web 介面讓使用者可以在任何裝置上存取 Claude Code CLI，支援即時對話、圖片上傳、session 管理、多工 agent 調度。

## 功能

### 核心對話
- 繁體中文優先；使用 Claude Code CLI（`--no-session-persistence`）
- 即時 WebSocket 串流（chunk-by-chunk 顯示），含思考過程（`<thinking>` block）
- Markdown 渲染（標題、程式碼、表格、清單）

### Session 管理
- 側邊欄列出所有 session；重命名（✏）、釘選（📌）
- Session 持久化到 SQLite（`~/.claude/claudecode-remote.db`）
- 斷線自動重連（1.5s）；iOS zombie WS 偵測（ping-pong）

### 圖片上傳
- 選圖後立刻上傳；AI 版本（2048px）+ 縮圖（160px）單次解碼
- bodyLimit 25MB，iOS 相容

### 輸入佇列 / 中斷
- Claude 回覆中輸入可排隊（Enter 排隊，⬛ 中斷）
- 完成後自動送出下一則

### Task Dispatch（Phase 3）
- 後端支援最多 20 個並行 Claude CLI agent，各運行於獨立 git worktree
- Agent 任務透過 AI 自動派工（Claude 在對話中呼叫 `POST /api/tasks`）
- 側邊欄「📋 任務」tab：即時進度串流、展開完整對話記錄

## 技術堆疊

- **後端**: Node.js 22 + TypeScript + Fastify + `@fastify/websocket` + SQLite
- **前端**: React + TypeScript + Vite + Tailwind CSS
- **CLI bridge**: `claude --print --output-format stream-json --input-format stream-json`

## 架構

```
claudecode-remote/
├── packages/
│   ├── server/src/
│   │   ├── index.ts          # Fastify 入口、REST API
│   │   ├── websocket.ts      # WebSocket handler
│   │   ├── claude.ts         # CLI process pool（chat sessions）
│   │   ├── task-manager.ts   # Task agent pool（up to 20, git worktrees）
│   │   ├── store.ts          # In-memory session store
│   │   ├── db.ts             # SQLite（sessions, messages, tasks）
│   │   └── config.ts         # Env config
│   └── web/src/
│       └── App.tsx           # Single-page React app
├── scripts/
│   ├── install.ps1 / install.sh     # One-click install (Windows / Mac)
│   ├── uninstall.ps1 / uninstall.sh # One-click uninstall
│   ├── start.sh / stop.sh           # Mac manual start/stop
├── watchdog.ps1              # Windows: restart if port dies
├── watchdog.vbs              # Windows: VBScript wrapper (silent Task Scheduler trigger)
├── start-hidden.ps1          # Windows: manual start
└── stop.ps1                  # Windows: manual stop
```

## 安裝

### Windows（一鍵）
```powershell
git clone https://github.com/chuangkevin/claudecode-remote
cd claudecode-remote
# 編輯 .env（複製 .env.example）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

**自動設定：**
- npm install + build
- Registry `HKCU\Run` → 每次登入自動啟動
- Task Scheduler watchdog → 每分鐘檢查，crash 後自動重啟
- 啟動 server + health check

**手動操作：**
```powershell
.\start-hidden.ps1   # 啟動
.\stop.ps1           # 停止
.\scripts\uninstall.ps1  # 移除全部
```

### Mac（一鍵）
```bash
git clone https://github.com/chuangkevin/claudecode-remote
cd claudecode-remote
# 編輯 .env
bash scripts/install.sh
```

**自動設定：**
- npm install + build
- `~/Library/LaunchAgents/com.claudecode-remote.plist` → 登入自動啟動 + crash 自動重啟（launchd `KeepAlive`）
- health check

**手動操作：**
```bash
bash scripts/start.sh    # 啟動
bash scripts/stop.sh     # 停止
bash scripts/uninstall.sh  # 移除全部
```

## 環境變數（`.env`）

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `9224` | Server port |
| `HOST` | `0.0.0.0` | Listen address |
| `WORKSPACE_ROOT` | `process.cwd()` | Claude CLI 工作目錄 |
| `CLAUDE_DATA_DIR` | `~/.claude` | Claude 資料目錄（存 DB、auth） |

## Task API

```
POST   /api/tasks                   # 建立 agent 任務
GET    /api/tasks                   # 列出所有任務
DELETE /api/tasks/:id               # 取消 + 清理
GET    /api/tasks/:id/transcript    # 取得完整對話
```

## 開發

```bash
npm install
npm run build
node --env-file=.env packages/server/dist/index.js   # 啟動
npx playwright test                                    # E2E 測試
```

## 部署

Domain 透過反向代理（nginx / Caddy）對應到 `localhost:9224`。需支援 WebSocket upgrade。

```nginx
location / {
    proxy_pass http://127.0.0.1:9224;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```
