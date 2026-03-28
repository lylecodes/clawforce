# Team Watcher Example

Demonstrates the team-watcher pattern: one team observes another's work to improve the shared platform.

- `platform-lead` watches the product team's task lifecycle via scoped `observe` entries
- Product team events (task creation, assignment, completion) appear in platform-lead's briefing
- Platform-lead creates improvement tasks for its own team based on what it sees — it does not intervene in product work

## Key config

```yaml
# platform-lead watches product team events
observe:
  - pattern: "task.*"
    scope:
      team: "product"
```

## Files

- `config.yaml` — Two teams: platform (watcher) and product (watched)
- `agents/platform-lead/SOUL.md` — Dogfood Observer + Meta-Awareness SOUL sections

See the [Team Watcher Pattern guide](../../docs/guides/team-watcher-pattern.md) for full setup instructions.
