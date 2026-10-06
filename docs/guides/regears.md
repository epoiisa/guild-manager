---
title: Re-gears
permalink: /guides/regears/
---

# Re-gears

Re-gears combine a content record, two evidence images, a requested amount, and a manager decision. Acceptance credits the selected character's account.

## Open content for requests

A Discord Administrator configures the channel with `/channel set regear`. Grant review authority with `/manager add regear` if needed. Re-gear managers use `/regear content add` to create content with its name, UTC date, Albion Online server, and optional time.

Only Open content accepts new requests. Managers can list, close, and reopen content through `/regear content`. Each Albion Online server can have at most 25 Open content records.

## Submit evidence

1. Click **REGEAR ME** in the Re-gears panel, or use `/regearme`.
2. Choose the Albion Online server, Open content, and your character where selection is needed.
3. Enter a positive Requested Amount in whole silver.
4. Upload one image in **Evidence 1** and one in **Evidence 2**, then submit.

The selected character must be registered to you and have active member-group membership on the same Albion Online server as the content. Private setup does not make the submitted evidence private: the review card is visible to people with access to the feature channel.

Use **My Re-gears** or `/regears` to inspect your requests. The eligible current owner can **Withdraw** a Pending request. Missing or deleted Pending evidence can cause that request to be removed; preserve the evidence card while review is outstanding.

## Review

Managers use the request card or `/regear view`, then **Accept** or **Reject**. `/regear accept` supports a reviewed amount and reason; `/regear reject` supports a reason. `/regear report` filters the wider workload.

Acceptance creates exactly one durable **REGEAR** account credit linked to the request. Accepted requests remain historical records, including after character recovery or presentation repair. Rejection or withdrawal removes the Pending request; it does not create a separate durable Rejected state.

Closing content stops submissions while existing requests remain available for review. Manager authority applies across all Albion Online servers in this Discord server.
