---
title: Giveaways
permalink: /reference/giveaways/
---

# Giveaways

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

A giveaway posts a scheduled draw in the configured giveaway channel. The creation command opens an editor for the giveaway text.

## Access and outcomes

Grant creation through Discord integration permissions and ensure the creator can use the configured channel. A current Discord member who is not timed out can manage their own giveaway. Discord administrators can manage others' giveaways, subject to revoked host authority checks.

Eligible managed members enter by reacting with 🎁 to the giveaway message. Other emoji do not enter the draw. Removing the entry reaction withdraws participation. Draws select from eligible participants; `/giveaway draw` draws an open giveaway immediately, while `/giveaway reroll` replaces one selected unavailable winner and retains the others. Cancel applies to an open giveaway.

The optional notification is a Discord role. Date and time are UTC; choose a valid future draw time. The bot posts draw outcomes in the configured channel. `/giveaways` reports the server's open giveaways with links.

See the UTC input rules in the [command index]({{ '/reference/' | relative_url }}).

## Commands

- [`/giveaway create`](#giveaway-create)
- [`/giveaway draw`](#giveaway-draw)
- [`/giveaway reroll`](#giveaway-reroll)
- [`/giveaway cancel`](#giveaway-cancel)
- [`/giveaways`](#giveaways)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /giveaway create

```text
/giveaway create <date> <time> <winners> [image] [notification]
```

Create a scheduled giveaway in the configured channel.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `date` | Yes | Text | UTC date. Choose one of the next 7 days. Choose a matching autocomplete suggestion. |
| `time` | Yes | Text | UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |
| `winners` | Yes | Whole number | Number of winners to draw. Minimum: 1. Maximum: 5. |
| `image` | No | Attachment | Optional image displayed in the giveaway. |
| `notification` | No | Discord role | Optional Discord role to notify. |

### /giveaway draw

```text
/giveaway draw <giveaway>
```

Draw one of your open giveaways now.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `giveaway` | Yes | Text | Open giveaway to draw. Choose a matching autocomplete suggestion. |

### /giveaway reroll

```text
/giveaway reroll <giveaway> <winner>
```

Replace one unavailable winner while retaining the others.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `giveaway` | Yes | Text | Drawn giveaway to update. Choose a matching autocomplete suggestion. |
| `winner` | Yes | Text | Unavailable winner to replace. Choose a matching autocomplete suggestion. |

### /giveaway cancel

```text
/giveaway cancel <giveaway>
```

Cancel one of your open giveaways.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `giveaway` | Yes | Text | Open giveaway to cancel. Choose a matching autocomplete suggestion. |

### /giveaways

```text
/giveaways
```

Show open giveaways on this server.

This command has no slash-command inputs.

