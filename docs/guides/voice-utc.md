---
title: Voice Channels and UTC Clock
permalink: /guides/voice-utc/
---

# Voice Channels and UTC Clock

Temporary voice rooms and the UTC clock are independent features.

## Configure temporary voice rooms

An administrator uses `/channel set voice` and selects an ordinary Discord voice channel. Members join that base channel to create or reuse their own temporary room. Its initial name is the owner's Discord server display name.

New rooms copy the base channel's settings and permission overwrites when created. Later changes to the base do not resynchronize existing rooms, so set the desired access before members start creating rooms.

## Use your room

The owner can use Discord's native controls to rename the room, set its voice status, move or moderate members, and manage its attached text chat. Ownership does not grant Manage Roles or permission-overwrite administration.

The room is removed when empty. Ownership does not transfer merely because the owner leaves while guests remain.

`/channel clear voice` stops new room creation and leaves existing temporary rooms managed until empty. It does not delete the base voice channel. `/channel show voice` inspects the current setting.

## Display UTC

Use `/utc add` to create the UTC time voice channel, and `/utc remove` to remove it. The displayed clock helps members coordinate scheduled content.

Party hosting, giveaway draw times, and automatic update schedules use UTC inputs. Forms and commands accept an hour or hour-and-minute time; `24:00` denotes the end of the selected date. Discord's saved timestamp displays can render that instant in each reader's own time zone.

If creation or movement fails, check Guild Manager's category access, channel-management and movement permissions, and whether the base is an ordinary voice channel.
