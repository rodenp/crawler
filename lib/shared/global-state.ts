// Shared global state management for browser sessions
export function getGlobalState() {
  // Ensure we always have a consistent global state
  if (!(global as any).crawlerGlobalState) {
    (global as any).crawlerGlobalState = {
      activeCrawlers: new Map(),
      browserSessions: new Map(),
      progressData: new Map()
    };
  }
  
  // For backward compatibility, also set up the old structure
  if (!(global as any).activeCrawlers) {
    (global as any).activeCrawlers = (global as any).crawlerGlobalState.activeCrawlers;
  }
  
  // Ensure browserSessions is always available on activeCrawlers
  (global as any).activeCrawlers.browserSessions = (global as any).crawlerGlobalState.browserSessions;
  (global as any).activeCrawlers.progressData = (global as any).crawlerGlobalState.progressData;
  
  return (global as any).activeCrawlers;
}

export function getBrowserSessions() {
  // Always get fresh state to ensure consistency
  getGlobalState();
  return (global as any).crawlerGlobalState.browserSessions;
}

export function setBrowserSession(sessionId: string, session: any) {
  // Ensure state is initialized
  getGlobalState();
  const sessions = (global as any).crawlerGlobalState.browserSessions;
  sessions.set(sessionId, session);
  
  // Also store in the old structure for compatibility
  (global as any).activeCrawlers.browserSessions = sessions;
  
  console.log(`[Global State] Browser session stored: ${sessionId}`);
  console.log(`[Global State] Total sessions: ${sessions.size}`);
  console.log(`[Global State] Sessions stored in: crawlerGlobalState and activeCrawlers`);
}

export function getBrowserSession(sessionId: string) {
  // Always get fresh state
  getGlobalState();
  const sessions = (global as any).crawlerGlobalState.browserSessions;
  const session = sessions.get(sessionId);
  
  console.log(`[Global State] Retrieving session ${sessionId}: ${!!session}`);
  console.log(`[Global State] Available sessions: ${Array.from(sessions.keys())}`);
  console.log(`[Global State] Total stored sessions: ${sessions.size}`);
  
  // Debug: check if session exists in any of the storage locations
  const legacySession = (global as any).activeCrawlers?.browserSessions?.get(sessionId);
  console.log(`[Global State] Legacy session found: ${!!legacySession}`);
  
  // Return session from either location
  return session || legacySession;
}

export function removeBrowserSession(sessionId: string) {
  getGlobalState();
  const sessions = (global as any).crawlerGlobalState.browserSessions;
  const removed = sessions.delete(sessionId);
  console.log(`[Global State] Removed session ${sessionId}: ${removed}`);
  return removed;
}