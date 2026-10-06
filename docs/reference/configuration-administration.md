---
title: Configuration and Administration
permalink: /reference/configuration-administration/
---

# Configuration and Administration

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

These commands activate the bot, configure its channels and roles, reconcile membership, and perform server administration.

## Access and outcomes

Slash commands default to disabled for ordinary members. Administrators control access through Discord integration permissions. `/manager`, `/channel`, and `/reset` also explicitly require Discord Administrator permission. Assign sensitive administration commands only to trusted officers.

`/manager` configures Accounts, Re-gears, and Weapon Specialisation manager roles across all Albion Online servers within this Discord server. `/channel` configures content, account, regear, specialisation, giveaway, voice, and log destinations. Feature channels coordinate entry panels; manager roles and channel visibility are separate settings. Clearing a channel removes its configuration, not all historical feature records. The voice destination is the base channel for temporary voice rooms. The optional log channel receives confirmed membership changes and depends on its visibility and bot permissions.

`/audit` previews configured membership and Discord-role reconciliation without applying it. `/update` applies reconciliation and exports a complete text report. `/schedule` sets, removes, or shows recurring member updates in UTC. `/status` reports configuration; `/tasks` reports administrative work needing attention; `/ping` reports bot health.

`/reaction roles` configures existing opt-in Discord roles. `/reaction emoji add` connects a role to an emoji on a bot-authored message. Removing the role configuration removes tracked/cached grants; emoji removal removes a selected placement. `/roles` reports the caller's membership and reaction roles.

`/message` posts or edits bot-authored messages and supports multiline forms, coloured containers, forum posts, reposts, and pinning. Some operations default to the current channel. Discord channel type, attachment access, message ownership, and the bot's permissions constrain each operation. `/clear` deletes recent messages in the current channel and accepts an optional count and user filter; The default count is 10; messages at least 14 days old are excluded.

`/bot name` and `/bot avatar` change the bot's identity in this Discord server. `/utc add` creates a managed voice channel showing UTC time; `/utc remove` deletes it.

## Destructive lifecycle commands

`/activate` registers active commands for the current Discord server. It is the activation-only command offered before Guild Manager is active.

`/reset` presents confirmation before deleting this Discord server's Guild Manager data and configuration; activation remains. `/deactivate` presents confirmation before deleting the data and configuration and returning to activation-only commands. Both remove the managed UTC time channel. Existing unrelated channels, messages, and roles are not a database backup and remain separate Discord resources. Read the bot's confirmation before acting and keep a database backup if recovery is needed.

See the UTC input rules in the [command index]({{ '/reference/' | relative_url }}).

## Commands

