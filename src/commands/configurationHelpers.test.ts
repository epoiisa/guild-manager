import assert from "node:assert/strict";
import test from "node:test";
import { formatMemberGroupRoleConfigList } from "./configurationHelpers.js";

test("member-group role lists place all roles for a group on one line", () => {
  const description = formatMemberGroupRoleConfigList([
    {
      memberGroupId: "1",
      groupName: "North America",
      albionServer: "americas",
      discordRoleId: "100"
    },
    {
      memberGroupId: "2",
      groupName: "Asia",
      albionServer: "asia",
      discordRoleId: "200"
    },
    {
      memberGroupId: "2",
      groupName: "Asia",
      albionServer: "asia",
      discordRoleId: "300"
    },
    {
      memberGroupId: "3",
      groupName: "Frostborn Exiles",
      albionServer: "asia",
      discordRoleId: "400"
    }
  ]);

  assert.equal(
    description,
    [
      "**North America**",
      "North America • North America • <@&100>",
      "",
      "**Asia**",
      "Asia • Asia • <@&200> <@&300>",
      "Frostborn Exiles • Asia • <@&400>"
    ].join("\n")
  );
});
