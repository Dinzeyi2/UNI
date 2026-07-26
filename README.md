# Nexus Intent Engine

Nexus is an intent-to-behavior control-plane prototype. The UI lets a person propose and approve safe environment behaviors. `server.mjs` keeps provider credentials on the server, connects to supported ecosystems, imports their devices, validates normalized actions, and sends supported commands back through the ecosystem.

## Behavior creation API

`POST /api/behaviors` compiles a natural-language intent into a Nexus Behavior: a named, versioned draft containing triggers, conditions, normalized actions, safeguards, termination rules, and required capabilities. `POST /api/behaviors/:id/simulate` runs the behavior against the current capability graph without calling a provider. `POST /api/behaviors/:id/deploy` refuses deployment if the simulation finds missing capabilities or non-low-risk actions. `PATCH /api/behaviors/:id` creates the next version as a new draft so users can edit and test safely. The local runtime persists behavior/device/approval/audit data to `.nexus-state.json` and accepts provider or test events at `POST /api/events`.

The browser creator calls the behavior, simulation, deployment, device, and audit APIs directly; it no longer relies on the previous hard-coded device graph. The current compiler is deterministic and template-based; a production LLM compiler must emit this same structured Behavior schema, never raw provider commands.

## Run locally

```bash
cp .env.example .env
# Set SESSION_SECRET and NEXUS_TOKEN_KEY, then add only the cloud credentials you use.
docker compose up --build
```

Open `http://localhost:4173`. `npm start` runs the PostgreSQL API and requires `DATABASE_URL`, `SESSION_SECRET`, and `NEXUS_TOKEN_KEY`; use `npm run start:prototype` only for the local prototype runtime. **Do not share cloud credentials in chat or add them to git.** Put them only in `.env` for local Docker use or in your host's encrypted secret manager.

## Railway API authentication

The production API exposes `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/auth/me`. The Lovable frontend should retain the returned bearer token and send `Authorization: Bearer <token>` for authenticated API requests. Set `CORS_ORIGIN` to the Lovable deployment origin and set a high-entropy `SESSION_SECRET` in Railway variables.

## Production data foundation

`db/schema.sql` defines the PostgreSQL contract for users, organizations, provider connections, devices/capabilities, context facts, behaviors/versions, approvals, executions, audit events, packages, and installations. `docker compose up` starts PostgreSQL with that schema and the Nexus container foundation. See [production-foundation.md](docs/production-foundation.md) before migrating the local runtime state store.

## Local-first device agent

`local-agent.mjs` is the in-home half of Nexus. Run it on a Raspberry Pi, mini-PC, NAS, or other trusted machine connected to the user's LAN—not on Railway. It actively discovers devices advertised through SSDP and DNS-SD/mDNS, classifies them as locally supported, pairing-required, or locked/unknown, and retains a local inventory. Discovery never implies permission to control a device.

```bash
export NEXUS_AGENT_TOKEN="$(openssl rand -hex 32)"
export NEXUS_AGENT_SECRET="$(openssl rand -hex 32)"
npm run start:agent
```

The agent binds to `127.0.0.1:4180` by default. Its authenticated API provides `POST /discover`, `GET /inventory`, `POST /pair/hue`, and `POST /execute`. Hue pairing requires the user to press the physical bridge link button; its pairing credential is encrypted in the local state file and paired lights are imported as individually addressable capabilities. The first executable adapters support paired Hue Bridge light actions and compatible Shelly switch on/off RPC. Unknown devices remain visible but non-executable instead of being probed with arbitrary packets. Expose the agent remotely only through a separately authenticated, encrypted tunnel; never port-forward it directly to the internet.

When `LLM_API_URL`, `LLM_API_KEY`, and `LLM_MODEL` point to an OpenAI-compatible strict structured-output endpoint, `POST /create` converts an arbitrary user intention plus the real local inventory into a grounded Behavior proposal. The compiler is given only normalized devices/context, and its output is rejected if it invents a device, capability, or invalid parameter. The user must then approve the proposal through `POST /behaviors/deploy`; `POST /events` runs matching triggers locally. The persistent runtime supports scheduled ticks, time and context conditions, ordered priorities, delayed cascading actions, bounded retries, device health updates, explicit capability-grounded fallbacks, and manual-override holds so Nexus does not fight a person who changes a device.

