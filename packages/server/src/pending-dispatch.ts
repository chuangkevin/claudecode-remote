// Tracks sub-tasks that the main agent dispatched but hasn't yet seen finish.
// Lives in its own module so both websocket.ts (adds on DISPATCH parse) and
// index.ts (consumes on task finish, decides whether to auto-continue the
// orchestrator) can import without a circular dependency.

const pendingTasksBySession = new Map<string, Set<string>>();

export function addPendingDispatch(sessionId: string, taskId: string): void {
  let set = pendingTasksBySession.get(sessionId);
  if (!set) { set = new Set(); pendingTasksBySession.set(sessionId, set); }
  set.add(taskId);
}

/** Remove the task; return true iff this was the last pending dispatch for the session. */
export function consumePendingDispatch(sessionId: string, taskId: string): boolean {
  const set = pendingTasksBySession.get(sessionId);
  if (!set || !set.has(taskId)) return false;
  set.delete(taskId);
  if (set.size === 0) {
    pendingTasksBySession.delete(sessionId);
    return true;
  }
  return false;
}

/** True if any sub-tasks dispatched from this session are still pending. */
export function hasPendingDispatch(sessionId: string): boolean {
  const set = pendingTasksBySession.get(sessionId);
  return !!set && set.size > 0;
}
