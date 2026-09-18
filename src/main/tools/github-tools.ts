import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { parseGithubRepo } from '../github'
import { getWorkspaceRoots, isPathGranted } from '../local-folder'
import { getSettings } from '../settings'
import { appendAudit } from './audit-log'
import { createRoweOctokit, getGithubAuthMode, githubCloneToken } from './octokit-client'
import { putPending } from './pending'
import type { ToolCallResponse, ToolContext } from './types'

const execFileAsync = promisify(execFile)

function repoParts(params: Record<string, unknown>): { owner: string; repo: string } {
  const raw = String(params.repo || params.repository || '')
  if (!raw) throw new Error('Missing repo (owner/name)')
  return parseGithubRepo(raw)
}

function assertUnderRoots(absolute: string): void {
  const roots = getWorkspaceRoots()
  const ok =
    roots.some((root) => absolute === root || absolute.startsWith(root.endsWith('/') ? root : `${root}/`)) ||
    isPathGranted(absolute) ||
    isPathGranted(dirname(absolute))
  if (!ok) throw new Error(`Blocked path outside granted folders: ${absolute}`)
}

function cloneUrl(owner: string, repo: string): string {
  const token = githubCloneToken()
  if (!token) {
    throw new Error(
      'Clone needs a user GitHub token (Settings). GitHub App install tokens are not used for git clone in this build.'
    )
  }
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return `${stdout || ''}${stderr || ''}`.trim()
}

