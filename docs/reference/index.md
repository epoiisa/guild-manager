---
title: Command Reference
permalink: /reference/
---

# Command Reference

This reference describes **0.1.0-alpha.1**, the public source release. Commands available on another running version may differ.

Upcoming features are explicitly marked in their topic pages and are excluded from the released command counts below.

Each topic lists exact registered command signatures, input names, accepted choices, required and optional options, and operational rules. Guides explain complete workflows; use this reference when choosing a command or checking an input.

## Topics

| Topic | Command families | Registered actions |
| --- | --- | --- |
| [Registration and Membership]({{ "/reference/registration-membership/" | relative_url }}) | `/register`, `/unregister`, `/character`, `/member`, `/membership`, `/roles`, `/kick` | 20 |
| [Member Groups and Positions]({{ "/reference/groups-positions/" | relative_url }}) | `/guild`, `/alliance`, `/group`, `/position` | 33 |
| [Applications and Tickets]({{ "/reference/applications-tickets/" | relative_url }}) | `/applications`, `/application`, `/tickets`, `/ticket` | 29 |
| [Parties and Templates]({{ "/reference/parties-templates/" | relative_url }}) | `/template`, `/party`, `/join`, `/leave`, `/standby` | 22 |
| [Giveaways]({{ "/reference/giveaways/" | relative_url }}) | `/giveaway`, `/giveaways` | 5 |
| [Character Accounts]({{ "/reference/accounts/" | relative_url }}) | `/account`, `/balance`, `/statement`, `/credit`, `/debit`, `/transfer`, `/give` | 12 |
| [Re-gears]({{ "/reference/regears/" | relative_url }}) | `/regear`, `/regearme`, `/regears` | 10 |
| [Weapon Specialisation]({{ "/reference/specialisation/" | relative_url }}) | `/weapon`, `/weapons`, `/specialisation` | 10 |
| [Configuration and Administration]({{ "/reference/configuration-administration/" | relative_url }}) | `/activate`, `/deactivate`, `/reset`, `/manager`, `/channel`, `/bot`, `/clear`, `/message`, `/reaction`, `/schedule`, `/audit`, `/update`, `/status`, `/tasks`, `/ping`, `/utc` | 36 |

The release contains **51 top-level commands and 177 executable command actions**, including `/activate`. An active Discord server receives the 50 active command families; activation-only registration contains `/activate`.

## Reading a signature

`/account set <character> <balance> <description>` has three required options. `/statement [character]` has one optional option. Enter these through Discord's slash-command picker; brackets and placeholder names are notation, not literal values.

Autocomplete suggestions identify exact stored records. Select the matching Albion Online character and Albion Online server rather than guessing an identifier. Select earlier filtering options first when later choices depend on them.

## Shared access rules

Commands run in a Discord server, not direct messages. Each Discord server has isolated Guild Manager configuration and records. Slash commands default to hidden from ordinary members; administrators grant access in Discord's integration settings. Command visibility alone does not override runtime ownership, manager, reviewer, account, or channel checks.

Most feedback and reports are private to the caller. Commands that publish to a channel, manage a party, create a ticket, or announce a decision produce persistent Discord content as described on their topic page. Private entry-panel forms expire after 15 minutes or a bot restart. If a form or control is stale, reopen the command or current entry panel.

A user whose Guild Manager access has been revoked cannot use normal commands or autocomplete until an officer reconnects them. During an access change, the bot may ask other users to retry shortly.

## Albion Online server inputs

Albion Online server choices are **North America**, **Asia**, and **Europe**. Some list or configuration selections offer **All Servers**. Use that only where offered; it is a selection scope, not an additional Albion Online server.

## UTC dates and times

Scheduling uses UTC. Date inputs describe their expected format in the command's input table; choose autocomplete dates where supplied.

Clock inputs accept `H`, `HH`, `H:MM`, or `HH:MM`: for example `9`, `09`, `9:30`, and `09:30`. Missing minutes mean `00`; supplied minutes must contain two digits from `00` to `59`.

Hours run from `0` to `23`. `24` and `24:00` mean midnight at the end of the selected date, on the next UTC date. `0` and `00:00` mean midnight at its beginning. `24:01` is invalid. Weekly schedules advance to the next weekday for hour 24; Daily at hour 24 runs at midnight daily.

These rules apply to scheduled parties, party edits, giveaways, re-gear content, and automatic member-update schedules.

## Destructive operations

Review confirmations before deleting member groups, application or ticket classes, or all server data. Closing a conversation or content record differs from deleting it. `/kick` revokes Guild Manager access and preserves character-owned records; `/reset` and `/deactivate` delete Guild Manager data for the Discord server.

If Discord reports missing channel or role permissions, correct the bot's access and hierarchy before retrying. When a receipt says a database decision succeeded but presentation failed, inspect the stored record or report before repeating an adjustment.
