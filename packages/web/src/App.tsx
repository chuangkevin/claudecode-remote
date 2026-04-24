import { useState, useEffect, useRef, useCallback } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  imageUrl?: string // preview only, not stored on server
}

interface ImageInput {
  base64: string
  mediaType: string
}

const SESSION_KEY = 'claudecode-session-id'
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: { systemPrompt: string }) => setSystemPrompt(d.systemPrompt ?? ''))
      .catch(() => {})
  }, [])

  const save = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt }),
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="bg-gray-800 border-b border-gray-700 px-6 py-4 flex-shrink-0">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-300">System Prompt</span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <textarea
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          placeholder="每次對話開始時自動附加的指令，例如：請先讀 CLAUDE.md 再開始工作"
          className="w-full resize-none rounded-lg border border-gray-600 bg-gray-700 text-gray-100 placeholder-gray-500 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          rows={3}
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={save}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 transition-colors"
          >
            儲存
          </button>
          {saved && <span className="text-sm text-green-400">✓ 已儲存</span>}
          <span className="text-xs text-gray-500 ml-auto">下一則訊息起生效</span>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data:image/...;base64, prefix
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ── Main App ──────────────────────────────────────────────────────────────────

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentResponse, setCurrentResponse] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [pendingImage, setPendingImage] = useState<{ file: File; preview: string; input: ImageInput } | null>(null)

  const currentResponseRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  useEffect(() => { scrollToBottom() }, [messages, currentResponse])

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      ws.send(JSON.stringify({ type: 'resume', sessionId: localStorage.getItem(SESSION_KEY) }))
    }
    ws.onclose = () => {
      setIsConnected(false)
      wsRef.current = null
      reconnectTimerRef.current = setTimeout(connect, 3000)
    }
    ws.onerror = () => {}
    ws.onmessage = (event) => {
      let data: Record<string, unknown>
      try { data = JSON.parse(event.data as string) as Record<string, unknown> }
      catch { return }

      switch (data.type) {
        case 'session': {
          sessionIdRef.current = data.sessionId as string
          localStorage.setItem(SESSION_KEY, data.sessionId as string)
          setMessages((data.messages ?? []) as Message[])
          const live = (data.streaming ?? '') as string
          currentResponseRef.current = live
          setCurrentResponse(live)
          setIsProcessing(data.status === 'running')
          break
        }
        case 'chunk': {
          const text = (data.text ?? '') as string
          if (!text) break
          currentResponseRef.current += text
          setCurrentResponse(currentResponseRef.current)
          setIsProcessing(true)
          break
        }
        case 'done': {
          const content = currentResponseRef.current
          if (content) setMessages(prev => [...prev, { role: 'assistant', content, timestamp: Date.now() }])
          currentResponseRef.current = ''
          setCurrentResponse('')
          setIsProcessing(false)
          break
        }
        case 'error': {
          const msg = (data.message ?? String(data.error ?? 'Unknown error')) as string
          setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${msg}`, timestamp: Date.now() }])
          currentResponseRef.current = ''
          setCurrentResponse('')
          setIsProcessing(false)
          break
        }
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  const onImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      alert('僅支援 JPEG、PNG、GIF、WebP 圖片')
      return
    }
    const base64 = await readFileAsBase64(file)
    const preview = URL.createObjectURL(file)
    setPendingImage({ file, preview, input: { base64, mediaType: file.type } })
    e.target.value = ''
  }

  const clearImage = () => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.preview)
    setPendingImage(null)
  }

  const sendMessage = () => {
    if (!input.trim() || !wsRef.current || !isConnected || isProcessing) return

    const userMsg: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
      imageUrl: pendingImage?.preview,
    }
    setMessages(prev => [...prev, userMsg])
    setIsProcessing(true)
    currentResponseRef.current = ''
    setCurrentResponse('')

    wsRef.current.send(JSON.stringify({
      type: 'chat',
      message: input,
      sessionId: sessionIdRef.current,
      ...(pendingImage ? { image: pendingImage.input } : {}),
    }))

    setInput('')
    if (pendingImage) {
      URL.revokeObjectURL(pendingImage.preview)
      setPendingImage(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-6 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-100">Claude Code Remote</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSettings(s => !s)}
              title="System Prompt 設定"
              className={`text-lg transition-colors ${showSettings ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            >⚙</button>
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-gray-400">{isConnected ? '已連線' : '重連中…'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && !currentResponse && (
            <div className="text-center text-gray-600 mt-16 text-sm">傳送訊息開始對話</div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-xl px-4 py-2.5 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 border border-gray-700 text-gray-100'
              }`}>
                {msg.imageUrl && (
                  <img src={msg.imageUrl} alt="" className="max-w-xs rounded-lg mb-2 max-h-48 object-contain" />
                )}
                <div className="whitespace-pre-wrap break-words text-sm">{msg.content}</div>
                <div className={`text-xs mt-1 ${msg.role === 'user' ? 'text-blue-200' : 'text-gray-500'}`}>
                  {new Date(msg.timestamp).toLocaleTimeString('zh-TW')}
                </div>
              </div>
            </div>
          ))}

          {currentResponse && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-xl px-4 py-2.5 bg-gray-800 border border-gray-700 text-gray-100">
                <div className="whitespace-pre-wrap break-words text-sm">{currentResponse}</div>
              </div>
            </div>
          )}

          {isProcessing && !currentResponse && (
            <div className="flex justify-start">
              <div className="rounded-xl px-4 py-3 bg-gray-800 border border-gray-700">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0.15s]" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0.3s]" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Pending image preview */}
      {pendingImage && (
        <div className="bg-gray-800 border-t border-gray-700 px-4 py-2 flex-shrink-0">
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <img src={pendingImage.preview} alt="" className="h-12 w-12 object-cover rounded-lg" />
            <span className="text-xs text-gray-400 flex-1 truncate">{pendingImage.file.name}</span>
            <button onClick={clearImage} className="text-gray-500 hover:text-gray-300 text-sm">✕</button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="bg-gray-800 border-t border-gray-700 px-4 py-3 flex-shrink-0">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          {/* Image upload */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected || isProcessing}
            title="附加圖片"
            className="flex-shrink-0 p-2 text-gray-400 hover:text-gray-200 disabled:text-gray-700 transition-colors rounded-lg hover:bg-gray-700"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={onImagePick}
          />

          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="輸入訊息… (Enter 傳送，Shift+Enter 換行)"
            className="flex-1 resize-none rounded-xl border border-gray-600 bg-gray-700 text-gray-100 placeholder-gray-500 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            rows={2}
            disabled={!isConnected || isProcessing}
          />
          <button
            onClick={sendMessage}
            disabled={!isConnected || isProcessing || !input.trim()}
            className="flex-shrink-0 px-4 py-2.5 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
          >
            傳送
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