export async function runGithubTool(
  tool: string,
  params: Record<string, unknown>,
  requestId: string,
  ctx: ToolContext
): Promise<ToolCallResponse> {
  const trusted = ctx.trusted ?? Boolean(getSettings().trustedMode)

  const execute = async (): Promise<ToolCallResponse> => {
    try {
      if (tool === 'github.clone') {
        const { owner, repo } = repoParts(params)
        const roots = getWorkspaceRoots()
        if (!roots.length) throw new Error('Grant a folder first, then clone into it.')
        const dest = resolve(
          String(params.path || params.dest || resolve(roots[0], repo))
        )
        assertUnderRoots(dest)
        if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`)
        mkdirSync(dirname(dest), { recursive: true })
        const out = await git(dirname(dest), ['clone', cloneUrl(owner, repo), dest])
        // scrub token from any accidental echo
        appendAudit({ tool, action: 'clone', path: dest, status: 'success', detail: `${owner}/${repo}` })
        return {
          requestId,
          status: 'success',
          result: { path: dest, owner, repo, summary: `Cloned ${owner}/${repo} → ${dest}`, log: out.slice(0, 500) }
        }
      }

      if (tool === 'github.pull') {
        const cwd = resolve(String(params.path || params.cwd || ''))
        if (!cwd || !existsSync(cwd)) throw new Error('pull requires an existing local repo path')
        assertUnderRoots(cwd)
        const out = await git(cwd, ['pull', '--ff-only'])
        appendAudit({ tool, action: 'pull', path: cwd, status: 'success', detail: out.slice(0, 200) })
        return { requestId, status: 'success', result: { path: cwd, summary: 'Pulled latest', log: out.slice(0, 1000) } }
      }

      if (tool === 'github.push') {
        const cwd = resolve(String(params.path || params.cwd || ''))
        if (!cwd || !existsSync(cwd)) throw new Error('push requires an existing local repo path')
        assertUnderRoots(cwd)
        const remote = String(params.remote || 'origin')
        const branch = String(params.branch || '').trim()
        const args = branch ? ['push', '-u', remote, branch] : ['push', remote]
        // Rewrite origin URL with token for HTTPS remotes when possible
        try {
          const url = await git(cwd, ['remote', 'get-url', remote])
          const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i)
          if (m) {
            await git(cwd, ['remote', 'set-url', remote, cloneUrl(m[1], m[2])])
          }
        } catch {
          /* keep existing remote */
        }
        const out = await git(cwd, args)
        appendAudit({ tool, action: 'push', path: cwd, status: 'success', detail: out.slice(0, 200) })
        return { requestId, status: 'success', result: { path: cwd, summary: 'Pushed to remote', log: out.slice(0, 1000) } }
      }

      const api = createRoweOctokit()
      const authMode = getGithubAuthMode()

      if (tool === 'github.create_branch') {
        const { owner, repo } = repoParts(params)
        const branch = String(params.branch || params.name || '').trim()
        if (!branch) throw new Error('Missing branch name')
        const from = String(params.from || params.base || '').trim()
        let sha = String(params.sha || '')
        if (!sha) {
          const base = from || (await api.repos.get({ owner, repo })).data.default_branch
          const ref = await api.git.getRef({ owner, repo, ref: `heads/${base}` })
          sha = ref.data.object.sha
        }
        await api.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha })
        appendAudit({ tool, action: 'create_branch', status: 'success', detail: `${owner}/${repo}@${branch}` })
        return {
          requestId,
          status: 'success',
          result: { owner, repo, branch, sha, authMode, summary: `Created branch ${branch}` }
        }
      }

      if (tool === 'github.commit_files') {
        const { owner, repo } = repoParts(params)
        const branch = String(params.branch || '').trim()
        const message = String(params.message || params.commitMessage || '').trim()
        const files = params.files
        if (!branch) throw new Error('Missing branch')
        if (!message) throw new Error('Missing commit message')
        if (!Array.isArray(files) || !files.length) throw new Error('Missing files[]')

        const ref = await api.git.getRef({ owner, repo, ref: `heads/${branch}` })
        const baseSha = ref.data.object.sha
        const baseCommit = await api.git.getCommit({ owner, repo, commit_sha: baseSha })
        const treeItems: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = []
        for (const file of files) {
          const item = file as { path?: string; content?: string }
          if (!item?.path || typeof item.content !== 'string') continue
          const blob = await api.git.createBlob({
            owner,
            repo,
            content: item.content,
            encoding: 'utf-8'
          })
          treeItems.push({ path: item.path, mode: '100644', type: 'blob', sha: blob.data.sha })
        }
        if (!treeItems.length) throw new Error('No valid files to commit')
        const tree = await api.git.createTree({
          owner,
          repo,
          base_tree: baseCommit.data.tree.sha,
          tree: treeItems
        })
        const commit = await api.git.createCommit({
          owner,
          repo,
          message,
          tree: tree.data.sha,
          parents: [baseSha]
        })
        await api.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha })
        appendAudit({
          tool,
          action: 'commit_files',
          status: 'success',
          detail: `${owner}/${repo}@${branch} ${commit.data.sha.slice(0, 7)}`
        })
        return {
          requestId,
          status: 'success',
          result: {
            owner,
            repo,
            branch,
            sha: commit.data.sha,
            authMode,
            summary: `Committed ${treeItems.length} file(s) to ${branch}`
          }
        }
      }

      if (tool === 'github.open_pr') {
        const { owner, repo } = repoParts(params)
        const head = String(params.head || params.branch || '').trim()
        const base = String(params.base || 'main').trim()
        const title = String(params.title || head || 'Update').trim()
        const body = String(params.body || params.description || '')
        if (!head) throw new Error('Missing head branch')
        const pr = await api.pulls.create({ owner, repo, head, base, title, body })
        appendAudit({ tool, action: 'open_pr', status: 'success', detail: pr.data.html_url })
        return {
          requestId,
          status: 'success',
          result: {
            number: pr.data.number,
            url: pr.data.html_url,
            authMode,
            summary: `Opened PR #${pr.data.number}`
          }
        }
      }

      if (tool === 'github.get_repo') {
        const { owner, repo } = repoParts(params)
        const info = await api.repos.get({ owner, repo })
        return {
          requestId,
          status: 'success',
          result: {
            fullName: info.data.full_name,
            defaultBranch: info.data.default_branch,
            private: info.data.private,
            htmlUrl: info.data.html_url,
            authMode
          }
        }
      }

      return { requestId, status: 'error', error: `Unknown github tool: ${tool}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub tool failed'
      appendAudit({ tool, action: tool, status: 'error', detail: message })
      if (/not connected|GITHUB_APP/i.test(message)) {
        return { requestId, status: 'needs_permission', error: message }
      }
      return { requestId, status: 'error', error: message }
    }
  }

  const mutating = new Set([
    'github.create_branch',
    'github.commit_files',
    'github.open_pr',
    'github.clone',
    'github.push'
  ])
  if (mutating.has(tool) && !trusted) {
    putPending(requestId, { tool, params, requestId }, execute)
    appendAudit({ tool, action: tool, status: 'pending', detail: 'Awaiting confirmation' })
    return {
      requestId,
      status: 'needs_confirmation',
      confirmation: {
        title:
          tool === 'github.open_pr'
            ? 'Confirm open pull request'
            : tool === 'github.push'
              ? 'Confirm git push'
              : tool === 'github.clone'
                ? 'Confirm git clone'
                : 'Confirm GitHub write',
        summary: `${tool} ${String(params.repo || params.path || '')}`,
        danger: tool === 'github.commit_files' || tool === 'github.open_pr' || tool === 'github.push',
        preview: { tool, params }
      }
    }
  }

  return execute()
}
