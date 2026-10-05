import { ChannelType, MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationClass, OpenApplication, OperationalApplicationTarget } from "../db/applicationRepository.js";
import { applicationCommand, applicationsCommand, handleApplicationAutocomplete, handleApplicationCommand, handleApplicationsCommand, runApplicationLifecycleOperation } from "./application.js";

const APP: ApplicationClass = { applicationClassId: "class", discordGuildId: "g", name: "Raiders", outcomeType: "member_group", albionServer: "europe", ticketCategoryId: "category", reviewerRoleId: "reviewer", questions: [], enabled: true, createdByDiscordUserId: "creator" };
const operational = ["accept", "reject", "search", "verify", "cancel", "close", "reopen", "delete"] as const;
function state(overrides: Partial<OpenApplication> = {}): OpenApplication { return { applicationId: "a", applicationClassId: "class", discordGuildId: "g", applicantDiscordUserId: "applicant", ticketChannelId: "c", submittedCharacterName: "Applicant", modalAnswers: [], albionServer: "europe", characterResolutionState: "selected", selectedAlbionCharacterId: "character", characterSearchAttemptCount: 0, status: "accepted", channelStatus: "open", ...overrides }; }

test("builders separate administrative and operational application leaves with exact operational JSON", () => {
  const json = applicationCommand.toJSON();
  assert.equal(json.description, "Manage membership application tickets."); assert.equal(json.default_member_permissions, "0");
  assert.deepEqual(json.options?.map((option) => option.name), operational);
  const configuration = applicationsCommand.toJSON();
  assert.equal(configuration.default_member_permissions, "0");
  assert.deepEqual(configuration.options?.map((option) => option.name), ["list", "show", "create", "button", "questions", "messages", "disable", "remove"]);
  const descriptions = ["Accept an undecided membership application.", "Reject an undecided membership application.", "Retry or replace the application character search.", "Verify in-game membership for a waiting application.", "Close a waiting application without changing its waiting state.", "Close an undecided or completed application channel.", "Reopen a closed application channel.", "Permanently delete a closed application channel."];
  operational.forEach((name, index) => {
    const leaf = json.options?.find((option) => option.name === name) as { description?: string; options?: unknown[] } | undefined;
    assert.equal(leaf?.description, descriptions[index]);
    if (name === "search") { assert.deepEqual((leaf?.options as Array<{ name?: string; required?: boolean; autocomplete?: boolean; min_length?: number; max_length?: number }> | undefined)?.map((option) => ({ name: option.name, required: option.required, autocomplete: option.autocomplete, min_length: option.min_length, max_length: option.max_length })), [{ name: "character", required: true, autocomplete: undefined, min_length: 1, max_length: 64 }, { name: "application", required: false, autocomplete: true, min_length: undefined, max_length: undefined }]); return; }
    const option = leaf?.options?.[0] as { type?: number; name?: string; description?: string; required?: boolean; autocomplete?: boolean } | undefined;
    assert.deepEqual(option && { type: option.type, name: option.name, description: option.description, required: option.required, autocomplete: option.autocomplete }, { type: 3, name: "application", description: "Application target; omit in its application channel.", required: false, autocomplete: true });
  });
});

test("application class reports are handled by the plural configuration command", async () => {
  const events: string[] = [];
  const replies: unknown[] = [];
  const repository = {
    listApplicationClasses: async () => { events.push("list"); return [APP]; },
    getApplicationClass: async () => { events.push("show"); return APP; }
  };
  const interaction = (subcommand: "list" | "show") => ({
    guildId: "g",
    guild: { channels: { cache: new Map([["category", { name: "Applications" }]]) } },
    inGuild: () => true,
    options: { getSubcommandGroup: () => null, getSubcommand: () => subcommand, getString: () => "class" },
    deferReply: async (payload: { flags?: MessageFlags }) => {
      assert.equal(payload.flags, MessageFlags.Ephemeral);
      events.push(`defer:${subcommand}`);
    },
    editReply: async (payload: unknown) => { replies.push(payload); }
  });
  const membershipRepository = { listMemberGroups: async () => [] };

  await handleApplicationsCommand(interaction("list") as never, repository as never, membershipRepository as never);
  await handleApplicationsCommand(interaction("show") as never, repository as never, membershipRepository as never);

  assert.deepEqual(events, ["defer:list", "list", "defer:show", "show"]);
  assert.deepEqual(replies.map(titleOf), ["Applications", "Raiders"]);
});

