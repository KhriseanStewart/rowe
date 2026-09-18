import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { hideTrayWindow, initTray, destroyTray, setTrayClickHandler, setOpenAppHandler, toggleTrayExpanded, isTrayExpanded } from './tray-window'
import {
  connectCursor,
  disconnectCursor,
  disposeCursor,
  sendCursorPrompt,
  type CursorImage
} from './cursor'
import { getSnipGain, prepareSnipRuntime } from './snip'
import { getSettings, updateSettings, planAllowsAskLocal, recordLocalPlanUsage, type LocalPlan } from './settings'
import {
  connectGithub,
  disconnectGithub,
  getGithubProfile,
  inspectGithubRepo,
  listGithubRepos,
  openGithubTokenPage
} from './github'
import { githubOAuthConfigured, signInWithGithubOAuth } from './github-oauth'
import { inspectLocalFolder, pickLocalFolder, requestTrayFileAccess, trayFileAccessGranted, getWorkspaceRoots, isPathGranted, resolveAccessTargetFromQuestion, type FileAccessRequest } from './local-folder'
import { applyProposedEdit } from './file-edits'
import { exportDocumentPdf, type ExportDocumentPdfInput } from './documents'
import {
  addGithubProject,
  addLocalProject,
  listProjects,
  refreshProject,
  removeProject,
  setProjectSelected
} from './rag/projects'
import { closeRag, migrateRag } from './rag/db'
import { answerWithRag, ragIsConfigured } from './rag/system-ai'
import { ragEvents } from './rag/events'
import { agentProgress } from './agent-progress'
import { searchRag } from './rag/retrieve'
import { resolveProjectsForQuestion, listLocalProjects, wantsWorkspaceInventory, buildWorkspaceInventoryContext } from './rag/workspace'
import { buildCursorHandoff } from './rag/handoff'
import {
  ensurePublicYellowPagesSeeded,
  getPublicYellowPagesProjectIds
} from './rag/yellow-pages'
import {
  appendMessage,
  createThread,
  deleteThread,
  getThread,
  listThreads
} from './history'
import {
  buildAgentAttachmentContext,
  clearActiveAgent,
  deleteAgent,
  getActiveAgent,
  getAgent,
  getAgentThread,
  getOrCreateAgent,
  listAgents,
  pickAndAttachToAgent,
  setActiveAgent,
  touchAgent
} from './agents'
import {
  cancelAgentRun,
  getAgentRunStatus,
  startAgentRun,
  type AgentRunStatus
} from './agent-runner'
import {
  copyJarvisDraft,
  hideJarvis,
  insertJarvisDraft,
  isCompanionActive,
  pinJarvisContext,
  selectCompanionAi,
  startCompanion,
  stopCompanion,
  submitJarvisNote
} from './companion'
import { loadRenderer } from './renderer-url'
import {
  clearAuthSession,
  getUserPlan,
  getUserProfile,
  listUsageLogs,
  migrateUsers,
  readPresenceStats,
  saveUserPlan,
  saveUserProfile,
  setAuthSession,
  syncTokensSaved,
  syncUsageFromLocal,
  trackEvent,
  trackPresence
} from './users'

let mainWindow: BrowserWindow | undefined
let quitting = false

function uniqueProjectIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}

export function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Rowe',
    icon,
    backgroundColor: '#18191a',
    movable: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 16 }
        }
      : {
          // Custom top chrome still needs a drag region on Windows/Linux when
          // the OS title bar is thin; keep a normal frame so the window stays movable.
          frame: true
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (getSettings().trayEnabled && !quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow, 'app')
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  return mainWindow
}

export function showMainWindow(): void {
  const window = createWindow()
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
}

function authStatus(): {
  trayAsked: boolean
  trayEnabled: boolean
  trayFileAccess: boolean
  github: ReturnType<typeof getGithubProfile>
  cursor: boolean
  platform: NodeJS.Platform
  githubOAuth: boolean
  ragConfigured: boolean
} {
  const settings = getSettings()
  return {
    trayAsked: settings.trayAsked,
    trayEnabled: settings.trayEnabled,
    trayFileAccess: trayFileAccessGranted(),
    github: getGithubProfile(),
    cursor: Boolean(settings.cursorKey),
    platform: process.platform,
    githubOAuth: githubOAuthConfigured(),
    ragConfigured: ragIsConfigured()
  }
}

