# ClawForce Deployment Guide

Covers both embedded mode (running inside OpenClaw) and standalone mode (dedicated HTTP server).

---

## Modes

### Embedded mode (default)

The dashboard runs as an OpenClaw plugin route. OpenClaw owns the HTTP server, auth, and process lifecycle. ClawForce registers a route handler at `/clawforce`.

This is the normal mode when running ClawForce with OpenClaw. No additional server configuration is needed — the dashboard is available at whatever port OpenClaw runs on.

Auth is delegated to OpenClaw. If a user is authenticated in OpenClaw, they can access the dashboard.

The `X-ClawForce-Runtime: embedded` header is set on all responses.

### Standalone mode

The dashboard runs its own HTTP server independent of OpenClaw. ClawForce owns auth and process lifecycle.

Use this when:
- Running ClawForce without OpenClaw
- You want the dashboard on a dedicated port
- You need separate auth for the dashboard

```typescript
import { serveDashboard } from "clawforce/dashboard";
import { Clawforce } from "clawforce";

const cf = Clawforce.init({ domain: "my-team" });
serveDashboard(cf, { port: 3117 });
```

Or use `createDashboardServer` directly for more control:

```typescript
import { createDashboardServer } from "clawforce/dashboard/server";

const dashboard = createDashboardServer({
  port: 3117,
  host: "127.0.0.1",
  token: process.env.MY_AUTH_TOKEN,
  corsOrigin: "https://my-app.example.com",
  dashboardDir: "/path/to/clawforce-dashboard/dist",
});

await dashboard.start();
// later:
await dashboard.stop();
```

