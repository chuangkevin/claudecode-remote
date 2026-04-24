import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  imagePreviews?: string[]
}

interface ImageInput { base64: string; mediaType: string }
interface PendingImage { file: File; preview: string; input: ImageInput }

interface DiskSession {
  id: string
  preview: string
  updatedAt: number
}

const SESSION_KEY = 'claudecode-session-id'
const ACCEPTED = 'image/jpeg,image/png,image/gif,image/webp'

// ── Helpers ───────────────────────────────────────────────────────────────────

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '剛才'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then((d: { systemPrompt: string }) => setPrompt(d.systemPrompt ?? '')).catch(() => {})
  }, [])

  const save = async () => {
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: prompt }) })
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="bg-gray-800 border-b border-gray-700 px-6 py-4 flex-shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-300">System Prompt</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
      </div>
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
        placeholder="每次對話自動附加的指令，例如：請先讀 CLAUDE.md"
        className="w-full resize-none rounded-lg border border-gray-600 bg-gray-700 text-gray-100 placeholder-gray-500 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        rows={3} />
      <div className="flex items-center gap-2 mt-2">
        <button onClick={save} className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500">儲存</button>
        {saved && <span className="text-sm text-green-400">✓ 已儲存</span>}
        <span className="text-xs text-gray-500 ml-auto">下一則訊息起生效</span>
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

