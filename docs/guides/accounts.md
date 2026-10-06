---
title: Character Accounts
permalink: /guides/accounts/
---

# Character Accounts

An account is a character-specific ledger within this Discord server. Its balance represents the server's recorded whole-silver accounting; Guild Manager does not move silver inside Albion Online.

## View your accounts

Click **Balance** or **Statement** in the Accounts panel, or use `/balance` and `/statement`. Reports and transaction receipts are private. If you own several eligible characters, select the exact character account. The shared panel never publishes balances.

## Give funds

1. Click **Give** in the Accounts panel.
2. Select your source character account, the recipient, and their destination account.
3. Enter a positive whole-silver amount and optional description.
4. Check the receipt and account statement.

`/give` is the command equivalent. The source must belong to you, source and destination must differ, and the source needs sufficient funds. Frozen, closed, or membership-suspended accounts cannot participate in ordinary financial changes.

## Manager actions

An Accounts Manager role or Discord Administrator permission is required for **Credit**, **Debit**, and **Transfer**, and their slash commands. `/account list` exports balances; `/account statement` exports a selected ledger. `/account set` and `/account reset` record balance adjustments and require a description. `/account freeze` and `/account unfreeze` require a reason.

Manager roles apply across all Albion Online servers within this Discord server. Slash commands additionally need Discord Integration access. Financial mutations require a current member without a Discord timeout.

## Membership and history

Accounts belong to the stable Albion Online character identity, rather than its present owner or one particular group. Recoverable membership can preserve the account while blocking financial changes. Ordinary final loss of eligible membership closes and zeroes the account while retaining ledger history; a later eligible return reopens it at zero. Registration history does not restore forfeited funds.

`/kick` preserves account balances and freezes while revoking access. Accepted [re-gears]({{ '/guides/regears/' | relative_url }}) produce a linked account credit once; re-registering the character does not repeat that credit.
