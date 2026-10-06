---
title: Giveaways
permalink: /guides/giveaways/
---

# Giveaways

Giveaways draw winners from eligible Discord members who react to the announcement with 🎁. Other reactions do not enter the draw.

## Host a giveaway

You need at least one registered Albion Online character and access to the configured giveaway channel to host. Click **Host Giveaway** in its panel, select the setup options, and complete the Title, Description, Draw Time (UTC), and optional Image fields. A notification role is optional.

Alternatively, use `/giveaway create` with its date, time, number of winners, and optional image or notification role, then complete the form. Slash-command access is also required. Check the published announcement and its draw time.

## Enter

Add 🎁 to the giveaway announcement. You must be a managed member: at least one of your registered Albion Online characters must have active member-group membership in this Discord server. Registration alone is sufficient to host, but does not satisfy entry eligibility.

Removing your 🎁 withdraws your entry while the giveaway is open. Eligibility is checked again for the draw, so an old reaction does not guarantee participation after membership or access changes. A Discord user enters once regardless of how many qualifying characters they own.

## Draw, cancel, or replace a winner

The giveaway draws automatically at its saved time. The host can use **My Giveaways** to inspect and manage their giveaways, or `/giveaway draw` to draw early and `/giveaway cancel` to cancel an open giveaway. Confirm the requested action when prompted.

`/giveaway reroll` replaces one selected unavailable winner while preserving the other winners. A replacement is chosen from eligible recorded participants who have not already won; it requires an available candidate. The bot records draws and replacements.

Use `/giveaways` for open giveaways. Changing the configured channel affects future announcements; existing giveaways continue in their original destination. Do not delete an announcement while expecting its scheduled draw to work normally.
