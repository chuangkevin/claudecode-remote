import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  imagePreviews?: string[]
}

interface PendingImage {
  localId: string    // client-side key for state updates
  preview: string    // object URL for display while uploading
  thumbnail: string  // small data URL shown after upload completes
  id?: string        // server-assigned ID after upload
  uploading: boolean
  error?: boolean    // true if upload failed
}

interface DiskSession {
  id: string
  preview: string
  updatedAt: number
  name?: string
  pinned?: boolean
}

const SESSION_KEY = 'claudecode-session-id'
const ACCEPTED = 'image/jpeg,image/png,image/gif,image/webp'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Single-pass image processor: loads the image once, derives both the AI copy
// (max 2048px JPEG) and the display thumbnail (max 160px JPEG).
// Loading twice (readAsBase64 + createThumbnail separately) doubles memory
// pressure and causes silent failures on iOS with large photos.
function processImageFile(
  file: File,
  aiMaxPx = 2048,
  thumbMaxPx = 160,
): Promise<{ aiBase64: string; thumbnail: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)

      function scaleCanvas(maxPx: number): HTMLCanvasElement {
        const scale = Math.min(maxPx / img.width, maxPx / img.height, 1)
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        c.getContext('2d')?.drawImage(img, 0, 0, w, h)
        return c
      }

      const aiCanvas = scaleCanvas(aiMaxPx)
      const aiBase64 = aiCanvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? ''
      const thumbnail = scaleCanvas(thumbMaxPx).toDataURL('image/jpeg', 0.8)
      resolve({ aiBase64, thumbnail })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
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
  onRename: (id: string, name: string) => Promise<void>
  onPin: (id: string, pinned: boolean) => Promise<void>
}

