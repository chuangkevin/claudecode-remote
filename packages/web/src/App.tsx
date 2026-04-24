import { useState, useEffect, useRef, useCallback } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const SESSION_KEY = 'claudecode-session-id'

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentResponse, setCurrentResponse] = useState('')

  // Track live streaming content in a ref so the onmessage closure
  // (registered once with []) can read the current value without stale capture.
  const currentResponseRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => { scrollToBottom() }, [messages, currentResponse])

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      // Resume the stored session (or start fresh if none)
      const storedId = localStorage.getItem(SESSION_KEY)
      ws.send(JSON.stringify({ type: 'resume', sessionId: storedId }))
    }

    ws.onclose = () => {
      setIsConnected(false)
      wsRef.current = null
      // Auto-reconnect after 3 s
      reconnectTimerRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => { /* onclose fires after onerror — handled there */ }

    ws.onmessage = (event) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(event.data as string) as Record<string, unknown>
      } catch {
        return
      }

      switch (data.type) {
        // ── Server assigned / confirmed session ───────────────────────────
        case 'session': {
          const id = data.sessionId as string
          sessionIdRef.current = id
          localStorage.setItem(SESSION_KEY, id)

          const history = (data.messages ?? []) as Message[]
          setMessages(history)

          const live = (data.streaming ?? '') as string
          currentResponseRef.current = live
          setCurrentResponse(live)

          const running = data.status === 'running'
          setIsProcessing(running)
          break
        }

        // ── Live streaming chunk ──────────────────────────────────────────
        case 'chunk': {
          const text = (data.text ?? '') as string
          if (!text) break
          currentResponseRef.current += text
          setCurrentResponse(currentResponseRef.current)
          setIsProcessing(true)
          break
        }

        // ── Claude finished ───────────────────────────────────────────────
        case 'done': {
          const content = currentResponseRef.current
          if (content) {
            setMessages(prev => [...prev, {
              role: 'assistant',
              content,
              timestamp: Date.now(),
            }])
          }
          currentResponseRef.current = ''
          setCurrentResponse('')
          setIsProcessing(false)
          break
        }

        // ── Error ─────────────────────────────────────────────────────────
        case 'error': {
          const msg = (data.message ?? String(data.error ?? 'Unknown error')) as string
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `Error: ${msg}`,
            timestamp: Date.now(),
          }])
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

  const sendMessage = () => {
    if (!input.trim() || !wsRef.current || !isConnected || isProcessing) return

    const userMsg: Message = { role: 'user', content: input, timestamp: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setIsProcessing(true)
    currentResponseRef.current = ''
    setCurrentResponse('')

    wsRef.current.send(JSON.stringify({
      type: 'chat',
      message: input,
      sessionId: sessionIdRef.current,
    }))

    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Claude Code Remote</h1>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-sm text-gray-500">
              {isConnected ? '已連線' : '重新連線中…'}
            </span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && !currentResponse && (
            <div className="text-center text-gray-400 mt-16 text-sm">
              傳送訊息開始對話
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-4 py-2 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-900'
              }`}>
                <div className="whitespace-pre-wrap break-words text-sm">{msg.content}</div>
                <div className={`text-xs mt-1 ${msg.role === 'user' ? 'text-blue-200' : 'text-gray-400'}`}>
                  {new Date(msg.timestamp).toLocaleTimeString('zh-TW')}
                </div>
              </div>
            </div>
          ))}

          {/* Live streaming response */}
          {currentResponse && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-4 py-2 bg-white border border-gray-200 text-gray-900">
                <div className="whitespace-pre-wrap break-words text-sm">{currentResponse}</div>
              </div>
            </div>
          )}

          {/* Typing indicator — shown only before first chunk arrives */}
          {isProcessing && !currentResponse && (
            <div className="flex justify-start">
              <div className="rounded-lg px-4 py-3 bg-white border border-gray-200">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.15s]" />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.3s]" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="bg-white border-t border-gray-200 px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="輸入訊息… (Enter 傳送，Shift+Enter 換行)"
            className="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50"
            rows={2}
            disabled={!isConnected || isProcessing}
          />
          <button
            onClick={sendMessage}
            disabled={!isConnected || isProcessing || !input.trim()}
            className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors self-end"
          >
            傳送
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
