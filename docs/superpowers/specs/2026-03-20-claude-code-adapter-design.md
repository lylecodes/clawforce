# Claude Code Adapter — Design Spec

## Overview

Makes ClawForce work with Claude Code as an alternative to OpenClaw. Separate adapter (not shared interface) — both call the same core functions through different integration mechanisms.

## Architecture

```
ClawForce Core (framework-agnostic)
    |
    +-- OpenClaw Adapter (existing, plugin lifecycle hooks)
    |
    +-- Claude Code Adapter (new, CC hooks + claude -p subprocess)
    |
    +-- SDK (Clawforce class — already framework-agnostic)
```

## Integration Mapping

| OpenClaw Hook | Claude Code Equivalent |
|---|---|
| before_prompt_build | SessionStart hook + --append-system-prompt |
| before_tool_call | PreToolUse hook → { decision: "block" } |
| after_tool_call | PostToolUse hook |
| agent_end | Stop/SessionEnd hook + dispatch wrapper |
| llm_output | --output-format json parsing |
| Cron dispatch | claude -p subprocess |
| Tool registration | MCP server |

## Key Components

### 1. Dispatch via `claude -p`
Instead of OpenClaw cron API, spawn headless Claude processes:
```bash
claude -p "task prompt" --append-system-prompt "context" --output-format json --permission-mode auto --mcp-config clawforce-tools.json
```

### 2. ClawForce Tools via MCP Server
Stdio MCP server exposing all 10 ClawForce tools (clawforce_task, clawforce_log, etc.) — same tool logic, different registration.

### 3. Hook Scripts
Shell scripts installed in `.claude/settings.json` that call ClawForce core for:
- Context injection (SessionStart)
- Policy enforcement (PreToolUse)
- Tool tracking (PostToolUse)
- Compliance check (Stop/SessionEnd)

### 4. Runner Process
Persistent process that replaces what OpenClaw gateway does:
- Initializes ClawForce domains
- Runs dispatch loop (claims queue → spawns `claude -p`)
- Runs sweep timer
- Starts dashboard server
- Manages scheduling via node-cron

### 5. Agent Identity
Via environment variables set by runner when dispatching:
- `CLAWFORCE_AGENT_ID`
- `CLAWFORCE_SESSION_KEY`
- `CLAWFORCE_PROJECT_ID`

## Configuration

```yaml
# ~/.clawforce/config.yaml
adapter: claude-code  # or "openclaw" (default)

claude_code:
  binary: claude
  model: claude-opus-4-6
  permission_mode: auto
  max_budget_per_dispatch: 1.00
```

## Feature Parity

Full parity except:
- **Message injection** — CC has no API to inject into running sessions. Start new session instead.
- **Ghost memory recall** — needs alternative RAG solution (file-based or SQLite FTS)

## Implementation Phases

1. Foundation — dispatch.ts, runner.ts, mcp-server.ts
2. Hooks — session-start, pre-tool-use, post-tool-use, session-end scripts + installer
3. Runner integration — dispatch loop, scheduling, cost tracking
4. Testing — dispatch lifecycle, hook enforcement, e2e governance cycle