test("handler resolves current, durable, raw, and mention targets; target errors are exact and deferred", async () => {
  for (const [channelId, supplied, title] of [["101", undefined, "<#c> was closed. The accepted decision was retained."], ["outside", "a", "<#c> was closed. The accepted decision was retained."], ["outside", "101", "<#c> was closed. The accepted decision was retained."], ["outside", "<#101>", "<#c> was closed. The accepted decision was retained."], ["101", "other", "The selected application does not match this channel. Omit the option or run the command outside an application channel."], ["outside", undefined, "Run this command in an application channel or choose an application."], ["outside", "missing", "Choose an active application."]] as const) {
    const h = harness({ channelId, supplied, app: state({ ticketChannelId: "101" }) }); await command(h); assert.deepEqual(h.events.slice(0, 2), ["defer", "targets"]); assert.equal(titleOf(h.edits.at(-1)), title);
  }
  const mismatch = harness({ channelId: "c", supplied: "other" }); await command(mismatch); assert.equal(descriptionOf(mismatch.edits.at(-1)), "The selected application does not match this channel. Omit the option or run the command outside an application channel.");
  const required = harness({ channelId: "outside" }); await command(required); assert.equal(descriptionOf(required.edits.at(-1)), "Run this command in an application channel or choose an application.");
  const missing = harness({ channelId: "outside", supplied: "missing" }); await command(missing); assert.equal(descriptionOf(missing.edits.at(-1)), "Choose an active application.");
});

test("handler fetches target channels and reports unavailable text channels after defer", async () => {
  for (const input of [{ cached: true, fetch: "text" as const, calls: 0, title: "<#c> was closed. The accepted decision was retained." }, { fetch: "text" as const, calls: 1, title: "<#c> was closed. The accepted decision was retained." }, { fetch: "reject" as const, calls: 1, title: "The retained application channel is no longer available." }, { fetch: "voice" as const, calls: 1, title: "The retained application channel is no longer available." }]) { const h = harness(input); await command(h); assert.equal(h.fetches, input.calls); assert.equal(titleOf(h.edits.at(-1)), input.title); assert.equal(h.events[0], "defer"); }
});

test("authorization, state errors, retained state, and repairs are routed through the command", async () => {
  const rows = [
    { action: "cancel" as const, user: "reviewer", roles: ["reviewer"], app: state({ status: "awaiting_ingame_membership" }), expected: "<#c> was closed. The application remains waiting for in-game membership." },
    { action: "cancel" as const, user: "administrator", roles: ["administrator"], app: state({ status: "awaiting_ingame_membership" }), expected: "Only members with <@&reviewer> can perform this action." },
    { action: "close" as const, user: "applicant", roles: [], app: state(), expected: "<#c> was closed. The accepted decision was retained." },
    { action: "close" as const, user: "reviewer", roles: ["reviewer"], app: state({ status: "rejected" }), expected: "<#c> was closed. The rejected decision was retained." },
    { action: "close" as const, user: "administrator", roles: ["administrator"], app: state(), expected: "Only the applicant or a configured reviewer can close this channel." },
    { action: "reopen" as const, user: "applicant", roles: [], app: state({ channelStatus: "closed" }), expected: "<#c> was reopened. The accepted state was retained." },
    { action: "reopen" as const, user: "reviewer", roles: ["reviewer"], app: state({ channelStatus: "closed", status: "withdrawn" }), expected: "<#c> was reopened. The withdrawn state was retained." },
    { action: "reopen" as const, user: "administrator", roles: ["administrator"], app: state({ channelStatus: "closed" }), expected: "Only the applicant or a configured reviewer can reopen this channel." },
    { action: "cancel" as const, user: "reviewer", roles: ["reviewer"], app: state(), expected: "Only an open application waiting for in-game membership can be cancelled." },
    { action: "close" as const, user: "reviewer", roles: ["reviewer"], app: state({ status: "open" }), expected: "<#c> was closed. The application remains undecided." },
    { action: "close" as const, user: "reviewer", roles: ["reviewer"], app: state({ status: "open", channelStatus: "closed", characterResolutionState: "unresolved", selectedAlbionCharacterId: undefined }), expected: "<#c> was already closed. Its conversation permissions and controls were repaired.", repairs: true },
    { action: "close" as const, user: "applicant", roles: [], app: state({ status: "open" }), expected: "Only members with <@&reviewer> can perform this action." },
    { action: "close" as const, user: "applicant", roles: [], app: state({ status: "open", channelStatus: "closed" }), expected: "Only members with <@&reviewer> can perform this action." },
    { action: "reopen" as const, user: "reviewer", roles: ["reviewer"], app: state(), expected: "<#c> was already open. Its conversation permissions and controls were repaired." },
    { action: "close" as const, user: "reviewer", roles: ["reviewer"], app: state({ channelStatus: "closed" }), expected: "<#c> was already closed. Its conversation permissions and controls were repaired.", repairs: true },
    { action: "reopen" as const, user: "reviewer", roles: ["reviewer"], app: state(), expected: "<#c> was already open. Its conversation permissions and controls were repaired.", repairs: true }
  ];
  for (const row of rows) { const h = harness({ action: row.action, user: row.user, roles: row.roles, app: row.app }); await command(h); assert.equal(titleOf(h.edits.at(-1)), row.expected); if (row.repairs) assert.equal(h.transitions, 0); }
  const denied = harness({ action: "cancel", user: "administrator", roles: ["administrator"], app: state({ status: "awaiting_ingame_membership" }) }); await command(denied); assert.equal(descriptionOf(denied.edits.at(-1)), "Only members with <@&reviewer> can perform this action.");
});

