---
title: Characters and Membership
permalink: /guides/characters-membership/
---

# Characters and Membership

Registration connects an Albion Online character to a Discord user within this Discord server. Membership connects that character to a configured member group. A user is **managed** when at least one registered character has active member-group membership. Registration alone does not satisfy that requirement.

## Register a character

1. Run `/register` and choose the Albion Online server: North America, Asia, or Europe.
2. Enter the character name. If several results match, select the exact character.
3. Check the private confirmation. Guild Manager checks configured membership and updates eligible roles and the nickname where possible.
4. Run `/membership` to inspect your characters and active memberships, and `/roles` to inspect your recorded role entitlements.

A character already registered to another Discord user cannot be claimed through self-registration. Ask an officer to investigate rather than selecting a different identity with a similar name.

## Main characters and officers

Your first registration is the initial main character; later registrations append to your character order. An officer can use `/member main set` to choose another registered character. Removing the main promotes the next registration. Officers can inspect users with `/member lookup user`, inspect a character's owner with `/member lookup character`, and investigate lifecycle state with `/character status`.

`/character register` lets an authorized officer register or reconnect a character to a specified user. `/character switch` replaces an exact registration with another character; it does not move the original character's account or proof records onto the replacement identity.

## Unregistration and recovery

`/unregister` removes your selected registration and leaves its membership profiles ownerless. Eligible Discord roles are recalculated from your remaining registrations and memberships. An officer must reconnect an ownerless character; self-registration cannot bypass recovery checks.

Leaving Discord removes active ownership and begins a 72-hour registration hold. Rejoining alone does not reconnect the character. Ask an officer to use `/character register`; after hold cleanup, an abandoned registration still requires that officer route.

Confirmed departure from an Albion Online guild or Albion Online alliance removes access immediately and starts a separate minimum 72-hour membership grace period. Cleanup requires a later update that confirms continued absence. A verified return before actual cleanup can preserve retained entitlements. An unavailable Albion Online API is not proof of departure.

See [administration]({{ '/guides/administration/' | relative_url }}) for `/kick` and reconciliation, and [accounts]({{ '/guides/accounts/' | relative_url }}) for balance consequences.
