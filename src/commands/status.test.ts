import { createUnblockedMemberActionGuard } from "../testSupport/memberActionGuard.js";
import { ApplicationCommandType, ComponentType, MessageFlags, type Role } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { StatusSnapshot } from "../db/statusRepository.js";
import { createInteractionRouter } from "../discord/interactionRouter.js";
import { assertV2Message, messageText } from "../testSupport/messageAssertions.js";
import { buildStatusResponse, handleStatusCommand, statusCommand } from "./status.js";

test("status command exposes the exact optionless hidden configuration surface", () => {
  const command = statusCommand.toJSON();
  assert.equal(command.name, "status");
  assert.equal(command.description, "Show this server's Guild Manager configuration.");
  assert.equal(command.default_member_permissions, "0");
  assert.deepEqual(command.options ?? [], []);
  assert.equal(command.type, ApplicationCommandType.ChatInput);
});

test("status is one non-notifying V2 container with the fifteen format sections", () => {
  const response = buildStatusResponse(snapshot(), { roles: new Map(allRoleIds.map((id) => [id, {} as Role])), channels: new Map([["category", {} as never], ["content", {} as never], ["utc", {} as never], ["temporary", {} as never], ["reaction-channel", {} as never]]), botNickname: "FBEX", botAvatarUrl: "https://cdn.example/avatar.png" });
  assert.equal(response.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(response.allowedMentions, { parse: [], repliedUser: false });
  const container = response.components[0].toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, 0x3b82f6);
  assert.equal(container.components?.length, 16);
  assert.ok((container.components?.length ?? 0) + 1 <= 40);
  const text = container.components?.filter((component) => component.type === ComponentType.TextDisplay).map((component) => component.content) ?? [];
  assert.match(text[0]!, /^# Status\n### Character Roles\n/);
  assert.deepEqual(text.map((value) => value?.match(/(?:^|\n)### ([^\n]+)/)?.[1]), ["Character Roles", "Guilds", "Alliances", "Groups", "Positions", "Reaction Roles", "Party Templates", "Application Classes", "Ticket Classes", "Managers", "Update Schedule", "Special Channels", "Feature Entry Panels", "Weapon Specialisation Catalogue", "Bot Profile"]);
  assert.match(text[1]!, /Dreamweavers.*Managed • Default/);
  assert.match(text[2]!, /Funky Monke Fridays \[FUNKY\]/);
  assert.match(text[7]!, /<#category>/);
  assert.equal(text[8], "### Ticket Classes\n- **Ticket** • <@&ticket-reviewer> • Enabled");
  assert.equal(text[9], "### Managers\n- **Re-gears** • <@&reviewer>\n- **Weapon Specialisation** • No Manager Set");
  assert.ok(text.every(section => !section?.includes("Giveaway Hosts")));
  assert.match(text[13]!, /Trees.*17\/17 enabled[\s\S]*Weapons.*136\/136 enabled/);
  assert.equal(container.components?.at(-1)?.type, ComponentType.MediaGallery);
});

test("status uses the approved empty and deleted-resource fallbacks without users or counts", () => {
  const empty = emptySnapshot();
  empty.characterRoleConfigs = [{ characterRoleConfigId: "1", albionServer: "asia", discordRoleId: "deleted-role" }];
  empty.memberGroups = [{ memberGroupId: "group", albionServer: "asia", groupType: "group", groupName: "Friends", isDefaultAlbionGuild: false, discordRoleIds: ["deleted-role"] }];
  empty.positions = [{ memberGroupPositionId: "position", memberGroupId: "group", name: "Officers", discordRoleId: "deleted-role" }];
  empty.reactionRoles = [{ reactionRoleConfigId: "reaction", discordRoleId: "deleted-role" }];
  empty.applicationClasses = [{ applicationClassId: "application", name: "Friends", enabled: true, albionServer: "asia", memberGroupId: "group", memberGroupName: "Friends", memberGroupType: "group", ticketCategoryId: "deleted-channel", reviewerRoleId: "deleted-role", activeRoleId: "deleted-role" }];
  empty.ticketClasses = [{ ticketClassId: "ticket", name: "Ticket", enabled: true, ticketCategoryId: "deleted-channel", reviewerRoleId: "deleted-role" }];
  empty.contentChannelId = "deleted-channel";
  const response = buildStatusResponse(empty);
  const components = response.components[0].toJSON().components ?? [];
  const text = components.map((component) => "content" in component ? component.content : "").join("\n");
  assert.match(text, /### Character Roles\n- Asia • No Role Set/);
  assert.match(text, /### Guilds\nNone/);
  assert.match(text, /### Groups\n- \*\*Friends\*\* • Asia\n/);
  assert.match(text, /### Positions\n- \*\*Officers\*\* • Friends • Asia • No Role Set/);
  assert.match(text, /### Reaction Roles\n- No Role Set • Not Attached/);
  assert.match(text, /### Party Templates\nNone/);
  assert.match(text, /### Application Classes\n- \*\*Friends\*\* – Friends • Asia • Not Set • No Reviewer Set • Enabled/);
  assert.match(text, /### Ticket Classes\n- \*\*Ticket\*\* • No Reviewer Set • Enabled/);
  assert.match(text, /### Managers\n- \*\*Re-gears\*\* • No Manager Set\n- \*\*Weapon Specialisation\*\* • No Manager Set/);
  assert.match(text, /### Update Schedule\nNone/);
  assert.match(text, /### Special Channels\n- \*\*Content\*\* • Not Set\n- \*\*Log\*\* • Not Set\n- \*\*UTC\*\* • Not Set\n- \*\*Temporary VC\*\* • Not Set/);
  assert.match(text, /### Bot Profile\n- \*\*Name\*\* • Default/);
  assert.doesNotMatch(text, /Unavailable|deleted-role|deleted-channel/);
  assert.doesNotMatch(text, /Members:|Registered users|Characters:|<@user/);
  assert.equal(components.some((component) => component.type === ComponentType.MediaGallery), false);
});

test("status exports every record when the complete report exceeds the V2 budget", () => {
  const long = emptySnapshot();
  long.partyTemplates = Array.from({ length: 40 }, (_, index) => ({ contentTemplateId: String(index), name: `${index}-${"x".repeat(3_900)}` }));
  const response = buildStatusResponse(long);
  assertV2Message(response);
  assert.equal(response.files?.[0].name, "status.md");
  const full = response.files![0].attachment.toString();
  const normalized = full.replaceAll(/### Party Templates \(continued\)\n/g, "").replaceAll("\n", "");
  for (const template of long.partyTemplates) assert.ok(normalized.includes(template.name));
  assert.match(full, /### Bot Profile/);
  assert.ok(full.length > 150_000);
});

test("status handler does not fetch guild members and edits the deferred ephemeral reply as V2", async () => {
  let memberFetches = 0;
  const edits: any[] = [];
  const interaction = {
    guildId: "guild", inGuild: () => true,
    guild: {
      roles: { fetch: async () => new Map() }, channels: { fetch: async () => new Map() },
      members: { fetch: async () => { memberFetches += 1; return new Map(); }, me: { nickname: null, avatarURL: () => null } }
    },
    deferReply: async (payload: any) => assert.equal(payload.flags, MessageFlags.Ephemeral),
    editReply: async (payload: any) => { edits.push(payload); }
  } as never;
  await handleStatusCommand(interaction, { getSnapshot: async () => emptySnapshot() });
  assert.equal(memberFetches, 0);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].flags, MessageFlags.IsComponentsV2);
  assert.equal(edits[0].components.length, 1);
});

test("interaction routing dispatches status only for active Discord servers", async () => {
  let snapshotReads = 0;
  let edited = 0;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const activeRouter = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(),
    lifecycleRepository: { isGuildActive: async () => true },
    statusRepository: { getSnapshot: async () => { snapshotReads += 1; return emptySnapshot(); } },
    logger
  } as never);
  await activeRouter.handleInteraction(statusInteraction({ editReply: async () => { edited += 1; } }));
  assert.equal(snapshotReads, 1);
  assert.equal(edited, 1);

  const rejectedReplies: string[] = [];
  const guardedRouter = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(),
    lifecycleRepository: { isGuildActive: async () => false },
    statusRepository: { getSnapshot: async () => { throw new Error("status repository must not be called"); } },
    logger
  } as never);
  await guardedRouter.handleInteraction(statusInteraction({
    reply: async (response: { content: string }) => { rejectedReplies.push(messageText(response)); }
  }));
  await guardedRouter.handleInteraction(statusInteraction({
    guildId: null,
    guild: null,
    inGuild: () => false,
    reply: async (response: { content: string }) => { rejectedReplies.push(messageText(response)); }
  }));
  assert.deepEqual(rejectedReplies, [
    "Guild Manager is not active on this server.",
    "Guild Manager commands can only be used from a Discord server."
  ]);
});

const allRoleIds = ["character", "guild", "alliance", "group", "position", "reaction", "reviewer", "application-reviewer", "active", "ticket-reviewer"];
function emptySnapshot(): StatusSnapshot { return { discordGuildId: "guild", memberGroups: [], positions: [], characterRoleConfigs: [], reactionRoles: [], reviewerBindings: [], partyTemplates: [], applicationClasses: [], ticketClasses: [], specialisationCatalogueExclusionKeys: [] }; }
function snapshot(): StatusSnapshot {
  return {
    ...emptySnapshot(),
    memberGroups: [
      { memberGroupId: "guild", albionServer: "asia", groupType: "guild", groupName: "Dreamweavers", managed: true, isDefaultAlbionGuild: true, discordRoleIds: ["guild"] },
      { memberGroupId: "alliance", albionServer: "asia", groupType: "alliance", groupName: "Funky Monke Fridays", albionAllianceTag: "FUNKY", isDefaultAlbionGuild: false, discordRoleIds: ["alliance"] },
      { memberGroupId: "group", albionServer: "asia", groupType: "group", groupName: "Friends", isDefaultAlbionGuild: false, discordRoleIds: ["group"] }
    ],
    positions: [{ memberGroupPositionId: "position", memberGroupId: "guild", name: "Guild Queen", discordRoleId: "position" }],
    characterRoleConfigs: [{ characterRoleConfigId: "character", albionServer: "asia", discordRoleId: "character" }],
    reactionRoles: [{ reactionRoleConfigId: "reaction", discordRoleId: "reaction", emojiPlacement: { reactionRoleEmojiPlacementId: "placement", channelId: "reaction-channel", messageId: "message", emojiDisplayValue: "🎁" } }],
    reviewerBindings: [{ reviewerBindingId: "reviewer", domain: "regears", discordRoleId: "reviewer" }],
    partyTemplates: [{ contentTemplateId: "template", name: "Roam" }],
    applicationClasses: [{ applicationClassId: "application", name: "Dreamweavers", enabled: true, albionServer: "asia", memberGroupId: "guild", memberGroupName: "Dreamweavers", memberGroupType: "guild", ticketCategoryId: "category", reviewerRoleId: "application-reviewer", activeRoleId: "active" }],
    ticketClasses: [{ ticketClassId: "ticket", name: "Ticket", enabled: true, ticketCategoryId: "category", reviewerRoleId: "ticket-reviewer" }],
    memberUpdateSchedule: { cadence: "daily", weekday: null, hourUtc: 2, minuteUtc: 0 },
    contentChannelId: "content", utcChannelId: "utc", temporaryVoice: { baseChannelId: "temporary" }, specialisationCatalogueExclusionKeys: []
  };
}

function statusInteraction(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "actor" }, createdTimestamp: Date.now(),
    guildId: "guild",
    guild: {
      roles: { fetch: async () => new Map() },
      channels: { fetch: async () => new Map() },
      members: { me: { nickname: null, avatarURL: () => null } }
    },
    commandName: "status",
    deferred: false,
    replied: false,
    ephemeral: null,
    inGuild: () => true,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => false,
    options: { getSubcommandGroup: () => null, getSubcommand: () => null },
    deferReply: async () => undefined,
    editReply: async () => undefined,
    followUp: async () => undefined,
    reply: async () => undefined,
    type: 2,
    ...overrides
  } as never;
}
