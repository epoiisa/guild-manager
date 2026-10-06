---
title: Member Groups and Leadership Positions
permalink: /guides/groups-positions/
---

# Member Groups and Leadership Positions

Member groups give configured communities their Discord membership roles. A group profile belongs to one exact Albion Online character. The same character can belong to several groups, and a Discord user can own several characters.

## Set up membership

For a custom group, use `/group create`, selecting its Albion Online server and name. Add Discord roles with `/group roles add`. Use `/group list`, `/group roles list`, and `/group report` to inspect the configuration and roster.

Configure Albion Online guilds and Albion Online alliances through `/guild` and `/alliance`. Their role settings and reports follow the same member-group model. Managed Albion Online guild membership is verified through the Albion Online API; custom groups use explicit membership actions.

To add someone to a custom group, first register their character, then use `/member add` and select that registered character and group. An [application]({{ '/guides/applications/' | relative_url }}) can also provide reviewed admission.

`/member remove` removes the selected custom-group profile and its position appointments. It preserves character registration and memberships in other groups. Removing an entire configured group through `/group delete`, `/guild remove`, or `/alliance remove` has wider consequences: review the confirmation before proceeding.

## Create and fill a position

1. Create the position with `/position create`, choosing its member group, name, and Discord role.
2. Use `/position appoint` to select a character profile within that group.
3. Inspect appointments with `/position list`.
4. Use `/position dismiss` to remove an appointment, or `/position delete` to remove the configured position.

Appointments belong to character profiles. Removing that profile also removes its appointments. Discord roles are reconciled from all surviving membership and appointment sources, so losing one source does not necessarily remove a role that another source still grants.

If the stored entitlement is correct but the actual Discord role is missing, check the bot's role hierarchy and permissions, then use the [audit and update workflow]({{ '/guides/administration/' | relative_url }}).
