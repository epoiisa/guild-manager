---
title: Applications and Tickets
permalink: /reference/applications-tickets/
---

# Applications and Tickets

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

**Class editing is available in Production (verified 15 October 2026 UTC). It remains upcoming in public source releases and is absent from 0.1.0-alpha.1.** This includes the two `edit` commands, saved conversation settings, and class role-conflict checks described below.

Application classes define reviewed membership workflows. Ticket classes define private conversations without deciding membership. Both use entry buttons on bot-authored messages.

## Access and outcomes

Give class-configuration commands (`/applications` and `/tickets`) to administrators or officers through Discord integration permissions. Each class has its own reviewer role. Possession of an unrelated system manager role does not grant class review access.

For applications, reviewers accept, reject, retry character searches, and verify waiting in-game membership. An intended Albion Online character must be resolved and selected before acceptance. Acceptance can leave an application waiting for Albion Online guild or Albion Online alliance membership; `/application verify` retries that check. Cancelling a waiting application closes its conversation while preserving its waiting decision state.

Reviewers can close an undecided application. The applicant or reviewer can close a completed application and reopen an eligible closed conversation. Deletion requires the reviewer role and a closed channel. Closing or reopening a conversation is distinct from accepting or rejecting membership. Historical application channels blocked by a kick cannot be reopened.

Ticket openers and class reviewers can close and reopen their tickets. Only class reviewers can delete a closed ticket. Omit the optional operational target when running a command inside its own application or ticket channel; otherwise select the target with autocomplete.

Creating a class does not place its entry button. Post a message as Guild Manager, then attach the button using its channel and Discord message ID. Questions and message settings open forms. Disabling a class stops new entries; removing it requires confirmation and removes the class and associated channels.

## Publish entry messages with buttons (upcoming)

**Available in Production (verified 18 October 2026). Upcoming in public source releases; absent from 0.1.0-alpha.1.**

Only `buttons:true` on the four `/message` creation commands opens a private draft for mixed application and ticket buttons. An officer with current `/message` access may select either class type without a separate `/applications` or `/tickets` grant. The draft supports labels, styles, ordering, removal, text/title edits, and optional replacement media, retaining the current file when no replacement is supplied. It creates the complete message or forum starter only on **Post**; **Cancel** saves no settings and creates nothing. Disabled classes stay disabled.

Drafts expire 15 minutes after the command began and are lost on restart. Each class retains one configured source location; publishing does not remove older button copies. An uncertain create result does not resend. A known post with unsaved settings offers **Retry Saving Settings** against the same post within the remaining draft lifetime. See the [administration guide]({{ '/guides/administration/#compose-entry-buttons-upcoming' | relative_url }}).

The existing immediate `/applications button add` and `/tickets button add` commands remain available with their original permissions, validation, and private receipt. They add or update a button on an existing supported Guild Manager message without a draft or additional confirmation, and may produce Discord's `(edited)` label. Application add keeps its text/announcement channel picker; ticket add keeps its existing channel-picker behavior. The new forum composer does not change either command.

## Class editing and saved settings (upcoming)

Edits affect new conversations. Each application saves its class name, category, reviewer role, and optional applicant role when it opens; each ticket saves the first three. Existing conversations retain those settings through review, close, reopen, and cleanup. Their channels, permissions, reviewer authority, and applicant roles are not changed by editing the class. Edits do not notify participants. Existing questions, answers, configured messages, and explicit entry-button labels keep their existing behavior.

Supply at least one setting to edit. Omitted inputs remain unchanged. Applicant roles can be added or replaced, not removed; general tickets have no applicant role. Disabled classes can be edited without enabling intake. Archived application classes cannot be edited. The Discord server, Albion Online server, target group, and application outcome type remain fixed. Names must contain 1–80 characters after trimming spaces and be unique without regard to case within the Discord server and class type.

Create and edit reject `@everyone` as an applicant role and reject using a role for both applicants and reviewers across current application and ticket classes in the same Discord server. Disabled classes are included; archived classes and historical conversation settings are excluded. Sharing reviewer roles with other reviewers, or applicant roles with other applicants, is allowed. Reusing a role retained by older conversations can therefore give its new holders authority over those older conversations.

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
- [`/applications edit` (upcoming)](#applications-edit)
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
- [`/tickets edit` (upcoming)](#tickets-edit)
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

### /applications edit

```text
/applications edit <application> [name] [category] [reviewer] [role]
```

Edit an application class for new conversations. Upcoming in public source releases; absent from **0.1.0-alpha.1**. Available in Production.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `application` | Yes | Text | Application class. Choose a matching autocomplete suggestion. |
| `name` | No | Text | Replacement class name, 1–80 characters. |
| `category` | No | Discord channel | Category for new application channels. |
| `reviewer` | No | Discord role | Reviewer role for new applications. |
| `role` | No | Discord role | Applicant role for new applications; add or replace only. |

Omitted settings remain unchanged. Existing applications keep their saved settings, including when reopened. See [class editing and saved settings](#class-editing-and-saved-settings-upcoming).

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

### /tickets edit

```text
/tickets edit <ticket> [name] [category] [reviewer]
```

Edit a ticket class for new conversations. Upcoming in public source releases; absent from **0.1.0-alpha.1**. Available in Production.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `ticket` | Yes | Text | Ticket class. Choose a matching autocomplete suggestion. |
| `name` | No | Text | Replacement class name, 1–80 characters. |
| `category` | No | Discord channel | Category for new ticket channels. |
| `reviewer` | No | Discord role | Reviewer role for new tickets. |

Omitted settings remain unchanged. Existing tickets keep their saved settings, including when reopened. See [class editing and saved settings](#class-editing-and-saved-settings-upcoming).

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

