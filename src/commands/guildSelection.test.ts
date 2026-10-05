import assert from "node:assert/strict";
import test from "node:test";
import type { AlbionGuild, AlbionSearchGuild } from "../services/albion/types.js";
import {
  buildGuildLookupDetailsEmbed,
  buildGuildLookupResultsEmbed,
  buildGuildLookupSelectRow,
  parseGuildLookupSelectionCustomId
} from "./guildSelection.js";

const baseGuild: AlbionSearchGuild = { id: "guild-id", name: "Guild" };

function lookupDescription(guild: AlbionSearchGuild): string {
  return buildGuildLookupResultsEmbed("asia", "query", [guild]).toJSON().description!;
}

function lookupOption(guild: AlbionSearchGuild) {
  const row = buildGuildLookupSelectRow("requester", "asia", [guild]).toJSON();
  const component = row.components[0];
  assert.equal(component.type, 3);
  return component.options[0];
}

test("lookup no-match query neutralizes inline-code delimiters", () => {
  const embed = buildGuildLookupResultsEmbed("asia", "bad`query", []).toJSON();
  assert.equal(embed.title, "No Guild Found");
  assert.equal(embed.description, "No Albion Online guilds found for `badˋquery` on Asia.");
  assert.equal(embed.footer, undefined);
});

test("lookup match formatting supports every alliance name and tag combination", () => {
  assert.equal(lookupDescription(baseGuild), "1. Guild • `guild-id`");
  assert.equal(lookupDescription({ ...baseGuild, allianceName: "Alliance" }), "1. Guild • Alliance • `guild-id`");
  assert.equal(lookupDescription({ ...baseGuild, allianceTag: "TAG" }), "1. Guild • [TAG] • `guild-id`");
  assert.equal(lookupDescription({ ...baseGuild, allianceName: "Alliance", allianceTag: "TAG" }), "1. Guild • Alliance [TAG] • `guild-id`");
});

test("lookup treats whitespace-only alliance values as absent", () => {
  const guild = { ...baseGuild, allianceName: " ", allianceTag: "\t" };
  assert.equal(lookupDescription(guild), "1. Guild • `guild-id`");
  assert.equal(lookupOption(guild).description, "guild-id");
});

test("lookup select carries requester and server in a parseable custom ID", () => {
  const component = buildGuildLookupSelectRow("requester", "europe", [baseGuild]).toJSON().components[0];
  assert.deepEqual(parseGuildLookupSelectionCustomId(component.custom_id!), {
    requesterDiscordUserId: "requester",
    server: "europe"
  });
  assert.equal(parseGuildLookupSelectionCustomId("albion-guild:lookup:requester:invalid"), undefined);
  assert.equal(parseGuildLookupSelectionCustomId("albion-guild:lookup:requester:asia:extra"), undefined);
  assert.equal(parseGuildLookupSelectionCustomId("other:requester:asia"), undefined);
});

test("lookup select respects Discord limits and preserves the ID when possible", () => {
  assert.equal(lookupOption({ ...baseGuild, name: "a".repeat(100) }).label, "a".repeat(100));
  assert.equal(lookupOption({ ...baseGuild, name: "a".repeat(101) }).label, `${"a".repeat(97)}...`);

  const suffix = "guild-id";
  const exactAlliance = "a".repeat(100 - suffix.length - 3);
  assert.equal(lookupOption({ ...baseGuild, allianceName: exactAlliance }).description, `${exactAlliance} • ${suffix}`);

  const long = lookupOption({ ...baseGuild, allianceName: "Very Long Alliance ".repeat(7) }).description!;
  assert.equal(long.length, 100);
  assert.match(long, /\.\.\. • guild-id$/);

  const longId = "i".repeat(100);
  assert.equal(lookupOption({ ...baseGuild, id: longId }).description, longId);
});

test("lookup details show member count only, safe IDs, and parseable founded timestamps", () => {
  const guild: AlbionGuild = {
    id: "guild`id\r\nnext",
    name: "Guild",
    memberCount: 12_345,
    founderName: "Founder",
    founded: "2026-08-15T12:00:00.000Z",
    allianceId: "alliance`id",
    allianceName: "Alliance",
    allianceTag: "TAG"
  };
  assert.deepEqual(buildGuildLookupDetailsEmbed("asia", guild).toJSON().fields, [
    { name: "Server", value: "Asia", inline: true },
    { name: "Members", value: "12,345", inline: true },
    { name: "Founder", value: "Founder", inline: true },
    { name: "Founded", value: "<t:1786795200:f>", inline: true },
    { name: "Alliance", value: "Alliance", inline: true },
    { name: "Alliance Tag", value: "TAG", inline: true },
    { name: "Alliance ID", value: "```allianceˋid```", inline: false },
    { name: "Guild ID", value: "```guildˋid next```", inline: false }
  ]);
});

test("lookup details omit absent alliance fields and use safe missing-value fallbacks", () => {
  const noAlliance: AlbionGuild = { id: "guild-id", name: "Guild", founderName: " ", founded: "not a date" };
  assert.deepEqual(buildGuildLookupDetailsEmbed("asia", noAlliance).toJSON().fields, [
    { name: "Server", value: "Asia", inline: true },
    { name: "Members", value: "—", inline: true },
    { name: "Founder", value: "—", inline: true },
    { name: "Founded", value: "not a date", inline: true },
    { name: "Guild ID", value: "```guild-id```", inline: false }
  ]);

  const idOnlyAlliance: AlbionGuild = { id: "guild-id", name: "Guild", allianceId: "alliance-id" };
  const fields = buildGuildLookupDetailsEmbed("asia", idOnlyAlliance).toJSON().fields!;
  assert.deepEqual(fields.slice(4, 7), [
    { name: "Alliance", value: "—", inline: true },
    { name: "Alliance Tag", value: "—", inline: true },
    { name: "Alliance ID", value: "```alliance-id```", inline: false }
  ]);
});
