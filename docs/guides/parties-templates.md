---
title: Parties and Templates
permalink: /guides/parties-templates/
---

# Parties and Templates

Parties collect signups for content in a Discord thread. The announcement holds the title and start information; the thread contains the description, host controls, and pinned role roster.

## Host content

Click **Host Scheduled** or **Host Unscheduled** in the Content panel. Choose a template or Blank, select the setup options, and complete the Title, Description, and Roles form. Roles are entered one per line. Scheduled content also requires a UTC date and time.

The `/party host scheduled` and `/party host unscheduled` commands are alternative entry points. Panel hosting is available to current members who can view the configured channel. Slash commands also need Discord Integration access.

Set **Host approval** and **Multi-signup** before publishing. They are independent and fixed afterwards. Defaults are approval not required and Multi-signup off. With Multi-signup on, several users can occupy a numbered role; each user still has only one confirmed place.

## Join or request a place

In the thread's pinned roster, click **Join** and select a named role. Click **Standby** to join standby, or **Leave** to leave. The `/join`, `/standby`, and `/leave` commands operate in the content thread.

When approval is required, a request does not reserve a place or count as a signup. The host accepts or declines using request controls or `/party accept` and `/party decline`. A requested move preserves your existing confirmed place until acceptance. Host self-signup and host assignments remain immediate. Hosts use `/party add` for named roles; they cannot assign another user directly to standby.

## Eligible Discord roles {#eligible-discord-roles-upcoming}

Role gates are available in Production. They remain upcoming in public source releases and are absent from **0.1.0-alpha.1**.

Optionally select one **Eligible role** in the button hosting setup, after Multi-signup and before Continue. This is a searchable Discord role dropdown with zero or one selection. Clearing it allows everyone. Continue opens the existing details form; Retry preserves the chosen role. The hosting commands offer the equivalent optional `role` input. Eligibility roles are Discord roles, separate from the named Tank/Healer-style slots in the form.

After publication, the current host uses `/party roles add <role>` or `/party roles remove <role>` in the open party thread, including after starting. The pinned roster shows **Eligible roles** Everyone or role mentions joined by **or**, without pinging the roles. Members need only one listed role. Removing the final requirement opens signups to everyone; templates do not save these requirements.

The gate covers named slots, Standby, signup requests and approval acceptance. Hosting alone does not qualify a participant. Explicit `/party add` assignments are exempt for the user's current signup, including subsequent moves, role losses, gate edits and host transfers. Leaving or removal ends that exemption. Accepting an ordinary signup request does not create one, and capacity limits still apply.

Adding the first role restricts an unrestricted party; adding more alternatives broadens eligibility. Removing an alternative can also disqualify existing users. Gate edits and later Discord role losses remove ineligible signups and requests, preserving host exemptions. Each affected member gets one thread notification: “@User, your signup was removed because you no longer meet this party’s role requirement.” Pending requests use equivalent wording; a signup and pending request are combined into one line.

The bot checks role events and reconciles on startup and every minute. Unavailable Discord lookups preserve existing signups; an unverifiable gate edit makes no changes. A deleted role remains a nonmatching requirement until the host explicitly removes it, so deletion cannot silently open the party. Regaining eligibility never automatically restores a removed signup. Uncertain notification delivery is not automatically repeated.

## Manage the session

The host's thread card offers **Start**, **End**, **Edit**, and **Cancel** as appropriate. Edit opens the title, description, and roles form. `/party edit` also supports scheduling changes and replacement images. `/party transfer` changes the host.

Scheduled parties retain their scheduled start and cleanup six hours after that scheduled time. Unscheduled parties start manually and expire twelve hours after publication or six hours after their first manual start. Where offered, **Unstart** returns early-started content to waiting; it preserves signups and cleanup deadlines.

Automatic cleanup recovery for already archived threads is available in Production. It is also upcoming for public source releases and absent from the published **0.1.0-alpha.1** source and downloads. The correction temporarily reopens the expired thread with its lock applied, refreshes its closed-state messages, and archives it again while retaining its history.

### Archive a finished party

After ending or cancelling a party, its host can click **Archive** on the closing message or use `/party archive` inside the thread. Archiving locks the thread and removes the party from the active list.

**Archive-message cleanup is available in Production (24 October 2026). It remains upcoming in public source releases and absent from 0.1.0-alpha.1.** With this update, manual archiving and automatic expiry remove the bot's obsolete Archive messages and buttons, leaving one silent notice:

> This thread has been archived and locked. Its history remains available to read, but no further messages or signups can be added.

The announcement, party details, roster and other conversation remain. The notice has no buttons and sends no notifications. An old Archive button on an already archived party, or `/party archive` in that thread, can repair its messages. If message cleanup is incomplete, retry with `/party archive`; a retry reuses an existing notice. Previously archived threads are not changed in bulk.

## Send another ping {#send-another-ping-upcoming}

Manual Ping is available in Production. It remains upcoming for public source releases and is not included in the currently published **0.1.0-alpha.1** source or downloads.

After content starts, the current host can click **Ping** on its details card or use `/party ping` in the party thread, with no command inputs. The active host-control row is **End**, **Ping**, **Edit**, **Cancel**. Ping is available only while the party is started, open, and unexpired.

