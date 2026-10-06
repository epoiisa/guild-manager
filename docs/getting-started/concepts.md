---
title: Key Concepts
permalink: /getting-started/concepts/
---

# Key Concepts

## Discord server and Albion Online server

A **Discord server** is the community where Guild Manager is installed. Its configuration, registrations, memberships, accounts, and operational records are isolated from other Discord servers.

An **Albion Online server** identifies a game region: North America (`americas`), Asia (`asia`), or Europe (`europe`). A character's durable identity combines the Albion Online server and Albion Online character ID. Names are display and search information; the same name is not a safe identity across regions.

## Registration, membership, and managed users

**Registration** links one Albion Online character to its current Discord owner. One Discord user can register multiple characters.

A **member group** is a configured Albion Online guild, Albion Online alliance, or custom group. A **member-group profile** represents one character's membership in that group.

A **managed user** owns at least one active member-group profile. Registration on its own does not make a user managed. Features can therefore allow a registered user to host a giveaway while requiring active managed membership to enter it.

## Main character and nickname

Registered characters have an order. The main character comes first and provides the default identity for nickname and profile presentation. New registrations append. Changing the main moves that character to the front; removing it promotes the next remaining registration.

An officer can configure a nickname override. Discord permissions and role hierarchy still determine whether Guild Manager can apply the nickname.

## Character records and registration history

Registration history records ownership periods. Accounts, re-gears, and weapon specialisations belong to the stable character identity within a Discord server, rather than to a particular registration period.

Re-registration reconnects retained eligible records. It does not recreate forfeited funds, repeat an accepted re-gear credit, or automatically restore former manager/reviewer authority and leadership positions.

## Departure and recovery

Discord departure and verified Albion Online membership loss are different lifecycles. They have separate recovery rules and deadlines. A failed Albion Online API check is not evidence that someone left a group.

An officer should inspect `/character status` before attempting recovery. See [Characters and Membership]({{ '/guides/characters-membership/' | relative_url }}) for the 72-hour holds, cleanup, explicit removal, and kick behavior.

## Accounts and evidence

A **character account** is a ledger shared across that character's memberships in this Discord server. An accepted re-gear request credits that account exactly once. Weapon specialisation proof records the reviewed character's specialisation; it does not itself create membership.

## Configuration and operations

Configuration defines a feature's channels, roles, templates, or classes. Operations act on particular parties, conversations, requests, or characters. For example, `/applications` configures application classes while `/application` acts on an application conversation.

`/status` reports configuration. `/tasks` reports open administrative queues. Neither replaces `/audit`, which examines membership reconciliation, or `/update`, which applies it.
