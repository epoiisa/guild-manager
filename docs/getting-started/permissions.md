---
title: Permissions and Command Access
permalink: /getting-started/permissions/
---

# Permissions and Command Access

Guild Manager uses several permission layers. An action must satisfy every layer that applies.

## Discord command visibility

Registered slash commands have default member permissions set to `0`. Ordinary members do not receive command access by default. Discord server owners and administrators configure access through **Server Settings → Integrations**.

An Integration override controls whether a member can invoke a command. It does not create character membership or override Guild Manager's manager, reviewer, host, and ownership checks.

## Feature authority

| Authority | Where it comes from |
| --- | --- |
| Registered character owner | The character's current registration in this Discord server |
| Managed member | At least one active character profile in a configured member group |
| Accounts manager | A configured Accounts manager role, or Discord Administrator permission |
| Re-gears manager | A configured Re-gears manager role, or Discord Administrator permission |
| Weapon Specialisation manager | A configured Weapon Specialisation manager role, or Discord Administrator permission |
| Application/ticket reviewer | The configured class reviewer role; Administrator permission alone does not grant reviewer authority |
| Party host | The party's current host; transfer changes who controls it |
| Giveaway host | The original giveaway host, with applicable Administrator management authority |

Party approval belongs to the current host; Administrator permission alone does not grant that approval authority. Consult each feature guide for its exact exceptions.

`/channel set|clear|show` and `/manager add|remove|list` require Discord Administrator permission, including their read operations. Manager roles are specific to a system and apply across all Albion Online servers in the invoking Discord server.

## Buttons and forms

Panel buttons do not require slash-command access, but they enforce their own rules. Channel visibility is enough to enter the Content hosting flow. Giveaway hosting additionally requires at least one registered Albion Online character. Giveaway entry requires active managed membership. Account, re-gear, and specialisation actions check their own character and role eligibility.

Restrict channel visibility to the intended audience and configure Integration access separately. Hiding a slash command is not a substitute for reviewing the buttons visible in a channel.

## The bot's own permissions

Guild Manager needs Discord permissions to perform an operation, and its highest role must sit above roles or members it needs to manage. Role hierarchy can prevent role or nickname changes even when the person invoking a command is authorized.

The Discord server owner's nickname is skipped during reconciliation. Other nickname or role failures should be investigated using the operation's warnings and the bot's role placement.

## Troubleshooting access

1. If a command is absent, check activation and Integration overrides.
2. If a command is visible but denied, check its runtime authority and character eligibility.
3. If a panel is absent or unavailable, check its configured channel and the bot's access.
4. If a permitted operation cannot change a role or channel, check Discord permission overwrites and role hierarchy.
5. If an old button no longer works, use the current panel or control message and start a fresh form.

See the [Command Reference]({{ '/reference/' | relative_url }}) and [Troubleshooting]({{ '/self-hosting/troubleshooting/' | relative_url }}) for operation-specific help.
