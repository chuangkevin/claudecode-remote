# claudecode-remote

Web 介面讓使用者可以在任何裝置上存取 Claude Code CLI，支援即時對話、圖片上傳與 session 管理。

## 目前功能

### 核心對話
- 繁體中文優先回覆；使用 Claude Code CLI（`--no-session-persistence`）避免 Windows session lock
- 對話歷史以文字前綴方式注入，跨 turn 保持完整上下文
- 即時 WebSocket 串流（chunk-by-chunk 顯示）

### 圖片上傳
- 選圖後立刻 POST 上傳（`/api/upload-image`）；顯示上傳進度 → 綠勾
- 單次解碼：同時產生 AI 用版本（最大 2048px JPEG）與縮圖（160px），減少 iOS 記憶體壓力
- 上傳失敗顯示紅色 `!` 標記（不自動移除），bodyLimit 25MB 避免手機大圖被截斷
- 圖片縮圖存入 `StoredMessage.images`，session resume 時帶回，切換/重整不遺失

### Session 管理
- 側邊欄列出所有 claudecode-remote 建立的 session（不混入 Dispatch/其他工具的 JSONL）
- **重命名**：每個 session 旁 ✏ 按鈕 → inline 輸入框，Enter 確認，Esc 取消
- **釘選**：📌 按鈕切換，釘選 session 排在最上面，帶藍色圖示
- 名稱 / 釘選狀態持久化到 `~/.claude/claudecode-remote.json`
- Session 在 server 重啟後仍列於側邊欄（透過 `sessionMeta` 的 `source: 'claudecode-remote'` marker）

### UI / UX
- 深色主題（Tailwind CSS）；響應式設計，375px 手機可用
- 側邊欄手機版：滑出式覆蓋；背景遮罩點擊關閉
- 斷線自動重連（1.5s 延遲）；iOS zombie WS 偵測（ping-pong）
- System Prompt 設定面板（跨 session 生效）

### 測試
- `tests/e2e.spec.ts`：12 個 Playwright E2E 情境（頁面載入、對話、工具呼叫、圖片、session 切換、行動版、斷線重連、壓力測試）
- `test-ws.mjs`：9 個 WebSocket 整合測試

## 技術堆疊

- **後端**: Node.js + TypeScript + Fastify + `@fastify/websocket`
- **前端**: React + TypeScript + Vite + Tailwind CSS
- **CLI**: Claude Code CLI（`claude --print --output-format stream-json`）

## 架構

```
claudecode-remote/
├── packages/
│   ├── server/src/
│   │   ├── index.ts        # Fastify 入口、REST API
│   │   ├── websocket.ts    # WebSocket handler（chat / resume / ping）
│   │   ├── claude.ts       # CLI 封裝、history injection、processImage
│   │   ├── store.ts        # 記憶體 session store
│   │   ├── session.ts      # 磁碟 JSONL 讀取（resume 用）
│   │   ├── settings.ts     # 持久化設定 + sessionMeta（名稱/釘選/source）
│   │   ├── image-store.ts  # 上傳圖片暫存（ID → base64 + thumbnail）
│   │   └── config.ts       # 環境變數
│   └── web/src/
│       └── App.tsx         # 單檔 React SPA（Sidebar + Chat + Settings）
├── tests/e2e.spec.ts       # Playwright 12-scenario E2E
├── test-ws.mjs             # WebSocket 整合測試
└── openspec/specs/mvp/spec.md  # 功能規格與 Roadmap
```

## 啟動

```bash
npm install
npm run build
node packages/server/dist/index.js
# 開啟 http://localhost:9224
```

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | 9224 | 伺服器埠號 |
| `HOST` | 0.0.0.0 | 監聽位址 |
| `WORKSPACE_ROOT` | `process.cwd()` | Claude CLI 工作目錄 |
| `CLAUDE_DATA_DIR` | `~/.claude` | Claude 資料目錄 |

## License

MIT
