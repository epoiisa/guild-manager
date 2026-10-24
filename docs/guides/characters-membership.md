---
title: Characters and Membership
permalink: /guides/characters-membership/
---

# Characters and Membership

Registration connects an Albion Online character to a Discord user within this Discord server. Membership connects that character to a configured member group. A user is **managed** when at least one registered character has active member-group membership. Registration alone does not satisfy that requirement.

## Registration panel (upcoming)

**Deployed to Production on 24 October 2026; automated deployment checks verified. Manual Production Discord acceptance confirmed on 24 October 2026. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

A Discord Administrator may enable a **Registration** panel with `/channel set register <channel>`. It starts disabled. Click **Register**, choose the Albion Online server, search by character name and deliberately select the exact result, even when there is only one match. Selection completes registration. Retry and Cancel stay private. This route needs current channel visibility, not `/register` command access or ordinary Send Messages permission. Timeout and kick restrictions still apply.

The panel shares ordinary self-registration: the 25-character limit, unique ownership, main-character order/history, automatic verified configured Albion Online guild/alliance membership, Discord roles and nickname reconciliation. It does not independently verify character ownership, grant custom-group membership, or bypass officer recovery for kicked, held, abandoned or orphaned identities. Discord reconciliation warnings can follow a successful registration; inspect the receipt.

Drafts belong to the initiating user/server and last 15 minutes. Clearing/changing the Registration channel, reset, deactivation or restart invalidates them; ordinary panel movement in the same channel does not. Clearing the panel retains completed registrations and does not disable `/register`. For applications-only onboarding, leave it unset and keep ordinary `/register` Integration access unavailable. The existing slash-command signature and single-result behaviour are unchanged.

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

## Membership change history (upcoming)

**Deployed to Production (20 October 2026); automated checks verified. Manual Discord acceptance remains pending. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

The optional Log feed distinguishes restored registration, restored retained membership and freshly verified membership. It identifies actual membership restoration and final expiry alongside ordinary update counts. A new Discord registration hold includes its saved duration and deadline; Albion Online membership grace has its own separately labelled deadline. Officer recovery also records grace periods first established during that recovery.

Changed main selections identify the old and new Albion Online characters and servers. Nickname preferences are recorded separately from successful Discord nickname changes; saving a preference does not prove Discord accepted it. Repeated preferences and selections stay silent unless a real repair occurs. Kick and subsequent officer reconnection report actual block/cleanup transitions without claiming that revoked appointments or authority returned. See the [administration guide]({{ '/guides/administration/#membership-and-authority-log-upcoming' | relative_url }}).
