---
title: Reaction Roles
permalink: /guides/reaction-roles/
---

# Reaction Roles

Reaction roles let managed members subscribe to optional Discord roles by reacting to configured bot messages.

## Configure an entry message

1. Create the Discord role and place it below Guild Manager's highest role.
2. Configure it with `/reaction roles add`.
3. Post a bot-authored message explaining the available role.
4. Attach its emoji with `/reaction emoji add`, selecting the configured role, message, and one Unicode or available custom emoji.
5. Check `/reaction roles list` and test the reaction with an eligible member.

The mapping is server-wide. Use supported bot-authored messages where Guild Manager can read and maintain reactions. Changing configuration does not replace Discord's channel visibility rules.

## Subscribe and unsubscribe

Add the configured emoji to subscribe. Remove your reaction to withdraw the associated subscription. Guild Manager checks managed membership: owning a registered Albion Online character without active member-group membership is insufficient.

Use `/roles` to inspect recorded reaction-role subscriptions alongside membership-derived roles. When membership no longer qualifies, preserved subscriptions become **dormant** and no longer grant access. Reconciliation can restore eligible subscriptions when membership returns.

## Remove configuration

`/reaction emoji remove` removes a configured role's emoji placement while preserving existing subscriptions and role assignments. `/reaction roles remove` removes the configured reaction role and its managed assignments. These have different purposes: removing an entry emoji and retiring the underlying role configuration are separate actions.

If the role does not appear, check active membership, the exact emoji mapping, bot permissions, and role hierarchy. `/roles` reports stored entitlements; it does not inspect or repair the member's actual Discord roles. An administrator can use `/audit` and `/update` to diagnose and reconcile differences.
