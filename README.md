# Nexus Intent Engine

Nexus is an intent-to-behavior control-plane prototype. The UI lets a person propose and approve safe environment behaviors. `server.mjs` keeps provider credentials on the server, connects to supported ecosystems, imports their devices, validates normalized actions, and sends supported commands back through the ecosystem.

## Behavior creation API

`POST /api/behaviors` compiles a natural-language intent into a Nexus Behavior: a named, versioned draft containing triggers, conditions, normalized actions, safeguards, termination rules, and required capabilities. `POST /api/behaviors/:id/simulate` runs the behavior against the current capability graph without calling a provider. `POST /api/behaviors/:id/deploy` refuses deployment if the simulation finds missing capabilities or non-low-risk actions. `PATCH /api/behaviors/:id` creates the next version as a new draft so users can edit and test safely. The local runtime persists behavior/device/approval/audit data to `.nexus-state.json` and accepts provider or test events at `POST /api/events`.

The browser creator calls the behavior, simulation, deployment, device, and audit APIs directly; it no longer relies on the previous hard-coded device graph. The current compiler is deterministic and template-based; a production LLM compiler must emit this same structured Behavior schema, never raw provider commands.

## Run locally

```bash
npm start
```

Open `http://localhost:4173`. `npm start` runs the Railway-oriented PostgreSQL API and requires `DATABASE_URL` and `SESSION_SECRET`; use `npm run start:prototype` only for the previous local prototype runtime.

## Railway API authentication

The production API exposes `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/auth/me`. The Lovable frontend should retain the returned bearer token and send `Authorization: Bearer <token>` for authenticated API requests. Set `CORS_ORIGIN` to the Lovable deployment origin and set a high-entropy `SESSION_SECRET` in Railway variables.

## Production data foundation

`db/schema.sql` defines the PostgreSQL contract for users, organizations, provider connections, devices/capabilities, context facts, behaviors/versions, approvals, executions, audit events, packages, and installations. `docker compose up` starts PostgreSQL with that schema and the Nexus container foundation. See [production-foundation.md](docs/production-foundation.md) before migrating the local runtime state store.

## Connect a provider

1. Copy `.env.example` to your deployment secret manager/environment. Do not place real credentials in the browser or in source control.
2. Create a SmartThings OAuth application and register `https://YOUR_HOST/api/oauth/smartthings/callback` as its redirect URI.
3. Set `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET`, `NEXUS_BASE_URL`, and a strong `NEXUS_TOKEN_KEY` on the server.
4. Call `POST /api/connect/smartthings`; the API returns an authorization URL. Send the user to that URL.
5. For Home Assistant, configure `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_TOKEN`, then call `POST /api/connect/home_assistant`.

The token envelope is AES-256-GCM encrypted server-side. It is never returned by an API response. The SmartThings callback exchanges an OAuth authorization code for a server-side token; Home Assistant uses its server API and a user-created long-lived access token.

## Real execution flow

```text
Connected ecosystem → Nexus sync endpoint → normalized capability graph
User intent → proposed plan → policy validation → user approval
→ Nexus execution endpoint → provider API → real devices
```

First create an approval with `POST /api/approvals`. Nexus binds that approval to the user, behavior, an SHA-256 hash of the exact action list, a five-minute expiry, and a single-use status. `POST /api/execute` verifies every one of those conditions. Low-risk actions may execute after that approval; medium and high-risk actions also require `explicitConfirmation: true`. Nexus validates that each action is present in the user's imported capability graph before it calls the provider.

The first production deployment must still add PostgreSQL-backed connections/approvals, token refresh, provider rate limiting, provider event subscriptions, and reported-state verification. Do not use this prototype for locks, alarms, garage doors, cameras, heating equipment, or other safety-critical automations.

## Current API boundary

- `GET /api/health` — health and registered providers.
- `GET /api/providers` — configured/connected provider metadata, never secrets.
- `POST /api/connect/:provider` — start OAuth or connect configured Home Assistant.
- `POST /api/devices/import` — import normalized, provider-derived device data.
- `GET|POST /api/behaviors` — list existing behaviors or compile a new draft from a user intent.
- `PATCH /api/behaviors/:id` — create the next editable behavior version.
- `POST /api/behaviors/:id/simulate` — evaluate a behavior without touching physical devices.
- `POST /api/behaviors/:id/deploy` — deploy a behavior only if its simulation is safe and grounded.
- `POST /api/events` — send a normalized environment event to deployed behaviors.
- `GET /api/audit-events` — read the persistent local audit trail.
- `POST /api/sync/:provider` — fetch real provider devices/state and build the normalized graph (`smartthings` and `home_assistant`).
- `GET /api/devices` — read a user's normalized capability graph.
- `POST /api/plans/validate` — apply deterministic risk rules and check that each action is grounded in imported capabilities.
- `POST /api/approvals` — create a short-lived, single-use approval bound to one exact action list.
- `POST /api/execute` — execute a grounded, approved provider command. The current translations support Home Assistant lights/media/climate and SmartThings light commands.

This keeps the browser away from OAuth credentials while Nexus sends approved commands to the connected ecosystem.
