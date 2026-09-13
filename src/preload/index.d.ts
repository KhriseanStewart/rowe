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
  status: 'pulse' | 'compose' | 'searching' | 'answer' | 'error'
  text: string
  appName: string
  source?: 'mail' | 'outlook' | 'ax' | 'selection' | 'pin' | 'empty'
  canPin?: boolean
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

type AuthStatus = {
  trayAsked: boolean
  trayEnabled: boolean
  github?: GithubProfile
  cursor: boolean
  platform: NodeJS.Platform
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
      startCompanion: () => Promise<void>
      stopCompanion: () => Promise<void>
      platform: NodeJS.Platform
      hideJarvis: () => Promise<void>
      submitJarvisNote: (note?: string, options?: JarvisAskOptions) => Promise<void>
      pinJarvisContext: () => Promise<void>
      getSnipGain: () => Promise<SnipGain>
      getAuthStatus: () => Promise<AuthStatus>
      connectGithub: (token: string) => Promise<AuthStatus>
      connectCursorKey: (apiKey: string) => Promise<AuthStatus>
      openGithubToken: () => Promise<void>
      disconnect: () => Promise<AuthStatus>
      setTray: (enabled: boolean) => Promise<AuthStatus>
      listHistory: () => Promise<HistoryThread[]>
      getHistory: (id: string) => Promise<HistoryThread | undefined>
      createHistory: () => Promise<HistoryThread>
      deleteHistory: (id: string) => Promise<HistoryThread[]>
      onCompanionPointer: (
        listener: (point: { x: number; y: number; kind: CursorKind; image?: string }) => void
      ) => () => void
      onCursorDelta: (listener: (chunk: string) => void) => () => void
      onCompanionStatus: (listener: (active: boolean) => void) => () => void
      onJarvisState: (listener: (state: JarvisState) => void) => () => void
    }
  }
}