- [`/activate`](#activate)
- [`/manager add`](#manager-add)
- [`/manager remove`](#manager-remove)
- [`/manager list`](#manager-list)
- [`/channel set`](#channel-set)
- [`/channel clear`](#channel-clear)
- [`/channel show`](#channel-show)
- [`/audit`](#audit)
- [`/bot name set`](#bot-name-set)
- [`/bot name clear`](#bot-name-clear)
- [`/bot avatar set`](#bot-avatar-set)
- [`/bot avatar clear`](#bot-avatar-clear)
- [`/clear`](#clear)
- [`/deactivate`](#deactivate)
- [`/message post`](#message-post)
- [`/message compose`](#message-compose)
- [`/message v2`](#message-v2)
- [`/message forum`](#message-forum)
- [`/message edit`](#message-edit)
- [`/message repost`](#message-repost)
- [`/message pin`](#message-pin)
- [`/ping`](#ping)
- [`/reaction roles add`](#reaction-roles-add)
- [`/reaction roles remove`](#reaction-roles-remove)
- [`/reaction roles list`](#reaction-roles-list)
- [`/reaction emoji add`](#reaction-emoji-add)
- [`/reaction emoji remove`](#reaction-emoji-remove)
- [`/reset`](#reset)
- [`/schedule set`](#schedule-set)
- [`/schedule remove`](#schedule-remove)
- [`/schedule view`](#schedule-view)
- [`/status`](#status)
- [`/tasks`](#tasks)
- [`/update`](#update)
- [`/utc add`](#utc-add)
- [`/utc remove`](#utc-remove)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /activate

```text
/activate
```

Activate Guild Manager on this Discord server.

This command has no slash-command inputs.

### /manager add

```text
/manager add <system> <role>
```

Add a system manager role.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `system` | Yes | Text | System to manage. Choices: Accounts, Re-gears, Weapon Specialisation. |
| `role` | Yes | Discord role | Discord manager role. |

### /manager remove

```text
/manager remove <system> <role>
```

Remove a system manager role.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `system` | Yes | Text | System to manage. Choices: Accounts, Re-gears, Weapon Specialisation. |
| `role` | Yes | Discord role | Discord manager role. |

### /manager list

```text
/manager list [system]
```

List configured system manager roles.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `system` | No | Text | System to manage. Choices: Accounts, Re-gears, Weapon Specialisation. |

### /channel set

```text
/channel set <system> <channel>
```

Set a system's channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `system` | Yes | Text | System whose channel is being configured. Choices: content, account, regear, specialisation, giveaway, voice, log. |
| `channel` | Yes | Discord channel | Channel to use for this system. |

### /channel clear

```text
/channel clear <system>
```

Clear a system's channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `system` | Yes | Text | System whose channel is being configured. Choices: content, account, regear, specialisation, giveaway, voice, log. |

### /channel show

```text
/channel show [system]
```

Show one or all configured system channels.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `system` | No | Text | System whose channel is being configured. Choices: content, account, regear, specialisation, giveaway, voice, log. |

### /audit

```text
/audit
```

Preview configured membership group and Discord role reconciliation.

This command has no slash-command inputs.

### /bot name set

```text
/bot name set <name>
```

Set Guild Manager's server nickname.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `name` | Yes | Text | Server-specific bot nickname. Minimum length: 1 character. Maximum length: 32 characters. |

### /bot name clear

```text
/bot name clear
```

Clear Guild Manager's server nickname.

This command has no slash-command inputs.

### /bot avatar set

```text
/bot avatar set <attachment>
```

Set Guild Manager's server avatar.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `attachment` | Yes | Attachment | Server-specific bot avatar image. |

### /bot avatar clear

```text
/bot avatar clear
```

Clear Guild Manager's server avatar.

This command has no slash-command inputs.

### /clear

```text
/clear [number] [user]
```

Delete recent messages from this channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `number` | No | Whole number | Number of messages to delete. Defaults to 10. Minimum: 1. Maximum: 100. |
| `user` | No | Discord user | Delete only messages sent by this user. |

### /deactivate

```text
/deactivate
```

Deactivate Guild Manager and purge this server's data.

This command has no slash-command inputs.

### /message post

```text
/message post [channel] [message] [attachment]
```

Post a message as Guild Manager.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `channel` | No | Discord channel | Channel to post in. Defaults to the current channel. |
| `message` | No | Text | Message text. Maximum length: 2000 characters. |
| `attachment` | No | Attachment | Attachment to include. |

### /message compose

```text
/message compose [channel] [attachment]
```

Open a multiline editor and post as Guild Manager.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `channel` | No | Discord channel | Channel to post in. Defaults to the current channel. |
| `attachment` | No | Attachment | Attachment to include. |

### /message v2

```text
/message v2 [color] [channel]
```

Compose a message with a coloured container and optional image.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `color` | No | Text | Accent colour. Defaults to Slate. Choose a colour or enter #RRGGBB. Choose a matching autocomplete suggestion. |
| `channel` | No | Discord channel | Channel to post in. Defaults to the current channel. |

### /message forum

```text
/message forum [channel] [attachment]
```

Open an editor and create a forum post as Guild Manager.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `channel` | No | Discord channel | Forum channel. Defaults to the current forum when used from a forum thread. |
| `attachment` | No | Attachment | Attachment to include. |

### /message edit

```text
/message edit <id> [channel]
```

Edit a message posted as Guild Manager.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `id` | Yes | Text | Message ID to edit. |
| `channel` | No | Discord channel | Channel containing the message. Defaults to the current channel. |

### /message repost

```text
/message repost <id> [source] [destination]
```

Repost an existing message as Guild Manager.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `id` | Yes | Text | Message ID to repost. |
| `source` | No | Discord channel | Channel containing the original message. Defaults to the current channel. |
| `destination` | No | Discord channel | Channel to repost in. Defaults to the current channel. |

### /message pin

```text
/message pin <id> [channel]
```

Pin an existing message without changing other pins.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `id` | Yes | Text | Message ID to pin. |
| `channel` | No | Discord channel | Channel containing the message. Defaults to the current channel. |

### /ping

```text
/ping
```

Check Guild Manager health.

This command has no slash-command inputs.

### /reaction roles add

```text
/reaction roles add <role>
```

Configure an existing Discord role.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `role` | Yes | Discord role | Discord role. |

### /reaction roles remove

```text
/reaction roles remove <role>
```

Remove a reaction role from tracked and cached members.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `role` | Yes | Text | Configured reaction role. Choose a matching autocomplete suggestion. |

### /reaction roles list

```text
/reaction roles list
```

List configured reaction roles.

This command has no slash-command inputs.

### /reaction emoji add

```text
/reaction emoji add <message> <role> <emoji>
```

Attach a role emoji to a bot-authored message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `message` | Yes | Text | Message link, or ID for a message in this channel. |
| `role` | Yes | Text | Configured reaction role. Choose a matching autocomplete suggestion. |
| `emoji` | Yes | Text | One Unicode emoji or an available custom emoji. |

### /reaction emoji remove

```text
/reaction emoji remove <role>
```

Remove one configured role emoji.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `role` | Yes | Text | Configured reaction role. Choose a matching autocomplete suggestion. |

### /reset

```text
/reset
```

Delete this Discord server's Guild Manager data.

This command has no slash-command inputs.

### /schedule set

```text
/schedule set <day> <time>
```

Schedule automatic member updates.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `day` | Yes | Text | Daily or one UTC weekday. Choose a matching autocomplete suggestion. |
| `time` | Yes | Text | UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |

### /schedule remove

```text
/schedule remove
```

Remove the automatic member update schedule.

This command has no slash-command inputs.

### /schedule view

```text
/schedule view
```

View the automatic member update schedule.

This command has no slash-command inputs.

### /status

```text
/status
```

Show this server's Guild Manager configuration.

This command has no slash-command inputs.

### /tasks

```text
/tasks
```

Show open administrative tasks for this server.

This command has no slash-command inputs.

### /update

```text
/update
```

Reconcile configured membership groups and Discord roles.

This command has no slash-command inputs.

### /utc add

```text
/utc add
```

Create the UTC time voice channel.

This command has no slash-command inputs.

### /utc remove

```text
/utc remove
```

Remove the UTC time voice channel.

This command has no slash-command inputs.

