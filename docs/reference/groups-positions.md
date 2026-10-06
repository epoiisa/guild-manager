---
title: Member Groups and Positions
permalink: /reference/groups-positions/
---

# Member Groups and Positions

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Configure Albion Online guilds, Albion Online alliances, and custom member groups before assigning their Discord roles or using them in applications.

## Access and outcomes

These commands are intended for officers with access granted through Discord integration permissions. A `managed` Albion Online guild is used for managed membership. Custom group membership is explicitly maintained with `/member add` and `/member remove`.

Lookups query the Albion Online API. Configuration commands save definitions in this Discord server. Roles are existing Discord roles; Guild Manager must be able to manage them in the role hierarchy. Adding a role mapping defines the entitlement, and reconciliation applies current membership to Discord.

Reports export member profiles as text attachments. The default Albion Online guild is a selected configuration; clearing it does not remove the Albion Online guild definition.

Positions belong to one selected member group. Appointments link a character to a position and its Discord role. Select the position from that group, and the character from the provided choices. Deleting a position removes its appointments. Removing an Albion Online guild or Albion Online alliance, or deleting a custom group, presents a confirmation describing the affected records; read it before proceeding.

## Commands

- [`/alliance lookup`](#alliance-lookup)
- [`/alliance add`](#alliance-add)
- [`/alliance remove`](#alliance-remove)
- [`/alliance list`](#alliance-list)
- [`/alliance report`](#alliance-report)
- [`/alliance roles add`](#alliance-roles-add)
- [`/alliance roles remove`](#alliance-roles-remove)
- [`/alliance roles list`](#alliance-roles-list)
- [`/group create`](#group-create)
- [`/group delete`](#group-delete)
- [`/group edit`](#group-edit)
- [`/group list`](#group-list)
- [`/group report`](#group-report)
- [`/group roles add`](#group-roles-add)
- [`/group roles remove`](#group-roles-remove)
- [`/group roles list`](#group-roles-list)
- [`/guild lookup`](#guild-lookup)
- [`/guild add`](#guild-add)
- [`/guild edit`](#guild-edit)
- [`/guild remove`](#guild-remove)
- [`/guild list`](#guild-list)
- [`/guild report`](#guild-report)
- [`/guild default set`](#guild-default-set)
- [`/guild default clear`](#guild-default-clear)
- [`/guild default show`](#guild-default-show)
- [`/guild roles add`](#guild-roles-add)
- [`/guild roles remove`](#guild-roles-remove)
- [`/guild roles list`](#guild-roles-list)
- [`/position create`](#position-create)
- [`/position delete`](#position-delete)
- [`/position appoint`](#position-appoint)
- [`/position dismiss`](#position-dismiss)
- [`/position list`](#position-list)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /alliance lookup

```text
/alliance lookup <server> <id>
```

Look up an Albion Online alliance by ID.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `id` | Yes | Text | Albion Online alliance ID. Minimum length: 1 character. Maximum length: 128 characters. |

### /alliance add

```text
/alliance add <server> <id>
```

Configure an Albion Online alliance definition.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `id` | Yes | Text | Albion Online alliance ID. Minimum length: 1 character. Maximum length: 128 characters. |

### /alliance remove

```text
/alliance remove <server> <alliance>
```

Remove an Albion Online alliance definition.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `alliance` | Yes | Text | Configured Albion Online alliance. Choose a matching autocomplete suggestion. |

### /alliance list

```text
/alliance list
```

List configured Albion Online alliance definitions.

This command has no slash-command inputs.

### /alliance report

```text
/alliance report <server> <alliance>
```

List member profiles for a configured Albion Online alliance.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `alliance` | Yes | Text | Configured Albion Online alliance. Choose a matching autocomplete suggestion. |

### /alliance roles add

```text
/alliance roles add <server> <alliance> <role>
```

Configure a role for an Albion Online alliance.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `alliance` | Yes | Text | Configured Albion Online alliance. Choose a matching autocomplete suggestion. |
| `role` | Yes | Discord role | Discord role. |

### /alliance roles remove

```text
/alliance roles remove <server> <alliance> <role>
```

Remove a configured Albion Online alliance role.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `alliance` | Yes | Text | Configured Albion Online alliance. Choose a matching autocomplete suggestion. |
| `role` | Yes | Text | Configured Discord role. Choose a matching autocomplete suggestion. |

### /alliance roles list

```text
/alliance roles list
```

List configured Albion Online alliance roles.

This command has no slash-command inputs.

### /group create

```text
/group create <server> <name>
```

Create a member group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `name` | Yes | Text | Group name. Minimum length: 1 character. Maximum length: 100 characters. |

### /group delete

```text
/group delete <server> <group>
```

Delete a member group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |

### /group edit

```text
/group edit <server> <group> <rename>
```

Rename a member group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |
| `rename` | Yes | Text | New group name. Minimum length: 1 character. Maximum length: 100 characters. |

### /group list

```text
/group list
```

List member groups.

This command has no slash-command inputs.

### /group report

```text
/group report <server> <group>
```

List member profiles for a member group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |

### /group roles add

```text
/group roles add <server> <group> <role>
```

Configure a role for a member group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |
| `role` | Yes | Discord role | Discord role. |

### /group roles remove

```text
/group roles remove <server> <group> <role>
```

Remove a configured role from a member group.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `group` | Yes | Text | Configured group. Choose a matching autocomplete suggestion. |
| `role` | Yes | Text | Configured Discord role. Choose a matching autocomplete suggestion. |

### /group roles list

```text
/group roles list
```

List configured group roles.

This command has no slash-command inputs.

### /guild lookup

```text
/guild lookup <server> <name>
```

Look up Albion Online guilds by name.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `name` | Yes | Text | Albion Online guild name or partial name. Minimum length: 1 character. Maximum length: 64 characters. |

### /guild add

```text
/guild add <server> <id> <managed>
```

Configure an Albion Online guild definition.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `id` | Yes | Text | Albion Online guild ID. Minimum length: 1 character. Maximum length: 128 characters. |
| `managed` | Yes | Text | Track the full Albion Online guild roster later. Choices: Managed, Not Managed. |

### /guild edit

```text
/guild edit <server> <guild> <managed>
```

Edit an Albion Online guild definition.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `guild` | Yes | Text | Configured Albion Online guild. Choose a matching autocomplete suggestion. |
| `managed` | Yes | Text | Track the full Albion Online guild roster later. Choices: Managed, Not Managed. |

### /guild remove

```text
/guild remove <server> <guild>
```

Remove an Albion Online guild definition.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `guild` | Yes | Text | Configured Albion Online guild. Choose a matching autocomplete suggestion. |

### /guild list

```text
/guild list
```

List configured Albion Online guild definitions.

This command has no slash-command inputs.

### /guild report

```text
/guild report <server> <guild>
```

List member profiles for a configured Albion Online guild.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `guild` | Yes | Text | Configured Albion Online guild. Choose a matching autocomplete suggestion. |

### /guild default set

```text
/guild default set <server> <guild>
```

Set the default Albion Online guild.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `guild` | Yes | Text | Configured Albion Online guild. Choose a matching autocomplete suggestion. |

### /guild default clear

```text
/guild default clear
```

Clear the default Albion Online guild.

This command has no slash-command inputs.

### /guild default show

```text
/guild default show
```

Show configured defaults.

This command has no slash-command inputs.

### /guild roles add

```text
/guild roles add <server> <guild> <role>
```

Configure a role for an Albion Online guild.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `guild` | Yes | Text | Configured Albion Online guild. Choose a matching autocomplete suggestion. |
| `role` | Yes | Discord role | Discord role. |

### /guild roles remove

```text
/guild roles remove <server> <guild> <role>
```

Remove a configured Albion Online guild role.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `guild` | Yes | Text | Configured Albion Online guild. Choose a matching autocomplete suggestion. |
| `role` | Yes | Text | Configured Discord role. Choose a matching autocomplete suggestion. |

### /guild roles list

```text
/guild roles list
```

List configured Albion Online guild roles.

This command has no slash-command inputs.

### /position create

```text
/position create <group> <name> <role>
```

Create a group-scoped position.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `group` | Yes | Text | Configured member group. Choose a matching autocomplete suggestion. |
| `name` | Yes | Text | Position name. Minimum length: 1 character. Maximum length: 100 characters. |
| `role` | Yes | Discord role | Discord role. |

### /position delete

```text
/position delete <group> <position>
```

Delete a group-scoped position.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `group` | Yes | Text | Configured member group. Choose a matching autocomplete suggestion. |
| `position` | Yes | Text | Configured position. Choose a matching autocomplete suggestion. |

### /position appoint

```text
/position appoint <group> <position> <character>
```

Appoint a character to a group-scoped position.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `group` | Yes | Text | Configured member group. Choose a matching autocomplete suggestion. |
| `position` | Yes | Text | Configured position. Choose a matching autocomplete suggestion. |
| `character` | Yes | Text | Member group profile. Choose a matching autocomplete suggestion. |

### /position dismiss

```text
/position dismiss <group> <position> <character>
```

Dismiss a character from a group-scoped position.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `group` | Yes | Text | Configured member group. Choose a matching autocomplete suggestion. |
| `position` | Yes | Text | Configured position. Choose a matching autocomplete suggestion. |
| `character` | Yes | Text | Appointed member group profile. Choose a matching autocomplete suggestion. |

### /position list

```text
/position list [group]
```

List group-scoped positions.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `group` | No | Text | Configured member group. Choose a matching autocomplete suggestion. |

