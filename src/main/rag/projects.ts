import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { inspectGithubRepo } from '../github'
import { inspectLocalFolder, rememberFolderBookmark, withFolderAccess } from '../local-folder'
import { ragOwnerId } from '../users'
import { getPool, migrateRag } from './db'
import { ragEvents } from './events'
import { checkoutGithubRepo } from './github-source'
import { indexDirectory } from './ingest'

export type StoredProject = {
  id: string
  name: string
  source: 'github' | 'local' | 'yellow_pages'
  location: string
  status: 'indexing' | 'ready' | 'failed'
  selected: boolean
  files: number
  chunks?: number
  addedAt: number
  error?: string
}

type ProjectRow = {
  id: string
  name: string
  source_type: 'github' | 'local' | 'yellow_pages'
  source_ref: string
  selected: boolean
  status: string
  files: number
  chunks: number
  created_at: Date
  error: string | null
}

export async function listProjects(): Promise<StoredProject[]> {
  await migrateRag()
  const owner = ragOwnerId()
  const result = await getPool().query<ProjectRow>(
    `SELECT id, name, source_type, source_ref, selected, status, files, chunks, created_at, error
     FROM rag_projects
     WHERE owner_id = $1 OR owner_id = 'public'
     ORDER BY
       CASE WHEN source_type = 'yellow_pages' THEN 0 ELSE 1 END,
       created_at DESC`,
    [owner]
  )
  // Yellow Pages is an internal retrieval source — never surface it in the library UI.
  return result.rows.map(mapRow).filter((project) => project.source !== 'yellow_pages')
}

export async function selectedReadyProjects(): Promise<StoredProject[]> {
  const projects = await listProjects()
  return projects.filter((project) => project.selected && project.status === 'ready')
}

export async function addLocalProject(input: {
  path: string
  name?: string
  bookmark?: string
}): Promise<StoredProject> {
  await migrateRag()
  if (input.bookmark) {
    rememberFolderBookmark(input.path, input.bookmark)
  }
  const folder = inspectLocalFolder(input.path)
  const id = await insertProject({
    name: input.name?.trim() || folder.name,
    source: 'local',
    location: folder.path
  })
  return indexProject(id, folder.path)
}

/** Index a local folder if needed; reuse an existing library entry for the same path. */
export async function ensureLocalProject(input: {
  path: string
  name?: string
}): Promise<StoredProject> {
  await migrateRag()
  const folder = inspectLocalFolder(input.path)
  const existing = await getPool().query<ProjectRow>(
    `SELECT id, name, source_type, source_ref, selected, status, files, chunks, created_at, error
       FROM rag_projects
      WHERE owner_id = $1 AND source_ref = $2
      LIMIT 1`,
    [ragOwnerId(), folder.path]
  )
  if (existing.rows[0]) {
    const project = mapRow(existing.rows[0])
    if (!project.selected) {
      await getPool().query(
        `UPDATE rag_projects SET selected = true, updated_at = now() WHERE id = $1`,
        [project.id]
      )
      project.selected = true
    }
    if (project.status === 'ready') return project
    return indexProject(project.id, folder.path)
  }
  return addLocalProject({
    path: folder.path,
    name: input.name?.trim() || folder.name
  })
}

export async function addGithubProject(input: { repo: string; name?: string }): Promise<StoredProject> {
  await migrateRag()
  const repo = await inspectGithubRepo(input.repo)
  const existing = await getPool().query<ProjectRow>(
    `SELECT id, name, source_type, source_ref, selected, status, files, chunks, created_at, error
       FROM rag_projects
      WHERE owner_id = $1 AND source_ref = $2
      LIMIT 1`,
    [ragOwnerId(), repo.fullName]
  )
  if (existing.rows[0]) {
    const project = mapRow(existing.rows[0])
    if (!project.selected) {
      await getPool().query(
        `UPDATE rag_projects SET selected = true, updated_at = now() WHERE id = $1`,
        [project.id]
      )
      project.selected = true
    }
    if (project.status === 'ready') {
      return project
    }
    try {
      const root = await checkoutGithubRepo(repo)
      const indexed = await indexProject(project.id, root)
      await getPool().query(
        `UPDATE rag_projects SET branch = COALESCE($2, branch), commit_sha = $3, updated_at = now() WHERE id = $1`,
        [project.id, repo.defaultBranch || null, repo.commitSha || null]
      )
      return getProject(project.id).catch(() => indexed)
    } catch (caught) {
      return failProject(project.id, caught)
    }
  }

  const id = await insertProject({
    name: input.name?.trim() || repo.name,
    source: 'github',
    location: repo.fullName
  })
  try {
    const root = await checkoutGithubRepo(repo)
    const project = await indexProject(id, root)
    await getPool().query(
      `UPDATE rag_projects SET branch = COALESCE($2, branch), commit_sha = $3, updated_at = now() WHERE id = $1`,
      [id, repo.defaultBranch || null, repo.commitSha || null]
    )
    return getProject(id).catch(() => project)
  } catch (caught) {
    return failProject(id, caught)
  }
}

