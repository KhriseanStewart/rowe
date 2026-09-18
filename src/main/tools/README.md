# Rowe main-process tools

JSON contract (IPC `tools:invoke` / `tools:confirm`):

```json
{ "tool": "filesystem.write", "params": { "path": "...", "content": "..." }, "requestId": "…" }
{ "requestId": "…", "status": "success|error|needs_permission|needs_confirmation", "result": {}, "confirmation": {} }
```

Trusted mode (`settings.trustedMode`) skips confirmation for mutating tools.

Chat streaming remains IPC (`rag:delta`). Optional localhost WebSocket: `tools:stream-port` → `ws://127.0.0.1:<port>` for tool/LLM bridge events.

## Tool names

- filesystem.list | read | write | mkdir | delete | exists | patch | shell
- documents.pdf | docx | xlsx | md | reveal
- github.create_branch | commit_files | open_pr | get_repo | clone | pull | push
- screenshot.list_windows | capture
- os.click | type | key | focus_window

## GitHub auth

1. **GitHub App** when `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (or `_PATH`), and `GITHUB_APP_INSTALLATION_ID` are set.
2. Else **OAuth/PAT** from Settings (`getGithubToken()`). Clone/pull/push HTTPS uses the user token.
