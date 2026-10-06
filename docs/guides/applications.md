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

## Apply

Click the configured entry button and complete the form. In your application channel, explicitly select the correct Albion Online character, even if only one result appears. The bot then posts the review summary, configured instructions, and your answers.

Use **Retry Character Search** for the wrong name or character. A successful new search clears the previous selection until you choose again. Cancelling the search form changes nothing. **Withdraw** ends your undecided application.

## Review and verify

The configured reviewer role authorizes decisions. **Accept** and **Reject** require a selected character whose ownership does not conflict with another Discord user. The equivalent commands are `/application accept` and `/application reject`.

Acceptance into a configured Albion Online guild or Albion Online alliance requires the appropriate in-game membership. A waiting application offers **Verify Membership** when the applicant has joined. **Cancel** closes that waiting conversation while retaining its waiting state; it does not invent a completed acceptance.

## Close, reopen, or delete

Closing an undecided application preserves its selection and answers. Reopening restores its appropriate controls and temporary role. Reopening a completed conversation does not undo the original decision. Only reviewers can permanently delete a closed application channel.

Use the current card's controls, or the `/application` lifecycle commands. Inside the application channel, its target option can be omitted. Outside it, select the specific conversation from autocomplete. A command permission grant does not replace the configured reviewer requirement.
