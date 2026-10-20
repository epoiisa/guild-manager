---
title: Private Tickets
permalink: /guides/tickets/
---

# Private Tickets

General tickets provide a private conversation with a configured reviewer role. They do not register characters or accept membership applications.

## Configure a ticket class

1. Use `/tickets create` with a name, Discord category, and reviewer role.
2. Use `/tickets messages set` to configure optional initial and closed messages.
3. Post a bot-authored entry message and use `/tickets button add` to attach the ticket button.
4. Inspect the class with `/tickets show`; `/tickets list` lists configured classes.

The category and bot permissions must allow creation and management of the private channel. Discord Administrators retain Discord-level visibility.

## Publish with buttons already included (upcoming)

**Available in Production (verified 18 October 2026). Upcoming in public source releases; absent from 0.1.0-alpha.1.**

Use `buttons:true` with `/message post`, `/message compose`, `/message v2`, or `/message forum` to prepare a new entry message privately. Choose **Add Ticket**, select a ticket class, and configure its label/style. You can mix application and ticket buttons, edit their order, and revise the message before **Post** creates the complete message. A forum thread is created only at that point. Disabled classes remain disabled.

Current `/message` access authorizes both button types in this workflow, without a separate class-configuration command grant. Drafts expire 15 minutes after the original command and do not survive a restart. See the [administration guide]({{ '/guides/administration/#compose-entry-buttons-upcoming' | relative_url }}) for editing, cancellation, and recovery.

`/tickets button add` remains the immediate way to attach or update a button on an existing bot-authored message. It keeps its own command access rules, opens no draft, and may show Discord's `(edited)` label. Omitted or false `buttons` values keep the normal `/message` posting behavior.

## Edit a class (upcoming)

Class editing and saved conversation settings are available in Production (verified 15 October 2026 UTC). They remain upcoming in public source releases and absent from **0.1.0-alpha.1**.

Use `/tickets edit <ticket> [name] [category] [reviewer]` to change settings for new tickets. Omitted settings remain unchanged, and disabled classes remain disabled. The Discord server stays fixed; general tickets have no applicant-role setting.

Each ticket retains the name, category, and reviewer role saved when it opened, including after closing and reopening. Editing does not rename or move its channel, transfer reviewer access or authority, or notify its participants. Configured messages and explicit entry-button labels keep their existing behavior.

Create and edit reject a reviewer role currently used as an applicant role by a non-archived application class in this Discord server, including a disabled class. Reviewer roles may be shared. Historical conversation roles are excluded from the check; see the [reference]({{ '/reference/applications-tickets/#class-editing-and-saved-settings-upcoming' | relative_url }}) for that limitation.

## Open and use a ticket

Click the configured entry button. Guild Manager creates the conversation channel and posts an opening card identifying the opener and reviewer role. Discuss the issue there; general tickets have no claim or assigned-reviewer mechanism.

The opener or configured reviewers can **Close** the ticket. Closure retains the channel history. They can **Reopen** a closed ticket when further discussion is needed. A reviewer can **Delete** a closed ticket; deletion permanently removes its channel.

`/ticket close`, `/ticket reopen`, and `/ticket delete` provide the same lifecycle operations under their applicable permissions. Omit the target while running the command inside that ticket, or choose the specific ticket from autocomplete elsewhere.

## Stop intake or remove a class

`/tickets disable` stops new tickets for the class. `/tickets remove` is a confirmed removal of the class and its channels; use it only when that broader removal is intended.

If controls appear stale or a channel is unavailable, ask a reviewer to inspect the stored conversation and current permissions. Repeatedly clicking an old control does not grant additional access.

See [applications]({{ '/guides/applications/' | relative_url }}) for membership intake and the [command reference]({{ '/reference/' | relative_url }}) for exact options.

## Reviewer configuration history (upcoming)

**Deployed to Production (20 October 2026); automated checks verified. Manual Discord acceptance remains pending. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

With a Log channel configured, ticket-class creation, actual reviewer-role changes and removal record the actor, class and relevant roles. Repeated or unrelated edits stay silent. Entries describe configuration changes; other grants may still authorize the same people. Existing conversations retain their saved reviewer role after class editing. Ordinary ticket conversations and lifecycle activity do not become a general conversation-history feed. See the [administration guide]({{ '/guides/administration/#membership-and-authority-log-upcoming' | relative_url }}).
