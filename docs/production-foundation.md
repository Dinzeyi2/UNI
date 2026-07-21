# Production foundation

This repository now includes a PostgreSQL data model and Docker Compose deployment foundation for the systems that cannot safely live in browser storage or in a local JSON file.

## What the schema supports

- users, organizations, and membership roles;
- encrypted provider connections and device capability/state records;
- timestamped context facts with expiration and permission level;
- persistent behaviors, immutable behavior versions, simulations, approvals, executions, and audit events;
- portable behavior packages and installation-time capability mappings.

## Required implementation boundary

`server.mjs` remains the dependency-free local runtime. A production service must replace its local Maps with repository implementations backed by `db/schema.sql`; it must not run both stores for a single production account. The database schema is intentionally committed before that migration so the durable product contract is explicit and reviewable.

## External integrations

Google Home, Tuya, Calendar, weather, presence, webhook delivery, and an LLM compiler need real vendor projects/credentials. Their contracts should follow the same normalized `device_capabilities`, `context_facts`, `behavior_versions`, `approvals`, and `executions` records rather than bypassing the policy/runtime boundary.
