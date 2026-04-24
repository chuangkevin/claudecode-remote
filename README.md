# claudecode-remote

Web 介面讓使用者可以在多裝置上存取並繼續 Claude Code 對話。

## 功能

- 多裝置共享 Claude Code CLI session
- 完整對話功能與工具呼叫支援
- Session 管理（載入/儲存 .jsonl 格式）
- 即時 WebSocket 通訊
- 支援所有主要工具：Bash, Read, Write, Edit, Grep, Glob

## 技術堆疊

- **後端**: Node.js + TypeScript + Fastify + WebSocket
- **前端**: React + TypeScript + Vite + Tailwind CSS
- **API**: Claude API (Anthropic)

## 安裝

```bash
# 安裝依賴
npm install

# 設定環境變數
cp .env.example .env
# 編輯 .env 填入您的 API key
```

## 開發

```bash
# 啟動開發伺服器（前後端同時啟動）
npm run dev

# 分別啟動
npm run dev:server  # 後端 (port 9224)
npm run dev:web     # 前端 (port 5173)
```

## 建置

```bash
# 建置所有套件
npm run build

# 啟動生產環境
npm start
```

## 環境變數

- `PORT`: 伺服器埠號（預設：9224）
- `HOST`: 伺服器位址（預設：0.0.0.0）
- `ANTHROPIC_API_KEY`: Claude API 金鑰（必填）
- `CLAUDE_DATA_DIR`: Claude CLI 資料目錄（預設：~/.claude）
- `WORKSPACE_ROOT`: 工作區根目錄（預設：目前目錄）

## 架構

```
claudecode-remote/
├── packages/
│   ├── server/          # Fastify 後端
│   │   ├── src/
│   │   │   ├── index.ts      # 伺服器入口
│   │   │   ├── config.ts     # 設定管理
│   │   │   ├── claude.ts     # Claude API 整合
│   │   │   ├── websocket.ts  # WebSocket 處理
│   │   │   ├── session.ts    # Session 管理
│   │   │   └── tools/        # 工具實作
│   │   └── package.json
│   └── web/             # React 前端
│       ├── src/
│       │   ├── App.tsx       # 主要元件
│       │   ├── main.tsx      # 入口點
│       │   └── index.css     # 樣式
│       └── package.json
└── openspec/
    └── config.yaml      # 專案規格
```

## License

MIT
