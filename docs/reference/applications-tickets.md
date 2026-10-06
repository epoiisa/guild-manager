---
title: Applications and Tickets
permalink: /reference/applications-tickets/
---

# Applications and Tickets

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Application classes define reviewed membership workflows. Ticket classes define private conversations without deciding membership. Both use entry buttons attached to bot-authored messages.

## Access and outcomes

Give class-configuration commands (`/applications` and `/tickets`) to administrators or officers through Discord integration permissions. Each class has its own reviewer role. Possession of an unrelated system manager role does not grant class review access.

For applications, reviewers accept, reject, retry character searches, and verify waiting in-game membership. An intended Albion Online character must be resolved and selected before acceptance. Acceptance can leave an application waiting for Albion Online guild or Albion Online alliance membership; `/application verify` retries that check. Cancelling a waiting application closes its conversation while preserving its waiting decision state.

Reviewers can close an undecided application. The applicant or reviewer can close a completed application and reopen an eligible closed conversation. Deletion requires the reviewer role and a closed channel. Closing or reopening a conversation is distinct from accepting or rejecting membership. Historical application channels blocked by a kick cannot be reopened.

Ticket openers and class reviewers can close and reopen their tickets. Only class reviewers can delete a closed ticket. Omit the optional operational target when running a command inside its own application or ticket channel; otherwise select the target with autocomplete.

Creating a class does not place its entry button. Post a message as Guild Manager, then attach the button using its channel and Discord message ID. Questions and message settings open forms. Disabling a class stops new entries; removing it requires confirmation and removes the class and associated channels.

## Commands

