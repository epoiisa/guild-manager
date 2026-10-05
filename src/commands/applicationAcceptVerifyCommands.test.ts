import { ChannelType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationClass, OpenApplication } from "../db/applicationRepository.js";
import { handleApplicationCommand } from "./application.js";

test("slash accept defers, authorizes by reviewer role, posts configured acceptance before retiring controls, and persists it", async () => {
  const h = harness({ action: "accept", acceptanceMessage: "Welcome aboard.", nicknameFailure: true, pendingRegear: true });
  await command(h);
  assert.deepEqual(h.events, ["defer", "send:Application Accepted", "retire:old", "retire:character", "persist:new"]);
  assert.equal(title(h.edits.at(-1)), "The application in <#channel> was accepted.");
  assert.equal(description(h.edits.at(-1)), "The application in <#channel> was accepted.");
  assert.equal(title(h.sent[0]), "Application Accepted");
  assert.equal(
    description(h.sent[0]),
    "Application accepted by <@reviewer>.\n\nWelcome aboard.\n\nApplicant • <@applicant> was registered and added to Raiders • Europe.\nApplicant has pending re-gear requests.\n\nNickname update failed for <@applicant>: Missing Permissions"
  );

  const denied = harness({ action: "accept", roles: ["administrator"] });
  await command(denied);
  assert.equal(title(denied.edits.at(-1)), "Only members with <@&reviewer> can perform this action.");
  assert.equal(description(denied.edits.at(-1)), "Only members with <@&reviewer> can perform this action.");
});

test("slash accept waiting replaces the canonical decision while verify waiting retains it", async () => {
  const acceptedWaiting = harness({ action: "accept", playerGuildId: "other" });
  await command(acceptedWaiting);
  assert.deepEqual(acceptedWaiting.events, ["defer", "send:Waiting For In-Game Membership", "retire:old", "retire:character", "persist:new"]);
  assert.equal(title(acceptedWaiting.edits.at(-1)), "<#channel> remains open while the selected character is waiting for in-game membership.");

  const verifying = harness({ action: "verify", status: "awaiting_ingame_membership", playerGuildId: "other" });
  await command(verifying);
  assert.deepEqual(verifying.events, ["defer", "retain:old", "send:Waiting For In-Game Membership"]);
  assert.equal(title(verifying.edits.at(-1)), "<#channel> remains open while the selected character is waiting for in-game membership.");
});

test("slash verify success replaces, retires the old waiting controls, then persists Accepted", async () => {
  const h = harness({ action: "verify", status: "awaiting_ingame_membership", actorId: "verifier" });
  await command(h);
  assert.deepEqual(h.events, ["defer", "send:Application Accepted", "retire:old", "retire:character", "persist:new"]);
  assert.deepEqual(h.oldComponents, [[]]);
  assert.equal(title(h.sent[0]), "Application Accepted");
  assert.equal(description(h.sent[0]), "Application accepted by <@verifier>.\n\nApplicant • <@applicant> was registered and added to Raiders • Europe.");
});

test("slash reject defers, requires the reviewer role, and persists its replacement after retirement", async () => {
  const h = harness({ action: "reject", rejectionMessage: "Try again later." });
  await command(h);
  assert.deepEqual(h.events, ["defer", "send:Application Rejected", "retire:old", "retire:character", "persist:new"]);
  assert.equal(title(h.sent[0]), "Application Rejected");
  assert.equal(description(h.sent[0]), "Application rejected by <@reviewer>.\n\nTry again later.");
  assert.equal(description(h.edits.at(-1)), "The application in <#channel> was rejected.");
  const denied = harness({ action: "reject", roles: ["administrator"] }); await command(denied);
  assert.equal(title(denied.edits.at(-1)), "Only members with <@&reviewer> can perform this action.");

  const defaultMessage = harness({ action: "reject" });
  await command(defaultMessage);
  assert.equal(description(defaultMessage.sent[0]), "Application rejected by <@reviewer>.");
});

async function command(h: ReturnType<typeof harness>) {
  await handleApplicationCommand(
    h.interaction as unknown as ChatInputCommandInteraction,
    h.repository as never,
    h.membership as never,
    h.albion as never,
    h.regear as never
  );
}

