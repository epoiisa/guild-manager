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

## Open and use a ticket

Click the configured entry button. Guild Manager creates the conversation channel and posts an opening card identifying the opener and reviewer role. Discuss the issue there; general tickets have no claim or assigned-reviewer mechanism.

The opener or configured reviewers can **Close** the ticket. Closure retains the channel history. They can **Reopen** a closed ticket when further discussion is needed. A reviewer can **Delete** a closed ticket; deletion permanently removes its channel.

`/ticket close`, `/ticket reopen`, and `/ticket delete` provide the same lifecycle operations under their applicable permissions. Omit the target while running the command inside that ticket, or choose the specific ticket from autocomplete elsewhere.

## Stop intake or remove a class

`/tickets disable` stops new tickets for the class. `/tickets remove` is a confirmed removal of the class and its channels; use it only when that broader removal is intended.

If controls appear stale or a channel is unavailable, ask a reviewer to inspect the stored conversation and current permissions. Repeatedly clicking an old control does not grant additional access.

See [applications]({{ '/guides/applications/' | relative_url }}) for membership intake and the [command reference]({{ '/reference/' | relative_url }}) for exact options.