The `X-ClawForce-Runtime: standalone` header is set on all responses.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWFORCE_DASHBOARD_PORT` | `3117` | Port to listen on |
| `CLAWFORCE_DASHBOARD_HOST` | `127.0.0.1` | Host to bind |
| `CLAWFORCE_DASHBOARD_TOKEN` | unset | Bearer token for auth (standalone mode) |
| `CLAWFORCE_CORS_ORIGINS` | unset | Comma-separated allowed CORS origins |

Environment variables are overridden by programmatic options when both are set.

### Dashboard directory

The static files for the dashboard SPA are served from a `clawforce-dashboard/dist` directory. The server looks for this in two locations relative to the ClawForce package:

1. `<clawforce-root>/../clawforce-dashboard/dist` (sibling project)
2. `<clawforce-root>/../../clawforce-dashboard/dist`

Override with `dashboardDir` option or by setting the path programmatically.

---

## Authentication

### Standalone mode — bearer token

Set `CLAWFORCE_DASHBOARD_TOKEN` or pass `token` in options. All API requests must include:

```
Authorization: Bearer <token>
```

Static files (the SPA itself) are not protected. Only `/clawforce/api/*` requests require auth.

If no token is configured and `host` is `127.0.0.1` or `localhost`, the server starts in localhost-only mode. Connections from remote IPs are rejected with 401.

If no token is configured and `host` is a non-localhost address, the server refuses to start:

```
Error: Refusing to start dashboard server on non-localhost host "0.0.0.0" without authentication.
Set CLAWFORCE_DASHBOARD_TOKEN or pass options.token to enable auth.
```

### Embedded mode — OpenClaw delegated

Auth is handled by OpenClaw. ClawForce sets `skipAuth: true` in the gateway handler so OpenClaw's auth layer applies upstream.

---

## CORS

By default, CORS is restricted to localhost origins. To allow additional origins:

```bash
CLAWFORCE_CORS_ORIGINS=https://my-app.example.com,https://staging.example.com
```

Or programmatically:

```typescript
createDashboardServer({
  corsOrigin: "https://my-app.example.com,https://staging.example.com",
});
```

CORS headers allowed:

```
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 600
```

---

## Security Headers

All responses include:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
X-ClawForce-Runtime: embedded | standalone
```

---

## Rate Limiting

API requests are rate-limited per IP:

- 100 requests per minute per IP
- Exceeded limit returns `429 Too Many Requests`
- Rate limit state is in-memory and resets on process restart
- Static file requests are not rate-limited

---

## Runtime Detection

### Header

Every response includes `X-ClawForce-Runtime` indicating the mode:

```
X-ClawForce-Runtime: embedded
X-ClawForce-Runtime: standalone
```

### Endpoint

```
GET /clawforce/api/runtime
```

Response:

```json
{
  "mode": "standalone",
  "auth": "clawforce-managed",
  "version": "0.2.0"
}
```

In embedded mode, `auth` is `"openclaw-delegated"`. In standalone mode, `auth` is `"clawforce-managed"`.

The SPA uses this endpoint to adapt its behavior (e.g., show different auth hints).

---

## API Routes

All API routes are under `/clawforce/api/`. Key paths:

| Path | Method | Description |
|------|--------|-------------|
| `/clawforce/api/runtime` | GET | Runtime mode metadata |
| `/clawforce/api/extensions` | GET | Registered dashboard extensions |
| `/clawforce/api/domains` | GET | List active domains |
| `/clawforce/api/:domain` | GET | Domain dashboard summary |
| `/clawforce/api/:domain/agents` | GET | Agent list |
| `/clawforce/api/:domain/tasks` | GET | Task list (filter: state, assignee, priority) |
| `/clawforce/api/:domain/approvals` | GET | Approval queue |
| `/clawforce/api/:domain/budget` | GET | Budget status |
| `/clawforce/api/:domain/budget/forecast` | GET | Budget forecast |
| `/clawforce/api/:domain/health` | GET | Health status |
| `/clawforce/api/:domain/slos` | GET | SLO compliance |
| `/clawforce/api/:domain/alerts` | GET | Active alerts |
| `/clawforce/api/:domain/metrics` | GET | Operational metrics |
| `/clawforce/api/:domain/org` | GET | Org chart |
| `/clawforce/api/:domain/config` | GET | Domain config |
| `/clawforce/api/:domain/sse` | GET | SSE stream (query: `domain=<id>`) |

Action endpoints (POST):

| Path | Description |
|------|-------------|
| `/clawforce/api/:domain/approvals/:id/approve` | Approve a proposal |
| `/clawforce/api/:domain/approvals/:id/reject` | Reject a proposal |
| `/clawforce/api/:domain/tasks/:id/transition` | Transition task state |
| `/clawforce/api/:domain/tasks/:id/reassign` | Reassign task |
| `/clawforce/api/:domain/agents/:id/disable` | Disable agent |
| `/clawforce/api/:domain/agents/:id/enable` | Enable agent |
| `/clawforce/api/:domain/agents/:id/message` | Send message to agent |
| `/clawforce/api/:domain/disable` | Disable domain |
| `/clawforce/api/:domain/enable` | Enable domain |
| `/clawforce/api/:domain/kill` | Emergency stop |
| `/clawforce/api/:domain/context-files` | Write context file |

---

## Static Files

The SPA is built with `base="/clawforce/"`. Static assets are served from `<dashboardDir>/assets/` with long-lived cache headers (`max-age=31536000, immutable`). Other files are served with `no-cache`. Non-asset paths fall back to `index.html` for SPA routing.

Path traversal is blocked — the server resolves file paths and ensures they remain within the dashboard directory.

---

## Troubleshooting

### Dashboard shows "Not found" instead of the SPA

The dashboard dist directory is missing or wrong. Check:

1. `clawforce-dashboard/dist` exists as a sibling of the ClawForce repo
2. Or set `dashboardDir` to the correct path

### 401 on API requests from browser

In standalone mode: include `Authorization: Bearer <token>` in requests.

In embedded mode: you may not be authenticated in OpenClaw.

### CORS errors from browser

Set `CLAWFORCE_CORS_ORIGINS` to include your frontend origin.

### Server refuses to start

If you see "Refusing to start dashboard server on non-localhost host", you must set `CLAWFORCE_DASHBOARD_TOKEN` before binding to a non-localhost address.

### SSE connection drops immediately

The SSE endpoint requires a `domain` query parameter: `/clawforce/api/sse?domain=my-team`.

### Rate limit hit during development

Rate limits reset every minute. The limit is 100 requests per IP per minute. In development, you can restart the server to reset in-memory state.