test("canonical command presentation persists replacements after presentation and retires prior controls", async () => {
  const closed = harness({ app: state({ applicationControlMessageId: "active", closedControlMessageId: "closed" }) }); await command(closed); assert.deepEqual(closed.presentation, ["send:Application Closed", "restore", "persist:replacement", "retire:closed"]);
  const reopened = harness({ action: "reopen", app: state({ channelStatus: "closed", applicationControlMessageId: "active", closedControlMessageId: "closed" }) }); await command(reopened); assert.deepEqual(reopened.presentation, ["restore", "send:Application Reopened", "retire:closed", "persist:cleared"]); assert.equal(reopened.closedId, undefined);
});

test("autocomplete is operationally private, capped, labelled, and supports the administrative command", async () => {
  const targets: OperationalApplicationTarget[] = Array.from({ length: 30 }, (_, index) => ({ applicationId: `a${index}`, applicationName: `Raiders ${index}`, targetMemberGroupName: index ? `Raiders ${index}` : "Hearties", applicantDiscordUserId: index ? "other" : "applicant", ticketChannelId: index === 1 ? undefined : `c${index}`, status: "accepted", channelStatus: "open", characterResolutionState: "selected", selectedAlbionCharacterId: "character", reviewerRoleId: "reviewer" }));
  const choices: unknown[][] = []; await handleApplicationAutocomplete(auto("close", "application", "applicant", [], targets, choices) as unknown as AutocompleteInteraction, { listOperationalApplicationTargets: async () => targets } as never, {} as never); assert.equal(choices[0].length, 1); assert.equal((choices[0][0] as { name: string }).name, "Hearties • @applicant • accepted/open");
  const admin: unknown[][] = []; await handleApplicationAutocomplete(auto("close", "application", "admin", ["administrator"], targets, admin) as unknown as AutocompleteInteraction, { listOperationalApplicationTargets: async () => targets } as never, {} as never); assert.deepEqual(admin[0], []);
  const config: unknown[][] = []; await handleApplicationAutocomplete(auto("disable", "application", "reviewer", ["reviewer"], targets, config, "applications") as unknown as AutocompleteInteraction, { listApplicationClasses: async () => [APP] } as never, {} as never); assert.deepEqual(config[0], [{ name: "Enabled • Raiders", value: "class" }]);
  const archiveFlags: boolean[] = [];
  const archiveRepository = { listOperationalApplicationTargets: async (_guildId: string, includeArchived: boolean) => { archiveFlags.push(includeArchived); return targets; } };
  await handleApplicationAutocomplete(auto("reopen", "application", "reviewer", ["reviewer"], targets, []) as unknown as AutocompleteInteraction, archiveRepository as never, {} as never);
  await handleApplicationAutocomplete(auto("delete", "application", "reviewer", ["reviewer"], targets, []) as unknown as AutocompleteInteraction, archiveRepository as never, {} as never);
  assert.deepEqual(archiveFlags, [false, true]);
});

