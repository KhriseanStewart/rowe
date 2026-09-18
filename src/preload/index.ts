import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type CursorImage = {
  data: string
  mimeType: string
}

type CursorKind =
  | 'pointer'
  | 'text'
  | 'hand'
  | 'cross'
  | 'move'
  | 'resize-ns'
  | 'resize-ew'
  | 'resize-nwse'
  | 'resize-nesw'
  | 'busy'

type JarvisState = {
  status: 'pulse' | 'pick' | 'compose' | 'searching' | 'answer' | 'error'
  text: string
  appName: string
  source?: 'mail' | 'outlook' | 'ax' | 'selection' | 'clipboard' | 'pin' | 'app' | 'empty'
  canPin?: boolean
  canInsert?: boolean
  canReply?: boolean
  cursorReady?: boolean
  ragReady?: boolean
  engine?: 'cursor' | 'system'
  pickError?: string
}

type JarvisAskOptions = {
  includeScreen?: boolean
  pin?: boolean
}

type SnipGain = {
  ready: boolean
  commands: number
  tokensSaved: number
  avgSavings: number
  top: Array<{ command: string; runs: number; tokensSaved: number; avgSavings: number }>
}

type GithubProfile = {
  login: string
  name?: string
  avatar?: string
}

type GithubRepo = {
  name: string
  fullName: string
  description?: string
  private: boolean
  htmlUrl: string
  updatedAt: string
}

type AuthStatus = {
  trayAsked: boolean
  trayEnabled: boolean
  trayFileAccess?: boolean
  github?: GithubProfile
  cursor: boolean
  platform: NodeJS.Platform
  githubOAuth?: boolean
  ragConfigured?: boolean
}

type ReferenceProject = {
  id: string
  name: string
  source: 'github' | 'local' | 'yellow_pages'
  location: string
  status: 'indexing' | 'ready' | 'failed'
  selected: boolean
  files: number
  addedAt: number
  error?: string
}

type StoredAgent = {
  id: string
  name: string
  slug: string
  threadId: string
  projectIds?: string[]
  attachmentPaths: string[]
  systemNote?: string
  createdAt: number
  updatedAt: number
}

type AgentRunStatus = {
  agentId: string
  status: 'idle' | 'running' | 'waiting' | 'failed' | 'done'
  goal?: string
  progress?: string
  error?: string
  startedAt?: number
  updatedAt?: number
}

type UserProfile = {
  username: string
  roles: string[]
  company?: string
  industry?: string
  experience?: string
  goals?: string
  preferredStyle?: string
  timezone?: string
  tokensSaved?: number
}

type UserPlanDb = {
  planId: 'free' | 'pro'
  planName: string
  priceUsd: number
  openRouterBudgetUsd: number
  status: 'active'
  selectedAt?: string
  usage: {
    periodKey: string
    openRouterSpendUsd: number
    promptTokens: number
    completionTokens: number
    askCount: number
  }
}

type UsageLogDb = {
  id: string
  at?: string
  source: string
  openRouterSpendUsd: number
  promptTokens: number
  completionTokens: number
  askCount: number
}

type PresenceStatsDb = {
  activeLast5m: number
  activeLast24h: number
  users: number
}

type HistoryThread = {
  id: string
  title: string
  agentId?: string
  createdAt: number
  updatedAt: number
  preview?: string
  messages?: Array<{
    id: string
    role: 'user' | 'assistant'
    text: string
    image?: string
    createdAt: number
  }>
}