The fresh start notification uses the latest confirmed roles and Standby signups, including people who joined after the start. It preserves the actual start time, starting-host attribution, and Details and Signups links. Pending-only requests are excluded. At most the first 100 distinct confirmed users are notified; large rosters retain everyone in an attached report.

Once the new notification is sent and saved, Guild Manager deletes earlier start and Ping notifications in that thread, including the original automatic or manual start message. The latest notification offers **Unstart** when eligible. Ping leaves the party's start time and cleanup deadline unchanged.

If preparation, sending, or saving the new message cannot be confirmed, earlier notifications remain; check the thread before trying again. A warning after a successful ping means some earlier messages could not be removed. The next manual ping retries their removal. Guild Manager does not automatically resend a ping.

## Reuse a template

Create a template with `/template create`, or use `/template capture` inside a content thread. Inspect and maintain it with `/template list`, `show`, `edit`, and `remove`. Approval and Multi-signup are party choices and are not saved in templates.

## Reusable builds graphics

**Deployed to Production (20 October 2026); automated checks verified. Manual Discord acceptance and memory checks during image decoding in the running bot remain pending. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

Template create, edit and capture forms add one optional **Builds graphic** upload. Empty creation means no image; empty editing keeps the saved image. Capture fetches the current canonical Discord party image and saves a new template-only R2 copy, with an optional replacement upload. It leaves the source party and attachment unchanged. `/template show` displays it privately and offers **Remove Image**. Removing an image or template leaves existing parties intact. Controls expire after 15 minutes and recheck current template access.

Both hosting commands open the details form directly; both Content panel routes open it through **Continue**. The form contains Title, Description, Roles one per line, **Use template’s image** only for a template with a saved image, then **Builds graphic**. The checkbox starts checked. Uncheck it without a replacement to publish no image; a new or retained validated upload overrides it for this party only. Retry preserves entered text, checkbox state and a validated upload. The form explicitly identifies a retained upload because Discord cannot prepopulate the upload control; leaving it empty keeps the retained file. A changed or deleted template requires **Use Current Template** or **Use Blank**, retaining those values and opening the form directly. Retry and recovery keep the original 15-minute deadline.

The simplified hosting form and scheduled panel setup are deployed to Production (20 October 2026), with automated checks verified and manual Discord acceptance pending. The layout was accepted in Local. They remain upcoming in public source releases and absent from **0.1.0-alpha.1**. Scheduled setup groups controls under **Template**, **Date and Time**, and **Settings**, beneath **Host Scheduled**. The schedule summary follows the minutes dropdown, before Settings, using a 24-hour UTC time and Australian-style date in inline code: **Scheduled** `21:00 UTC on Thursday 22 October 2026`. Unscheduled setup uses **Host Unscheduled**, **Template**, and **Settings**. Both omit introductory prose. Select a UTC date and hour; minutes initially show **Minutes (default 00)** and use **00** if left untouched, with five-minute choices through **55**. Settings contains Host approval, Multi-signup, and Eligible role; Continue/Cancel follow. Hours are **00–23** plus **24 — End of selected day**, which selects and disables minute **00** and displays the resulting next-day UTC date/time before Continue. A selected date never rolls forward silently at midnight. Continue opens the same form without a time field. If the start passes while editing, **Edit setup** lets you correct it while retaining entered values and a validated upload. Slash commands retain their existing exact-minute UTC time input.

Supported formats are PNG, JPEG, WebP and GIF, up to 15 MiB subject to Discord delivery and decoding limits. Images are preserved without resizing or flattening. Animated PNG is not supported; GIF and WebP animation are bounded and validated. The default server allowance is 512 MiB for template assets, transient template leases and cleanup state; older template versions awaiting cleanup count. Ordinary party attachments do not. Template reuse adds no stored bytes, while replacement needs room for both versions. The operator must configure private storage for template image saves and reads. Saved media outages are reported without silently discarding the saved reference.

R2 stores template graphics only. Hosting with a template image reads its verified bytes under a temporary lease and uploads an independent Discord attachment; the party keeps no R2 reference. Manual party uploads and `/party edit [image]` replacements work without R2 and stay entirely in Discord. Party graphics stay on the thread details card, and ordinary joins, roster updates and lifecycle controls preserve their Discord attachments. R2 does not restore missing party graphics. Historical parties require no automatic image migration or archive cleanup. See [image storage and recovery]({{ '/self-hosting/updates-backups/#paired-image-backups-upcoming' | relative_url }}) for operator requirements.

An uncertain-save warning means the result could not be confirmed. Check `/template list` and `/template show`, or the existing party, before retrying. Guild Manager retires the affected controls and does not automatically repeat publication.

## Member access (upcoming)

**Deployed to Production on 24 October 2026; automated deployment checks verified. Manual Production Discord acceptance confirmed on 24 October 2026. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

New hosting and signup actions require registration here and any configured `content` usage role. Party-specific eligible roles apply in addition; removing the final party-specific role does not remove the server-level usage requirement. Host assignments and approval acceptance recheck the target’s usage access. Existing-host management, leaving and cancellation retain their existing rules. See [member usage access]({{ '/getting-started/permissions/#member-usage-access-upcoming' | relative_url }}) for shared rules. Usage-role changes alone do not retrospectively delete existing participation or submitted records.
