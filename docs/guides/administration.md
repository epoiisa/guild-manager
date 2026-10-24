---
title: Administration and Moderation
permalink: /guides/administration/
---

# Administration and Moderation

Use Discord Integration overrides to grant only the commands each role needs. Operational authorization can additionally require a configured manager or reviewer role.

## Inspect and configure

`/status` reports stored server configuration. `/channel show` lists system channels; `/manager list` lists configured Accounts, Re-gears, and Weapon Specialisation manager roles. Configuring channels and manager roles requires Discord Administrator permission.

**Channel-report display deployed to Production (20 October 2026); automated checks verified, manual Discord acceptance pending. Upcoming in public source releases; absent from 0.1.0-alpha.1:** `/channel show` uses level 2 headings for Content, Accounts, Re-gears, Weapon Specialisation, Giveaways, Temporary Voice, and Logs, with each channel or `Not configured.` beneath its heading. The log destination's existing `Available` status means Guild Manager can currently find a supported channel with View Channel and Send Messages permission; it is not a test delivery. Other entries show stored settings.

Each panel feature has one channel shared across applicable Albion Online servers. `/channel set` publishes or repairs its panel. Reapplying the current setting can restore a missing panel. Clearing or moving a channel ends unfinished private setup; ordinary setup expires after 15 minutes. Existing requests, giveaway announcements, and party threads retain their original destinations.

`/channel set log` enables a concise membership and registration audit feed. Review channel visibility before configuring it. The feed omits conversations, answers, and proof, and failed delivery does not reverse a successful action.

## Membership and authority log (upcoming)

**Deployed to Production (20 October 2026); automated checks verified. Manual Discord acceptance remains pending. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

The optional Log feed adds committed position appointments, dismissals and deletion; main-character and nickname-preference changes; manager bindings; reviewer-role settings; and confirmed temporary application-role changes. It identifies the completing officer for officer actions. Self-service actions identify the affected member, and automatic cleanup has no invented actor. Mentions never notify.

Stored appointments and actual Discord access are separate facts. Orphaned appointments still count; a shared role stays assigned while another entitlement needs it. Position deletion also cleans up its retired role when appropriate. Repeated assignments remain silent unless an explicit appointment clears saved authority-role suppression or a real Discord repair succeeds. A saved nickname preference can succeed while applying it to Discord fails; the feed preserves that distinction and any partial-success warning.

Membership updates retain concise counts and identify actual restored memberships and final expiry. New Discord registration holds and Albion Online membership grace periods show their separate saved deadlines in your local time. Officer recovery distinguishes restored registration, retained membership restoration and fresh verified membership. Relevant operations include actual appointment losses and Pending request cleanup counts without account balances, conversations or evidence.

Kick reports authorized profile removals even without current registrations, the access block and any incomplete cleanup. Later successful cleanup is reported once. Officer reconnection reports restored Guild Manager access only when it actually clears a block; former appointments and authority do not return automatically. Whole-group summaries say **members affected**, without implying every Discord update succeeded.

Manager and reviewer entries describe configuration bindings, not every role holder's effective authority. Class edits affect future conversations; retained conversations keep their saved reviewer settings. Reports, `/audit`, cancellations, unchanged state, unrelated configuration and arbitrary external role/nickname edits stay out of the feed. Delivery remains optional and best effort after changes commit, with silent mentions, no historical replay and lossless continuation for long entries.

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

**Display refinement deployed to Production; manual Discord acceptance remains pending. Upcoming in public source releases; absent from 0.1.0-alpha.1:** the draft uses a level-one **Message Draft** heading and level-two **Destination Channel**, **Message**, and **Buttons (count)** headings. V2 drafts add a level-two **Accent** heading directly after **Destination Channel** and before **Message**, with the uppercase `#RRGGBB` colour in inline backticks. Message text appears in a plain-text code block. The expiry timestamp is hidden; drafts still expire after 15 minutes.

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

## Member usage roles and Registration (upcoming)

**Deployed to Production on 24 October 2026; automated deployment checks verified. Manual Production Discord acceptance confirmed on 24 October 2026. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

`/access add|remove|list` configures [member usage access]({{ '/getting-started/permissions/#member-usage-access-upcoming' | relative_url }}) independently of manager roles and Integration grants. `/status` includes usage roles and missing-role markers. The optional `register` channel enables self-registration and appears before Content in channel reports and shared panel order. Setting it warns that configured Albion Online guild/alliance membership and roles may be granted immediately; leave it unset for applications-only onboarding. Channel visibility and all existing recovery safeguards still apply.
