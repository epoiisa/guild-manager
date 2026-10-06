---
title: Re-gears
permalink: /reference/regears/
---

# Re-gears

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

Re-gear content records define an event and Albion Online server for which eligible members can submit replacement-cost requests. Claims and account credits remain tied to the Albion Online character.

## Access and outcomes

Administrative `/regear` actions require a configured Re-gears manager role or Discord Administrator permission. `/regearme` starts the current entry-panel submission workflow; `/regears` shows the caller's Pending and Accepted claims.

Open content before members submit. Closing content blocks new requests; reopening allows them again. Submission selects eligible content and character, then collects the requested whole-silver amount and two evidence images in a form. The review channel must be configured and available.

Accepting a Pending claim credits the character's account. Omit `amount` to use the requested value; supply an amount to adjust it and explain the change. Rejecting removes a Pending claim. Claims already decided cannot be accepted again. Account restrictions and unavailable evidence can block a review.

`/regear view` presents a claim and attempts to repair its review/outcome presentation. A missing outcome post after a successful database decision does not mean the credit failed; inspect the claim before repeating an action. Read report filters carefully: the report covers Pending and Accepted requests.

Dates and optional times use UTC. See the [command index]({{ '/reference/' | relative_url }}) for clock formats.

## Commands

- [`/regear content add`](#regear-content-add)
- [`/regear content close`](#regear-content-close)
- [`/regear content reopen`](#regear-content-reopen)
- [`/regear content list`](#regear-content-list)
- [`/regear report`](#regear-report)
- [`/regear view`](#regear-view)
- [`/regear accept`](#regear-accept)
- [`/regear reject`](#regear-reject)
- [`/regearme`](#regearme)
- [`/regears`](#regears)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /regear content add

```text
/regear content add <name> <date> <server> [time]
```

Open content for re-gear requests.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `name` | Yes | Text | Re-gear content name. Minimum length: 1 character. Maximum length: 100 characters. |
| `date` | Yes | Text | Content date in D/M/YYYY or YYYY-MM-DD format. Choose a matching autocomplete suggestion. |
| `server` | Yes | Text | Albion Online server. Choose a matching autocomplete suggestion. |
| `time` | No | Text | Optional UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |

### /regear content close

```text
/regear content close <content>
```

Close re-gear content to new requests.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `content` | Yes | Text | Open re-gear content. Choose a matching autocomplete suggestion. |

### /regear content reopen

```text
/regear content reopen <content>
```

Reopen closed re-gear content.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `content` | Yes | Text | Closed re-gear content. Choose a matching autocomplete suggestion. |

### /regear content list

```text
/regear content list [server] [state]
```

List re-gear content records.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `server` | No | Text | Optional Albion Online server. Choose a matching autocomplete suggestion. |
| `state` | No | Text | Optional content state. Choices: Open, Closed, All. |

### /regear report

```text
/regear report [content] [user] [status] [server]
```

Report Pending and Accepted re-gear requests.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `content` | No | Text | Optional re-gear content. Choose a matching autocomplete suggestion. |
| `user` | No | Discord user | Optional current character owner. |
| `status` | No | Text | Request state. Choices: Pending, Accepted, All. |
| `server` | No | Text | Optional Albion Online server. Choose a matching autocomplete suggestion. |

### /regear view

```text
/regear view <claim>
```

View and repair a re-gear request presentation.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `claim` | Yes | Text | Accessible re-gear request. Choose a matching autocomplete suggestion. |

### /regear accept

```text
/regear accept <claim> [amount] [reason]
```

Accept and credit a Pending re-gear request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `claim` | Yes | Text | Pending re-gear request. Choose a matching autocomplete suggestion. |
| `amount` | No | Text | Optional positive whole-silver amount. |
| `reason` | No | Text | Required when the accepted amount changes. Maximum length: 500 characters. |

### /regear reject

```text
/regear reject <claim> [reason]
```

Reject and remove a Pending re-gear request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `claim` | Yes | Text | Pending re-gear request. Choose a matching autocomplete suggestion. |
| `reason` | No | Text | Optional concise reason. Maximum length: 500 characters. |

### /regearme

```text
/regearme
```

Submit a re-gear request.

This command has no slash-command inputs.

### /regears

```text
/regears
```

Show your Pending and Accepted re-gear requests.

This command has no slash-command inputs.