const api = {
  connectCursor: (
    apiKey?: string
  ): Promise<{
    apiKeyName: string
    email?: string
    models: string[]
  }> => ipcRenderer.invoke('cursor:connect', apiKey),
  sendCursorPrompt: (text: string, images?: CursorImage[], threadId?: string): Promise<string> =>
    ipcRenderer.invoke('cursor:send', text, images, threadId),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  showApp: (): Promise<void> => ipcRenderer.invoke('window:show-app'),
  quitApp: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  toggleTrayExpand: (): Promise<boolean> => ipcRenderer.invoke('tray:toggle-expand'),
  isTrayExpanded: (): Promise<boolean> => ipcRenderer.invoke('tray:expanded'),
  startCompanion: (): Promise<void> => ipcRenderer.invoke('companion:start'),
  stopCompanion: (): Promise<void> => ipcRenderer.invoke('companion:stop'),
  selectCompanionAi: (engine: 'cursor' | 'system'): Promise<void> =>
    ipcRenderer.invoke('companion:select-ai', engine),
  platform: process.platform,
  hideJarvis: (): Promise<void> => ipcRenderer.invoke('jarvis:hide'),
  submitJarvisNote: (note?: string, options?: JarvisAskOptions): Promise<void> =>
    ipcRenderer.invoke('jarvis:submit', note, options),
  pinJarvisContext: (): Promise<void> => ipcRenderer.invoke('jarvis:pin'),
  insertJarvisDraft: (mode?: 'paste' | 'reply'): Promise<void> =>
    ipcRenderer.invoke('jarvis:insert', mode),
  copyJarvisDraft: (): Promise<string> => ipcRenderer.invoke('jarvis:copy'),
  getSnipGain: (): Promise<SnipGain> => ipcRenderer.invoke('snip:gain'),
  getAuthStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  updateProfileContext: (context: string): Promise<void> =>
    ipcRenderer.invoke('profile:update-context', context),
  updatePlan: (plan: {
    planId: 'free' | 'pro'
    planName: string
    priceUsd: number
    openRouterBudgetUsd: number
    status: 'active'
    openRouterSpendUsd: number
    promptTokens: number
    completionTokens: number
    askCount: number
    periodKey: string
  }): Promise<unknown> => ipcRenderer.invoke('plan:update', plan),
  getPlanStatus: (): Promise<{
    planId: 'free' | 'pro'
    planName: string
    priceUsd: number
    openRouterBudgetUsd: number
    status: 'active'
    openRouterSpendUsd: number
    promptTokens: number
    completionTokens: number
    askCount: number
    periodKey: string
  } | null> => ipcRenderer.invoke('plan:status'),
  recordPlanUsage: (delta: {
    openRouterSpendUsd?: number
    promptTokens?: number
    completionTokens?: number
    askCount?: number
  }): Promise<unknown> => ipcRenderer.invoke('plan:record-usage', delta),
  connectGithub: (token: string): Promise<AuthStatus> =>
    ipcRenderer.invoke('auth:connect-github', token),
  connectGithubOAuth: (): Promise<string> => ipcRenderer.invoke('auth:github-oauth'),
  connectCursorKey: (apiKey: string): Promise<AuthStatus> =>
    ipcRenderer.invoke('auth:connect-cursor', apiKey),
  openGithubToken: (): Promise<void> => ipcRenderer.invoke('auth:open-github-token'),
  openCursorDashboard: (): Promise<void> => ipcRenderer.invoke('auth:open-cursor-dashboard'),
  disconnect: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:disconnect'),
  setTray: (enabled: boolean): Promise<AuthStatus> => ipcRenderer.invoke('tray:set', enabled),
  pickLocalFolder: (): Promise<{ path: string; bookmark?: string } | undefined> =>
    ipcRenderer.invoke('projects:pick-folder'),
  requestTrayFileAccess: (
    request?: {
      question?: string
      defaultPath?: string
      targetLabel?: string
      reason?: string
      wantFile?: boolean
    }
  ): Promise<{ granted: boolean; path?: string; bookmark?: string }> =>
    ipcRenderer.invoke('tray:request-file-access', request),
  getTrayFileAccess: (): Promise<boolean> => ipcRenderer.invoke('tray:file-access'),
  exportDocumentPdf: (input: {
    markdown: string
    meta?: { title?: string; filename?: string; subtitle?: string; accent?: string }
  }): Promise<{ canceled: true } | { canceled: false; path: string }> =>
    ipcRenderer.invoke('documents:export-pdf', input),
  inspectLocalFolder: (path: string): Promise<{ path: string; name: string; files: number }> =>
    ipcRenderer.invoke('projects:inspect-folder', path),
  listGithubRepos: (): Promise<GithubRepo[]> => ipcRenderer.invoke('projects:list-github'),
  listLocalProjects: (): Promise<Array<{ path: string; name: string; root?: string }>> =>
    ipcRenderer.invoke('projects:list-local'),
  listWorkspaceRoots: (): Promise<string[]> => ipcRenderer.invoke('projects:workspace-roots'),
  inspectGithubRepo: (input: string): Promise<GithubRepo> =>
    ipcRenderer.invoke('projects:inspect-github', input),
  listProjects: (): Promise<ReferenceProject[]> => ipcRenderer.invoke('projects:list'),
  addLocalProject: (input: {
    path: string
    name?: string
    bookmark?: string
  }): Promise<ReferenceProject> => ipcRenderer.invoke('projects:add-local', input),
  addGithubProject: (input: { repo: string; name?: string }): Promise<ReferenceProject> =>
    ipcRenderer.invoke('projects:add-github', input),
  removeProject: (id: string): Promise<ReferenceProject[]> => ipcRenderer.invoke('projects:remove', id),
  refreshProject: (id: string): Promise<ReferenceProject> => ipcRenderer.invoke('projects:refresh', id),
  selectProject: (id: string, selected: boolean): Promise<ReferenceProject[]> =>
    ipcRenderer.invoke('projects:select', id, selected),
  askRag: (
    question: string,
    projectIds: string[],
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<{
    text: string
    citations: Array<{
      projectName: string
      path: string
      startLine: number | null
      endLine: number | null
      content?: string
    }>
    usage?: {
      promptTokens: number
      completionTokens: number
      costUsd: number
    }
    edits?: Array<{
      id: string
      path: string
      absolutePath: string
      oldText: string
      newText: string
      description?: string
      before: string
      after: string
    }>
    toolResults?: Array<{
      name: string
      ok: boolean
      path?: string
      summary: string
    }>
  }> => ipcRenderer.invoke('rag:ask', question, projectIds, history),
  applyFileEdit: (edit: {
    path?: string
    absolutePath: string
    oldText: string
    newText: string
  }): Promise<{ ok: true; absolutePath: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('edits:apply', edit),
  searchRag: (question: string, projectIds: string[]) =>
    ipcRenderer.invoke('rag:search', question, projectIds),
  handoffToCursor: (input: {
    task: string
    targetWorkspace?: string
    projectIds: string[]
    constraints?: string
    sendToCursor?: boolean
  }) => ipcRenderer.invoke('rag:handoff', input),
  onRagDelta: (listener: (chunk: string) => void): (() => void) => {
    const handler = (_event: unknown, chunk: string): void => listener(chunk)
    ipcRenderer.on('rag:delta', handler)
    return () => ipcRenderer.removeListener('rag:delta', handler)
  },
  onRagProgress: (
    listener: (payload: {
      projectId: string
      status: 'indexing' | 'ready' | 'failed'
      filesSeen: number
      filesTotal: number
      chunksWritten: number
      error?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        projectId: string
        status: 'indexing' | 'ready' | 'failed'
        filesSeen: number
        filesTotal: number
        chunksWritten: number
        error?: string
      }
    ): void => listener(payload)
    ipcRenderer.on('rag:progress', handler)
    return () => ipcRenderer.removeListener('rag:progress', handler)
  },
  listHistory: (): Promise<HistoryThread[]> => ipcRenderer.invoke('history:list'),
  getHistory: (id: string): Promise<HistoryThread | undefined> =>
    ipcRenderer.invoke('history:get', id),
  createHistory: (): Promise<HistoryThread> => ipcRenderer.invoke('history:create'),
  deleteHistory: (id: string): Promise<HistoryThread[]> => ipcRenderer.invoke('history:delete', id),
  setUserSession: (input: {
    uid: string
    email?: string | null
    name?: string | null
    photo?: string | null
  }): Promise<unknown> => ipcRenderer.invoke('users:set-session', input),
  clearUserSession: (): Promise<void> => ipcRenderer.invoke('users:clear-session'),
  trackUserPresence: (extras?: {
    github?: string
    cursor?: boolean
    platform?: string
  }): Promise<void> => ipcRenderer.invoke('users:track-presence', extras),
  getUserProfile: (): Promise<UserProfile | null> => ipcRenderer.invoke('users:get-profile'),
  saveUserProfile: (profile: UserProfile): Promise<UserProfile> =>
    ipcRenderer.invoke('users:save-profile', profile),
  syncTokensSaved: (localTokensSaved: number): Promise<number> =>
    ipcRenderer.invoke('users:sync-tokens-saved', localTokensSaved),
  getUserPlanDb: (): Promise<UserPlanDb | null> => ipcRenderer.invoke('users:get-plan'),
  saveUserPlanDb: (planId: 'free' | 'pro'): Promise<UserPlanDb> =>
    ipcRenderer.invoke('users:save-plan', planId),
  syncUserUsage: (entry: {
    openRouterSpendUsd?: number
    promptTokens?: number
    completionTokens?: number
    askCount?: number
    source?: string
  }): Promise<UserPlanDb | null> => ipcRenderer.invoke('users:sync-usage', entry),
  listUserUsage: (limitCount?: number): Promise<UsageLogDb[]> =>
    ipcRenderer.invoke('users:list-usage', limitCount),
  trackUserEvent: (name: string, payload?: Record<string, string | boolean>): Promise<void> =>
    ipcRenderer.invoke('users:track-event', name, payload),
  getPresenceStats: (): Promise<PresenceStatsDb> => ipcRenderer.invoke('users:presence-stats'),
  listAgents: (): Promise<StoredAgent[]> => ipcRenderer.invoke('agents:list'),
  getOrCreateAgent: (name: string): Promise<StoredAgent> =>
    ipcRenderer.invoke('agents:get-or-create', name),
  getAgent: (nameOrId: string): Promise<StoredAgent | undefined> =>
    ipcRenderer.invoke('agents:get', nameOrId),
  setActiveAgent: (nameOrId: string | null): Promise<StoredAgent | null> =>
    ipcRenderer.invoke('agents:set-active', nameOrId),
  getActiveAgent: (): Promise<StoredAgent | undefined> => ipcRenderer.invoke('agents:get-active'),
  clearActiveAgent: (): Promise<void> => ipcRenderer.invoke('agents:clear-active'),
  attachToAgent: (agentId?: string): Promise<StoredAgent | undefined> =>
    ipcRenderer.invoke('agents:attach', agentId),
  deleteAgent: (nameOrId: string): Promise<StoredAgent[]> =>
    ipcRenderer.invoke('agents:delete', nameOrId),
  getAgentThread: (nameOrId?: string): Promise<HistoryThread | undefined> =>
    ipcRenderer.invoke('agents:thread', nameOrId),
  runAgent: (input: { name?: string; goal: string }): Promise<AgentRunStatus> =>
    ipcRenderer.invoke('agents:run', input),
  stopAgent: (nameOrId?: string): Promise<{ stopped: boolean }> =>
    ipcRenderer.invoke('agents:stop', nameOrId),
  getAgentStatus: (nameOrId?: string): Promise<AgentRunStatus | null> =>
    ipcRenderer.invoke('agents:status', nameOrId),
  onAgentProgress: (
    listener: (payload: AgentRunStatus & { name?: string; slug?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: AgentRunStatus & { name?: string; slug?: string }
    ): void => listener(payload)
    ipcRenderer.on('agents:progress', handler)
    return () => ipcRenderer.removeListener('agents:progress', handler)
  },
  onAgentTrail: (
    listener: (payload: { phase: string; message: string; taskId?: string; ok?: boolean }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { phase: string; message: string; taskId?: string; ok?: boolean }
    ): void => listener(payload)
    ipcRenderer.on('agent:trail', handler)
    return () => ipcRenderer.removeListener('agent:trail', handler)
  },
  onCompanionPointer: (
    listener: (point: { x: number; y: number; kind: CursorKind; image?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      point: { x: number; y: number; kind: CursorKind; image?: string }
    ): void => listener(point)
    ipcRenderer.on('companion:pointer', handler)
    return () => {
      ipcRenderer.removeListener('companion:pointer', handler)
    }
  },
  onCursorDelta: (listener: (chunk: string) => void): (() => void) => {
    const handler = (_event: unknown, chunk: string): void => listener(chunk)
    ipcRenderer.on('cursor:delta', handler)
    return () => {
      ipcRenderer.removeListener('cursor:delta', handler)
    }
  },
  onCompanionStatus: (listener: (active: boolean) => void): (() => void) => {
    const handler = (_event: unknown, payload: { active: boolean }): void => listener(payload.active)
    ipcRenderer.on('companion:status', handler)
    return () => {
      ipcRenderer.removeListener('companion:status', handler)
    }
  },
  onJarvisState: (listener: (state: JarvisState) => void): (() => void) => {
    const handler = (_event: unknown, state: JarvisState): void => listener(state)
    ipcRenderer.on('jarvis:state', handler)
    return () => {
      ipcRenderer.removeListener('jarvis:state', handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
