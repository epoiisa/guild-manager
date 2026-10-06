---
title: Installation
permalink: /self-hosting/installation/
---

# Installation

Choose the compiled download for running an unchanged release, or the source installation for reviewing and building the code yourself. Both use the same configuration and PostgreSQL database.

## Create a database

Use PostgreSQL administrator tools to create a dedicated database and a database role that owns its schema. The bot must be able to create and alter tables during startup; it does not need to be a PostgreSQL superuser.

For a local installation where your current PostgreSQL role can create databases:

```sh
createdb guild_manager
```

If your installation uses a separate host, username, or password, configure those through your PostgreSQL tools or provider. Store the resulting connection information privately. The local connection example in `.env.example` assumes local authentication is already working.

## Option 1: Compiled release

Open the [v0.1.0-alpha.1 release](https://github.com/epoiisa/guild-manager/releases/tag/v0.1.0-alpha.1) and download:

- `guild-manager-0.1.0-alpha.1-runtime.tar.gz`
- `SHA256SUMS`

Verify the archive's SHA-256 checksum against its entry in `SHA256SUMS` before extracting it. Examples:

```sh
# macOS
shasum -a 256 guild-manager-0.1.0-alpha.1-runtime.tar.gz

# Linux
sha256sum guild-manager-0.1.0-alpha.1-runtime.tar.gz
```

On Windows, use PowerShell:

```powershell
Get-FileHash guild-manager-0.1.0-alpha.1-runtime.tar.gz -Algorithm SHA256
```

Extract the archive, enter the extracted directory containing `package.json`, and install runtime dependencies:

```sh
tar -xzf guild-manager-0.1.0-alpha.1-runtime.tar.gz
# Change into the extracted package directory.
npm ci --omit=dev
```

The download already includes compiled JavaScript. No TypeScript build is needed.

## Option 2: Source installation

Clone the public repository and select the release tag:

```sh
git clone https://github.com/epoiisa/guild-manager.git guild-manager
cd guild-manager
git checkout v0.1.0-alpha.1
npm ci
npm run check
npm test
```

`npm run check` checks TypeScript and builds `dist/`. `npm test` runs the source test suite. Select a release tag when you want the code matching these documentation pages.

## Prepare configuration

In the package directory:

```sh
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` with your own values using the [environment configuration guide]({{ '/self-hosting/environment/' | relative_url }}). Configure the database and Discord credentials before starting. Keep this file private.

Then follow [running the bot]({{ '/self-hosting/running/' | relative_url }}).
