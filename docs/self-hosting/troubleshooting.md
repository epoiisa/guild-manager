---
title: Troubleshooting
permalink: /self-hosting/troubleshooting/
---

# Troubleshooting

Start with the process logs and the exact failing step. Keep bot tokens, passwords, and database connection strings out of anything you share.

## The process does not start

| Symptom | What to check |
|---|---|
| `Missing required environment variable` | Supply the named variable. If using `.env`, start from its package directory. |
| Invalid `LOG_LEVEL` | Choose `debug`, `info`, `warn`, or `error`. |
| Cannot find `dist/index.js` | For source installations, run `npm ci` and `npm run check`. For compiled downloads, check that you extracted the runtime archive. |
| Missing dependency/module | Run the installation command for your installation path in the directory containing `package.json`. |
| PostgreSQL connection failure | Confirm the database exists, is reachable, and accepts the configured authentication and secure connection settings. |
| Schema migration permission error | Confirm the database role can create and alter the bot's schema and owns the relevant objects. |
| `waiting for runtime lock` | Another process owns this database's runtime lock. Locate and stop the intended previous instance before starting its replacement. |

Avoid changing database schema manually to make an error disappear. Keep the full migration error privately and check the release's update requirements before retrying.

## Discord login fails

Confirm that `DISCORD_TOKEN` is current and that `DISCORD_CLIENT_ID` is the Application ID for the same application. Check outbound access to Discord.

If Discord rejects the requested intents, enable **Server Members Intent** on the application's Bot page and check any approval requirements. This release does not request Presence or Message Content intents. See [Discord's gateway documentation](https://docs.discord.com/developers/events/gateway#privileged-intents).

## The bot is online but commands are missing

Check for `registered guild commands` in the logs for the intended Discord server. Confirm that you installed the application with `bot` and `applications.commands` scopes.

A new server has only `/activate` until an administrator activates it. Ordinary members cannot see or use commands by default: grant appropriate command access through **Server Settings → Integrations**. Check as an administrator to distinguish failed registration from member access settings.

If active commands are still missing, confirm the bot belongs to the application whose ID is configured. Review registration errors before restarting; repeated restarts do not fix incorrect credentials or access.

## Commands cannot change roles or channels

Check the bot's server permissions, channel overwrites, and role position. The bot's highest role must be above the roles and members it manages. Check that the configured channel or role still exists.

Also check the invoking user's command access and any manager/reviewer role required by the action. Giving the bot Administrator permission does not give every member permission to operate Guild Manager.

## Albion Online lookups or membership checks fail

Check access to the Albion Online API and select the correct Albion Online server for the character, guild, or alliance. Names and identities belong to a particular Albion Online server; a matching name elsewhere is a different identity.

An API outage can prevent a lookup or verification even while Discord and PostgreSQL remain available. Review the reported error and retry when the service is available. Do not change a character's stored identity merely to bypass a temporary lookup failure.

## The bot repeatedly disconnects or exits

Check PostgreSQL and network availability, process limits, and the host's restart policy. `runtime lock connection lost` intentionally shuts down the runtime; investigate the database connection before restarting. Preserve logs from before the exit, since later successful startup does not explain the original failure.

## Report a reproducible problem

Include the release version, installation method, operating system, Node.js and PostgreSQL versions, failing command or workflow, expected result, actual result, and a sanitized error excerpt. Avoid member details that are unnecessary to reproduce the problem. Support and contribution acceptance are at the maintainer's discretion.

See [source and issues](https://github.com/epoiisa/guild-manager) and [release notes](https://github.com/epoiisa/guild-manager/releases) for published project information.