interface SidebarProps {
  sessions: DiskSession[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRefresh: () => void
}

function Sidebar({ sessions, activeId, onSelect, onNew, onRefresh }: SidebarProps) {
  return (
    <div className="w-64 flex-shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col h-full">
      <div className="px-3 pt-4 pb-2 flex items-center gap-2">
        <button onClick={onNew}
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium transition-colors">
          <span className="text-lg leading-none">+</span> 新對話
        </button>
        <button onClick={onRefresh} title="重新整理" className="p-2 text-gray-500 hover:text-gray-300 rounded-lg hover:bg-gray-800">
          ↻
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-600 text-xs">尚無對話記錄</div>
        )}
        {sessions.map(s => (
          <button key={s.id} onClick={() => onSelect(s.id)}
            className={`w-full text-left px-3 py-2.5 mx-1 rounded-lg transition-colors group ${
              s.id === activeId ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            style={{ width: 'calc(100% - 8px)' }}>
            <div className="text-sm truncate">{s.preview || '新對話'}</div>
            <div className="text-xs text-gray-600 mt-0.5">{relativeTime(s.updatedAt)}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentResponse, setCurrentResponse] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [sessions, setSessions] = useState<DiskSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const currentResponseRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  useEffect(() => { scrollToBottom() }, [messages, currentResponse])

  const fetchSessions = useCallback(async () => {
    try {
      const data = await fetch('/api/sessions').then(r => r.json()) as DiskSession[]
      setSessions(data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { void fetchSessions() }, [fetchSessions])

  const resumeSession = useCallback((ws: WebSocket, sessionId: string | null) => {
    ws.send(JSON.stringify({ type: 'resume', sessionId }))
  }, [])

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      resumeSession(ws, localStorage.getItem(SESSION_KEY))
    }
    ws.onclose = () => {
      setIsConnected(false)
      wsRef.current = null
      reconnectTimerRef.current = setTimeout(connect, 3000)
    }
    ws.onerror = () => {}
    ws.onmessage = (event) => {
      let data: Record<string, unknown>
      try { data = JSON.parse(event.data as string) as Record<string, unknown> } catch { return }

      switch (data.type) {
        case 'session': {
          const id = data.sessionId as string
          sessionIdRef.current = id
          setActiveSessionId(id)
          localStorage.setItem(SESSION_KEY, id)
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
          void fetchSessions() // refresh sidebar after response
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
  }, [resumeSession, fetchSessions])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  const switchSession = (id: string) => {
    if (!wsRef.current || !isConnected) return
    currentResponseRef.current = ''
    setCurrentResponse('')
    setIsProcessing(false)
    wsRef.current.send(JSON.stringify({ type: 'resume', sessionId: id }))
  }

  const newSession = () => {
    // Start fresh: clear stored session ID so server creates a new one
    localStorage.removeItem(SESSION_KEY)
    if (!wsRef.current || !isConnected) return
    currentResponseRef.current = ''
    setCurrentResponse('')
    setIsProcessing(false)
    wsRef.current.send(JSON.stringify({ type: 'resume', sessionId: null }))
  }

  const onImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const newImages: PendingImage[] = await Promise.all(
      files.map(async file => ({
        file,
        preview: URL.createObjectURL(file),
        input: { base64: await readAsBase64(file), mediaType: file.type },
      }))
    )
    setPendingImages(prev => [...prev, ...newImages])
    e.target.value = ''
  }

  const removeImage = (idx: number) => {
    setPendingImages(prev => {
      URL.revokeObjectURL(prev[idx].preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const sendMessage = () => {
    if (!input.trim() || !wsRef.current || !isConnected || isProcessing) return

    const imagePreviews = pendingImages.map(p => p.preview)
    setMessages(prev => [...prev, { role: 'user', content: input, timestamp: Date.now(), imagePreviews }])
    setIsProcessing(true)
    currentResponseRef.current = ''
    setCurrentResponse('')

    wsRef.current.send(JSON.stringify({
      type: 'chat',
      message: input,
      sessionId: sessionIdRef.current,
      ...(pendingImages.length > 0 ? { images: pendingImages.map(p => p.input) } : {}),
    }))

    setInput('')
    pendingImages.forEach(p => URL.revokeObjectURL(p.preview))
    setPendingImages([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100 overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        activeId={activeSessionId}
        onSelect={switchSession}
        onNew={newSession}
        onRefresh={fetchSessions}
      />

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-gray-800 border-b border-gray-700 px-5 py-3 flex items-center justify-between flex-shrink-0">
          <h1 className="text-base font-semibold text-gray-100">Claude Code Remote</h1>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowSettings(s => !s)} title="System Prompt"
              className={`text-lg transition-colors ${showSettings ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>⚙</button>
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-gray-400">{isConnected ? '已連線' : '重連中…'}</span>
            </div>
          </div>
        </div>

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
                  msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-800 border border-gray-700 text-gray-100'
                }`}>
                  {msg.imagePreviews && msg.imagePreviews.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {msg.imagePreviews.map((src, i) => (
                        <img key={i} src={src} alt="" className="h-20 w-20 object-cover rounded-lg" />
                      ))}
                    </div>
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

        {/* Pending images strip */}
        {pendingImages.length > 0 && (
          <div className="bg-gray-800 border-t border-gray-700 px-4 py-2 flex-shrink-0">
            <div className="flex items-center gap-2 flex-wrap">
              {pendingImages.map((p, i) => (
                <div key={i} className="relative">
                  <img src={p.preview} alt="" className="h-14 w-14 object-cover rounded-lg" />
                  <button onClick={() => removeImage(i)}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-gray-600 hover:bg-red-600 rounded-full text-white text-xs flex items-center justify-center leading-none">
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="bg-gray-800 border-t border-gray-700 px-4 py-3 flex-shrink-0">
          <div className="flex items-end gap-2">
            <button onClick={() => fileInputRef.current?.click()} disabled={!isConnected || isProcessing}
              title="附加圖片（可多選）"
              className="flex-shrink-0 p-2 text-gray-400 hover:text-gray-200 disabled:text-gray-700 rounded-lg hover:bg-gray-700 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </button>
            <input ref={fileInputRef} type="file" accept={ACCEPTED} multiple className="hidden" onChange={onImagePick} />

            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="輸入訊息… (Enter 傳送，Shift+Enter 換行)"
              className="flex-1 resize-none rounded-xl border border-gray-600 bg-gray-700 text-gray-100 placeholder-gray-500 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
              rows={2} disabled={!isConnected || isProcessing} />

            <button onClick={sendMessage} disabled={!isConnected || isProcessing || !input.trim()}
              className="flex-shrink-0 px-4 py-2.5 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors">
              傳送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
