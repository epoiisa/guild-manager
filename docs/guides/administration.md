---
title: Administration and Moderation
permalink: /guides/administration/
---

# Administration and Moderation

Use Discord Integration overrides to grant only the commands each role needs. Operational authorization can additionally require a configured manager or reviewer role.

## Inspect and configure

`/status` reports stored server configuration. `/channel show` lists system channels; `/manager list` lists configured Accounts, Re-gears, and Weapon Specialisation manager roles. Configuring channels and manager roles requires Discord Administrator permission.

Each panel feature has one channel shared across applicable Albion Online servers. `/channel set` publishes or repairs its panel. Reapplying the current setting can restore a missing panel. Clearing or moving a channel ends unfinished private setup; ordinary setup expires after 15 minutes. Existing requests, giveaway announcements, and party threads retain their original destinations.

`/channel set log` enables a concise membership and registration audit feed. Review channel visibility before configuring it. The feed omits conversations, answers, and proof, and failed delivery does not reverse a successful action.

## Audit and reconcile membership

Use `/audit` to inspect proposed membership, role, and nickname changes without applying them. Read the attached report. Use `/update` to apply reconciliation and inspect its result attachment.

`/schedule set` configures automatic updates for Daily or a UTC weekday at a UTC time. `/schedule view` inspects the schedule; `/schedule remove` disables it. Confirmed Albion Online membership departures receive a minimum 72-hour buffer before a later verified cleanup. Without a schedule, that membership cleanup waits for `/update`. Unavailable evidence defers removal.

`/tasks` privately lists open applications, general tickets, Open re-gear content, Pending re-gears, and Pending specialisation requests. Access to `/tasks` grants visibility of the complete report; it does not grant authority over its listed work or access to linked channels.

## Revoke access

`/kick` revokes Guild Manager access until officer reconnection. It removes memberships, positions, manager/reviewer authority, and participation or conversation access while preserving character accounts, re-gears, and weapon specialisations. It is a Guild Manager lifecycle action; it does not act as a Discord server kick command.

Use `/character register` for authorized reconnection after cleanup finishes. Former authority and appointments do not automatically return. `/purge` is retired.

## Messages and server data

The `/message` commands provide posting, composing, forum posts, reposting, editing, and pinning under their access rules. `/clear` removes messages according to its selected command options. Review destinations and content before publishing or deleting.

`/reset` deletes this Discord server's Guild Manager data while leaving the bot activated. `/deactivate` removes its Guild Manager data and deactivates the server. Both require their confirmation flow and are broader than removing one feature. Retained character history cannot reconstruct data after a whole-server deletion.
