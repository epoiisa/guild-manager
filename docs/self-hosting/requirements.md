---
title: Requirements
permalink: /self-hosting/requirements/
---

# Requirements

The public release expects:

| Requirement | Purpose |
|---|---|
| Node.js 22 and npm | Run the bot and install its dependencies. |
| PostgreSQL 18 | Store configuration, character registrations, financial records, and other persistent data. |
| A dedicated database and schema-owning database role | Allow automatic schema creation and migrations at startup. |
| Your own Discord application, bot token, and Application ID | Connect your instance to Discord and register its commands. |
| A test Discord server you administer | Verify installation, permissions, and workflows before real use. |
| Outbound network access | Reach PostgreSQL, Discord, and the Albion Online API. |
| A continuously running process | Receive Discord events and run scheduled work. |

Install Node.js from the [official downloads](https://nodejs.org/en/download) and PostgreSQL from the [official downloads](https://www.postgresql.org/download/) or your hosting provider. Select the versions above rather than assuming the newest major versions are compatible. Check your installed tools with:

```sh
node --version
npm --version
psql --version
```

Git is required for the source-clone installation path. A compiled release needs an archive extractor and npm, but no TypeScript build. Release archives do not bundle Node.js, PostgreSQL, or installed dependencies.

## Hosting shape

The bot is a background process. It does not expose a website or HTTP health-check endpoint. Keep one running instance per database, with persistent PostgreSQL storage and access to its logs. A sleeping computer or stopped hosting service makes the bot unavailable.

For independent testing, use a separate Discord application and database from your live instance. Sharing a database causes runtimes to contend for the same lock; sharing an application can let command registration and events interfere.

Continue with [Discord application setup]({{ '/self-hosting/discord-setup/' | relative_url }}).
