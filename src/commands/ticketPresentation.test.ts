import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, MessageFlags } from "discord.js";
import { buildTicketControlCard } from "./ticket.js";

const ticket = { ticketId: "ticket-1", openerDiscordUserId: "opener-1" };
const ticketClass = {
  ticketClassId: "class-1", discordGuildId: "guild-1", name: "Support",
  ticketCategoryId: "category-1", reviewerRoleId: "reviewer-1", enabled: true,
  createdByDiscordUserId: "creator-1", initialMessage: "Read this before asking for help."
};

test("ticket opening card is a V2 container and notifies only the opener and reviewer role", () => {
  const payload = buildTicketControlCard(ticket, ticketClass, "open", { openingMentions: true });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in payload, false);
  assert.equal("embeds" in payload, false);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ["opener-1"], roles: ["reviewer-1"], repliedUser: false });

  const card = (payload.components?.[0] as { toJSON(): any } | undefined)?.toJSON();
  assert.equal(card?.type, ComponentType.Container);
  assert.deepEqual(card?.components?.map((component: any) => component.type), [
    ComponentType.TextDisplay, ComponentType.TextDisplay, ComponentType.TextDisplay,
    ComponentType.TextDisplay, ComponentType.ActionRow
  ]);
  assert.deepEqual(card?.components?.slice(0, 4).map((component: any) => component.content), [
    "# Support",
    "<@opener-1>, this is your private ticket channel.",
    "Read this before asking for help.",
    "Attn: <@&reviewer-1>"
  ]);
  assert.equal(card?.components?.[4]?.components?.[0]?.custom_id, "ticket:close:ticket-1");
});

test("ticket control-card refreshes suppress opening notifications", () => {
  const payload = buildTicketControlCard(ticket, ticketClass, "closed");
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  const card = (payload.components?.[0] as { toJSON(): any } | undefined)?.toJSON();
  assert.deepEqual(card?.components?.slice(0, -1).map((component: any) => component.content), [
    "# Support",
    "<@opener-1>, this is your private ticket channel.",
    "Read this before asking for help.",
    "Attn: <@&reviewer-1>"
  ]);
  assert.deepEqual(card?.components?.at(-1)?.components?.map((component: any) => component.custom_id), [
    "ticket:reopen:ticket-1", "ticket:delete:ticket-1"
  ]);
});

test("a control-free ticket card retains all opening content and removes only lifecycle controls", () => {
  const payload = buildTicketControlCard(ticket, ticketClass, "closed", { includeControls: false });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  const card = (payload.components?.[0] as { toJSON(): any } | undefined)?.toJSON();
  assert.deepEqual(card?.components?.map((component: any) => component.content), [
    "# Support",
    "<@opener-1>, this is your private ticket channel.",
    "Read this before asking for help.",
    "Attn: <@&reviewer-1>"
  ]);
  assert.equal(card?.components?.some((component: any) => component.type === ComponentType.ActionRow), false);
});
