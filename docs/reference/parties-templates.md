---
title: Parties and Templates
permalink: /reference/parties-templates/
---

# Parties and Templates

Public release **0.1.0-alpha.1**. [Command index]({{ "/reference/" | relative_url }}).

The manual Ping entry below is available in Production. It remains upcoming for public source releases and is not included in this published release's source or downloads.

**Role gates are available in Production; upcoming in public source releases.** The optional hosting `role` input and `/party roles` commands below are absent from **0.1.0-alpha.1**.

Content templates define signup layouts; parties use a selected template to create a content thread and signup controls in the configured content channel.

## Access and outcomes

Grant template editing and party hosting through Discord integration permissions. Hosts must be able to use the configured content channel. Commands referring to the “current” party run in its managed content thread.

The party host controls edits, transfers, roster changes, and lifecycle actions. Approval reviews validate the current host and pending requested place. Member commands `/join`, `/leave`, and `/standby` act on the caller in the current signup. Selecting a signup place may open additional controls.

Scheduled hosting requires a UTC date and time. Unscheduled hosting omits a start timestamp. Optional `approval` and `multisignup` settings are chosen at creation. Multi-signup permits several users to sign up for the same numbered role; each user retains one confirmed place. Both approval and multi-signup settings are fixed at creation. When approval is required, requested places remain pending until reviewed.

`/party start` marks the party started; the party's controls allow undo where available without extending its cleanup deadline. Ending or cancelling concludes the party; archiving removes it from the active list. Template creation, editing, and capture use interactive forms. Capture saves the current content thread as a reusable template.

See the UTC input rules in the [command index]({{ '/reference/' | relative_url }}).

## Template image controls (upcoming)

**Deployed to Production (20 October 2026); automated checks verified. Manual Discord acceptance and memory checks during image decoding in the running bot remain pending. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

Slash-command signatures below are unchanged. Create/edit/capture forms have a fifth optional **Builds graphic** field (one PNG, JPEG, WebP or GIF, maximum 15 MiB subject to Discord/decoder limits). Animated PNG is not supported. Empty edit keeps the current image; a new upload replaces it atomically with the text save. Explicit capture fetches the current canonical Discord party image and stores a new template-only R2 copy unless replaced, including accessible retained terminal parties; the source party and its attachment are unchanged. Changed source revisions require a fresh capture.

`/template show` renders a private preview with **Remove Image**. The button is bound to the viewer, original channel and template revision, expires after 15 minutes and rechecks current `/template` permission. Image-preview failure leaves the text readable. Removal changes only the template reference. Lists and autocomplete do not download images.

Both hosting commands open the details form directly; both Content panel routes open it through **Continue**. Fields appear as Title, Description, Roles one per line, **Use template’s image** only when the selected template has an image, then **Builds graphic**. The checkbox defaults checked; unchecked without a replacement creates no image. New or retained validated uploads override it for this party only. Retry retains text, checkbox state and validated uploads, with a notice explaining that an empty upload control keeps the retained file. Changed/deleted templates require **Use Current Template** or **Use Blank**, retaining those values and opening the form directly. Recovery never extends the original 15-minute expiry. R2 stores template graphics only. Template hosting uses a temporary lease to read verified bytes, then uploads an independent Discord attachment without saving a party R2 reference. Manual party uploads and replacements remain Discord-only, work without R2 and preserve current host/waiting-state restrictions. Party files are excluded from template quotas, backups and collection. Historical-party migration and archived-image cleanup are not required; R2 restore does not repair party attachments.

This simplified form and scheduled panel setup are deployed to Production (20 October 2026), with automated checks verified and manual Discord acceptance pending. The layout was accepted in Local. They remain upcoming in public source releases and absent from **0.1.0-alpha.1**. Scheduled setup uses **Host Scheduled** with **Template**, **Date and Time**, and **Settings** headings. Template selection precedes UTC date, hour, and minutes; the schedule summary appears immediately after minutes and before Settings. The summary uses a bold **Scheduled** label followed by inline code, for example: **Scheduled** `21:00 UTC on Thursday 22 October 2026`. Its 24-hour time and Australian-style date are UTC, without a native Discord timestamp. Settings contains Host approval, Multi-signup, and Eligible role, followed by Continue/Cancel. Unscheduled setup uses **Host Unscheduled**, **Template**, and **Settings**. Both omit introductory prose. Date and hour start unset; untouched minutes show **Minutes (default 00)** with no selected option and are accepted as **00**. Explicit minute choices run from **00** through **55** in five-minute steps. Hour choices are **00–23** plus **24 — End of selected day**; hour 24 selects and disables minute **00** and shows the next-day absolute UTC date/time. Midnight never silently advances the selected date. Continue opens the form without scheduling fields and checks the start is future; submission checks again. **Edit setup** corrects a passed start while retaining entered values and a validated upload. Slash signatures and exact-minute inputs are unchanged.

