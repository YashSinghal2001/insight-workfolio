# Insight Workfolio

Company-owned employee time tracking and productivity management for Windows and macOS.
Built for 10 employees initially, designed to scale to 50–100+.

> **Status: Day 8.** Employees clock in/out and take breaks from the desktop app (offline
> included), see their hours and request corrections; admins see live attendance, timesheets
> and approve corrections with an audit trail. **Transparent activity monitoring (macOS):**
> after the employee acknowledges the current monitoring notice, the app records the foreground
> application's name and idle time, only while clocked in and not on a break. **Screenshots
> (macOS, off by default):** when an admin turns them on and the employee has acknowledged the
> separate screenshot notice and allowed screen recording, the app captures the main screen at a
> fixed interval (WebP), queues it locally and uploads it through the API; the app always shows
> the screenshot state. Admins browse screenshots in an audited gallery. Storage: the company
> OneDrive through Microsoft Graph (delegated, `SCREENSHOT_STORAGE=onedrive`, tested against a fake
> tenant only; docs/onedrive.md) or a development-only local adapter. No keystrokes, window titles,
> websites or clipboard. Windows activity and screenshot capture are pending (docs/windows.md).
>
> **Deployment (selected 2026-11-05, not yet installed):** one Hostinger VPS runs the API, the
> dashboard and a persistent local SQLite database behind Caddy; screenshots and timelapse videos
> live in OneDrive, encrypted database backups go to a dedicated OneDrive folder. Assets and runbooks:
> `deploy/README.md`, docs/deployment.md. The earlier Render + Vercel + Turso plan is superseded.

## Quick start

Prerequisites: Node.js ≥ 24.7 (built-in Argon2), pnpm ≥ 10, Rust (stable) and the Tauri platform prerequisites. See [docs/setup.md](docs/setup.md).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env          # optional; defaults work for local dev

pnpm build:packages && pnpm --filter @workfolio/api build
pnpm --filter @workfolio/api admin:create --email you@company.com   # prints a one-time setup link

pnpm dev:api         # http://localhost:4000/api/v1/health
pnpm dev:dashboard   # http://localhost:3000
pnpm dev:desktop     # opens the native window (Vite on :1420)
# or all three at once:
pnpm dev
```

Open the printed link to choose the admin password, then sign in at http://localhost:3000/login.
Add employees from the dashboard; each gets a one-time setup link to deliver in person.

## Workspace scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Builds shared packages, runs API, dashboard and desktop in parallel |
| `pnpm build` | Builds every package and app (desktop: web assets only) |
| `pnpm lint` | ESLint everywhere, plus `cargo clippy -D warnings` for the desktop |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Unit tests, API e2e tests, dashboard smoke test, `cargo test` |
| `WORKFOLIO_API_URL=https://api.example.com pnpm --filter @workfolio/desktop package` | Native release build for that API (https only; sets the CSP origin; see docs/deployment.md) |
| `pnpm --filter @workfolio/api admin:create --email <e>` | Bootstrap the first admin (see [setup](docs/setup.md#first-admin)) |
| `pnpm --filter @workfolio/desktop verify:native` | Guided macOS check of idle, lock, sleep, break and clock-out with real OS events |
| `pnpm --filter @workfolio/desktop verify:screenshots` | Guided macOS check of real screenshot capture, upload, break, lock, sleep and clock-out |
| `pnpm --filter @workfolio/api verify:graph` | Real Microsoft Graph checks (needs `GRAPH_*` credentials; reports BLOCKED without) |

## Documentation

- [Architecture](docs/architecture.md)
- [Local setup](docs/setup.md)
- [Security & privacy](docs/security.md)
- [Screenshot storage (Microsoft Graph / SharePoint)](docs/onedrive.md)
- [Windows collector plan](docs/windows.md)
- [Development plan](docs/development-plan.md)
- [Master checklist](docs/master-checklist.md)
