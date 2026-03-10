/**
 * Clawforce skill topic — Channels & Meetings
 *
 * Documents channel types, meeting workflow, and tool actions.
 */

export function generate(): string {
  return `# Channels & Meetings

Clawforce provides group communication via channels. Two types exist:

## Topic Channels

Persistent group conversations for team communication. Agents join based on config rules (role, department, team) or manually.

- Messages stored in the unified messages table (same as DMs)
- Channel membership tracked in the channels table
- Optional Telegram group mirroring

## Meeting Mode

Orchestrated round-robin discussions:

1. **Manager starts meeting** — specifies participants and a prompt
2. **Sequential dispatch** — each participant gets an isolated session
3. **Full transcript** — each participant sees all previous responses
4. **Manager last** — summarizes, creates action items as tasks
5. **Conclude** — meeting marked concluded, transcript optionally mirrored to Telegram

Meeting turns are dispatched via the cron service (one-shot isolated sessions).

## Tool Actions (\`clawforce_channel\`)

| Action | Description | Roles |
|--------|-------------|-------|
| \`create\` | Create a new channel | manager |
| \`join\` | Join a channel | all |
| \`leave\` | Leave a channel | all |
| \`send\` | Send a message to a channel | all |
| \`list\` | List channels you belong to | all |
| \`history\` | View recent channel transcript | all |
| \`start_meeting\` | Start a round-robin meeting | manager |
| \`meeting_status\` | Check meeting state | all |

## Configuration

Channels can be defined in workforce YAML:

\`\`\`yaml
channels:
  - name: engineering
    departments: [engineering]
    telegram_group_id: "-1001234567890"
  - name: standup
    type: meeting
    roles: [employee]
\`\`\`

## Context Injection

The \`channel_messages\` context source injects recent channel messages into agent briefing.
Active meeting channels show a "your turn" indicator when applicable.
`;
}