app.whenReady().then(() => {
  const snip = prepareSnipRuntime()
  if (snip) {
    console.log(`Rowe bundled snip at ${snip.snipBin}`)
  }

  void migrateUsers().catch((error) => {
    console.error('[rowe] user/rag migrate failed', error)
  })

  electronApp.setAppUserModelId('com.rowe.app')
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('window:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === mainWindow) {
      if (getSettings().trayEnabled) {
        window.hide()
        return
      }
      window.close()
      return
    }
    hideTrayWindow()
  })

  ipcMain.handle('window:show-app', () => {
    showMainWindow()
  })

  ipcMain.handle('app:quit', () => {
    quitting = true
    stopCompanion()
    app.quit()
  })

  ipcMain.handle('tray:toggle-expand', () => toggleTrayExpanded())
  ipcMain.handle('tray:expanded', () => isTrayExpanded())

  ipcMain.handle('auth:status', () => authStatus())

  ipcMain.handle('profile:update-context', (_event, context: string) => {
    updateSettings({ userProfileContext: context.trim().slice(0, 2000) })
  })

  ipcMain.handle('plan:update', (_event, plan: LocalPlan) => {
    updateSettings({ plan })
    return getSettings().plan
  })

  ipcMain.handle('plan:status', () => getSettings().plan ?? null)

  ipcMain.handle('plan:record-usage', (_event, delta: {
    openRouterSpendUsd?: number
    promptTokens?: number
    completionTokens?: number
    askCount?: number
  }) => recordLocalPlanUsage(delta) ?? null)

  ipcMain.handle('auth:connect-cursor', async (_event, apiKey?: string) => {
    const connection = await connectCursor(apiKey)
    return { ...authStatus(), connection }
  })

  ipcMain.handle('auth:connect-github', async (_event, token: string) => {
    await connectGithub(token)
    return authStatus()
  })

  ipcMain.handle('auth:github-oauth', async () => {
    const token = await signInWithGithubOAuth()
    await connectGithub(token)
    return token
  })

  ipcMain.handle('auth:open-github-token', () => {
    openGithubTokenPage()
  })

  ipcMain.handle('projects:pick-folder', (event) => pickLocalFolder(event.sender))

  ipcMain.handle('tray:request-file-access', (event, request?: FileAccessRequest) => requestTrayFileAccess(event.sender, request))
  ipcMain.handle('tray:file-access', () => trayFileAccessGranted())
  ipcMain.handle('projects:workspace-roots', () => getWorkspaceRoots())
  ipcMain.handle('projects:list-local', () => listLocalProjects())

  ipcMain.handle('documents:export-pdf', (event, input: ExportDocumentPdfInput) =>
    exportDocumentPdf(input, event.sender)
  )

  ipcMain.handle('projects:inspect-folder', (_event, path: string) => inspectLocalFolder(path))

  ipcMain.handle('projects:list-github', () => listGithubRepos())

  ipcMain.handle('projects:inspect-github', (_event, input: string) => inspectGithubRepo(input))

  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('projects:add-local', (_event, input: { path: string; name?: string; bookmark?: string }) =>
    addLocalProject(input)
  )

  ipcMain.handle('projects:add-github', (_event, input: { repo: string; name?: string }) =>
    addGithubProject(input)
  )

  ipcMain.handle('projects:remove', (_event, id: string) => removeProject(id))

  ipcMain.handle('projects:refresh', (_event, id: string) => refreshProject(id))

  ipcMain.handle('projects:select', (_event, id: string, selected: boolean) =>
    setProjectSelected(id, selected)
  )

  ipcMain.handle(
    'rag:ask',
    async (
      event,
      question: string,
      projectIds: string[],
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    ) => {
      const allowed = planAllowsAskLocal()
      if (!allowed.ok) {
        throw new Error(allowed.message)
      }

      const active = getActiveAgent()
      // Prefer a permission prompt aimed at the folder/file named in the question.
      // Attachments alone do not cover a newly named path outside granted roots.
      const accessTarget = resolveAccessTargetFromQuestion(question)
      const needsSpecific =
        Boolean(accessTarget?.defaultPath) && !isPathGranted(accessTarget!.defaultPath!)
      const needsGeneric = !trayFileAccessGranted() && !(active?.attachmentPaths.length)
      if (needsSpecific || needsGeneric) {
        const access = await requestTrayFileAccess(event.sender, {
          question,
          ...accessTarget
        })
        if (!access.granted) {
          throw new Error(
            accessTarget?.targetLabel
              ? `Access to “${accessTarget.targetLabel}” was not granted. Use /files when you are ready to add that folder.`
              : 'Folder access was not granted. Use /files when you are ready to add a folder.'
          )
        }
      }
      let scopedIds = projectIds
      let historyTurns = history
      let attachmentContext = ''

      if (active) {
        touchAgent(active.id)
        if (active.projectIds?.length) {
          scopedIds = active.projectIds
        }
        const thread = getAgentThread(active)
        if (thread?.messages.length) {
          historyTurns = thread.messages
            .filter((message) => message.text.trim())
            .map((message) => ({
              role: message.role,
              content: message.text
            }))
        }
        attachmentContext = await buildAgentAttachmentContext(active)
      }

      const publicIds = await getPublicYellowPagesProjectIds()
      const resolved = await resolveProjectsForQuestion(question, scopedIds, historyTurns)
      const searchProjectIds = uniqueProjectIds([
        ...resolved.subjectIds,
        ...resolved.projectIds,
        ...publicIds
      ])
      // When the user asks to check/list local folders (or no subject matched on a local ask),
      // scan granted roots ourselves — do not make the model ask for ls paste-back.
      const shouldInventory =
        wantsWorkspaceInventory(question) ||
        (!resolved.subjectIds.length &&
          /\b(folder|folders|project|projects|repo|repos|local|machine|computer|workspace|dev)\b/i.test(
            question
          ))
      const inventoryContext = shouldInventory ? await buildWorkspaceInventoryContext(question) : ''
      const liveContext = [attachmentContext, inventoryContext].filter(Boolean).join('\n\n') || undefined
      const preferHints = [
        active?.name || '',
        active?.slug || '',
        ...(resolved.matched?.name ? [resolved.matched.name] : []),
        ...(resolved.matched?.path ? [resolved.matched.path] : [])
      ].filter(Boolean)
      const result = await answerWithRag({
        question,
        projectIds: searchProjectIds,
        subjectIds: resolved.subjectIds,
        referenceIds: resolved.referenceIds,
        history: historyTurns,
        liveContext,
        resolutionNote: resolved.note,
        preferHints,
        enableFsTools: true,
        sender: event.sender,
        onDelta: (chunk) => event.sender.send('rag:delta', chunk)
      })

      if (active) {
        const thread = getAgentThread(active)
        if (thread) {
          appendMessage(thread.id, { role: 'user', text: question })
          appendMessage(thread.id, { role: 'assistant', text: result.text })
          touchAgent(active.id)
        }
      }

      if (result.usage) {
        recordLocalPlanUsage({
          openRouterSpendUsd: result.usage.costUsd,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          askCount: 1,
          source: 'system-ai'
        })
      } else {
        recordLocalPlanUsage({ askCount: 1, source: 'system-ai' })
      }
      return result
    }
  )

  ipcMain.handle(
    'edits:apply',
    async (
      event,
      edit: { absolutePath: string; oldText: string; newText: string }
    ) => applyProposedEdit(edit, event.sender)
  )

  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.handle('agents:get-or-create', (_event, name: string) => getOrCreateAgent(name))
  ipcMain.handle('agents:get', (_event, nameOrId: string) => getAgent(nameOrId))
  ipcMain.handle('agents:set-active', (_event, nameOrId: string | null) => {
    if (!nameOrId) {
      clearActiveAgent()
      return null
    }
    return setActiveAgent(nameOrId)
  })
  ipcMain.handle('agents:get-active', () => getActiveAgent())
  ipcMain.handle('agents:clear-active', () => {
    clearActiveAgent()
  })
  ipcMain.handle('agents:attach', (event, agentId?: string) => {
    const agent = agentId ? getAgent(agentId) : getActiveAgent()
    if (!agent) {
      throw new Error('No active agent. Use /agent <name> first.')
    }
    return pickAndAttachToAgent(agent.id, event.sender)
  })
  ipcMain.handle('agents:delete', (_event, nameOrId: string) => deleteAgent(nameOrId))
  ipcMain.handle('agents:thread', (_event, nameOrId?: string) => {
    const agent = nameOrId ? getAgent(nameOrId) : getActiveAgent()
    if (!agent) return undefined
    return getAgentThread(agent)
  })
  ipcMain.handle(
    'agents:run',
    async (event, input: { name?: string; goal: string }) => {
      const agent = input.name ? getOrCreateAgent(input.name) : getActiveAgent()
      if (!agent) {
        throw new Error('No agent. Use /agent <name> first.')
      }
      // An attachment is already explicit local context; otherwise a background
      // run gets a user-selected workspace before it attempts project discovery.
      const accessTarget = resolveAccessTargetFromQuestion(input.goal)
      const needsSpecific =
        Boolean(accessTarget?.defaultPath) && !isPathGranted(accessTarget!.defaultPath!)
      const needsGeneric = !trayFileAccessGranted() && !agent.attachmentPaths.length
      if (needsSpecific || needsGeneric) {
        const access = await requestTrayFileAccess(event.sender, {
          question: input.goal,
          ...accessTarget
        })
        if (!access.granted) {
          throw new Error(
            accessTarget?.targetLabel
              ? `Access to “${accessTarget.targetLabel}” was not granted. Use /files when you are ready to add that folder.`
              : 'Folder access was not granted. Use /files when you are ready to add a folder.'
          )
        }
      }
      return startAgentRun(agent, input.goal)
    }
  )
  ipcMain.handle('agents:stop', (_event, nameOrId?: string) => {
    const agent = nameOrId ? getAgent(nameOrId) : getActiveAgent()
    if (!agent) return { stopped: false }
    return { stopped: cancelAgentRun(agent.id) }
  })
  ipcMain.handle('agents:status', (_event, nameOrId?: string): AgentRunStatus | null => {
    const agent = nameOrId ? getAgent(nameOrId) : getActiveAgent()
    if (!agent) return null
    return getAgentRunStatus(agent.id)
  })

  ipcMain.handle('rag:search', async (_event, question: string, projectIds: string[]) => {
    const publicIds = await getPublicYellowPagesProjectIds()
    return searchRag({
      question,
      projectIds: uniqueProjectIds([...projectIds, ...publicIds])
    })
  })


  ipcMain.handle(
    'rag:handoff',
    async (
      event,
      input: {
        task: string
        targetWorkspace?: string
        projectIds: string[]
        constraints?: string
        sendToCursor?: boolean
      }
    ) => {
      const citations = await searchRag({ question: input.task, projectIds: input.projectIds, limit: 8 })
      const brief = buildCursorHandoff({
        task: input.task,
        targetWorkspace: input.targetWorkspace,
        citations,
        constraints: input.constraints
      })
      if (input.sendToCursor) {
        const text = await sendCursorPrompt(brief, (chunk) => event.sender.send('cursor:delta', chunk))
        return { brief, text, citations }
      }
      return { brief, citations }
    }
  )

  ragEvents.on('progress', (payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('rag:progress', payload)
    }
  })

  agentProgress.on('progress', (payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent:trail', payload)
    }
  })

  ipcMain.handle('auth:open-cursor-dashboard', () => {
    void shell.openExternal('https://cursor.com/dashboard')
  })

  ipcMain.handle('auth:disconnect', async () => {
    disconnectGithub()
    disconnectCursor()
    return authStatus()
  })

  ipcMain.handle('tray:set', (_event, enabled: boolean) => {
    updateSettings({ trayAsked: true, trayEnabled: enabled })
    if (enabled) {
      initTray()
    } else {
      destroyTray()
    }
    return authStatus()
  })

  ipcMain.handle('cursor:connect', async (_event, apiKey?: string) => {
    return connectCursor(apiKey)
  })

  ipcMain.handle(
    'cursor:send',
    async (event, text: string, images?: CursorImage[], threadId?: string) => {
      const allowed = planAllowsAskLocal()
      if (!allowed.ok) {
        throw new Error(allowed.message)
      }
      const reply = await sendCursorPrompt(
        text,
        (chunk) => {
          event.sender.send('cursor:delta', chunk)
        },
        images,
        threadId
      )
      recordLocalPlanUsage({ askCount: 1, source: 'cursor' })
      return reply
    }
  )

  ipcMain.handle('history:list', () => listThreads())
  ipcMain.handle('history:get', (_event, id: string) => getThread(id))
  ipcMain.handle('history:create', () => createThread())
  ipcMain.handle('history:delete', (_event, id: string) => {
    deleteThread(id)
    return listThreads()
  })

  ipcMain.handle(
    'users:set-session',
    (
      _event,
      input: { uid: string; email?: string | null; name?: string | null; photo?: string | null }
    ) => setAuthSession(input)
  )
  ipcMain.handle('users:clear-session', () => {
    clearAuthSession()
  })
  ipcMain.handle('users:track-presence', (_event, extras?: { github?: string; cursor?: boolean; platform?: string }) =>
    trackPresence(extras || {})
  )
  ipcMain.handle('users:get-profile', () => getUserProfile())
  ipcMain.handle('users:save-profile', (_event, profile) => saveUserProfile(profile))
  ipcMain.handle('users:sync-tokens-saved', (_event, localTokensSaved: number) =>
    syncTokensSaved(localTokensSaved)
  )
  ipcMain.handle('users:get-plan', () => getUserPlan())
  ipcMain.handle('users:save-plan', (_event, planId: 'free' | 'pro') => saveUserPlan(planId))
  ipcMain.handle('users:sync-usage', (_event, entry) => syncUsageFromLocal(entry))
  ipcMain.handle('users:list-usage', (_event, limitCount?: number) => listUsageLogs(limitCount))
  ipcMain.handle('users:track-event', (_event, name: string, payload?: Record<string, string | boolean>) =>
    trackEvent(name, payload)
  )
  ipcMain.handle('users:presence-stats', () => readPresenceStats())

  ipcMain.handle('companion:start', () => {
    startCompanion()
  })

  ipcMain.handle('companion:stop', () => {
    stopCompanion()
  })

  ipcMain.handle('companion:select-ai', (_event, engine?: string) => {
    if (engine === 'cursor' || engine === 'system') {
      void selectCompanionAi(engine)
    }
  })

  ipcMain.handle('jarvis:hide', () => {
    hideJarvis()
  })

  ipcMain.handle(
    'jarvis:submit',
    (_event, note?: string, options?: { includeScreen?: boolean; pin?: boolean }) => {
      submitJarvisNote(note, options)
    }
  )

  ipcMain.handle('jarvis:pin', () => {
    pinJarvisContext()
  })

  ipcMain.handle('jarvis:insert', (_event, mode?: 'paste' | 'reply') => {
    insertJarvisDraft(mode === 'reply' ? 'reply' : 'paste')
  })

  ipcMain.handle('jarvis:copy', () => {
    return copyJarvisDraft()
  })

  ipcMain.handle('snip:gain', () => {
    return getSnipGain()
  })

  setOpenAppHandler(() => {
    showMainWindow()
  })

  setTrayClickHandler(() => {
    if (isCompanionActive()) {
      stopCompanion()
    }
  })

  const settings = getSettings()
  if (settings.cursorKey) {
    void connectCursor(settings.cursorKey).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
    })
  }

  if (settings.trayEnabled) {
    initTray()
  }

  void migrateRag()
    .then(() => migrateUsers())
    .then(() => ensurePublicYellowPagesSeeded())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
    })

  createWindow()

  app.on('activate', function () {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  stopCompanion()
  void disposeCursor()
  void closeRag()
})

app.on('window-all-closed', () => {
  if (getSettings().trayEnabled) {
    return
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
