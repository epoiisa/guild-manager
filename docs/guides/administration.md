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

## Compose entry buttons (upcoming)

**Available in Production (verified 18 October 2026). Upcoming in public source releases; absent from 0.1.0-alpha.1.**

For an ordinary message, choose `/message post` or `/message compose` with `buttons:true`. Use `/message v2` for a coloured container with an optional image, or `/message forum` for a forum title and body. All four keep their existing immediate behavior when `buttons` is omitted or false. With true, compose, V2, and forum collect their usual form first; its submission opens the private draft. No public message or forum thread exists until **Post**.

1. Review the destination, text preview or labelled excerpt, media filename, and any forum title or V2 colour.
2. Choose **Add Application** or **Add Ticket**, select a class, and set its label and style in **Configure Button**. Labels contain 1–80 characters; styles are Primary, Secondary, Success, and Danger. Disabled classes remain disabled.
3. Use **Edit Buttons** to use **Edit Label / Style**, **Remove**, **Move Earlier**, or **Move Later**. A class appears once per type. The ordered summary shows five entries per page; selectors show up to 25, with navigation for the rest.
4. Use **Edit Message** to revise text and, for a forum, its title. Leave the replacement upload empty to keep the current file. Uploading a replacement changes the file; a V2 replacement must be an image. Buttons and accent colour are retained.
5. Choose **Post** to publish the whole message and its buttons together, or **Cancel** to discard the draft. Removing every button is allowed; the message still needs text or media.

Anyone currently allowed to use `/message` can configure both kinds of entry button in this workflow, without a separate `/applications` or `/tickets` grant. Every action rechecks `/message` access in the original channel. Drafts are private, bound to their initiating user and server, and expire 15 minutes after the command began, including the first form. Restart, reset, deactivation, or a Guild Manager access block invalidates applicable controls. Current `/message` access is rechecked; unavailable or revoked command grants block actions. Restoring a command grant does not extend the draft lifetime. Preview mentions never notify and preview buttons never open real intake.

Ordinary messages accept up to 2,000 text characters, V2 up to 4,000, and required forum titles up to 100. An attachment-only or image-only post remains valid. Ordinary posts allow five rows of five buttons; V2 posts also respect their container and total component limits. Final messages keep the usual mention policy, subject to Discord permissions. V2 buttons follow the text and image in the same editable container. Forum buttons belong to the new thread's starter message.

Publication includes every button in the first create request, with no follow-up public edit to attach them. This avoids that cause of an `(edited)` label; later edits can still add it. Each selected class records the new source location and button settings together. Older copies are not automatically removed. Draft edits and cancellation do not save settings or enable classes.

Correct validation errors in the draft before trying again. If Discord does not confirm whether a post was created, inspect the destination: that draft will not resend. If **Post Created — Settings Not Saved** appears, follow its link to the existing post and choose **Retry Saving Settings** to retry configuration only. It never creates another post or overwrites newer class changes. Recovery lasts until expiry or restart; later reconciliation can use the immediate button-add commands.

The existing `/applications button add` and `/tickets button add` commands still update an existing bot-authored message immediately, with their own access rules and private receipt. They do not open this draft and may produce Discord's `(edited)` label. `/message edit`, `/message repost`, and `/message pin` are unchanged.

## Reset or deactivate

`/reset` deletes this Discord server's Guild Manager data while leaving the bot activated. `/deactivate` removes its Guild Manager data and deactivates the server. Both require their confirmation flow and are broader than removing one feature. Retained character history cannot reconstruct data after a whole-server deletion.
