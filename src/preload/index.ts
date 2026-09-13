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
  startCompanion: (): Promise<void> => ipcRenderer.invoke('companion:start'),
  stopCompanion: (): Promise<void> => ipcRenderer.invoke('companion:stop'),
  platform: process.platform,
  hideJarvis: (): Promise<void> => ipcRenderer.invoke('jarvis:hide'),
  submitJarvisNote: (note?: string, options?: JarvisAskOptions): Promise<void> =>
    ipcRenderer.invoke('jarvis:submit', note, options),
  pinJarvisContext: (): Promise<void> => ipcRenderer.invoke('jarvis:pin'),
  getSnipGain: (): Promise<SnipGain> => ipcRenderer.invoke('snip:gain'),
  getAuthStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  connectGithub: (token: string): Promise<AuthStatus> =>
    ipcRenderer.invoke('auth:connect-github', token),
  connectCursorKey: (apiKey: string): Promise<AuthStatus> =>
    ipcRenderer.invoke('auth:connect-cursor', apiKey),
  openGithubToken: (): Promise<void> => ipcRenderer.invoke('auth:open-github-token'),
  disconnect: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:disconnect'),
  setTray: (enabled: boolean): Promise<AuthStatus> => ipcRenderer.invoke('tray:set', enabled),
  listHistory: (): Promise<HistoryThread[]> => ipcRenderer.invoke('history:list'),
  getHistory: (id: string): Promise<HistoryThread | undefined> =>
    ipcRenderer.invoke('history:get', id),
  createHistory: (): Promise<HistoryThread> => ipcRenderer.invoke('history:create'),
  deleteHistory: (id: string): Promise<HistoryThread[]> => ipcRenderer.invoke('history:delete', id),
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
