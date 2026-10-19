---
title: Applications
permalink: /guides/applications/
---

# Applications

Applications combine a private conversation, an exact Albion Online character selection, and a reviewer decision about membership.

## Configure intake

1. Use `/applications create` to choose a name, Albion Online server, target member group, channel category, and reviewer role. An optional temporary role can apply while the application is open.
2. Configure questions with `/applications questions set` and instructions or outcome messages with `/applications messages set`.
3. Publish a bot-authored entry message, then attach its button using `/applications button add`.
4. Inspect the result with `/applications show` and test entry with an appropriate member account.

`/applications disable` stops new intake. Removing a class is a separate confirmed operation that can remove its conversations.

## Publish with buttons already included (upcoming)

**Available in Production (verified 18 October 2026). Upcoming in public source releases; absent from 0.1.0-alpha.1.**

Use `buttons:true` with `/message post`, `/message compose`, `/message v2`, or `/message forum` to prepare a new entry message privately. Choose **Add Application**, select an application class, and configure its label/style. You can mix application and ticket buttons, edit their order, and revise the message before **Post** creates the complete message. A forum thread is created only at that point. Disabled classes remain disabled.

Current `/message` access authorizes both button types in this workflow, without a separate class-configuration command grant. Drafts expire 15 minutes after the original command and do not survive a restart. See the [administration guide]({{ '/guides/administration/#compose-entry-buttons-upcoming' | relative_url }}) for editing, cancellation, and recovery.

`/applications button add` remains the immediate way to attach or update a button on an existing bot-authored message. It keeps its own command access rules, opens no draft, and may show Discord's `(edited)` label. Omitted or false `buttons` values keep the normal `/message` posting behavior.

## Edit a class (upcoming)

Class editing and saved conversation settings are available in Production (verified 15 October 2026 UTC). They remain upcoming in public source releases and absent from **0.1.0-alpha.1**.

Use `/applications edit <application> [name] [category] [reviewer] [role]` to change settings for new applications. Omitted settings stay unchanged. The applicant role is optional and can be added or replaced, but cannot be removed. The Discord server, Albion Online server, and target group stay fixed. Disabled classes remain disabled; archived classes cannot be edited.

Each application retains the name, category, reviewer role, and optional applicant role saved when it opened. Existing conversations continue with their original reviewers and applicant roles, including after closing and reopening. Editing does not rename or move their channels, change their access, or notify participants. Configured questions and messages, stored answers, and explicit entry-button labels retain their existing behavior.

Create and edit check current role settings: applicant roles cannot be `@everyone` or a reviewer role on any application or ticket class in this Discord server, and reviewers cannot use a current applicant role. Disabled classes count; archived classes and roles saved only on older conversations do not. Roles may be shared for the same purpose. See the [reference]({{ '/reference/applications-tickets/#class-editing-and-saved-settings-upcoming' | relative_url }}) for the historical role-reuse limitation.

## Apply

Click the configured entry button and complete the form. In your application channel, explicitly select the correct Albion Online character, even if only one result appears. The bot then posts the review summary, configured instructions, and your answers.

Use **Retry Character Search** for the wrong name or character. A successful new search clears the previous selection until you choose again. Cancelling the search form changes nothing. **Withdraw** ends your undecided application.

## Review and verify

The configured reviewer role authorizes decisions. **Accept** and **Reject** require a selected character whose ownership does not conflict with another Discord user. The equivalent commands are `/application accept` and `/application reject`.

Acceptance into a configured Albion Online guild or Albion Online alliance requires the appropriate in-game membership. A waiting application offers **Verify Membership** when the applicant has joined. **Cancel** closes that waiting conversation while retaining its waiting state; it does not invent a completed acceptance.

## Close, reopen, or delete

Closing an undecided application preserves its selection and answers. Reopening restores its appropriate controls and temporary role. Reopening a completed conversation does not undo the original decision. Only reviewers can permanently delete a closed application channel.

Use the current card's controls, or the `/application` lifecycle commands. Inside the application channel, its target option can be omitted. Outside it, select the specific conversation from autocomplete. A command permission grant does not replace the configured reviewer requirement.

## Application role history (upcoming)

**Upcoming in public source releases; absent from 0.1.0-alpha.1. Prepared locally; not yet deployed or verified in Production.**

The optional Log feed records confirmed temporary applicant-role changes from intake, acceptance/verification, rejection, withdrawal, close/cancel/reopen, deletion, class removal and external channel deletion. Commands, buttons and forms share the same behavior. Another active application or membership entitlement can retain the role; no removal is claimed in that case. Transitions with no membership or role consequence stay silent, and incomplete cleanup keeps its warning.

Reviewer actions identify the completing reviewer. Applicant self-service and external cleanup identify affected users without presenting them as officers. Class creation, actual reviewer-role edits and removal record the changed binding; unrelated class edits remain silent. Retained conversations keep their saved reviewer role. See the [administration guide]({{ '/guides/administration/#membership-and-authority-log-upcoming' | relative_url }}).