The Railway control plane can claim a home agent with `POST /api/agents`. The one-time token returned by that endpoint is stored as `NEXUS_CLOUD_AGENT_TOKEN` on the home agent alongside the HTTPS `NEXUS_CLOUD_URL`. The agent then makes an outbound-only authenticated request to `/api/agent/sync`: it uploads normalized inventory, receives the user's deployed/paused Behaviors, and persists them in the local runtime. No inbound router port or direct public exposure of the agent is required. Revoking an agent with `DELETE /api/agents/:id` disables later synchronization.

This is a functional local creation path for the adapters above, not universal Wi-Fi control. Matter commissioning, HomeKit pairing, Sonos control, broader context connectors, DHCP/MAC reconciliation, and spatial CSI sensing require dedicated adapters and are intentionally not faked by this implementation.

## Connect a provider

Nexus separates **user authorization** from a commercial ecosystem partnership. A person must approve access to their own home; Nexus then receives only the scoped credentials needed to read the provider's device graph and send supported commands. The MVP currently provides connection flows for SmartThings and Home Assistant. Google Home, Tuya, and Matter are shown as planned integrations rather than implying that an unimplemented connector is available.

1. Copy `.env.example` to your deployment secret manager/environment. Do not place real credentials in the browser or in source control.
2. Create a SmartThings OAuth application and register `https://YOUR_HOST/api/oauth/smartthings/callback` as its redirect URI.
3. Set `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET`, `NEXUS_BASE_URL`, and a strong `NEXUS_TOKEN_KEY` on the server.
4. Call `POST /api/connect/smartthings`; the API returns an authorization URL. Send the user to that URL.
5. For Home Assistant, configure `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_TOKEN`, then call `POST /api/connect/home_assistant`.

The provider routes also have explicit production aliases: `POST /api/providers/smartthings/connect`, `POST /api/providers/smartthings/refresh`, and `POST /api/providers/smartthings/disconnect`. The equivalent Home Assistant connect/disconnect routes are available; it uses its supplied long-lived token rather than an OAuth refresh token.

The token envelope is AES-256-GCM encrypted server-side. It is never returned by an API response. The SmartThings callback exchanges an OAuth authorization code for a server-side token; Home Assistant uses its server API and a user-created long-lived access token.

## Real execution flow

```text
Connected ecosystem → Nexus sync endpoint → normalized capability graph
User intent → proposed plan → policy validation → user approval
→ Nexus execution endpoint → provider API → real devices
```

First create an approval with `POST /api/approvals`. Nexus binds that approval to the user, behavior, an SHA-256 hash of the exact action list, a five-minute expiry, and a single-use status. `POST /api/execute` verifies every one of those conditions. Low-risk actions may execute after that approval; medium and high-risk actions also require `explicitConfirmation: true`. Nexus validates that each action is present in the user's imported capability graph before it calls the provider.

`production-server.mjs` now persists users, encrypted provider connections, normalized devices/capabilities, behavior versions, and audit events in PostgreSQL. It implements the SmartThings OAuth authorization-code callback, Home Assistant token connection, and provider synchronization endpoints used by the browser. Token refresh, provider rate limiting, provider event subscriptions, execution receipts, and reported-state verification remain required production-hardening work. Do not use this prototype for locks, alarms, garage doors, cameras, heating equipment, or other safety-critical automations.

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
- `POST /api/emergency-stop` — pause every deployed behavior for the authenticated user and record the safety action.

The PostgreSQL API also persists approvals and executions: `POST /api/plans/validate`, `POST /api/approvals`, and `POST /api/execute` validate parameter schemas, bind an approval to the exact SHA-256 action hash, require explicit confirmation for medium/high-risk actions, create an idempotent execution record, and audit command outcomes. `POST /api/behaviors/:id/run` runs a deployed, still-safe low-risk behavior; `POST /api/events` evaluates matching deployed behavior triggers. `POST /api/executions/:id/verify` polls the provider and records whether the reported state matches the requested light action. `POST /api/behaviors/:id/pause`, `resume`, or `stop` and `DELETE /api/behaviors/:id` provide backend behavior lifecycle control.

This keeps the browser away from OAuth credentials while Nexus sends approved commands to the connected ecosystem.
