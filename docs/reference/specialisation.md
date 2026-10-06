---
title: Weapon Specialisation
permalink: /reference/specialisation/
---

# Weapon Specialisation

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Weapon specialisation records are human-reviewed claims for Albion Online characters, using an enabled catalogue of weapons and weapon trees.

## Access and outcomes

`/weapon` submits proof for one of the caller's eligible managed characters. `/weapons` shows the caller's specialisations. `/specialisation` review, reporting, manual edits, and catalogue controls require a configured Weapon Specialisation manager role or Discord Administrator permission.

Use `/weapon 100` for a weapon at level 100 and `/weapon 800` for a complete weapon tree at level 800. Select an enabled catalogue entry and attach an image screenshot. The configured review channel must be available before proof can be published.

A reviewer selects Confirm or Dismiss for a Pending request. Confirmation requires the review card and its proof image to remain available. A request with missing proof can still be dismissed. Successful decisions remove the pending proof/control presentation and publish an outcome.

Manual add records a confirmed weapon or tree directly; level must match its kind. Remove revokes an active specialisation. Catalogue edit opens the enabled-entry list; reset opens the full catalogue for review before saving. Changing the enabled catalogue affects future selection and reporting.

Confirmed records belong to the character and remain available through legitimate reconnection or ownership changes.

## Commands

- [`/weapon 100`](#weapon-100)
- [`/weapon 800`](#weapon-800)
- [`/weapons`](#weapons)
- [`/specialisation requests`](#specialisation-requests)
- [`/specialisation review`](#specialisation-review)
- [`/specialisation list`](#specialisation-list)
- [`/specialisation add`](#specialisation-add)
- [`/specialisation remove`](#specialisation-remove)
- [`/specialisation catalogue reset`](#specialisation-catalogue-reset)
- [`/specialisation catalogue edit`](#specialisation-catalogue-edit)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /weapon 100

```text
/weapon 100 <character> <weapon> <screenshot>
```

Submit a weapon at level 100.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Your managed character. Choose a matching autocomplete suggestion. |
| `weapon` | Yes | Text | Enabled weapon. Choose a matching autocomplete suggestion. |
| `screenshot` | Yes | Attachment | Proof screenshot. |

### /weapon 800

```text
/weapon 800 <character> <tree> <screenshot>
```

Submit a weapon tree at level 800.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Your managed character. Choose a matching autocomplete suggestion. |
| `tree` | Yes | Text | Enabled weapon tree. Choose a matching autocomplete suggestion. |
| `screenshot` | Yes | Attachment | Proof screenshot. |

### /weapons

```text
/weapons
```

Show your weapon specialisations.

This command has no slash-command inputs.

### /specialisation requests

```text
/specialisation requests
```

List pending requests.

This command has no slash-command inputs.

### /specialisation review

```text
/specialisation review <request> <response>
```

Review a request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `request` | Yes | Text | Pending request. Choose a matching autocomplete suggestion. |
| `response` | Yes | Text | Review response. Choices: Confirm, Dismiss. |

### /specialisation list

```text
/specialisation list [character]
```

List confirmed specialisations.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | No | Text | Character. Choose a matching autocomplete suggestion. |

### /specialisation add

```text
/specialisation add <character> <weapon> <level>
```

Add a confirmed specialisation.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character. Choose a matching autocomplete suggestion. |
| `weapon` | Yes | Text | Weapon or tree. Choose a matching autocomplete suggestion. |
| `level` | Yes | Whole number | 100 for a weapon or 800 for a tree. Choices: 100, 800. |

### /specialisation remove

```text
/specialisation remove <character> <specialisation>
```

Remove an active specialisation.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `character` | Yes | Text | Character. Choose a matching autocomplete suggestion. |
| `specialisation` | Yes | Text | Active weapon or tree. Choose a matching autocomplete suggestion. |

### /specialisation catalogue reset

```text
/specialisation catalogue reset
```

Review the full catalogue before restoring it.

This command has no slash-command inputs.

### /specialisation catalogue edit

```text
/specialisation catalogue edit
```

Edit the enabled catalogue.

This command has no slash-command inputs.

