import {
  MessageFlags,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type StringSelectMenuInteraction
} from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createAlbionClient } from "../services/albion/client.js";
import { assertV2Fields, messageSummary, messageText } from "../testSupport/messageAssertions.js";
import { handleGuildLookupSelect } from "./guild.js";

const guildResponse = {
  Id: "OwkV3jyaQBmkEn6HA8aZUg",
  Name: "Frostborn Exiles",
  FounderName: "Epoiisa",
  Founded: "2025-08-06T23:59:13.841368Z",
  MemberCount: 60,
  AllianceId: "BEZ8i3qMQ6ShbSrlB95pyg",
  AllianceName: null,
  AllianceTag: "FUNKY"
};

function selection(requester = "requester") {
  const replies: InteractionReplyOptions[] = [];
  const edits: InteractionEditReplyOptions[] = [];
  let deferred = false;
  const interaction = {
    customId: "albion-guild:lookup:requester:asia",
    user: { id: requester },
    values: [guildResponse.Id],
    inGuild: () => true,
    reply: async (payload: InteractionReplyOptions) => { replies.push(payload); },
    deferReply: async (payload: { flags: number }) => {
      assert.equal(payload.flags, MessageFlags.Ephemeral);
      deferred = true;
    },
    editReply: async (payload: InteractionEditReplyOptions) => { edits.push(payload); }
  } as unknown as StringSelectMenuInteraction;
  return { interaction, replies, edits, isDeferred: () => deferred };
}


test("Albion Online guild selection renders the missing name from the exact Albion Online alliance", async () => {
  const state = selection();
  const requested: string[] = [];
  const client = createAlbionClient({
    fetch: async (input) => {
      assert.equal(state.isDeferred(), true, "Acknowledge the interaction before any API request.");
      const url = new URL(String(input));
      assert.equal(url.origin, "https://gameinfo-sgp.albiononline.com");
      requested.push(url.pathname);
      if (url.pathname === `/api/gameinfo/guilds/${guildResponse.Id}`) {
        return Response.json(guildResponse);
      }
      assert.equal(url.pathname, `/api/gameinfo/alliances/${guildResponse.AllianceId}`);
      return Response.json({
        AllianceId: guildResponse.AllianceId,
        AllianceName: "Funky Monke Fridays",
        AllianceTag: "FUNKY",
        Guilds: [{ Id: guildResponse.Id, Name: guildResponse.Name }]
      });
    }
  });

  assert.equal(await handleGuildLookupSelect(state.interaction, client), true);
  assert.deepEqual(requested, [
    `/api/gameinfo/guilds/${guildResponse.Id}`,
    `/api/gameinfo/alliances/${guildResponse.AllianceId}`
  ]);
  assert.equal(state.edits.length, 1);
  const embed = state.edits[0];
  assert.equal(messageSummary(embed), "Frostborn Exiles");
  assertV2Fields(embed, [
    { name: "Server", value: "Asia", inline: true },
    { name: "Members", value: "60", inline: true },
    { name: "Founder", value: "Epoiisa", inline: true },
    { name: "Founded", value: "<t:1754524753:f>", inline: true },
    { name: "Alliance", value: "Funky Monke Fridays", inline: true },
    { name: "Alliance Tag", value: "FUNKY", inline: true },
    { name: "Alliance ID", value: `\`\`\`${guildResponse.AllianceId}\`\`\``, inline: false },
    { name: "Guild ID", value: `\`\`\`${guildResponse.Id}\`\`\``, inline: false }
  ]);
});

test("Albion Online guild selection still renders partial details after bounded Albion Online alliance retries fail", async () => {
  const state = selection();
  const requested: string[] = [];
  const client = createAlbionClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      requested.push(path);
      return path === `/api/gameinfo/guilds/${guildResponse.Id}`
        ? Response.json(guildResponse)
        : new Response("Unavailable", { status: 503 });
    },
    sleep: async () => undefined
  });

  assert.equal(await handleGuildLookupSelect(state.interaction, client), true);
  assert.deepEqual(requested, [
    `/api/gameinfo/guilds/${guildResponse.Id}`,
    `/api/gameinfo/alliances/${guildResponse.AllianceId}`,
    `/api/gameinfo/alliances/${guildResponse.AllianceId}`
  ]);
  assert.equal(state.edits.length, 1);
  const embed = state.edits[0];
  assert.equal(messageSummary(embed), "Frostborn Exiles");
  assertV2Fields(embed, [
    { name: "Alliance", value: "—", inline: true },
    { name: "Alliance Tag", value: "FUNKY", inline: true },
    { name: "Alliance ID", value: `\`\`\`${guildResponse.AllianceId}\`\`\``, inline: false }
  ]);
});

test("Albion Online guild selection rejects another requester before fetching any API data", async () => {
  const state = selection("someone-else");
  const client = createAlbionClient({
    fetch: async () => assert.fail("Another requester must not trigger a lookup.")
  });

  assert.equal(await handleGuildLookupSelect(state.interaction, client), true);
  assert.equal(state.isDeferred(), false);
  assert.equal(state.edits.length, 0);
  assert.equal(state.replies.length, 1);
  assert.equal(messageText(state.replies[0]), "Only the person who started this guild lookup can use this selection.");
  assert.equal(state.replies[0].flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
});
