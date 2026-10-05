# Guild Manager

A self-hosted Discord bot for Albion Online guilds and communities. It supports character registration, membership and roles, applications and tickets, party signups, giveaways, character accounts, re-gears and weapon specialisations.

This repository contains periodic source releases. The current version is **0.1.0-alpha.1**, an alpha prerelease. Commands and database schemas may change between releases. Public access to the maintainer's hosted instance is not currently offered. Self-hosting is free; a future paid hosted service would be a separate offering.

## AI development disclosure

Guild Manager has been developed almost exclusively using AI tools, under the maintainer's direction. Testing does not guarantee correctness or security. Operators should review the code and test in their own Discord server before relying on it.

## Requirements

- Node.js 22 and npm.
- PostgreSQL 18, with a dedicated database and a role that can create and alter its schema.
- Your own Discord application, bot token and Application ID.
- Outbound access to Discord and the Albion Online API.

The bot needs a continuously running process. Release downloads contain compiled JavaScript; Node.js, PostgreSQL and npm dependencies are installed separately. No credentials or live data are included.

## Discord setup

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), add a bot, and enable **Server Members Intent** on its Bot page. The current source does not request Presence or Message Content intents.

Install your application into your own test server with the `bot` and `applications.commands` scopes. Use your application's ID, never the maintainer's application. Administrator is the current simple setup recommendation: it grants broad server access and bypasses channel permission overwrites. Review this access before using the bot in a real server. Place the bot's highest role above the roles and members it needs to manage.

See [Discord's gateway documentation](https://docs.discord.com/developers/events/gateway#privileged-intents) for intent settings and current access requirements.

## Clone and build

Clone the public source repository and select the release tag:

```sh
git clone https://github.com/epoiisa/guild-manager-public.git guild-manager
cd guild-manager
git checkout v0.1.0-alpha.1
npm ci
npm run check
npm test
```

The clone instructions refer to the release tag once published. For an unpublished local candidate, omit `git checkout`.

Create the database using your PostgreSQL administrator tools, for example `createdb guild_manager` when your local PostgreSQL role can create databases. Copy `.env.example` to `.env` and enter your own token, Application ID and database connection string. Keep `.env` private.

```sh
cp .env.example .env
# Edit .env before starting.
npm start
```

Startup acquires a PostgreSQL runtime lock, applies schema migrations and registers server-scoped commands. An administrator then runs `/activate` in the Discord server. Commands are hidden from ordinary members by default; grant appropriate access through Discord **Server Settings → Integrations**. Configure membership, channels and manager roles using the bot's commands.

## Download a pre-built release

Download `guild-manager-0.1.0-alpha.1-runtime.tar.gz` and `SHA256SUMS` from the [matching GitHub prerelease](https://github.com/epoiisa/guild-manager-public/releases/tag/v0.1.0-alpha.1). Verify its SHA-256 checksum before extracting. On macOS use `shasum -a 256`; on Linux use `sha256sum`; on Windows use PowerShell `Get-FileHash -Algorithm SHA256`.

Extract the archive, enter its directory, and run:

```sh
npm ci --omit=dev
cp .env.example .env
# Configure .env and create your dedicated database as described above.
npm start
```

No TypeScript build is required for this download. The JavaScript is portable; the archive does not bundle Node.js or platform-specific dependencies. Windows users can extract the archive with `tar` and copy the configuration example using `Copy-Item`.

## Updates

Stop the old process and back up your database before updating. Read the release notes for schema changes, breaking commands and migration requirements. Prepare the new release in a separate directory, install its dependencies, transfer your private configuration securely, and start it against your existing database. Startup applies migrations. Do not run both versions simultaneously or downgrade across incompatible schema changes. Retain a tested database backup for recovery.

## Licence and support

Guild Manager is distributed under the [MIT licence](LICENSE). You may use, modify, redistribute and commercially host it subject to its notice requirements. Third-party dependencies retain their own licences; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The licence applies to rights the maintainer can grant and does not replace third-party rights.

This is an actively developed alpha project. Support and acceptance of contributions are at the maintainer's discretion. Source publication does not include a hosted-service commitment. Guild Manager is an independent project and is not affiliated with or endorsed by Discord or the makers of Albion Online.
