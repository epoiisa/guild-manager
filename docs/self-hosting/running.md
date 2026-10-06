---
title: Running the Bot
permalink: /self-hosting/running/
---

# Running the Bot

From the package directory, after [installation]({{ '/self-hosting/installation/' | relative_url }}) and [configuration]({{ '/self-hosting/environment/' | relative_url }}):

```sh
npm start
```

This starts `dist/index.js`. A source installation must first have completed `npm run check` or `npm run build`. A compiled release already includes `dist/`.

## What startup does

Guild Manager loads configuration, connects to PostgreSQL, acquires its database runtime lock, and applies database schema migrations. It then connects to Discord and registers the appropriate server-scoped commands.

Useful startup log messages include:

- `runtime lock acquired`
- `postgres connected`
- `postgres schema migrated`
- `discord logged in`
- `registered guild commands`

The earlier `discord login requested` message alone does not prove that the bot is ready. Confirm successful command registration and an actual response in Discord.

Only one runtime can hold the lock for a database. A second process logs `waiting for runtime lock` until the first releases it. Stop the previous instance before switching versions; do not leave an unintended duplicate waiting to take over later. The database connection must support a persistent session for this advisory lock.

## Activate and verify

1. Confirm the bot appears online in your test Discord server.
2. As an administrator, run `/activate`.
3. Confirm that the active command set appears and `/ping` responds.
4. Configure the server using the [administrator quick start]({{ '/getting-started/administrator/' | relative_url }}).
5. Test command visibility and enabled feature workflows with an ordinary member account as well as an administrator.

Newly installed servers initially expose only `/activate`. Existing active servers load their active command set on startup. Grant member access through Discord **Server Settings → Integrations**.

## Keep the process running

For unattended operation, use your operating system's service manager or a hosting service that runs persistent background processes. Set its working directory to the package directory, provide the environment variables, retain logs, and restart the process after unexpected exits. Account for restart delays and maintenance downtime.

This release has no HTTP endpoint or built-in web health check. Check process logs and Discord responses when verifying availability.

## Stop safely

For an interactive foreground run, press **Ctrl+C**. A service manager should send `SIGTERM` and allow the process to finish shutting down. The bot stops its background work, disconnects Discord, releases its runtime lock, and closes PostgreSQL connections.

Loss of the runtime-lock connection triggers shutdown so the process does not continue without exclusive database ownership. Investigate repeated exits using [troubleshooting]({{ '/self-hosting/troubleshooting/' | relative_url }}).
