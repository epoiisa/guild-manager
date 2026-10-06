---
title: Registration and Membership
permalink: /reference/registration-membership/
---

# Registration and Membership

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Registration links an Albion Online character to a Discord user in this Discord server. Membership records describe the character's groups. Registering a character and adding it to a custom group are separate actions.

## Access and outcomes

`/register`, `/unregister`, `/membership`, and `/roles` are member commands for the caller's own records. Give officers access to `/character`, `/member`, and `/kick` through Discord's integration permissions. Stored character and member selections come from autocomplete; choose the exact character and Albion Online server. Registration and lookup searches accept a character name or partial name and can return a selection when several matches exist.

`/member lookup user` and `/member lookup character` both show the current owner's full profile. `/character status` shows one character's stored registration and entitlements. Registration history follows ownership periods, while accounts, re-gears, and specialisations follow the character within this Discord server.

`/character switch` moves the selected registration's profiles to a replacement character; inspect any reconciliation warnings. `/member main set` selects the registered character used for the user's main identity. A custom nickname overrides the usual nickname format until reset.

`/kick` revokes Guild Manager access, manager/reviewer authority, positions, and relevant membership roles. It preserves character accounts, re-gears, specialisations, and registration history. Reconnection is an officer action through `/character register`; former authority must be removed before access can be restored. `/kick` does not ban or remove the user from Discord.

Self-registration can be blocked when officer recovery is required. An already-owned character cannot be registered to someone else without resolving ownership.

## Commands

- [`/character register`](#character-register)
- [`/character unregister`](#character-unregister)
- [`/character switch`](#character-switch)
- [`/character lookup`](#character-lookup)
- [`/character status`](#character-status)
- [`/character roles add`](#character-roles-add)
- [`/character roles remove`](#character-roles-remove)
- [`/character roles list`](#character-roles-list)
- [`/kick`](#kick)
- [`/member add`](#member-add)
- [`/member remove`](#member-remove)
- [`/member main set`](#member-main-set)
- [`/member nickname set`](#member-nickname-set)
- [`/member nickname reset`](#member-nickname-reset)
- [`/member lookup user`](#member-lookup-user)
- [`/member lookup character`](#member-lookup-character)
- [`/membership`](#membership)
- [`/register`](#register)
- [`/roles`](#roles)
- [`/unregister`](#unregister)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /character register

```text
/character register <user> <server> <character>
```

Register an Albion Online character to a Discord user.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `character` | Yes | Text | Albion Online character name or partial name. Minimum length: 1 character. Maximum length: 64 characters. |

### /character unregister

```text
/character unregister <user> <character>
```

Unregister an exact user-character pairing.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |
| `character` | Yes | Text | Registered character. Choose a matching autocomplete suggestion. |

### /character switch

```text
/character switch <user> <from> <server> <to>
```

Switch a user's registration from one character to another.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |
| `from` | Yes | Text | Currently registered character. Choose a matching autocomplete suggestion. |
| `server` | Yes | Text | Replacement character's Albion Online server. Choose a matching autocomplete suggestion. |
| `to` | Yes | Text | Replacement Albion Online character name or partial name. Minimum length: 1 character. Maximum length: 64 characters. |

### /character lookup

```text
/character lookup <server> <name>
```

Look up an Albion Online character.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `name` | Yes | Text | Albion Online character name or partial name. Minimum length: 1 character. Maximum length: 64 characters. |

### /character status

```text
/character status <character>
```

Show an exact Albion Online character’s stored registration and entitlements.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Stored Albion Online character. Choose a matching autocomplete suggestion. |

### /character roles add

```text
/character roles add <server> <role>
```

Configure a Discord role for registered characters.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server or all servers. Choose a matching autocomplete suggestion. |
| `role` | Yes | Discord role | Discord role. |

### /character roles remove

```text
/character roles remove <server> <role>
```

Remove a configured character role.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server or all servers. Choose a matching autocomplete suggestion. |
| `role` | Yes | Text | Configured Discord role. Choose a matching autocomplete suggestion. |

### /character roles list

```text
/character roles list
```

List configured character roles.

This command has no slash-command inputs.

### /kick

```text
/kick <user>
```

Revoke a Discord user's Guild Manager access until officer reconnection.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |

### /member add

```text
/member add <character> <group>
```

Add a registered character to a group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Registered character. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |

### /member remove

```text
/member remove <character> <group>
```

Remove a character from a group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Member group character. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |

### /member main set

```text
/member main set <user> <character>
```

Set a user's main character.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |
| `character` | Yes | Text | Registered character. Choose a matching autocomplete suggestion. |

### /member nickname set

```text
/member nickname set <user> <nickname>
```

Set a user's full custom nickname.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |
| `nickname` | Yes | Text | Full Discord nickname. Minimum length: 1 character. Maximum length: 32 characters. |

### /member nickname reset

```text
/member nickname reset <user>
```

Reset a user's custom nickname.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |

### /member lookup user

```text
/member lookup user <user>
```

Look up a Discord user's full member profile.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | Discord user. |

### /member lookup character

```text
/member lookup character <character>
```

Look up the registered owner's full member profile.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Stored character. Choose a matching autocomplete suggestion. |

### /membership

```text
/membership
```

Show your Guild Manager membership details.

This command has no slash-command inputs.

### /register

```text
/register <server> <character>
```

Register one of your Albion Online characters.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `character` | Yes | Text | Albion Online character name or partial name. Minimum length: 1 character. Maximum length: 64 characters. |

### /roles

```text
/roles
```

Show your membership and reaction roles.

This command has no slash-command inputs.

### /unregister

```text
/unregister <server> <character>
```

Unregister one of your Albion Online characters.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `character` | Yes | Text | Registered character name. Choose a matching autocomplete suggestion. Minimum length: 1 character. Maximum length: 64 characters. |