An unresolved save outcome retires the affected controls and asks the user to inspect `/template list` and `/template show`, or the existing party, before retrying. Unconfirmed publication is not automatically repeated, and possibly saved party messages are preserved.

## Commands

- [`/join`](#join)
- [`/leave`](#leave)
- [`/party host scheduled`](#party-host-scheduled)
- [`/party host unscheduled`](#party-host-unscheduled)
- [`/party roles add`](#party-roles-add) (Production; upcoming in public source releases)
- [`/party roles remove`](#party-roles-remove) (Production; upcoming in public source releases)
- [`/party list`](#party-list)
- [`/party edit`](#party-edit)
- [`/party start`](#party-start)
- [`/party ping`](#party-ping) (Production; upcoming in public source releases)
- [`/party end`](#party-end)
- [`/party cancel`](#party-cancel)
- [`/party archive`](#party-archive)
- [`/party transfer`](#party-transfer)
- [`/party add`](#party-add)
- [`/party accept`](#party-accept)
- [`/party decline`](#party-decline)
- [`/party remove`](#party-remove)
- [`/template create`](#template-create)
- [`/template list`](#template-list)
- [`/template edit`](#template-edit)
- [`/template show`](#template-show)
- [`/template remove`](#template-remove)
- [`/template capture`](#template-capture)
- [`/standby`](#standby)

Required inputs use `<angle brackets>`; optional inputs use `[square brackets]`. These show Discord option names, not text to paste literally.

### /join

```text
/join
```

Join the current content signup.

This command has no slash-command inputs.

### /leave

```text
/leave
```

Leave the current content signup.

This command has no slash-command inputs.

### /party host scheduled

```text
/party host scheduled <date> <time> <template> [approval] [multisignup] [role]
```

Create a scheduled content signup party.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `date` | Yes | Text | UTC date. Choose one of the next 7 days. Choose a matching autocomplete suggestion. |
| `time` | Yes | Text | UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |
| `template` | Yes | Text | Content template, or Blank to start from an empty form. Choose a matching autocomplete suggestion. |
| `approval` | No | Text | Require host approval for signups. Choices: Host approval not required, Host approval required. |
| `multisignup` | No | Text | Allow multiple users to sign up for each role. Choices: Multi-signup off, Multi-signup on. |
| `role` | No | Discord role | Initial eligible role; omit to allow everyone. |

### /party host unscheduled

```text
/party host unscheduled <template> [approval] [multisignup] [role]
```

Host a content signup party with no scheduled start.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Content template, or Blank to start from an empty form. Choose a matching autocomplete suggestion. |
| `approval` | No | Text | Require host approval for signups. Choices: Host approval not required, Host approval required. |
| `multisignup` | No | Text | Allow multiple users to sign up for each role. Choices: Multi-signup off, Multi-signup on. |
| `role` | No | Discord role | Initial eligible role; omit to allow everyone. |

### /party roles add

```text
/party roles add <role>
```

**Available in Production; upcoming in public source releases.** The current host adds one eligible Discord role using the native role picker, inside an open party thread. Any one configured role permits signup. Adding the first requirement rechecks existing signups and pending requests. Further additions broaden eligibility. `@everyone` is rejected; leave the gate empty to permit everyone.

### /party roles remove

```text
/party roles remove <role>
```

**Available in Production; upcoming in public source releases.** The current host removes one saved eligible role using autocomplete in the party thread. Saved names and IDs keep deleted Discord roles removable. Removing an alternative can remove newly ineligible signups and requests; removing the final role permits everyone. Duplicate additions and absent removals do nothing.

Host assignments through `/party add` are exempt until the user leaves or is removed. Ordinary approval acceptance does not grant an exemption. Role losses are reconciled automatically; failed lookups preserve existing signups. One thread line notifies each removed member. See [role eligibility]({{ '/guides/parties-templates/#eligible-discord-roles-upcoming' | relative_url }}) for details.

### /party list

```text
/party list
```

List all non-archived content signup parties.

This command has no slash-command inputs.

### /party edit

```text
/party edit [date] [time] [image]
```

Edit the current content signup party.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `date` | No | Text | Optional UTC date. Choose a matching autocomplete suggestion. |
| `time` | No | Text | Optional UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day. |
| `image` | No | Attachment | Optional builds graphic to replace the current image. |

### /party start

```text
/party start
```

Start the current content signup party.

This command has no slash-command inputs.

### /party ping

**Available in Production; upcoming in public source releases.** Not included in the published **0.1.0-alpha.1** source or downloads.

```text
/party ping
```

Resend the started party's signup notification. This command has no slash-command inputs.

Only the current host may use it, inside the party's managed thread, while the party is started, open, and unexpired. The **Ping** button on the canonical details message performs the same action. Active details controls appear in this order: **End**, **Ping**, **Edit**, **Cancel**. Waiting, ended, cancelled, archived, and expired parties cannot be pinged.

The new notification shows the latest confirmed named-role and Standby roster, the current party title, the saved actual start time and starting-host attribution, Details and Signups links, and pinned-signup guidance. Pending-only requests are excluded. At most the first 100 distinct confirmed users in signup order are notified. Larger rosters retain every signup in the complete attached report; users after the first 100 are not pinged.

Guild Manager identifies earlier bot-authored start and Ping notifications in the same thread, sends the new notification, saves it as the current start notification, then deletes all identified earlier notifications, including the original automatic or manual start message. The latest notification owns **Unstart** when eligible: unscheduled parties, or scheduled parties whose scheduled time is still in the future. Older Unstart controls cannot act after replacement. Ping does not change the actual start time, cleanup deadline, signups, or approval requests.

Earlier notifications remain if preparation, sending, or saving the new message cannot be confirmed. An uncertain-delivery warning asks the host to check the thread before trying again. If the party changes before the replacement is saved, the host is told to use its current controls. If the new notification is saved but some earlier messages cannot be deleted, a cleanup warning explains that the next manual ping retries their removal. Each invocation attempts at most one send; there is no automatic resend.

### /party end

```text
/party end
```

End the current content signup party.

This command has no slash-command inputs.

### /party cancel

```text
/party cancel
```

Cancel the current content signup party.

This command has no slash-command inputs.

### /party archive

```text
/party archive
```

Archive the current content signup party.

This command has no slash-command inputs.

The current host uses it inside the party thread after ending or cancelling the party. It locks and archives the thread. The closing message's **Archive** button performs the same action.

**Archive-message cleanup is upcoming in public source releases, absent from 0.1.0-alpha.1, and not yet deployed to Production.** With this update, the command, Archive button and automatic expiry remove the bot's obsolete Archive messages and buttons and leave one ordinary message without controls or notifications:

> This thread has been archived and locked. Its history remains available to read, but no further messages or signups can be added.

Other conversation and the announcement, details and roster messages remain. The command or an old Archive button also repairs an already archived party when used; there is no bulk update of archived history. If message cleanup fails, the bot still attempts to lock and archive the thread and reports incomplete cleanup. Use `/party archive` to retry; an existing notice is reused without another notification. Automatic cleanup retries incomplete work on later lifecycle checks.

### /party transfer

```text
/party transfer <user>
```

Transfer ownership of the current party.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | New party host. |

### /party add

```text
/party add <user>
```

Add or move a user in the current content signup.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User to add or move. |

### /party accept

```text
/party accept <user>
```

Accept a user's pending signup request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User whose request to accept. |

### /party decline

```text
/party decline <user>
```

Decline a user's pending signup request.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User whose request to decline. |

### /party remove

```text
/party remove <user>
```

Remove a user from the current content signup.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `user` | Yes | Discord user | User to remove. |

### /template create

```text
/template create
```

Create a content signup template.

This command has no slash-command inputs.

### /template list

```text
/template list
```

List content signup templates.

This command has no slash-command inputs.

### /template edit

```text
/template edit <template>
```

Edit a content signup template.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Template to edit. Choose a matching autocomplete suggestion. |

### /template show

```text
/template show <template>
```

Show a content signup template.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Template to show. Choose a matching autocomplete suggestion. |

### /template remove

```text
/template remove <template>
```

Remove a content signup template.

| Input | Required | Type | Meaning and accepted values |
| --- | --- | --- | --- |
| `template` | Yes | Text | Template to remove. Choose a matching autocomplete suggestion. |

### /template capture

```text
/template capture
```

Save the current content thread as a template.

This command has no slash-command inputs.

### /standby

```text
/standby
```

Join standby for the current content signup.

This command has no slash-command inputs.

