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

## Send another ping {#send-another-ping-upcoming}

Manual Ping is available in Production. It remains upcoming for public source releases and is not included in the currently published **0.1.0-alpha.1** source or downloads.

After content starts, the current host can click **Ping** on its details card or use `/party ping` in the party thread, with no command inputs. The active host-control row is **End**, **Ping**, **Edit**, **Cancel**. Ping is available only while the party is started, open, and unexpired.

The fresh start notification uses the latest confirmed roles and Standby signups, including people who joined after the start. It preserves the actual start time, starting-host attribution, and Details and Signups links. Pending-only requests are excluded. At most the first 100 distinct confirmed users are notified; large rosters retain everyone in an attached report.

Once the new notification is sent and saved, Guild Manager deletes earlier start and Ping notifications in that thread, including the original automatic or manual start message. The latest notification offers **Unstart** when eligible. Ping leaves the party's start time and cleanup deadline unchanged.

If preparation, sending, or saving the new message cannot be confirmed, earlier notifications remain; check the thread before trying again. A warning after a successful ping means some earlier messages could not be removed. The next manual ping retries their removal. Guild Manager does not automatically resend a ping.

## Reuse a template

Create a template with `/template create`, or use `/template capture` inside a content thread. Inspect and maintain it with `/template list`, `show`, `edit`, and `remove`. Approval and Multi-signup are party choices and are not saved in templates.
