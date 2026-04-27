import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  imagePreviews?: string[]
  thinking?: string
}

interface PendingImage {
  localId: string
  preview: string
  thumbnail: string
  id?: string
  uploading: boolean
  error?: boolean
}

interface DiskSession {
  id: string
  preview: string
  updatedAt: number
  name?: string
  pinned?: boolean
}

interface TaskMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface TaskInfo {
  id: string
  repoPath: string
  repoLabel?: string
  worktreeName: string | null
  branchName: string | null
  prompt: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  messages: TaskMessage[]
  streaming: string
  createdAt: number
  updatedAt: number
}

interface Toast {
  id: string
  message: string
  kind: 'success' | 'error'
}

const SESSION_KEY = 'claudecode-session-id'
const ACCEPTED = 'image/jpeg,image/png,image/gif,image/webp'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      const aiBase64 = scaleCanvas(aiMaxPx).toDataURL('image/jpeg', 0.9).split(',')[1] ?? ''
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

function repoBasename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1 text-gray-100">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold mt-3 mb-1 text-gray-100">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 text-gray-200">{children}</h3>,
        p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed break-all">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-outside pl-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-outside pl-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        pre: ({ children }) => <pre className="bg-gray-900 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono text-green-300">{children}</pre>,
        code: ({ className, children }) =>
          className
            ? <code className={className}>{children}</code>
            : <code className="bg-gray-900/70 rounded px-1 py-0.5 text-xs font-mono text-green-300">{children}</code>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-gray-600 pl-3 my-2 text-gray-400 italic">{children}</blockquote>,
        a: ({ href, children }) => <a href={href} className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>,
        strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
        em: ({ children }) => <em className="italic text-gray-300">{children}</em>,
        hr: () => <hr className="border-gray-700 my-3" />,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div>,
        th: ({ children }) => <th className="border border-gray-600 px-2 py-1 bg-gray-700 text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="border border-gray-600 px-2 py-1">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function ThinkingBlock({ thinking, live }: { thinking: string; live?: boolean }) {
  return (
    <details className="mb-2 rounded-lg border border-gray-700 overflow-hidden text-xs">
      <summary className="px-3 py-1.5 cursor-pointer select-none hover:bg-gray-700/40 flex items-center gap-1.5 text-gray-500 list-none">
        <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3.5 3.5 0 00-1.033 2.476v.228a2 2 0 01-4 0v-.228a3.5 3.5 0 00-1.033-2.476l-.347-.347z" />
        </svg>
        <span>{live ? '思考中…' : '思考過程'}</span>
      </summary>
      <div className="px-3 py-2 text-gray-500 whitespace-pre-wrap font-mono text-xs border-t border-gray-700 bg-gray-950/60 max-h-48 overflow-y-auto">
        {thinking}
      </div>
    </details>
  )
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [savedPrompt, setSavedPrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [saved, setSaved] = useState(false)
  const [showDefault, setShowDefault] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then((d: { systemPrompt: string; defaultSystemPrompt: string; workspaceRoot: string }) => {
      setPrompt(d.systemPrompt ?? '')
      setSavedPrompt(d.systemPrompt ?? '')
      setDefaultPrompt(d.defaultSystemPrompt ?? '')
      setWorkspaceRoot(d.workspaceRoot ?? '')
    }).catch(() => {})
  }, [])

  const persist = async (newPrompt: string) => {
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: newPrompt }) })
    setSavedPrompt(newPrompt)
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const usingDefault = savedPrompt.trim() === ''
  const dirty = prompt !== savedPrompt

  return (
    <div className="bg-gray-800 border-b border-gray-700 px-6 py-4 flex-shrink-0">
      <div className="flex items-center justify-between mb-2 gap-4">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="font-medium text-gray-300">System Prompt</span>
          <span className={`px-2 py-0.5 rounded text-xs ${usingDefault ? 'bg-gray-700 text-gray-400' : 'bg-blue-900 text-blue-200'}`}>
            {usingDefault ? '使用內建預設' : '使用自訂'}
          </span>
          {workspaceRoot && (
            <span className="text-xs text-gray-500">
              <code className="bg-gray-900 px-1 py-0.5 rounded">{'{{WORKSPACE_ROOT}}'}</code> = <code className="text-gray-400">{workspaceRoot}</code>
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 flex-shrink-0">✕</button>
      </div>
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
        placeholder={`空白 = 使用內建預設。可用範本變數：{{WORKSPACE_ROOT}}`}
        className="w-full resize-y rounded-lg border border-gray-600 bg-gray-700 text-gray-100 placeholder-gray-500 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
        rows={8} />
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <button onClick={() => persist(prompt)} disabled={!dirty}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">儲存</button>
        <button onClick={() => persist('')} disabled={usingDefault && prompt === ''}
          className="px-4 py-1.5 bg-gray-700 border border-gray-600 text-gray-300 text-sm rounded-lg hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
          title="清除自訂 prompt，回到內建預設">清空（用預設）</button>
        <button onClick={() => setPrompt(defaultPrompt)}
          className="px-4 py-1.5 border border-gray-600 text-gray-300 text-sm rounded-lg hover:bg-gray-700"
          title="把預設值貼進編輯區，方便基於預設修改">載入預設值</button>
        <button onClick={() => setShowDefault(s => !s)} className="text-xs text-gray-500 hover:text-gray-300 ml-1">
          {showDefault ? '隱藏' : '檢視'}預設值
        </button>
        {saved && <span className="text-sm text-green-400 ml-2">✓ 已儲存</span>}
        <span className="text-xs text-gray-500 ml-auto">下一則訊息起生效</span>
      </div>
      {showDefault && (
        <pre className="mt-3 p-3 rounded bg-gray-900 border border-gray-700 text-xs text-gray-400 max-h-64 overflow-auto whitespace-pre-wrap">
          {defaultPrompt}
        </pre>
      )}
    </div>
  )
}

// ── Toast notifications ───────────────────────────────────────────────────────

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium pointer-events-auto
            ${t.kind === 'success' ? 'bg-green-800/90 text-green-100 border border-green-700' : 'bg-red-800/90 text-red-100 border border-red-700'}`}>
          <span>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} className="ml-1 opacity-60 hover:opacity-100">✕</button>
        </div>
      ))}
    </div>
  )
}

// ── Task status helpers ───────────────────────────────────────────────────────

function TaskStatusBadge({ status }: { status: TaskInfo['status'] }) {
  if (status === 'running') return <span className="text-yellow-400 text-xs animate-pulse">●</span>
  if (status === 'done') return <span className="text-green-400 text-xs">✓</span>
  if (status === 'error') return <span className="text-red-400 text-xs">✗</span>
  return <span className="text-gray-500 text-xs">⬛</span>
}

// ── Tasks panel ───────────────────────────────────────────────────────────────

function TasksPanel({ tasks, onCancel, onDelete }: {
  tasks: TaskInfo[]
  onCancel: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-4 pb-2">
        <p className="text-xs text-gray-600 px-1">任務由 AI 自動派工</p>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {tasks.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-600 text-xs">尚無任務</div>
        )}
        {tasks.map(task => (
          <div key={task.id} className="mx-1 mb-1">
            {/* Task row */}
            <div className={`rounded-lg transition-colors ${expandedId === task.id ? 'bg-gray-800' : 'hover:bg-gray-800/60'}`}>
              <button
                onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                className="w-full text-left px-3 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <TaskStatusBadge status={task.status} />
                  <span className="flex-1 text-xs text-gray-300 truncate">{task.prompt}</span>
                  {task.status === 'running' && (
                    <button
                      onClick={e => { e.stopPropagation(); onCancel(task.id) }}
                      className="flex-shrink-0 text-xs text-red-400 hover:text-red-300 px-1 py-0.5 rounded hover:bg-red-900/30"
                    >
                      中斷
                    </button>
                  )}
                  {task.status !== 'running' && (
                    <button
                      onClick={e => { e.stopPropagation(); onDelete(task.id) }}
                      className="flex-shrink-0 text-xs text-gray-600 hover:text-red-400 px-1 py-0.5 rounded"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 pl-4">
                  <span className="text-xs text-gray-600 truncate">{task.repoLabel ?? repoBasename(task.repoPath)}</span>
                  {task.branchName && (
                    <span className="text-xs text-gray-700 truncate">· {task.branchName.replace('task/', '')}</span>
                  )}
                  <span className="text-xs text-gray-700 ml-auto flex-shrink-0">{relativeTime(task.createdAt)}</span>
                </div>
              </button>

              {/* Expanded transcript */}
              {expandedId === task.id && (
                <div className="px-3 pb-3">
                  <div className="rounded-lg bg-gray-900 border border-gray-700 p-3 max-h-72 overflow-y-auto space-y-2">
                    {task.messages.map((msg, i) => (
                      <div key={i} className={`text-xs ${msg.role === 'user' ? 'text-blue-300' : 'text-gray-300'}`}>
                        <span className="text-gray-600 mr-1">{msg.role === 'user' ? 'You:' : 'Claude:'}</span>
                        <span className="whitespace-pre-wrap break-all">{msg.content}</span>
                      </div>
                    ))}
                    {task.streaming && (
                      <div className="text-xs text-gray-300">
                        <span className="text-gray-600 mr-1">Claude:</span>
                        <span className="whitespace-pre-wrap break-all">{task.streaming}</span>
                        <span className="animate-pulse">▌</span>
                      </div>
                    )}
                    {task.status === 'running' && !task.streaming && task.messages.length <= 1 && (
                      <div className="flex items-center gap-1.5 text-xs text-gray-600">
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:0.15s]" />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:0.3s]" />
                        <span className="ml-1">處理中…</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

type SidebarTab = 'chat' | 'tasks'

interface SidebarProps {
  tab: SidebarTab
  onTabChange: (t: SidebarTab) => void
  sessions: DiskSession[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRefresh: () => void
  onRename: (id: string, name: string) => Promise<void>
  onPin: (id: string, pinned: boolean) => Promise<void>
  tasks: TaskInfo[]
  runningTaskCount: number
  onCancelTask: (id: string) => void
  onDeleteTask: (id: string) => void
}

function Sidebar({
  tab, onTabChange,
  sessions, activeId, onSelect, onNew, onRefresh, onRename, onPin,
  tasks, runningTaskCount, onCancelTask, onDeleteTask,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const confirmingRef = useRef(false)

  useEffect(() => { if (editingId) editRef.current?.focus() }, [editingId])

  const startEdit = (s: DiskSession, e: React.MouseEvent) => {
    e.stopPropagation(); confirmingRef.current = false
    setEditingId(s.id); setEditName(s.name ?? s.preview ?? '')
  }
  const commitEdit = async (id: string) => {
    confirmingRef.current = true; await onRename(id, editName)
    setEditingId(null); confirmingRef.current = false
  }
  const cancelEdit = () => { if (!confirmingRef.current) setEditingId(null) }

  return (
    <div className="w-64 flex-shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-800 flex-shrink-0">
        <button
          onClick={() => onTabChange('chat')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
            tab === 'chat' ? 'text-gray-100 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          💬 對話
        </button>
        <button
          onClick={() => onTabChange('tasks')}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors relative ${
            tab === 'tasks' ? 'text-gray-100 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          📋 任務
          {runningTaskCount > 0 && (
            <span className="absolute top-1.5 right-3 w-4 h-4 bg-yellow-500 text-gray-900 text-xs rounded-full flex items-center justify-center font-bold leading-none">
              {runningTaskCount}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      {tab === 'chat' ? (
        <>
          <div className="px-3 pt-3 pb-2 flex items-center gap-2">
            <button onClick={onNew}
              className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium transition-colors">
              <span className="text-lg leading-none">+</span> 新對話
            </button>
            <button onClick={onRefresh} title="重新整理" className="p-2 text-gray-500 hover:text-gray-300 rounded-lg hover:bg-gray-800">↻</button>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {sessions.length === 0 && (
              <div className="px-4 py-8 text-center text-gray-600 text-xs">尚無對話記錄</div>
            )}
            {sessions.map(s => (
              <div key={s.id} className="relative mx-1 mb-0.5" style={{ width: 'calc(100% - 8px)' }}>
                {editingId === s.id ? (
                  <div className="px-3 py-2 rounded-lg bg-gray-700">
                    <input ref={editRef} value={editName} onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitEdit(s.id) } if (e.key === 'Escape') cancelEdit() }}
                      onBlur={cancelEdit}
                      className="w-full bg-gray-600 text-gray-100 text-sm px-2 py-1 rounded border border-blue-500 outline-none"
                      placeholder="輸入名稱…" />
                    <div className="flex gap-2 mt-1.5">
                      <button onMouseDown={e => { e.preventDefault(); void commitEdit(s.id) }} className="text-xs text-green-400 hover:text-green-300">✓ 確認</button>
                      <button onMouseDown={e => { e.preventDefault(); cancelEdit() }} className="text-xs text-gray-500 hover:text-gray-300">✗ 取消</button>
                    </div>
                  </div>
                ) : (
                  <div className={`flex items-center rounded-lg transition-colors ${s.id === activeId ? 'bg-gray-700' : 'hover:bg-gray-800'}`}>
                    <button onClick={() => onSelect(s.id)} data-session-id={s.id}
                      className={`flex-1 min-w-0 text-left px-3 py-2.5 ${s.id === activeId ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
                      <div className="flex items-center gap-1 min-w-0">
                        {s.pinned && <span className="text-blue-400 flex-shrink-0 text-xs">📌</span>}
                        <span className="text-sm truncate">{s.name || s.preview || '新對話'}</span>
                      </div>
                      <div className="text-xs text-gray-600 mt-0.5">{relativeTime(s.updatedAt)}</div>
                    </button>
                    <div className="flex items-center gap-0.5 pr-2 flex-shrink-0">
                      <button onClick={e => startEdit(s, e)} title="重命名"
                        className="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                        </svg>
                      </button>
                      <button onClick={e => { e.stopPropagation(); void onPin(s.id, !s.pinned) }}
                        title={s.pinned ? '取消釘選' : '釘選'}
                        className={`p-1 rounded transition-colors ${s.pinned ? 'text-blue-400 hover:text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}>
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
        </>
      ) : (
        <TasksPanel
          tasks={tasks}
          onCancel={onCancelTask}
          onDelete={onDeleteTask}
        />
      )}
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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chat')
  const [longWait, setLongWait] = useState(false)
  const [currentThinking, setCurrentThinking] = useState('')
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [messageQueue, setMessageQueue] = useState<string[]>([])
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])

  const currentResponseRef = useRef('')
  const currentThinkingRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastChunkAtRef = useRef<number>(0)
  const messageQueueRef = useRef<string[]>([])

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  useEffect(() => { scrollToBottom() }, [messages, currentResponse])

  useEffect(() => {
    if (!isProcessing) { setLongWait(false); return }
    const t = setInterval(() => { setLongWait(Date.now() - lastChunkAtRef.current > 30_000) }, 2000)
    return () => clearInterval(t)
  }, [isProcessing])

  const addToast = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = crypto.randomUUID()
    setToasts(prev => [...prev, { id, message, kind }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const fetchSessions = useCallback(async () => {
    try { setSessions(await fetch('/api/sessions').then(r => r.json()) as DiskSession[]) } catch { /* ignore */ }
  }, [])

  const fetchTasks = useCallback(async () => {
    try { setTasks(await fetch('/api/tasks').then(r => r.json()) as TaskInfo[]) } catch { /* ignore */ }
  }, [])

  useEffect(() => { void fetchSessions() }, [fetchSessions])
  useEffect(() => { void fetchTasks() }, [fetchTasks])

  const renameSession = async (id: string, name: string) => {
    await fetch(`/api/sessions/${id}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    void fetchSessions()
  }

  const pinSession = async (id: string, pinned: boolean) => {
    await fetch(`/api/sessions/${id}/pin`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) })
    void fetchSessions()
  }

  const cancelTask = async (taskId: string) => {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
  }

  const deleteTask = async (taskId: string) => {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
    setTasks(prev => prev.filter(t => t.id !== taskId))
  }

  const resumeSession = useCallback((ws: WebSocket, sessionId: string | null) => {
    ws.send(JSON.stringify({ type: 'resume', sessionId }))
  }, [])

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
    wsRef.current = ws
    ;(window as unknown as Record<string, unknown>).__testWs = ws

    ws.onopen = () => {
      setIsConnected(true)
      setIsProcessing(false)
      void fetchSessions()
      void fetchTasks()
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
        // ── Session events ────────────────────────────────────────────────
        case 'session': {
          const id = data.sessionId as string
          sessionIdRef.current = id
          setActiveSessionId(id)
          localStorage.setItem(SESSION_KEY, id)
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
          currentThinkingRef.current = ''
          setCurrentThinking('')
          setIsProcessing(data.status === 'running')
          break
        }
        case 'thinking': {
          const text = (data.text ?? '') as string
          if (!text) break
          currentThinkingRef.current += text
          setCurrentThinking(currentThinkingRef.current)
          break
        }
        case 'chunk': {
          const text = (data.text ?? '') as string
          if (!text) break
          currentResponseRef.current += text
          setCurrentResponse(currentResponseRef.current)
          setIsProcessing(true)
          lastChunkAtRef.current = Date.now()
          setLongWait(false)
          break
        }
        case 'done': {
          const content = currentResponseRef.current
          const thinking = currentThinkingRef.current || undefined
          if (content) setMessages(prev => [...prev, { role: 'assistant', content, timestamp: Date.now(), thinking }])
          currentResponseRef.current = ''; currentThinkingRef.current = ''
          setCurrentResponse(''); setCurrentThinking('')
          setIsReconnecting(false); setIsProcessing(false)
          void fetchSessions()
          const queue = messageQueueRef.current
          if (queue.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            const [next, ...rest] = queue
            messageQueueRef.current = rest; setMessageQueue(rest)
            setTimeout(() => {
              if (!wsRef.current || !sessionIdRef.current) return
              setMessages(prev => [...prev, { role: 'user', content: next, timestamp: Date.now() }])
              setIsProcessing(true); setLongWait(false)
              lastChunkAtRef.current = Date.now()
              currentResponseRef.current = ''; setCurrentResponse('')
              currentThinkingRef.current = ''; setCurrentThinking('')
              wsRef.current.send(JSON.stringify({ type: 'chat', message: next, sessionId: sessionIdRef.current }))
            }, 100)
          }
          break
        }
        case 'cancelled': {
          currentResponseRef.current = ''; currentThinkingRef.current = ''
          setCurrentResponse(''); setCurrentThinking('')
          setIsReconnecting(false); setIsProcessing(false)
          setMessages(prev => [...prev, { role: 'assistant', content: '⬛ 已中斷', timestamp: Date.now() }])
          messageQueueRef.current = []; setMessageQueue([])
          break
        }
        case 'reconnecting': {
          currentResponseRef.current = ''; currentThinkingRef.current = ''
          setCurrentResponse(''); setCurrentThinking('')
          setIsReconnecting(true)
          break
        }
        case 'error': {
          const msg = (data.message ?? String(data.error ?? 'Unknown error')) as string
          setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${msg}`, timestamp: Date.now() }])
          currentResponseRef.current = ''; currentThinkingRef.current = ''
          setCurrentResponse(''); setCurrentThinking('')
          setIsReconnecting(false); setIsProcessing(false)
          break
        }

        // ── Task events ───────────────────────────────────────────────────
        case 'task:created': {
          const t = data as unknown as TaskInfo & { type: string; repoLabel?: string }
          setTasks(prev => [{
            id: t.id ?? (data.taskId as string),
            repoPath: t.repoPath ?? (data.repoPath as string),
            repoLabel: t.repoLabel ?? (data.repoLabel as string | undefined),
            worktreeName: (data.worktreeName as string | null) ?? null,
            branchName: (data.branchName as string | null) ?? null,
            prompt: (data.prompt as string) ?? '',
            status: 'running',
            messages: [{ role: 'user', content: (data.prompt as string) ?? '', timestamp: (data.createdAt as number) ?? Date.now() }],
            streaming: '',
            createdAt: (data.createdAt as number) ?? Date.now(),
            updatedAt: (data.createdAt as number) ?? Date.now(),
          }, ...prev])
          break
        }
        case 'task:progress': {
          const taskId = data.taskId as string
          const text = data.text as string
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, streaming: t.streaming + text } : t))
          break
        }
        case 'task:done': {
          const taskId = data.taskId as string
          setTasks(prev => prev.map(t => {
            if (t.id !== taskId) return t
            const content = t.streaming
            return {
              ...t,
              status: 'done' as const,
              messages: content ? [...t.messages, { role: 'assistant' as const, content, timestamp: Date.now() }] : t.messages,
              streaming: '',
              updatedAt: Date.now(),
            }
          }))
          addToast('✅ 任務完成', 'success')
          break
        }
        case 'task:error': {
          const taskId = data.taskId as string
          const errMsg = (data.message as string | undefined) ?? '未知錯誤'
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'error' as const, streaming: '', updatedAt: Date.now() } : t))
          addToast(`❌ 任務失敗：${errMsg.slice(0, 60)}`, 'error')
          break
        }
        case 'task:cancelled': {
          const taskId = data.taskId as string
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'cancelled' as const, streaming: '', updatedAt: Date.now() } : t))
          break
        }

        // Sub-task result injected into main conversation by server
        case 'inject': {
          const injected = data.message as { role: string; content: string; timestamp: number }
          if (injected?.content) {
            setMessages(prev => [...prev, {
              role: injected.role as 'user' | 'assistant',
              content: injected.content,
              timestamp: injected.timestamp ?? Date.now(),
            }])
          }
          break
        }
      }
    }
  }, [resumeSession, fetchSessions, fetchTasks, addToast])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const ws = wsRef.current
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connect()
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [connect])

  const switchSession = (id: string) => {
    if (!wsRef.current || !isConnected) return
    currentResponseRef.current = ''; currentThinkingRef.current = ''
    setCurrentResponse(''); setCurrentThinking('')
    setMessages([]); setIsProcessing(false)
    wsRef.current.send(JSON.stringify({ type: 'resume', sessionId: id }))
    setSidebarOpen(false)
  }

  const newSession = () => {
    localStorage.removeItem(SESSION_KEY)
    if (!wsRef.current || !isConnected) return
    currentResponseRef.current = ''; currentThinkingRef.current = ''
    setCurrentResponse(''); setCurrentThinking('')
    setMessages([]); setIsProcessing(false)
    wsRef.current.send(JSON.stringify({ type: 'resume', sessionId: null }))
    setSidebarOpen(false)
  }

  const onImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    const placeholders = files.map(f => ({ localId: crypto.randomUUID(), file: f, preview: URL.createObjectURL(f) }))
    setPendingImages(prev => [...prev, ...placeholders.map(p => ({ localId: p.localId, preview: p.preview, thumbnail: '', uploading: true }))])
    placeholders.forEach(({ localId, file }) => {
      processImageFile(file)
        .then(({ aiBase64, thumbnail }) =>
          fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: aiBase64, mediaType: 'image/jpeg', thumbnail }) }).then(async r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const { id } = await r.json() as { id: string }
            setPendingImages(prev => prev.map(p => p.localId === localId ? { ...p, thumbnail, id, uploading: false } : p))
          })
        )
        .catch(() => { setPendingImages(prev => prev.map(p => p.localId === localId ? { ...p, uploading: false, error: true } : p)) })
    })
  }

  const removeImage = (idx: number) => {
    setPendingImages(prev => { URL.revokeObjectURL(prev[idx].preview); return prev.filter((_, i) => i !== idx) })
  }

  const cancelMessage = () => { wsRef.current?.send(JSON.stringify({ type: 'cancel' })) }

  const sendMessage = () => {
    if (!input.trim() || !wsRef.current || !isConnected) return
    if (pendingImages.some(p => p.uploading)) return
    if (isProcessing) {
      const queued = input.trim()
      const next = [...messageQueueRef.current, queued]
      messageQueueRef.current = next; setMessageQueue(next); setInput('')
      return
    }
    const readyImages = pendingImages.filter(p => p.id && !p.error)
    const imagePreviews = readyImages.map(p => p.thumbnail)
    setMessages(prev => [...prev, { role: 'user', content: input, timestamp: Date.now(), imagePreviews }])
    setIsProcessing(true); setLongWait(false)
    lastChunkAtRef.current = Date.now()
    currentResponseRef.current = ''; setCurrentResponse('')
    currentThinkingRef.current = ''
    wsRef.current.send(JSON.stringify({
      type: 'chat', message: input, sessionId: sessionIdRef.current,
      ...(readyImages.length > 0 ? { imageIds: readyImages.map(p => p.id) } : {}),
    }))
    setInput('')
    pendingImages.forEach(p => URL.revokeObjectURL(p.preview))
    setPendingImages([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const runningTaskCount = tasks.filter(t => t.status === 'running').length

  return (
    <div className="flex bg-gray-900 text-gray-100 overflow-hidden" style={{ height: '100dvh' }}>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`
        fixed inset-y-0 left-0 z-30 md:static md:z-auto md:flex md:flex-shrink-0
        transition-transform duration-200
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <Sidebar
          tab={sidebarTab}
          onTabChange={setSidebarTab}
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={switchSession}
          onNew={newSession}
          onRefresh={fetchSessions}
          onRename={renameSession}
          onPin={pinSession}
          tasks={tasks}
          runningTaskCount={runningTaskCount}
          onCancelTask={cancelTask}
          onDeleteTask={deleteTask}
        />
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => setSidebarOpen(s => !s)}
              className="md:hidden p-1.5 text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-700">☰</button>
            <h1 className="text-base font-semibold text-gray-100">Claude Code Remote</h1>
          </div>
          <div className="flex items-center gap-2">
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
                <div className={`max-w-[80%] min-w-0 overflow-hidden rounded-xl px-4 py-2.5 ${
                  msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-800 border border-gray-700 text-gray-100'
                }`}>
                  {msg.imagePreviews && msg.imagePreviews.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {msg.imagePreviews.map((src, i) => (
                        <img key={i} src={src} alt="" className="h-20 w-20 object-cover rounded-lg" />
                      ))}
                    </div>
                  )}
                  {msg.role === 'assistant' ? (
                    <div className="text-sm">
                      {msg.thinking && <ThinkingBlock thinking={msg.thinking} />}
                      <MarkdownContent content={msg.content} />
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-all text-sm">{msg.content}</div>
                  )}
                  <div className={`text-xs mt-1 ${msg.role === 'user' ? 'text-blue-200' : 'text-gray-500'}`}>
                    {new Date(msg.timestamp).toLocaleTimeString('zh-TW')}
                  </div>
                </div>
              </div>
            ))}

            {(currentThinking || currentResponse) && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-xl px-4 py-2.5 bg-gray-800 border border-gray-700 text-gray-100">
                  <div className="text-sm">
                    {currentThinking && <ThinkingBlock thinking={currentThinking} live />}
                    {currentResponse && <MarkdownContent content={currentResponse} />}
                  </div>
                </div>
              </div>
            )}

            {isProcessing && !currentResponse && (
              <div className="flex justify-start">
                <div className="rounded-xl px-4 py-3 bg-gray-800 border border-gray-700">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                      <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0.15s]" />
                      <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0.3s]" />
                    </div>
                    <span className="text-xs text-gray-500">
                      {isReconnecting ? '重新連線中...' : longWait ? '處理中，請稍候…' : '正在思考…'}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {isProcessing && currentResponse && longWait && (
              <div className="flex justify-start">
                <span className="text-xs text-yellow-600/80 px-1">⏳ 仍在處理中，請稍候…</span>
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
                  {p.uploading && (
                    <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {!p.uploading && p.error && (
                    <div className="absolute inset-0 bg-red-900/70 rounded-lg flex items-center justify-center" title="上傳失敗">
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
                    className="absolute -top-1 -right-1 w-4 h-4 bg-gray-600 hover:bg-red-600 rounded-full text-white text-xs flex items-center justify-center leading-none">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Message queue strip */}
        {messageQueue.length > 0 && (
          <div className="bg-gray-800/80 border-t border-gray-700 px-4 py-2 flex-shrink-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-yellow-500/80">排隊中 ({messageQueue.length} 則)</span>
              <button onClick={() => { messageQueueRef.current = []; setMessageQueue([]) }}
                className="text-xs text-gray-600 hover:text-red-400 transition-colors">清除全部</button>
            </div>
            <div className="space-y-0.5">
              {messageQueue.map((qMsg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 w-4 flex-shrink-0">{i + 1}.</span>
                  <span className="flex-1 text-xs text-gray-400 truncate">{qMsg}</span>
                  <button onClick={() => {
                    const next = messageQueueRef.current.filter((_, j) => j !== i)
                    messageQueueRef.current = next; setMessageQueue(next)
                  }} className="text-xs text-gray-600 hover:text-red-400 px-1 transition-colors">×</button>
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
              placeholder={isProcessing ? '輸入訊息… (Enter 排隊，Shift+Enter 換行)' : '輸入訊息… (Enter 傳送，Shift+Enter 換行)'}
              className="flex-1 resize-none rounded-xl border border-gray-600 bg-gray-700 text-gray-100 placeholder-gray-500 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
              rows={2} disabled={!isConnected} data-processing={isProcessing} />

            {isProcessing && !input.trim() ? (
              <button onClick={cancelMessage}
                className="flex-shrink-0 px-4 py-2.5 bg-red-800 text-white text-sm rounded-xl hover:bg-red-700 transition-colors">
                ⬛ 中斷
              </button>
            ) : (
              <button onClick={sendMessage} disabled={!isConnected || !input.trim() || pendingImages.some(p => p.uploading)}
                className="flex-shrink-0 px-4 py-2.5 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors">
                {isProcessing ? '排隊' : '傳送'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