test("direct lifecycle operation performs transition, presentation, and canonical persistence without an interaction", async () => {
  const h = harness(); const result = await runApplicationLifecycleOperation({ action: "close", guild: h.interaction.guild as never, guildId: "g", applicationId: "a", actor: { userId: "applicant", roleIds: new Set() }, channel: h.channel as never, applicationRepository: h.repository as never, presentation: { renderClosed: async () => "direct", retireClosedCandidate: async () => assert.fail("unexpected retirement"), renderOpen: async () => assert.fail("unexpected reopen") } }); assert.deepEqual(result, { kind: "closed", repaired: false, retainedState: "accepted" }); assert.equal(h.transitions, 1); assert.equal(h.closedId, "direct");
});

test("concurrent application closes claim one canonical control and retire the losing candidate", async () => {
  const app = state(); const candidates: string[] = []; const retired: string[] = []; let rendered = 0;
  const repository = { getOpenApplication: async () => ({ ...app }), getApplicationClass: async () => APP, markApplicationClosed: async () => { if (app.channelStatus !== "open") return undefined; app.channelStatus = "closed"; return { ...app }; }, claimClosedControlMessageId: async (_guildId: string, _applicationId: string, expected: string | undefined, candidate: string) => { if (app.closedControlMessageId !== expected) return false; app.closedControlMessageId = candidate; return true; } };
  const presentation = { renderClosed: async () => { const candidate = `candidate-${++rendered}`; candidates.push(candidate); return candidate; }, retireClosedCandidate: async (id: string) => { retired.push(id); }, renderOpen: async () => undefined };
  const channel = { id: "c", type: ChannelType.GuildText, guild: { members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async () => undefined } };
  const input = { action: "close" as const, guild: { channels: { cache: new Map(), fetch: async () => undefined } } as never, guildId: "g", applicationId: "a", actor: { userId: "applicant", roleIds: new Set<string>() }, channel: channel as never, applicationRepository: repository as never, presentation };
  await Promise.all([runApplicationLifecycleOperation(input), runApplicationLifecycleOperation(input)]);
  assert.equal(candidates.length, 2); assert.equal(retired.length, 1); assert.equal(app.closedControlMessageId, candidates.find((candidate) => candidate !== retired[0]));
});

