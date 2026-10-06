---
title: Administrator Quick Start
permalink: /getting-started/administrator/
---

# Administrator Quick Start

This guide assumes your own Guild Manager bot is running, connected to its database, and installed in a test Discord server. If it is not, follow [Self-Hosting]({{ '/self-hosting/' | relative_url }}) first.

## 1. Activate the server

Run `/activate` as a Discord administrator. Guild Manager registers its active commands for this Discord server. If Discord still shows the old command list, reopen the command picker after registration finishes.

Run `/status` to inspect the current server configuration. Configuration is scoped to this Discord server; activating a second server does not copy the first server's settings.

## 2. Configure membership

Decide which Albion Online servers and membership scopes your community uses. You can configure Albion Online guilds, Albion Online alliances, and custom member groups.

For an Albion Online guild:

1. Use `/guild lookup` to find the correct Albion Online guild and its ID.
2. Use `/guild add` with that Albion Online server and ID. Choose whether Guild Manager should track its full roster with the `managed` setting.
3. Map Discord roles with `/guild roles add`.

Use `/alliance add` for an Albion Online alliance, or `/group create` for a custom member group. Map their roles with the corresponding `roles add` commands. Custom-group membership is assigned explicitly with `/member add` to a registered character.

See [Member Groups and Leadership Positions]({{ '/guides/groups-positions/' | relative_url }}) for the differences and removal consequences. Configure only the scopes your server needs.

## 3. Configure feature channels

Use `/channel set` to select a destination for each enabled feature:

| System value | Purpose |
| --- | --- |
| `content` | Party announcements and the Content hosting panel |
| `account` | Accounts panel |
| `regear` | Re-gears intake panel and evidence workflow |
| `specialisation` | Weapon Specialisation panel and proof workflow |
| `giveaway` | Giveaways panel and announcements |
| `voice` | Ordinary voice channel used to create temporary voice channels |
| `log` | Administrative event log |

Use text or announcement channels for the text features, and an ordinary voice channel for `voice`. Ensure Guild Manager can view and maintain its destination messages. Use `/channel show` to verify settings. Applications and private tickets have their own class/category configuration.

## 4. Configure managers and reviewers

Use `/manager add` to assign Discord manager roles for `account`, `regear`, or `specialisation`. Each binding applies across all Albion Online servers within this Discord server.

Applications and tickets use a reviewer role chosen when their classes are created. Party hosts control their own parties. These authorities are different; giving a member one manager role does not make them a manager of every feature.

## 5. Grant command access

Commands are hidden from ordinary members by default. In Discord **Server Settings → Integrations**, select your bot and grant the appropriate command access to your member and officer roles.

Start with the member commands your community will use, such as `/register`, `/membership`, `/balance`, `/statement`, `/roles`, `/join`, `/leave`, and `/standby`. Grant officer operations only to the roles responsible for them. Some operations also check manager, reviewer, host, or Administrator authority at runtime.

The feature panels offer button-based entry paths with their own eligibility checks. Read [Permissions and Command Access]({{ '/getting-started/permissions/' | relative_url }}) before relying on command visibility as your only control.

## 6. Test a complete workflow

Register a test character, verify the expected membership roles, and exercise each feature you enable with an appropriate member and officer account. Check both successful and denied actions.

Use `/audit` to preview membership reconciliation, then `/update` when you intend to apply it. Configure `/schedule set` only after you are satisfied with the membership setup. See [Characters and Membership]({{ '/guides/characters-membership/' | relative_url }}) for automatic departure and recovery rules.

Use `/tasks` for open administrative work and `/status` for configuration. They answer different questions.
