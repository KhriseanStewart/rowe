import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

export type ProjectSource = 'github' | 'local' | 'yellow_pages'
export type ProjectStatus = 'indexing' | 'ready' | 'failed'

export type ReferenceProject = {
  id: string
  name: string
  source: ProjectSource
  location: string
  status: ProjectStatus
  selected: boolean
  files: number
  chunks?: number
  addedAt: number
  error?: string
  filesSeen?: number
  filesTotal?: number
  chunksWritten?: number
}

type GithubRepo = {
  name: string
  fullName: string
  description?: string
  private: boolean
  htmlUrl: string
  updatedAt: string
}


type ProjectLibraryProps = {
  projects: ReferenceProject[]
  onProjectsChange: Dispatch<SetStateAction<ReferenceProject[]>>
  onClose: () => void
  initialSource?: ProjectSource
  github?: { login: string }
  githubOAuth?: boolean
  onGithubConnected: () => Promise<void>
}

const minimumProjects = 3

/** Electron wraps IPC throws as "Error invoking remote method 'x': Error: message". */
function formatRemoteError(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : fallback
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  return cleaned || fallback
}


export default function ProjectLibrary({
  projects,
  onProjectsChange,
  onClose,
  initialSource = 'github',
  github,
  githubOAuth,
  onGithubConnected
}: ProjectLibraryProps): React.JSX.Element {
  const [source, setSource] = useState<ProjectSource>(initialSource)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [githubTab, setGithubTab] = useState<'oauth' | 'key'>('oauth')
  const [connecting, setConnecting] = useState(false)
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [repoQuery, setRepoQuery] = useState('')
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [pendingRepo, setPendingRepo] = useState<string | null>(null)
  const [pendingLocal, setPendingLocal] = useState<string | null>(null)

  const readyCount = projects.filter((project) => project.status === 'ready').length
  const selectedCount = projects.filter(
    (project) => project.selected && project.status === 'ready'
  ).length
  const availableRepos = useMemo(() => {
    const query = repoQuery.trim().toLowerCase()
    const added = new Set(projects.map((project) => project.location.toLowerCase()))
    return repos.filter((repo) => {
      if (added.has(repo.fullName.toLowerCase())) {
        return false
      }
      if (!query) {
        return true
      }
      return (
        repo.fullName.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query) ||
        (repo.private && 'private'.includes(query))
      )
    })
  }, [projects, repoQuery, repos])

  useEffect(() => {
    setSource(initialSource)
  }, [initialSource])

  // Keep the library list in sync with the DB (fixes empty UI while Add says "already in library").
  useEffect(() => {
    let cancelled = false
    void window.api
      .listProjects()
      .then((next) => {
        if (!cancelled) onProjectsChange(next)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(formatRemoteError(caught, 'Could not load your project library.'))
      })
    return () => {
      cancelled = true
    }
  }, [onProjectsChange])

  useEffect(() => {
    if (!github || source !== 'github') {
      return
    }
    let cancelled = false
    setLoadingRepos(true)
    setError('')
    void window.api
      .listGithubRepos()
      .then((next) => {
        if (!cancelled) {
          setRepos(next)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(formatRemoteError(caught, 'Could not load GitHub projects.'))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRepos(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [github, source])

  const addGithubRepo = async (repo: GithubRepo): Promise<void> => {
    setAdding(true)
    setPendingRepo(repo.fullName)
    setError('')
    try {
      const project = await window.api.addGithubProject({
        repo: repo.fullName,
        name: repo.name
      })
      onProjectsChange((current) => [project, ...current.filter((item) => item.id !== project.id)])
    } catch (caught) {
      setError(formatRemoteError(caught, 'Could not add that GitHub project.'))
    } finally {
      setAdding(false)
      setPendingRepo(null)
    }
  }

  const addAllGithubRepos = async (): Promise<void> => {
    const batch = availableRepos.slice(0, 20)
    if (!batch.length) return
    setAdding(true)
    setError('')
    try {
      for (const repo of batch) {
        setPendingRepo(repo.fullName)
        const project = await window.api.addGithubProject({
          repo: repo.fullName,
          name: repo.name
        })
        onProjectsChange((current) => [project, ...current.filter((item) => item.id !== project.id)])
      }
    } catch (caught) {
      setError(formatRemoteError(caught, 'Could not add those GitHub projects.'))
    } finally {
      setAdding(false)
      setPendingRepo(null)
    }
  }

  const browseDevice = async (): Promise<void> => {

    setError('')
    const picked = await window.api.pickLocalFolder()
    if (!picked?.path) {
      return
    }
    setSource('local')
    setAdding(true)
    setPendingLocal(picked.path)
    try {
      const project = await window.api.addLocalProject({
        path: picked.path,
        bookmark: picked.bookmark
      })
      onProjectsChange((current) => [project, ...current.filter((item) => item.id !== project.id)])
    } catch (caught) {
      setError(formatRemoteError(caught, 'Could not add that folder.'))
    } finally {
      setAdding(false)
      setPendingLocal(null)
    }
  }

  const connectGithub = async (work: () => Promise<void>): Promise<void> => {
    setError('')
    setConnecting(true)
    try {
      await work()
      await onGithubConnected()
    } catch (caught) {
      setError(formatRemoteError(caught, 'Could not connect GitHub.'))
    } finally {
      setConnecting(false)
    }
  }

  const toggleProject = (id: string): void => {
    const project = projects.find((item) => item.id === id)
    if (!project) {
      return
    }
    void window.api.selectProject(id, !project.selected).then(onProjectsChange).catch((caught: unknown) => {
      setError(formatRemoteError(caught, 'Could not update that project.'))
    })
  }

  const removeProject = (id: string): void => {
    void window.api.removeProject(id).then(onProjectsChange).catch((caught: unknown) => {
      setError(formatRemoteError(caught, 'Could not remove that project.'))
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 pb-10">
      <div className="mx-auto w-full max-w-xl">
        <header className="flex items-center justify-between gap-3 py-4">
          <button type="button" className="ui-link text-[13px]" onClick={onClose}>
            ← Back to chat
          </button>
          <p className="text-[13px] font-semibold text-agent-text-soft">
            {readyCount} ready{readyCount < minimumProjects ? ` · need ${minimumProjects}` : ''}
          </p>
        </header>

        <section className="rounded-2xl border border-agent-stroke bg-agent-surface p-4">
          <div className="ui-tabs" role="tablist" aria-label="Project source">
            <button
              type="button"
              className="ui-tab"
              data-on={source === 'github'}
              onClick={() => {
                setSource('github')
                setError('')
              }}
            >
              GitHub
            </button>
            <button
              type="button"
              className="ui-tab"
              data-on={source === 'local'}
              onClick={() => {
                setSource('local')
                setError('')
              }}
            >
              This device
            </button>
          </div>

          {source === 'github' ? (
            github ? (
              <div className="mt-4 flex flex-col gap-3">
                <p className="text-[12px] leading-5 text-agent-text-soft">
                  Connected as {github.login}. Private and public repos you can access are listed —
                  add specific ones, or add all visible.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    className="ui-input min-w-0 flex-1"
                    value={repoQuery}
                    onChange={(event) => setRepoQuery(event.target.value)}
                    placeholder="Search repositories"
                  />
                  <button
                    type="button"
                    className="ui-btn shrink-0"
                    disabled={adding || availableRepos.length === 0}
                    onClick={() => {
                      void addAllGithubRepos()
                    }}
                  >
                    Add all
                  </button>
                </div>
                <div className="repo-list">
                  {loadingRepos ? (
                    <p className="px-3 py-10 text-center text-[13px] text-agent-text-soft">Loading…</p>
                  ) : availableRepos.length === 0 ? (
                    <p className="px-3 py-10 text-center text-[13px] text-agent-text-soft">
                      {repos.length ? 'Every matching repo is already added.' : 'No repositories found.'}
                    </p>
                  ) : (
                    availableRepos.slice(0, 30).map((repo) => (
                      <button
                        type="button"
                        key={repo.fullName}
                        className="repo-row"
                        disabled={adding}
                        onClick={() => {
                          void addGithubRepo(repo)
                        }}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-semibold">{repo.name}</span>
                            {repo.private ? (
                              <span className="shrink-0 rounded-md bg-agent-fill px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-agent-text-soft">
                                Private
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block truncate text-[12px] text-agent-text-soft">
                            {repo.fullName}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] font-semibold text-agent-accent">
                          {pendingRepo === repo.fullName ? 'Adding…' : 'Add'}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-5 flex flex-col gap-3">
                <p className="text-[12px] leading-5 text-agent-text-soft">
                  Sign in with repo access to list private and public repositories, then choose which
                  ones to add.
                </p>
                {githubTab === 'key' ? (
                  <>
                    <input
                      className="ui-input"
                      value={githubToken}
                      onChange={(event) => setGithubToken(event.target.value)}
                      placeholder="ghp_…"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary"
                      disabled={connecting || !githubToken.trim()}
                      onClick={() => {
                        void connectGithub(async () => {
                          await window.api.connectGithub(githubToken)
                        })
                      }}
                    >
                      Save token
                    </button>
                    <button
                      type="button"
                      className="ui-link self-center text-[13px]"
                      onClick={() => setGithubTab('oauth')}
                    >
                      Use GitHub sign-in
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary"
                      disabled={connecting || !githubOAuth}
                      onClick={() => {
                        void connectGithub(async () => {
                          await window.api.connectGithubOAuth()
                        })
                      }}
                    >
                      {connecting ? 'Opening GitHub…' : 'Continue with GitHub'}
                    </button>
                    <button
                      type="button"
                      className="ui-link self-center text-[13px]"
                      onClick={() => setGithubTab('key')}
                    >
                      Use a token instead
                    </button>
                  </>
                )}
              </div>
            )
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              <p className="text-[12px] leading-5 text-agent-text-soft">
                Add a local project by browsing to its folder on this device. Rowe indexes only what
                you choose — nothing is scanned automatically.
              </p>
              <button
                type="button"
                className="ui-btn ui-btn-primary w-full"
                disabled={adding}
                onClick={() => {
                  void browseDevice()
                }}
              >
                {adding
                  ? pendingLocal
                    ? 'Adding…'
                    : 'Waiting…'
                  : 'Browse for a folder…'}
              </button>
              <p className="text-center text-[12px] text-agent-text-soft">
                Choose the project folder you want Rowe to index.
              </p>
            </div>
          )}

          {error ? <p className="ui-error mt-3">{error}</p> : null}
        </section>

        {projects.length > 0 ? (
          <section className="mt-8">
            <p className="mb-3 text-[13px] font-semibold text-agent-text-soft">
              In your library{selectedCount ? ` · ${selectedCount} selected` : ''}
            </p>
            <div className="flex flex-col gap-2">
              {projects
                .filter((project) => project.source !== 'yellow_pages')
                .map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onToggle={() => toggleProject(project.id)}
                  onRemove={() => removeProject(project.id)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}

function shortPath(path: string): string {
  const match = path.match(/^\/Users\/[^/]+(\/.*)?$/)
  if (match) {
    return `~${match[1] || ''}`
  }
  return path
}

function ProjectCard({
  project,
  onToggle,
  onRemove
}: {
  project: ReferenceProject
  onToggle: () => void
  onRemove: () => void
}): React.JSX.Element {
  const sourceLabel = project.source === 'github' ? 'GitHub' : 'Local'
  return (
    <article className="flex items-center gap-3 rounded-xl border border-agent-stroke bg-agent-surface px-3 py-3">
      <button
        type="button"
        className={`grid size-5 shrink-0 place-items-center rounded-md border ${
          project.selected
            ? 'border-agent-accent bg-agent-accent text-white'
            : 'border-agent-stroke text-transparent'
        }`}
        aria-label={`${project.selected ? 'Deselect' : 'Select'} ${project.name}`}
        onClick={onToggle}
      >
        <CheckIcon />
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-[14px] font-semibold">
          <span className="truncate">{project.name}</span>
          <span className="shrink-0 rounded-md bg-agent-fill px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-agent-text-soft">
            {sourceLabel}
          </span>
        </p>
        <p className="truncate text-[12px] text-agent-text-soft">
          {project.status === 'indexing'
            ? project.filesTotal
              ? `Indexing ${project.filesSeen ?? 0}/${project.filesTotal} · ${project.chunksWritten ?? 0} chunks`
              : 'Indexing…'
            : project.status === 'failed'
              ? 'Indexing failed'
              : project.files
                ? `${project.files} files${project.chunks ? ` · ${project.chunks} chunks` : ''}`
                : shortPath(project.location)}
        </p>
        {project.error ? <p className="truncate text-[12px] text-agent-danger">{project.error}</p> : null}
      </div>
      <button
        type="button"
        className="project-icon-btn project-icon-btn-danger"
        aria-label={`Remove ${project.name}`}
        onClick={onRemove}
      >
        <TrashIcon />
      </button>
    </article>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m3 8.2 3.1 3.1L13 4.8" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3.2 4.5h9.6M6.1 4.5V3h3.8v1.5m-6 0 .5 8.5h7.2l.5-8.5M6.8 7v3.8m2.4-3.8v3.8" />
    </svg>
  )
}
