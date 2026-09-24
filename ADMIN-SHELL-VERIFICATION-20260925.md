# Admin Shell Verification — 2026-09-25

## Scope
This package extends the Phase 2 ZIP with the Admin Shell design:
- real `/index.html?embedded=admin` shown as the central work surface
- legacy bottom navigation hidden; existing management panels remain available as floating sheets through commands
- command palette / quick rail instead of adding navigation tabs
- room/player context surface
- live Server / Room / Player / Runtime Audit status bridge
- Google Admin login via tab-scoped bearer session
- tab ID bound on HTTP and Socket.IO requests
- OAuth admin callback uses one-time fragment handoff instead of browser-wide admin cookie
- Google-configured Admin mode rejects legacy cookie sessions at the Admin auth gate
- password fallback, when enabled, also issues a tab-scoped bearer session
- BroadcastChannel + pagehide handshake detects copied duplicate-tab sessions while preserving normal same-tab reload identity
- command registry delegates to existing Admin handlers
- Admin Shell/Tab Auth/command tests are integrated into Bug Replay and `npm test`

## Authentication model
Google Admin flow:
`Google OAuth -> signed state(tabId) -> verified Google claims -> one-time fragment ticket -> /api/admin/session/exchange -> tab bearer token -> sessionStorage`

The Admin HTTP layer accepts the signed bearer only when the presented `X-WW-Admin-Tab-Id` matches the token. Socket.IO uses the corresponding `adminToken` + `adminTabId` handshake values.

Tokens are not stored in localStorage. Google Admin callback does not create the browser-wide `ww_admin` cookie.

## Verification performed
### Syntax / static checks
- `node --check server.js` PASS
- `node --check public/js/admin-auth-tab.js` PASS
- `node --check public/js/admin-command-registry.js` PASS
- `node --check public/js/admin-shell.js` PASS

### Admin-specific regression
- `admin-auth-regression.js` PASS
- `admin-tab-session-regression.js` PASS
- `admin-tab-duplication-behavior.js` PASS
  - later duplicate tab rotates and drops copied token
  - normal reload preserves tab identity/token
- `admin-shell-browser.py` PASS
  - Shell construction
  - real Index iframe URL
  - legacy dock hidden
  - live status bridge
  - Ctrl/Cmd+K command palette
  - existing command dispatch
  - same-origin context
  - mobile fixed rail
- `admin-real-html-browser.py` PASS
  - loads the actual `public/admin.html` source with its real dependency scripts inlined for deterministic browser execution
  - verifies the real Admin page actually loads the Shell module
  - verifies Index surface, palette, Escape close, and mobile layout

### Bug Replay / coverage
- Bug Replay coverage audit PASS
- `96 runnable test files covered by 48 scenarios / 149 steps`
- Admin scenario includes the new tab/session and real-HTML browser tests

### Existing game regression
The complete `npm test` chain was exercised. The chained process repeatedly reached the Player Grid browser stage before the environment timeout, with no failure reported in the log. The Player Grid browser regression and every remaining tail test were then run independently and passed.

Tail verification after the timeout:
- Player HTML Grid: PASS (39 browser states)
- Pre-game day theme: PASS
- Phase 2 Chaos: 24/24 PASS
- Phase 2 Stress: 100 players / 2880 actions / converged PASS
- Phase 2 Long-Run: 12000 cycles / 12 checkpoints / stable PASS
- Phase 2 Recovery: 6/6 PASS
- Phase 2 Full Suite: PASS
- Phase 2 runner integration: PASS

Two deployment fixture checks remain intentionally SKIP as in the base project because the source ZIP does not contain:
- `.ebextensions/01-high-availability.config`
- `CLOUDFRONT-FAILOVER-SETUP.md`

## Environment limitation
A direct attempt to boot `server.js` from the isolated work directory could not start because the extracted working tree does not include installed `node_modules`. This is an environment/package-layout limitation, not a source failure; source-level and deterministic browser tests were used instead.
