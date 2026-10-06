---
title: Parties and Templates
permalink: /reference/parties-templates/
---

# Parties and Templates

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Content templates define signup layouts; parties use a selected template to create a content thread and signup controls in the configured content channel.

## Access and outcomes

Grant template editing and party hosting through Discord integration permissions. Hosts must be able to use the configured content channel. Commands referring to the “current” party run in its managed content thread.

The party host controls edits, transfers, roster changes, and lifecycle actions. Approval reviews validate the current host and pending requested place. Member commands `/join`, `/leave`, and `/standby` act on the caller in the current signup. Selecting a signup place may open additional controls.

Scheduled hosting requires a UTC date and time. Unscheduled hosting omits a start timestamp. Optional `approval` and `multisignup` settings are chosen at creation. Multi-signup permits several users to sign up for the same numbered role; each user retains one confirmed place. Both approval and multi-signup settings are fixed at creation. When approval is required, requested places remain pending until reviewed.

`/party start` marks the party started; the party's controls allow undo where available without extending its cleanup deadline. Ending or cancelling concludes the party; archiving removes it from the active list. Template creation, editing, and capture use interactive forms. Capture saves the current content thread as a reusable template.

See the UTC input rules in the [command index]({{ '/reference/' | relative_url }}).

## Commands

- [`/join`](#join)
- [`/leave`](#leave)
- [`/party host scheduled`](#party-host-scheduled)
- [`/party host unscheduled`](#party-host-unscheduled)
- [`/party list`](#party-list)
- [`/party edit`](#party-edit)
- [`/party start`](#party-start)
- [`/party end`](#party-end)
- [`/party cancel`](#party-cancel)
- [`/party archive`](#party-archive)
- [`/party transfer`](#party-transfer)
- [`/party add`](#party-add)
- [`/party accept`](#party-accept)
- [`/party decline`](#party-decline)
- [`/party remove`](#party-remove)
- [`/template create`](#template-create)
- [`/template list`](#template-list)
- [`/template edit`](#template-edit)
- [`/template show`](#template-show)
- [`/template remove`](#template-remove)
- [`/template capture`](#template-capture)
- [`/standby`](#standby)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /join

```text
/join
```

Join the current content signup.

This command has no slash-command inputs.

### /leave

```text
/leave
```

Leave the current content signup.

This command has no slash-command inputs.

### /party host scheduled

```text
/party host scheduled <date> <time> <template> [approval] [multisignup]
```

Create a scheduled content signup party.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `date` | Yes | Text | UTC date. Choose one of the next 7 days. Choose a matching autocomplete suggestion. |
| `time` | Yes | Text | UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |
| `template` | Yes | Text | Content template, or Blank to start from an empty form. Choose a matching autocomplete suggestion. |
| `approval` | No | Text | Require host approval for signups. Choices: Host approval not required, Host approval required. |
| `multisignup` | No | Text | Allow multiple users to sign up for each role. Choices: Multi-signup off, Multi-signup on. |

### /party host unscheduled

```text
/party host unscheduled <template> [approval] [multisignup]
```

Host a content signup party with no scheduled start.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Content template, or Blank to start from an empty form. Choose a matching autocomplete suggestion. |
| `approval` | No | Text | Require host approval for signups. Choices: Host approval not required, Host approval required. |
| `multisignup` | No | Text | Allow multiple users to sign up for each role. Choices: Multi-signup off, Multi-signup on. |

### /party list

```text
/party list
```

List all non-archived content signup parties.

This command has no slash-command inputs.

### /party edit

```text
/party edit [date] [time] [image]
```

Edit the current content signup party.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `date` | No | Text | Optional UTC date. Choose a matching autocomplete suggestion. |
| `time` | No | Text | Optional UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |
| `image` | No | Attachment | Optional builds graphic to replace the current image. |

### /party start

```text
/party start
```

Start the current content signup party.

This command has no slash-command inputs.

### /party end

```text
/party end
```

End the current content signup party.

This command has no slash-command inputs.

### /party cancel

```text
/party cancel
```

Cancel the current content signup party.

This command has no slash-command inputs.

### /party archive

```text
/party archive
```

Archive the current content signup party.

This command has no slash-command inputs.

### /party transfer

```text
/party transfer <user>
```

Transfer ownership of the current party.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | New party host. |

### /party add

```text
/party add <user>
```

Add or move a user in the current content signup.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User to add or move. |

### /party accept

```text
/party accept <user>
```

Accept a user's pending signup request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User whose request to accept. |

### /party decline

```text
/party decline <user>
```

Decline a user's pending signup request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User whose request to decline. |

### /party remove

```text
/party remove <user>
```

Remove a user from the current content signup.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User to remove. |

### /template create

```text
/template create
```

Create a content signup template.

This command has no slash-command inputs.

### /template list

```text
/template list
```

List content signup templates.

This command has no slash-command inputs.

### /template edit

```text
/template edit <template>
```

Edit a content signup template.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Template to edit. Choose a matching autocomplete suggestion. |

### /template show

```text
/template show <template>
```

Show a content signup template.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Template to show. Choose a matching autocomplete suggestion. |

### /template remove

```text
/template remove <template>
```

Remove a content signup template.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Template to remove. Choose a matching autocomplete suggestion. |

### /template capture

```text
/template capture
```

Save the current content thread as a template.

This command has no slash-command inputs.

### /standby

```text
/standby
```

Join standby for the current content signup.

This command has no slash-command inputs.