function harness(input: { action: "accept" | "verify" | "reject"; status?: OpenApplication["status"]; playerGuildId?: string; roles?: string[]; acceptanceMessage?: string; rejectionMessage?: string; actorId?: string; nicknameFailure?: boolean; pendingRegear?: boolean }) {
  const events: string[] = []; const edits: unknown[] = []; const sent: unknown[] = [];
  const application: ApplicationClass = { applicationClassId: "class", discordGuildId: "guild", name: "Raiders", outcomeType: "member_group", memberGroupId: "group", albionServer: "europe", ticketCategoryId: "category", reviewerRoleId: "reviewer", questions: [], enabled: true, createdByDiscordUserId: "creator", acceptanceMessage: input.acceptanceMessage, rejectionMessage: input.rejectionMessage };
  const open: OpenApplication = { applicationId: "application", applicationClassId: "class", discordGuildId: "guild", applicantDiscordUserId: "applicant", ticketChannelId: "channel", submittedCharacterName: "Applicant", modalAnswers: [], albionServer: "europe", selectedAlbionCharacterId: "character", characterResolutionState: "selected", characterSearchAttemptCount: 1, characterResolutionMessageId: "character", applicationControlMessageId: "old", status: input.status ?? "open", channelStatus: "open" };
  const oldComponents: unknown[][] = [];
  const old = { author: { id: "bot" }, edit: async (payload: { components?: unknown[] }) => { oldComponents.push(payload.components ?? []); events.push(payload.components?.length ? "retain:old" : "retire:old"); } };
  const character = { author: { id: "bot" }, edit: async () => { events.push("retire:character"); } };
  const member = { id: "applicant", guild: { id: "guild" }, nickname: null, roles: { cache: new Map(), add: async () => undefined, remove: async () => undefined }, setNickname: async () => { if (input.nicknameFailure) throw new Error("Missing Permissions"); } };
  const channel = { id: "channel", type: ChannelType.GuildText, client: { user: { id: "bot" } }, guild: { id: "guild" }, messages: { fetch: async (id: string) => id === "old" ? old : id === "character" ? character : undefined }, send: async (payload: unknown) => { sent.push(payload); events.push(`send:${title(payload)}`); return { id: "new" }; } };
  const guild = { id: "guild", channels: { cache: new Map([["channel", channel]]), fetch: async () => channel }, members: { me: { roles: { highest: { comparePositionTo: () => 1 } }, permissions: { has: () => true } }, fetch: async () => member } };
  const interaction = { guildId: "guild", guild, channelId: "outside", user: { id: input.actorId ?? "reviewer" }, member: { roles: { cache: new Map((input.roles ?? ["reviewer"]).map((id) => [id, {}])) } }, inGuild: () => true, inCachedGuild: () => true, options: { getSubcommandGroup: () => null, getSubcommand: () => input.action, getString: () => "application" }, deferReply: async (payload: { flags?: MessageFlags }) => { assert.equal(payload.flags, MessageFlags.Ephemeral); events.push("defer"); }, editReply: async (payload: unknown) => { edits.push(payload); return { id: "reply" }; }, reply: async () => assert.fail("unexpected reply") };
  const repository = { listOperationalApplicationTargets: async () => [{ applicationId: "application", applicationName: "Raiders", applicantDiscordUserId: "applicant", ticketChannelId: "channel", status: open.status, channelStatus: "open" as const, reviewerRoleId: "reviewer" }], getOpenApplication: async () => open, getApplicationClass: async () => application, markApplicationAccepted: async () => { open.status = "accepted"; return open; }, markApplicationRejected: async () => { open.status = "rejected"; return open; }, markApplicationAwaitingMembership: async () => { open.status = "awaiting_ingame_membership"; return open; }, setApplicationControlMessageId: async (_g: string, _a: string, id: string) => { events.push(`persist:${id}`); open.applicationControlMessageId = id; return open; } };
  const membership = {
    listConfiguredAlbionGuilds: async () => [],
    listConfiguredAlbionAlliances: async () => [],
    upsertVerifiedCharacter: async () => undefined,
    listProfilesForCharacter: async () => [],
    listMemberGroups: async () => [{ memberGroupId: "group", discordGuildId: "guild", groupName: "Raiders", groupType: "guild", albionServer: "europe" }], getConfiguredAlbionGuild: async () => ({ memberGroupId: "group", albionServer: "europe", albionGuildId: "target", albionGuildName: "Raiders" }), getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => undefined, completeApplicationAcceptance: async (acceptance: { reviewerDiscordUserId: string }) => { open.status = "accepted"; open.reviewerDiscordUserId = acceptance.reviewerDiscordUserId; return { albionServer: "europe", albionCharacterId: "character", characterName: "Applicant" }; }, listDormantReactionRoleSubscriptions: async () => [], listConfiguredRoleIdsForGuild: async () => [], listQualifiedRoleIdsForUser: async () => [], getEffectiveNickname: async () => input.nicknameFailure ? "Applicant Nick" : undefined };
  const albion = {
    getPlayer: async () => ({ id: "character", name: "Applicant", guildId: input.playerGuildId ?? "target" }),
    searchCharacters: async () => ({ players: [{ id: "character", name: "Applicant", guildId: input.playerGuildId ?? "target" }], guilds: [] }),
    getGuildMembers: async () => []
  };
  const regear = input.pendingRegear ? { observeCharacterRegistration: async () => ({ hasPendingClaims: true }) } : undefined;
  return { interaction, repository, membership, albion, regear, events, edits, sent, oldComponents };
}

function messageText(payload: unknown): string[] {
  if (typeof (payload as { content?: unknown })?.content === "string") return [(payload as { content: string }).content];
  return (payload as { components?: Array<{ toJSON?: () => { components?: Array<{ content?: string }> } }> }).components?.[0]?.toJSON?.().components?.flatMap((component) => component.content ? [component.content] : []) ?? [];
}
function title(payload: unknown) {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  return (payload as { embeds?: Array<{ data?: { title?: string } }> }).embeds?.[0]?.data?.title
    ?? messageText(payload)[0]?.replace(/^# /, "");
}
function description(payload: unknown) {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  return (payload as { embeds?: Array<{ data?: { description?: string } }> }).embeds?.[0]?.data?.description
    ?? messageText(payload).find((text, index) => index > 0 && !text.startsWith("**"));
}