- [`/application accept`](#application-accept)
- [`/application reject`](#application-reject)
- [`/application search`](#application-search)
- [`/application verify`](#application-verify)
- [`/application cancel`](#application-cancel)
- [`/application close`](#application-close)
- [`/application reopen`](#application-reopen)
- [`/application delete`](#application-delete)
- [`/applications list`](#applications-list)
- [`/applications show`](#applications-show)
- [`/applications create`](#applications-create)
- [`/applications button add`](#applications-button-add)
- [`/applications questions set`](#applications-questions-set)
- [`/applications questions clear`](#applications-questions-clear)
- [`/applications messages set`](#applications-messages-set)
- [`/applications messages clear`](#applications-messages-clear)
- [`/applications disable`](#applications-disable)
- [`/applications remove`](#applications-remove)
- [`/ticket close`](#ticket-close)
- [`/ticket reopen`](#ticket-reopen)
- [`/ticket delete`](#ticket-delete)
- [`/tickets list`](#tickets-list)
- [`/tickets show`](#tickets-show)
- [`/tickets create`](#tickets-create)
- [`/tickets button add`](#tickets-button-add)
- [`/tickets messages set`](#tickets-messages-set)
- [`/tickets messages clear`](#tickets-messages-clear)
- [`/tickets disable`](#tickets-disable)
- [`/tickets remove`](#tickets-remove)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /application accept

```text
/application accept [application]
```

Accept an undecided membership application.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application reject

```text
/application reject [application]
```

Reject an undecided membership application.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application search

```text
/application search <character> [application]
```

Retry or replace the application character search.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Albion Online character name to search. Minimum length: 1 character. Maximum length: 64 characters. |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application verify

```text
/application verify [application]
```

Verify in-game membership for a waiting application.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application cancel

```text
/application cancel [application]
```

Close a waiting application without changing its waiting state.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application close

```text
/application close [application]
```

Close an undecided or completed application channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application reopen

```text
/application reopen [application]
```

Reopen a closed application channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /application delete

```text
/application delete [application]
```

Permanently delete a closed application channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | No | Text | Application target; omit in its application channel. Choose a matching autocomplete suggestion. |

### /applications list

```text
/applications list
```

List application classes.

This command has no slash-command inputs.

### /applications show

```text
/applications show <application>
```

Show application class configuration.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |

### /applications create

```text
/applications create <name> <server> <group> <category> <reviewer> [role]
```

Create a membership application class.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `name` | Yes | Text | Staff-facing application name. Minimum length: 1 character. Maximum length: 80 characters. |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Target member group. Choose a matching autocomplete suggestion. |
| `category` | Yes | Discord channel | Category where application ticket channels are created. |
| `reviewer` | Yes | Discord role | Role allowed to review applications. |
| `role` | No | Discord role | Optional role granted while a ticket is open. |

### /applications button add

```text
/applications button add <application> <channel> <id> <label> <style>
```

Attach an application button to a bot-authored message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |
| `channel` | Yes | Discord channel | Channel containing the bot-authored message. |
| `id` | Yes | Text | Bot-authored message ID. |
| `label` | Yes | Text | Button label. Minimum length: 1 character. Maximum length: 80 characters. |
| `style` | Yes | Text | Button style. Choices: Primary, Secondary, Success, Danger. |

### /applications questions set

```text
/applications questions set <application>
```

Open a modal to set optional application questions.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |

### /applications questions clear

```text
/applications questions clear <application>
```

Clear optional application questions.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |

### /applications messages set

```text
/applications messages set <application> <type>
```

Open a modal to set an application message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |
| `type` | Yes | Text | Message to set. Choices: Initial, Accepted, Rejected. |

### /applications messages clear

```text
/applications messages clear <application> <type>
```

Clear an application message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |
| `type` | Yes | Text | Message to clear. Choices: Initial, Accepted, Rejected. |

### /applications disable

```text
/applications disable <application>
```

Disable an application class.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |

### /applications remove

```text
/applications remove <application>
```

Confirm removal of an application class and its channels.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |

### /ticket close

```text
/ticket close [ticket]
```

Close an open general ticket.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | No | Text | Ticket target; omit in its ticket channel. Choose a matching autocomplete suggestion. |

### /ticket reopen

```text
/ticket reopen [ticket]
```

Reopen a closed general ticket.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | No | Text | Ticket target; omit in its ticket channel. Choose a matching autocomplete suggestion. |

### /ticket delete

```text
/ticket delete [ticket]
```

Permanently delete a closed general ticket channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | No | Text | Ticket target; omit in its ticket channel. Choose a matching autocomplete suggestion. |

### /tickets list

```text
/tickets list
```

List ticket classes.

This command has no slash-command inputs.

### /tickets show

```text
/tickets show <ticket>
```

Show ticket class configuration.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |

### /tickets create

```text
/tickets create <name> <category> <reviewer>
```

Create a general ticket class.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `name` | Yes | Text | Staff-facing ticket name. Minimum length: 1 character. Maximum length: 80 characters. |
| `category` | Yes | Discord channel | Category where ticket channels are created. |
| `reviewer` | Yes | Discord role | Role allowed to review tickets. |

### /tickets button add

```text
/tickets button add <ticket> <channel> <id> <label> <style>
```

Attach a ticket button to a bot-authored message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |
| `channel` | Yes | Discord channel | Channel containing the message. |
| `id` | Yes | Text | Message ID. |
| `label` | Yes | Text | Button label. Minimum length: 1 character. Maximum length: 80 characters. |
| `style` | Yes | Text | Button style. Choices: Primary, Secondary, Success, Danger. |

### /tickets messages set

```text
/tickets messages set <ticket> <type>
```

Open a modal to set a ticket message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |
| `type` | Yes | Text | Message type. Choices: Initial, Closed. |

### /tickets messages clear

```text
/tickets messages clear <ticket> <type>
```

Clear a ticket message.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |
| `type` | Yes | Text | Message type. Choices: Initial, Closed. |

### /tickets disable

```text
/tickets disable <ticket>
```

Disable a ticket class.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |

### /tickets remove

```text
/tickets remove <ticket>
```

Confirm removal of a ticket class and its channels.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |

