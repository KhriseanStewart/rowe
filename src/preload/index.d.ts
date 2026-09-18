import { ElectronAPI } from '@electron-toolkit/preload'

type CursorConnection = {
  apiKeyName: string
  email?: string
  models: string[]
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

type CursorImage = {
  data: string
  mimeType: string
}

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

type UserProfileDto = {
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

type UserPlanDto = {
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

type UsageLogDto = {
  id: string
  at?: string
  source: string
  openRouterSpendUsd: number
  promptTokens: number
  completionTokens: number
  askCount: number
}

type PresenceStatsDto = {
  activeLast5m: number
  activeLast24h: number
  users: number
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

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      connectCursor: (apiKey?: string) => Promise<CursorConnection>
      sendCursorPrompt: (text: string, images?: CursorImage[], threadId?: string) => Promise<string>
      closeWindow: () => Promise<void>
      showApp: () => Promise<void>
      quitApp: () => Promise<void>
      toggleTrayExpand: () => Promise<boolean>
      isTrayExpanded: () => Promise<boolean>
      startCompanion: () => Promise<void>
      stopCompanion: () => Promise<void>
      selectCompanionAi: (engine: 'cursor' | 'system') => Promise<void>
      platform: NodeJS.Platform
      hideJarvis: () => Promise<void>
      submitJarvisNote: (note?: string, options?: JarvisAskOptions) => Promise<void>
      pinJarvisContext: () => Promise<void>
      insertJarvisDraft: (mode?: 'paste' | 'reply') => Promise<void>
      copyJarvisDraft: () => Promise<string>
      getSnipGain: () => Promise<SnipGain>
      getAuthStatus: () => Promise<AuthStatus>
      updateProfileContext: (context: string) => Promise<void>
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
      }) => Promise<unknown>
      getPlanStatus: () => Promise<{
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
      } | null>
      recordPlanUsage: (delta: {
        openRouterSpendUsd?: number
        promptTokens?: number
        completionTokens?: number
        askCount?: number
      }) => Promise<unknown>
      connectGithub: (token: string) => Promise<AuthStatus>
      connectGithubOAuth: () => Promise<string>
      connectCursorKey: (apiKey: string) => Promise<AuthStatus>
      openGithubToken: () => Promise<void>
      openCursorDashboard: () => Promise<void>
      disconnect: () => Promise<AuthStatus>
      setTray: (enabled: boolean) => Promise<AuthStatus>
      pickLocalFolder: () => Promise<{ path: string; bookmark?: string } | undefined>
      requestTrayFileAccess: (request?: {
        question?: string
        defaultPath?: string
        targetLabel?: string
        reason?: string
        wantFile?: boolean
      }) => Promise<{ granted: boolean; path?: string; bookmark?: string }>
      getTrayFileAccess: () => Promise<boolean>
      applyFileEdit: (edit: {
        path?: string
        absolutePath: string
        oldText: string
        newText: string
      }) => Promise<{ ok: true; absolutePath: string } | { ok: false; error: string }>
      exportDocumentPdf: (input: {
        markdown: string
        meta?: { title?: string; filename?: string; subtitle?: string; accent?: string }
      }) => Promise<{ canceled: true } | { canceled: false; path: string }>
      inspectLocalFolder: (path: string) => Promise<{ path: string; name: string; files: number }>
      listGithubRepos: () => Promise<GithubRepo[]>
      listLocalProjects: () => Promise<Array<{ path: string; name: string; root?: string }>>
      listWorkspaceRoots: () => Promise<string[]>
      inspectGithubRepo: (input: string) => Promise<GithubRepo>
      listProjects: () => Promise<ReferenceProject[]>
      addLocalProject: (input: {
        path: string
        name?: string
        bookmark?: string
      }) => Promise<ReferenceProject>
      addGithubProject: (input: { repo: string; name?: string }) => Promise<ReferenceProject>
      removeProject: (id: string) => Promise<ReferenceProject[]>
      refreshProject: (id: string) => Promise<ReferenceProject>
      selectProject: (id: string, selected: boolean) => Promise<ReferenceProject[]>
      askRag: (
        question: string,
        projectIds: string[],
        history?: Array<{ role: 'user' | 'assistant'; content: string }>
      ) => Promise<{
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
      }>
      searchRag: (
        question: string,
        projectIds: string[]
      ) => Promise<
        Array<{
          projectName: string
          path: string
          startLine: number | null
          endLine: number | null
          content?: string
          symbol?: string | null
        }>
      >
      handoffToCursor: (input: {
        task: string
        targetWorkspace?: string
        projectIds: string[]
        constraints?: string
        sendToCursor?: boolean
      }) => Promise<{
        brief: string
        text?: string
        citations: Array<{
          projectName: string
          path: string
          startLine: number | null
          endLine: number | null
          content?: string
        }>
      }>
      onRagDelta: (listener: (chunk: string) => void) => () => void
      onRagProgress: (
        listener: (payload: {
          projectId: string
          status: 'indexing' | 'ready' | 'failed'
          filesSeen: number
          filesTotal: number
          chunksWritten: number
          error?: string
        }) => void
      ) => () => void
      listHistory: () => Promise<HistoryThread[]>
      getHistory: (id: string) => Promise<HistoryThread | undefined>
      createHistory: () => Promise<HistoryThread>
      deleteHistory: (id: string) => Promise<HistoryThread[]>
      setUserSession: (input: {
        uid: string
        email?: string | null
        name?: string | null
        photo?: string | null
      }) => Promise<unknown>
      clearUserSession: () => Promise<void>
      trackUserPresence: (extras?: {
        github?: string
        cursor?: boolean
        platform?: string
      }) => Promise<void>
      getUserProfile: () => Promise<UserProfileDto | null>
      saveUserProfile: (profile: UserProfileDto) => Promise<UserProfileDto>
      syncTokensSaved: (localTokensSaved: number) => Promise<number>
      getUserPlanDb: () => Promise<UserPlanDto | null>
      saveUserPlanDb: (planId: 'free' | 'pro') => Promise<UserPlanDto>
      syncUserUsage: (entry: {
        openRouterSpendUsd?: number
        promptTokens?: number
        completionTokens?: number
        askCount?: number
        source?: string
      }) => Promise<UserPlanDto | null>
      listUserUsage: (limitCount?: number) => Promise<UsageLogDto[]>
      trackUserEvent: (name: string, payload?: Record<string, string | boolean>) => Promise<void>
      getPresenceStats: () => Promise<PresenceStatsDto>
      listAgents: () => Promise<StoredAgent[]>
      getOrCreateAgent: (name: string) => Promise<StoredAgent>
      getAgent: (nameOrId: string) => Promise<StoredAgent | undefined>
      setActiveAgent: (nameOrId: string | null) => Promise<StoredAgent | null>
      getActiveAgent: () => Promise<StoredAgent | undefined>
      clearActiveAgent: () => Promise<void>
      attachToAgent: (agentId?: string) => Promise<StoredAgent | undefined>
      deleteAgent: (nameOrId: string) => Promise<StoredAgent[]>
      getAgentThread: (nameOrId?: string) => Promise<HistoryThread | undefined>
      runAgent: (input: { name?: string; goal: string }) => Promise<AgentRunStatus>
      stopAgent: (nameOrId?: string) => Promise<{ stopped: boolean }>
      getAgentStatus: (nameOrId?: string) => Promise<AgentRunStatus | null>
      onAgentProgress: (
        listener: (payload: AgentRunStatus & { name?: string; slug?: string }) => void
      ) => () => void
      onAgentTrail: (
        listener: (payload: { phase: string; message: string; taskId?: string; ok?: boolean }) => void
      ) => () => void
      onCompanionPointer: (
        listener: (point: { x: number; y: number; kind: CursorKind; image?: string }) => void
      ) => () => void
      onCursorDelta: (listener: (chunk: string) => void) => () => void
      onCompanionStatus: (listener: (active: boolean) => void) => () => void
      onJarvisState: (listener: (state: JarvisState) => void) => () => void
    }
  }
}