async function command(h: ReturnType<typeof harness>) {
  await handleApplicationCommand(
    h.interaction as unknown as ChatInputCommandInteraction,
    h.repository as never,
    {
      listMemberGroups: async () => [],
      getRegisteredCharacter: async () => undefined,
      registerCharacterAndAdoptOrphans: async () => ({ albionServer: "europe", albionCharacterId: "character", characterName: "Applicant" })
    } as never,
    { getPlayer: async () => ({ id: "character", name: "Applicant" }) } as never
  );
}
function harness(input: { action?: typeof operational[number]; channelId?: string; supplied?: string; user?: string; roles?: string[]; app?: OpenApplication; cached?: boolean; fetch?: "text" | "reject" | "voice" } = {}) {
  const app = input.app ?? state(); const events: string[] = []; const edits: unknown[] = []; const presentation: string[] = []; let fetches = 0; let transitions = 0; let closedId: string | undefined; const channel = { id: "c", type: ChannelType.GuildText, guild: { id: "g", members: { fetch: async () => ({ id: "applicant" }) } }, client: { user: { id: "bot" } }, permissionOverwrites: { edit: async () => undefined }, messages: { fetch: async (id: string) => { presentation.push(id === "active" ? "restore" : `retire:${id}`); return id === "active" ? { author: { id: "bot" }, embeds: [{ title: "Raiders" }], edit: async () => undefined } : { edit: async () => undefined }; } }, send: async (payload: unknown) => { presentation.push(`send:${titleOf(payload)}`); return { id: "replacement" }; } }; const fetched = input.fetch === "voice" ? { type: ChannelType.GuildVoice } : channel; const guild = { id: "g", channels: { cache: input.cached ? new Map([["c", channel]]) : new Map(), fetch: async () => { fetches++; if (input.fetch === "reject") throw new Error("missing"); return fetched; } }, members: channel.guild.members }; const interaction = { guildId: "g", guild, channelId: input.channelId ?? "c", user: { id: input.user ?? "applicant" }, member: { roles: { cache: new Map((input.roles ?? []).map((id) => [id, {}])) } }, inGuild: () => true, inCachedGuild: () => true, options: { getSubcommandGroup: () => null, getSubcommand: () => input.action ?? "close", getString: () => input.supplied ?? null }, deferReply: async (payload: { flags?: MessageFlags }) => { assert.equal(payload.flags, MessageFlags.Ephemeral); events.push("defer"); }, editReply: async (payload: unknown) => { events.push("edit"); edits.push(payload); return { id: "reply" }; } }; const repository = { listOperationalApplicationTargets: async () => { events.push("targets"); return [{ applicationId: "a", applicationName: "Raiders", applicantDiscordUserId: app.applicantDiscordUserId, ticketChannelId: app.ticketChannelId, status: app.status, channelStatus: app.channelStatus, characterResolutionState: app.characterResolutionState, selectedAlbionCharacterId: app.selectedAlbionCharacterId, reviewerRoleId: "reviewer" }, { applicationId: "other", applicationName: "Other", applicantDiscordUserId: "other", ticketChannelId: "other-channel", status: "accepted" as const, channelStatus: "open" as const, reviewerRoleId: "reviewer" }]; }, getOpenApplication: async () => app, getApplicationClass: async () => APP, markApplicationClosed: async () => { transitions++; app.channelStatus = "closed"; return app; }, markApplicationReopened: async () => { transitions++; app.channelStatus = "open"; return app; }, setClosedControlMessageId: async (_g: string, _a: string, id: string | undefined) => { presentation.push(`persist:${id ?? "cleared"}`); closedId = id; app.closedControlMessageId = id; return app; }, claimClosedControlMessageId: async (_g: string, _a: string, expected: string | undefined, candidate: string) => { if (app.closedControlMessageId !== expected) return false; presentation.push(`persist:${candidate}`); closedId = candidate; app.closedControlMessageId = candidate; return true; }, setApplicationControlMessageId: async () => app }; return { interaction, repository, channel, events, edits, presentation, get fetches() { return fetches; }, get transitions() { return transitions; }, get closedId() { return closedId; } };
}
function auto(subcommand: string, focused: string, user: string, roles: string[], targets: OperationalApplicationTarget[], responses: unknown[][], commandName = "application") { return { commandName, guildId: "g", user: { id: user }, guild: { channels: { cache: new Map(targets.filter((target) => target.ticketChannelId).map((target) => [target.ticketChannelId!, { name: target.ticketChannelId }])) }, members: { cache: new Map([[user, { roles: { cache: new Map(roles.map((role) => [role, {}])) } }]]) } }, client: { users: { cache: new Map() } }, options: { getFocused: () => ({ name: focused, value: "" }), getSubcommand: () => subcommand, getString: () => null }, respond: async (choices: unknown[]) => { responses.push(choices); } }; }
function messageText(payload: unknown): string[] {
  if (typeof (payload as { content?: unknown })?.content === "string") return [(payload as { content: string }).content];
  return (payload as { components?: Array<{ toJSON?: () => { components?: Array<{ content?: string }> } }> }).components?.[0]?.toJSON?.().components?.flatMap((component) => component.content ? [component.content] : []) ?? [];
}
function titleOf(payload: unknown) {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content; return (payload as { embeds?: Array<{ data?: { title?: string } }> }).embeds?.[0]?.data?.title ?? messageText(payload)[0]?.replace(/^# /, ""); }
function descriptionOf(payload: unknown) {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content; return (payload as { embeds?: Array<{ data?: { description?: string } }> }).embeds?.[0]?.data?.description ?? messageText(payload).find((text, index) => index > 0 && !text.startsWith("**")); }