function Sidebar({ sessions, activeId, onSelect, onNew, onRefresh, onRename, onPin }: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const confirmingRef = useRef(false)

  useEffect(() => {
    if (editingId) editRef.current?.focus()
  }, [editingId])

  const startEdit = (s: DiskSession, e: React.MouseEvent) => {
    e.stopPropagation()
    confirmingRef.current = false
    setEditingId(s.id)
    setEditName(s.name ?? s.preview ?? '')
  }

  const commitEdit = async (id: string) => {
    confirmingRef.current = true
    await onRename(id, editName)
    setEditingId(null)
    confirmingRef.current = false
  }

  const cancelEdit = () => {
    if (!confirmingRef.current) setEditingId(null)
  }

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
          <div key={s.id} className="relative mx-1 mb-0.5" style={{ width: 'calc(100% - 8px)' }}>
            {editingId === s.id ? (
              /* ── Inline rename mode ── */
              <div className="px-3 py-2 rounded-lg bg-gray-700">
                <input
                  ref={editRef}
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitEdit(s.id) }
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  onBlur={cancelEdit}
                  className="w-full bg-gray-600 text-gray-100 text-sm px-2 py-1 rounded border border-blue-500 outline-none"
                  placeholder="輸入名稱…"
                />
                <div className="flex gap-2 mt-1.5">
                  <button
                    onMouseDown={e => { e.preventDefault(); void commitEdit(s.id) }}
                    className="text-xs text-green-400 hover:text-green-300">
                    ✓ 確認
                  </button>
                  <button
                    onMouseDown={e => { e.preventDefault(); cancelEdit() }}
                    className="text-xs text-gray-500 hover:text-gray-300">
                    ✗ 取消
                  </button>
                </div>
              </div>
            ) : (
              /* ── Normal row ── */
              <div className={`flex items-center rounded-lg transition-colors ${
                s.id === activeId ? 'bg-gray-700' : 'hover:bg-gray-800'
              }`}>
                {/* Main click area */}
                <button
                  onClick={() => onSelect(s.id)}
                  className={`flex-1 min-w-0 text-left px-3 py-2.5 ${
                    s.id === activeId ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'
                  }`}>
                  <div className="flex items-center gap-1 min-w-0">
                    {s.pinned && (
                      <span className="text-blue-400 flex-shrink-0 text-xs">📌</span>
                    )}
                    <span className="text-sm truncate">{s.name || s.preview || '新對話'}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">{relativeTime(s.updatedAt)}</div>
                </button>

                {/* Action buttons — always visible, subtle */}
                <div className="flex items-center gap-0.5 pr-2 flex-shrink-0">
                  <button
                    onClick={e => startEdit(s, e)}
                    title="重命名"
                    className="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                    </svg>
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); void onPin(s.id, !s.pinned) }}
                    title={s.pinned ? '取消釘選' : '釘選'}
                    className={`p-1 rounded transition-colors ${
                      s.pinned ? 'text-blue-400 hover:text-blue-300' : 'text-gray-600 hover:text-gray-300'
                    }`}>
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill={s.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M17 3a2 2 0 012 2v1a2 2 0 01-1.268 1.857L16 9.5V16l1 1v1H7v-1l1-1V9.5l-1.732-1.643A2 2 0 015 6V5a2 2 0 012-2h10zM12 16v5"/>
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
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
  const [sidebarOpen, setSidebarOpen] = useState(false)

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

  const renameSession = async (id: string, name: string) => {
    await fetch(`/api/sessions/${id}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    void fetchSessions()
  }

  const pinSession = async (id: string, pinned: boolean) => {
    await fetch(`/api/sessions/${id}/pin`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    })
    void fetchSessions()
  }

  const resumeSession = useCallback((ws: WebSocket, sessionId: string | null) => {
    ws.send(JSON.stringify({ type: 'resume', sessionId }))
  }, [])

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    wsRef.current = ws

    // Expose WS for E2E testing (force-close to simulate disconnect)
    ;(window as unknown as Record<string, unknown>).__testWs = ws

    ws.onopen = () => {
      setIsConnected(true)
      void fetchSessions()
      resumeSession(ws, localStorage.getItem(SESSION_KEY))
    }
    ws.onclose = () => {
      setIsConnected(false)
      wsRef.current = null
      reconnectTimerRef.current = setTimeout(connect, 1500)
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
          // Map server's StoredMessage.images → client's Message.imagePreviews
          type ServerMsg = { role: string; content: string; timestamp: number; images?: string[] }
          const mapped: Message[] = ((data.messages ?? []) as ServerMsg[]).map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.timestamp,
            ...(m.images && m.images.length > 0 ? { imagePreviews: m.images } : {}),
          }))
          setMessages(mapped)
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

  // On mobile, iOS may keep the WS in a zombie state (readyState=1 but dead)
  // so onclose never fires and the reconnect timer never starts.
  // visibilitychange fires reliably when the user returns to the tab.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const ws = wsRef.current
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connect()
      } else if (ws.readyState === WebSocket.OPEN) {
        // Probe the connection — if it's a zombie the pong will never arrive
        // and onclose will fire within a few seconds.
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [connect])

  const switchSession = (id: string) => {
    if (!wsRef.current || !isConnected) return
    currentResponseRef.current = ''
    setCurrentResponse('')
    setMessages([]) // clear immediately so empty state shows while server loads
    setIsProcessing(false)
    wsRef.current.send(JSON.stringify({ type: 'resume', sessionId: id }))
    setSidebarOpen(false)
  }

  const newSession = () => {
    localStorage.removeItem(SESSION_KEY)
    if (!wsRef.current || !isConnected) return
    currentResponseRef.current = ''
    setCurrentResponse('')
    setMessages([]) // clear immediately so empty state shows while server loads
    setIsProcessing(false)
    wsRef.current.send(JSON.stringify({ type: 'resume', sessionId: null }))
    setSidebarOpen(false)
  }

  const onImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return

    // Add placeholders immediately so user sees preview while uploading
    const placeholders = files.map(file => ({
      localId: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
    }))
    setPendingImages(prev => [...prev, ...placeholders.map(p => ({
      localId: p.localId,
      preview: p.preview,
      thumbnail: '',
      uploading: true,
    }))])

    // Upload each image to server in parallel
    placeholders.forEach(({ localId, file }) => {
      processImageFile(file)
        .then(({ aiBase64, thumbnail }) =>
          fetch('/api/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: aiBase64, mediaType: 'image/jpeg', thumbnail }),
          }).then(async r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const { id } = await r.json() as { id: string }
            setPendingImages(prev => prev.map(p =>
              p.localId === localId ? { ...p, thumbnail, id, uploading: false } : p
            ))
          })
        )
        .catch(() => {
          // Mark as failed — keep visible so user knows it didn't upload
          setPendingImages(prev => prev.map(p =>
            p.localId === localId ? { ...p, uploading: false, error: true } : p
          ))
        })
    })
  }

  const removeImage = (idx: number) => {
    setPendingImages(prev => {
      URL.revokeObjectURL(prev[idx].preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const sendMessage = () => {
    if (!input.trim() || !wsRef.current || !isConnected || isProcessing) return
    if (pendingImages.some(p => p.uploading)) return // wait for all uploads

    const readyImages = pendingImages.filter(p => p.id && !p.error)
    const imagePreviews = readyImages.map(p => p.thumbnail)
    setMessages(prev => [...prev, { role: 'user', content: input, timestamp: Date.now(), imagePreviews }])
    setIsProcessing(true)
    currentResponseRef.current = ''
    setCurrentResponse('')

    wsRef.current.send(JSON.stringify({
      type: 'chat',
      message: input,
      sessionId: sessionIdRef.current,
      ...(readyImages.length > 0 ? { imageIds: readyImages.map(p => p.id) } : {}),
    }))

    setInput('')
    pendingImages.forEach(p => URL.revokeObjectURL(p.preview))
    setPendingImages([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return (
    <div className="flex bg-gray-900 text-gray-100 overflow-hidden" style={{ height: '100dvh' }}>
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar — overlay on mobile, fixed on desktop */}
      <div className={`
        fixed inset-y-0 left-0 z-30 md:static md:z-auto md:flex md:flex-shrink-0
        transition-transform duration-200
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <Sidebar
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={switchSession}
          onNew={newSession}
          onRefresh={fetchSessions}
          onRename={renameSession}
          onPin={pinSession}
        />
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => setSidebarOpen(s => !s)}
              className="md:hidden p-1.5 text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-700">
              ☰
            </button>
            <h1 className="text-base font-semibold text-gray-100">Claude Code Remote</h1>
          </div>
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
                <div key={p.localId} className="relative">
                  <img src={p.preview} alt="" className="h-14 w-14 object-cover rounded-lg" />
                  {/* Upload status overlay */}
                  {p.uploading && (
                    <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {!p.uploading && p.error && (
                    <div className="absolute inset-0 bg-red-900/70 rounded-lg flex items-center justify-center" title="上傳失敗，請移除後重試">
                      <span className="text-white text-lg font-bold">!</span>
                    </div>
                  )}
                  {!p.uploading && !p.error && p.id && (
                    <div className="absolute bottom-0.5 right-0.5 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
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

            <button onClick={sendMessage} disabled={!isConnected || isProcessing || !input.trim() || pendingImages.some(p => p.uploading)}
              className="flex-shrink-0 px-4 py-2.5 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors">
              傳送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
