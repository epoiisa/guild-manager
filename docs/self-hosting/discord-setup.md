---
title: Discord Application Setup
permalink: /self-hosting/discord-setup/
---

# Discord Application Setup

Create an application you control in the [Discord Developer Portal](https://discord.com/developers/applications). Use your application's credentials throughout setup.

## Application and bot

1. Create an application and note its **Application ID**. This becomes `DISCORD_CLIENT_ID`.
2. Open its **Bot** settings and obtain its bot token. Store it privately as `DISCORD_TOKEN`.
3. Enable **Server Members Intent** under privileged gateway intents. Guild Manager uses member events for membership and role handling.

The current release requests Guilds, Guild Members, Guild Voice States, Guild Messages, and Guild Message Reactions intents. It does not request Presence or Message Content intents. Discord requires privileged intents to be enabled for the application; additional approval may apply as an application grows. See [Discord's privileged-intent documentation](https://docs.discord.com/developers/events/gateway#privileged-intents).

## Install in a test server

Use the Developer Portal's server-install or OAuth2 URL settings to create an installation link with the `bot` and `applications.commands` scopes. Install the application into a test Discord server you administer.

The current simple setup recommendation is **Administrator** for the bot. This grants broad server access and bypasses channel permission overwrites. Review that access before installing it in a real community. If you choose narrower permissions, test every feature you enable: role management, private channels, messages, reactions, and voice operations have different requirements.

Move the bot's highest role above the roles and members it needs to manage. Administrator permission does not remove Discord's role-hierarchy restrictions. Discord documents these rules in its [permissions reference](https://docs.discord.com/developers/topics/permissions#permission-hierarchy).

## Bot permissions and command access

The bot's permissions control what it can do to Discord resources. Member command permissions control who can ask it to do those things. They are separate settings.

Guild Manager registers commands for Discord servers where it is installed. New servers initially receive `/activate`. After an administrator activates a server, its active command set is registered. Commands default to hidden and unavailable for ordinary members; grant appropriate access through **Server Settings → Integrations**. Some actions also require configured manager or reviewer roles.

Continue with [installation]({{ '/self-hosting/installation/' | relative_url }}), then consult [permissions and command access]({{ '/getting-started/permissions/' | relative_url }}) when configuring your server.