export async function removeProject(id: string): Promise<StoredProject[]> {
  await migrateRag()
  const project = await getProject(id).catch(() => null)
  if (project?.source === 'yellow_pages') {
    throw new Error('That project cannot be removed.')
  }
  await getPool().query('DELETE FROM rag_projects WHERE id = $1 AND owner_id <> $2', [id, 'public'])
  if (project?.source === 'github') {
    const dest = join(app.getPath('userData'), 'rag', 'github', project.location.replaceAll('/', '__'))
    rmSync(dest, { recursive: true, force: true })
  }
  return listProjects()
}

export async function refreshProject(id: string): Promise<StoredProject> {
  await migrateRag()
  const project = await getProject(id)
  if (project.source === 'local') {
    inspectLocalFolder(project.location)
    return indexProject(id, project.location)
  }
  try {
    const repo = await inspectGithubRepo(project.location)
    const root = await checkoutGithubRepo(repo)
    return indexProject(id, root)
  } catch (caught) {
    return failProject(id, caught)
  }
}

export async function setProjectSelected(id: string, selected: boolean): Promise<StoredProject[]> {
  await migrateRag()
  await getPool().query(
    `UPDATE rag_projects SET selected = $2, updated_at = now() WHERE id = $1`,
    [id, selected]
  )
  return listProjects()
}

async function insertProject(input: {
  name: string
  source: 'github' | 'local' | 'yellow_pages'
  location: string
}): Promise<string> {
  const owner = ragOwnerId()
  const existing = await getPool().query<{ id: string }>(
    `SELECT id FROM rag_projects WHERE owner_id = $1 AND source_ref = $2`,
    [owner, input.location]
  )
  if (existing.rows[0]) {
    throw new Error(
      input.source === 'github'
        ? 'That GitHub project is already in your library.'
        : 'That folder is already in your library.'
    )
  }
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO rag_projects (id, owner_id, name, source_type, source_ref, selected, status, files, chunks)
     VALUES ($1, $2, $3, $4, $5, true, 'indexing', 0, 0)`,
    [id, owner, input.name, input.source, input.location]
  )
  ragEvents.progress({
    projectId: id,
    status: 'indexing',
    filesSeen: 0,
    filesTotal: 0,
    chunksWritten: 0
  })
  return id
}

async function indexProject(id: string, root: string): Promise<StoredProject> {
  await getPool().query(
    `UPDATE rag_projects SET status = 'indexing', error = NULL, updated_at = now() WHERE id = $1`,
    [id]
  )
  ragEvents.progress({
    projectId: id,
    status: 'indexing',
    filesSeen: 0,
    filesTotal: 0,
    chunksWritten: 0
  })
  try {
    const result = await withFolderAccess(root, () => indexDirectory(id, root))
    await getPool().query(
      `UPDATE rag_projects
          SET status = 'ready', files = $2, chunks = $3, error = NULL, updated_at = now()
        WHERE id = $1`,
      [id, result.files, result.chunks]
    )
    ragEvents.progress({
      projectId: id,
      status: 'ready',
      filesSeen: result.files,
      filesTotal: result.files,
      chunksWritten: result.chunks
    })
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Indexing failed'
    await getPool().query(
      `UPDATE rag_projects SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [id, message]
    )
    ragEvents.progress({
      projectId: id,
      status: 'failed',
      filesSeen: 0,
      filesTotal: 0,
      chunksWritten: 0,
      error: message
    })
  }
  return getProject(id)
}

async function failProject(id: string, caught: unknown): Promise<StoredProject> {
  const message = caught instanceof Error ? caught.message : 'Project setup failed'
  await getPool().query(
    `UPDATE rag_projects SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [id, message]
  )
  ragEvents.progress({
    projectId: id,
    status: 'failed',
    filesSeen: 0,
    filesTotal: 0,
    chunksWritten: 0,
    error: message
  })
  return getProject(id)
}

async function getProject(id: string): Promise<StoredProject> {
  const result = await getPool().query<ProjectRow>(
    `SELECT id, name, source_type, source_ref, selected, status, files, chunks, created_at, error
     FROM rag_projects WHERE id = $1`,
    [id]
  )
  if (!result.rows[0]) {
    throw new Error('Project was not found.')
  }
  return mapRow(result.rows[0])
}

function mapRow(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    name: row.name,
    source: row.source_type,
    location: row.source_ref,
    status: row.status === 'indexing' ? 'indexing' : row.status === 'failed' ? 'failed' : 'ready',
    selected: row.selected,
    files: row.files,
    chunks: row.chunks,
    addedAt: row.created_at.getTime(),
    error: row.error || undefined
  }
}
