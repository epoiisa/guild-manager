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

## Manage the session

The host's thread card offers **Start**, **End**, **Edit**, and **Cancel** as appropriate. Edit opens the title, description, and roles form. `/party edit` also supports scheduling changes and replacement images. `/party transfer` changes the host.

Scheduled parties retain their scheduled start and cleanup six hours after that scheduled time. Unscheduled parties start manually and expire twelve hours after publication or six hours after their first manual start. Where offered, **Unstart** returns early-started content to waiting; it preserves signups and cleanup deadlines.

## Reuse a template

Create a template with `/template create`, or use `/template capture` inside a content thread. Inspect and maintain it with `/template list`, `show`, `edit`, and `remove`. Approval and Multi-signup are party choices and are not saved in templates.
