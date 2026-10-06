---
title: Character Accounts
permalink: /reference/accounts/
---

# Character Accounts

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Character accounts track whole silver amounts in Guild Manager; they do not move silver inside Albion Online. Accounts are scoped to an Albion Online character in this Discord server and shared across that character's member groups.

## Access and outcomes

`/account`, `/credit`, `/debit`, and `/transfer` require a configured Accounts manager role or Discord Administrator permission as well as slash-command access. `/balance`, `/statement`, and `/give` are self-service commands. Configure manager roles with `/manager`.

`/balance` shows the caller's balances. `/statement` exports a text statement for a selected owned character, or uses the caller's first registered character when omitted. It reports an absent account rather than silently choosing another character. Officer account statements can inspect a selected account regardless of ownership.

Amounts for credit, debit, give, and transfer are positive whole silver. Balance setting accepts a signed whole-silver balance and records the difference as an adjustment. Setting or resetting requires a reason. Freeze/unfreeze records a reason and changes whether account mutations are permitted. Closed or frozen accounts can prevent transactions.

`/give` requires an open source account owned by the caller and an open destination registered to another member. Officer `/transfer` operates between selected character accounts. A successful transfer reports both characters and the amount. Account list and statement commands return downloadable text reports. The default account-list filter is Current.

Transaction history remains associated with the character when registration ends or ownership changes.

## Commands

- [`/account list`](#account-list)
- [`/account statement`](#account-statement)
- [`/account set`](#account-set)
- [`/account reset`](#account-reset)
- [`/account freeze`](#account-freeze)
- [`/account unfreeze`](#account-unfreeze)
- [`/balance`](#balance)
- [`/credit`](#credit)
- [`/debit`](#debit)
- [`/give`](#give)
- [`/statement`](#statement)
- [`/transfer`](#transfer)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /account list

```text
/account list [filter]
```

Export character accounts and balances.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `filter` | No | Text | Accounts to include. Choices: Current, Registered, Unregistered, Frozen, Closed, All. |

### /account statement

```text
/account statement <character>
```

Export a character's account statement.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |

### /account set

```text
/account set <character> <balance> <description>
```

Set a character's account balance.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |
| `balance` | Yes | Whole number | New signed whole-silver balance. |
| `description` | Yes | Text | Required reason for the adjustment. Minimum length: 1 character. Maximum length: 200 characters. |

### /account reset

```text
/account reset <character> <description>
```

Reset a character's account balance to zero.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |
| `description` | Yes | Text | Required reason for the adjustment. Minimum length: 1 character. Maximum length: 200 characters. |

### /account freeze

```text
/account freeze <character> <reason>
```

Freeze a character's account.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |
| `reason` | Yes | Text | Reason for freezing the account. Minimum length: 1 character. Maximum length: 200 characters. |

### /account unfreeze

```text
/account unfreeze <character> <reason>
```

Unfreeze a character's account.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |
| `reason` | Yes | Text | Reason for unfreezing the account. Minimum length: 1 character. Maximum length: 200 characters. |

### /balance

```text
/balance
```

Show your account balances.

This command has no slash-command inputs.

### /credit

```text
/credit <character> <amount> [description]
```

Credit a character's account.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |
| `amount` | Yes | Whole number | Whole silver amount. Minimum: 1. |
| `description` | No | Text | Optional transaction description. Minimum length: 1 character. Maximum length: 200 characters. |

### /debit

```text
/debit <character> <amount> [description]
```

Debit a character's account.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character account. Choose a matching autocomplete suggestion. |
| `amount` | Yes | Whole number | Whole silver amount. Minimum: 1. |
| `description` | No | Text | Optional transaction description. Minimum length: 1 character. Maximum length: 200 characters. |

### /give

```text
/give <from> <to> <amount> [description]
```

Give account funds to another member.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `from` | Yes | Text | Source character account. Choose a matching autocomplete suggestion. |
| `to` | Yes | Text | Destination character account. Choose a matching autocomplete suggestion. |
| `amount` | Yes | Whole number | Whole silver amount. Minimum: 1. |
| `description` | No | Text | Optional transaction description. Minimum length: 1 character. Maximum length: 200 characters. |

### /statement

```text
/statement [character]
```

Show your account statement.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | No | Text | Your registered character. Choose a matching autocomplete suggestion. |

### /transfer

```text
/transfer <from> <to> <amount> [description]
```

Transfer funds between character accounts.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `from` | Yes | Text | Source character account. Choose a matching autocomplete suggestion. |
| `to` | Yes | Text | Destination character account. Choose a matching autocomplete suggestion. |
| `amount` | Yes | Whole number | Whole silver amount. Minimum: 1. |
| `description` | No | Text | Optional transaction description. Minimum length: 1 character. Maximum length: 200 characters. |

