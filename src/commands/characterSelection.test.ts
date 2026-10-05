import assert from "node:assert/strict";
import test from "node:test";
import type { APIEmbed } from "discord.js";
import type { AlbionPlayer, AlbionSearchPlayer } from "../services/albion/types.js";
import {
  buildCharacterLookupDetailsEmbed,
  buildCharacterLookupResultsEmbed,
  buildCharacterLookupSelectRow,
  buildCharacterSearchResultsEmbed
} from "./characterSelection.js";

const basePlayer: AlbionSearchPlayer = {
  id: "character-id",
  name: "Character"
};

function lookupDescription(player: AlbionSearchPlayer): string {
  return buildCharacterLookupResultsEmbed("asia", "query", [player]).toJSON().description!;
}

function lookupOption(player: AlbionSearchPlayer) {
  const row = buildCharacterLookupSelectRow("requester", "asia", [player]).toJSON();
  const component = row.components[0];
  assert.equal(component.type, 3);
  return component.options[0];
}

test("lookup match formatting omits absent membership", () => {
  assert.equal(lookupDescription(basePlayer), "1. Character • Asia • `character-id`");
  assert.equal(lookupOption(basePlayer).description, "Asia • character-id");
});

test("lookup match formatting supports guild and alliance variants", () => {
  assert.equal(
    lookupDescription({ ...basePlayer, guildName: "Guild" }),
    "1. Character • Guild • Asia • `character-id`"
  );
  assert.equal(
    lookupDescription({ ...basePlayer, guildName: "Guild", allianceName: "Alliance", allianceTag: "TAG" }),
    "1. Character • Guild • Alliance [TAG] • Asia • `character-id`"
  );
  assert.equal(
    lookupDescription({ ...basePlayer, allianceName: "Alliance" }),
    "1. Character • Alliance • Asia • `character-id`"
  );
  assert.equal(
    lookupDescription({ ...basePlayer, allianceTag: "TAG" }),
    "1. Character • [TAG] • Asia • `character-id`"
  );
});

test("lookup treats whitespace-only membership values as absent", () => {
  const player = { ...basePlayer, guildName: "  ", allianceName: "\t", allianceTag: "\n" };
  assert.equal(lookupDescription(player), "1. Character • Asia • `character-id`");
  assert.equal(lookupOption(player).description, "Asia • character-id");
});

test("lookup no-match query neutralizes inline-code delimiters", () => {
  const embed = buildCharacterLookupResultsEmbed("asia", "bad`query", []).toJSON();
  assert.equal(embed.title, "No Character Found");
  assert.equal(embed.description, "No Albion Online characters found for `badˋquery` on Asia.");
});

test("lookup details use concise membership and a safe fenced ID", () => {
  const player: AlbionPlayer = {
    id: "id`part\r\nnext",
    name: "Character",
    guildName: "Guild",
    allianceName: "Alliance",
    allianceTag: "TAG",
    pvpFame: 13_371_709,
    pveFame: 1_180_243_625,
    gatheringFame: 55_783,
    craftingFame: 330_400_199
  };
  const fields = buildCharacterLookupDetailsEmbed("asia", player).toJSON().fields!;
  assert.deepEqual(fields, [
    { name: "Server", value: "Asia", inline: true },
    { name: "Guild", value: "Guild", inline: true },
    { name: "Alliance", value: "Alliance [TAG]", inline: true },
    { name: "ID", value: "```idˋpart next```", inline: false },
    {
      name: "Fame",
      value: "PvP 13,371,709\nPvE 1,180,243,625\nGathering 55,783\nCrafting 330,400,199",
      inline: false
    },
    {
      name: "Websites",
      value: "[AlbionDB](https://east.albiondb.net/player/Character)\n[Killboard-1](https://killboard-1.com/as/player/Character)",
      inline: false
    }
  ]);

  const absentFields = buildCharacterLookupDetailsEmbed("asia", { ...basePlayer, guildName: " ", allianceTag: "" }).toJSON().fields!;
  assert.equal(absentFields[1].value, "—");
  assert.equal(absentFields[2].value, "—");
  assert.equal(absentFields[4].value, "PvP —\nPvE —\nGathering —\nCrafting —");
});

test("lookup details map website regions and URL-encode the canonical player name", () => {
  const player: AlbionPlayer = { ...basePlayer, name: "Name With/Slash" };
  const expectedName = "Name%20With%2FSlash";

  const americas = buildCharacterLookupDetailsEmbed("americas", player).toJSON().fields![5].value;
  assert.equal(
    americas,
    `[AlbionDB](https://albiondb.net/player/${expectedName})\n[Killboard-1](https://killboard-1.com/us/player/${expectedName})`
  );

  const europe = buildCharacterLookupDetailsEmbed("europe", player).toJSON().fields![5].value;
  assert.equal(
    europe,
    `[AlbionDB](https://europe.albiondb.net/player/${expectedName})\n[Killboard-1](https://killboard-1.com/eu/player/${expectedName})`
  );
});

test("lookup select label observes the 100-character boundary", () => {
  assert.equal(lookupOption({ ...basePlayer, name: "a".repeat(100) }).label, "a".repeat(100));
  assert.equal(lookupOption({ ...basePlayer, name: "a".repeat(101) }).label, `${"a".repeat(97)}...`);
});

test("lookup select description observes the boundary and preserves server and ID", () => {
  const suffix = "Asia • character-id";
  const exactGuild = "g".repeat(100 - suffix.length - 3);
  const exact = lookupOption({ ...basePlayer, guildName: exactGuild }).description!;
  assert.equal(exact.length, 100);
  assert.equal(exact, `${exactGuild} • ${suffix}`);

  const overlong = lookupOption({
    ...basePlayer,
    guildName: "Very Long Guild Name ".repeat(5),
    allianceName: "Very Long Alliance Name"
  }).description!;
  assert.equal(overlong.length, 100);
  assert.match(overlong, /\.\.\. • Asia • character-id$/);
});

test("lookup select safely truncates an oversized required suffix", () => {
  const description = lookupOption({ ...basePlayer, id: "i".repeat(94) }).description!;
  assert.equal(description.length, 100);
  assert.match(description, /\.\.\.$/);
});

test("shared character search presentation remains unchanged", () => {
  const embed: APIEmbed = buildCharacterSearchResultsEmbed("asia", "Character", [{
    ...basePlayer,
    guildName: "Guild",
    allianceName: "Alliance",
    allianceTag: "TAG"
  }]).toJSON();
  assert.equal(
    embed.description,
    "1. Character • Guild • guild • Asia • Alliance [TAG] • alliance • Asia • `character-id`"
  );
});
