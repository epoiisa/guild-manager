import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, EmbedBuilder, MessageFlags,
  ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type APIButtonComponentWithCustomId, type AutocompleteInteraction, type ButtonInteraction,
  type ChatInputCommandInteraction, type GuildMember, type InteractionReplyOptions,
  type MessageActionRowComponentBuilder, type MessageCreateOptions, type MessageEditOptions,
  type ModalSubmitInteraction, type Role
} from "discord.js";
import type { TicketButtonStyle, TicketClass, TicketMessageType, createTicketRepository } from "../db/ticketRepository.js";
import { TicketClassUnavailableError } from "../db/ticketRepository.js";
import { asComponentsV2Edit, buildComponentsV2Card, messageHasNestedComponentCustomId } from "../discord/componentsV2.js";
import { mergeEntryButtonComponents } from "../discord/entryButtons.js";
import { feedbackEdit, feedbackMessage, feedbackReply } from "../discord/feedbackMessages.js";
import { withConversationClassLock } from "../services/conversationClassLock.js";
import { deleteTicketChannel } from "../services/tickets/deleteService.js";
import { runTicketLifecycleOperation, type TicketLifecycleAction, type TicketPresentation } from "../services/tickets/lifecycleService.js";
import { INFO_COLOR, INVALID_COLOR, buildInfoEmbed, buildNotFoundEmbed, buildSuccessEmbed, formatRole, normalizeQuery, truncateChoiceName } from "./configurationHelpers.js";
import { beginConversationClassRemoval } from "./conversationClassRemoval.js";
import { createCacheLabels, resolveTicketTarget, ticketChoices, type TicketTarget } from "./operationalTargets.js";
import {
  buildTicketConversationPermissionOverwrites
} from "./ticketChannelPermissions.js";

type TicketRepository = ReturnType<typeof createTicketRepository>;
type ComponentsV2Payload = MessageCreateOptions & InteractionReplyOptions & MessageEditOptions;
const PREFIX = "ticket:";
const OPEN_PREFIX = "ticket:open:";
const MESSAGE_PREFIX = "ticket:message:";

function ticketResponse(
  embed: EmbedBuilder,
  options: { ephemeral?: boolean; edit?: boolean; actionRows?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] } = {}
): ComponentsV2Payload {
  const json = embed.toJSON();
  const card = buildComponentsV2Card({
    accentColor: json.color ?? INFO_COLOR,
    title: json.title ?? "Ticket",
    text: json.description ? [json.description] : [],
    fields: (json.fields ?? []).map((field) => ({ label: field.name, value: field.value })),
    footer: json.footer?.text ? `*${json.footer.text}*` : undefined,
    actionRows: options.actionRows,
    ephemeral: options.ephemeral,
    allowedMentions: { parse: [], repliedUser: false }
  });
  return (options.edit ? asComponentsV2Edit(card) : card) as ComponentsV2Payload;
}

async function rejectNonGuildTicketInteraction(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.inGuild()) return false;
  await interaction.reply(ticketFeedback(
    new EmbedBuilder().setColor(INVALID_COLOR).setTitle("Server Only").setDescription("This command can only be used in a Discord server."),
    { ephemeral: true }
  ));
  return true;
}

export const ticketsCommand = new SlashCommandBuilder()
  .setName("tickets").setDescription("Configure general tickets.").setDefaultMemberPermissions(0)
  .addSubcommand((s) => s.setName("list").setDescription("List ticket classes."))
  .addSubcommand((s) => s.setName("show").setDescription("Show ticket class configuration.").addStringOption(ticketOption))
  .addSubcommand((s) => s.setName("create").setDescription("Create a general ticket class.")
    .addStringOption((o) => o.setName("name").setDescription("Staff-facing ticket name.").setMinLength(1).setMaxLength(80).setRequired(true))
    .addChannelOption((o) => o.setName("category").setDescription("Category where ticket channels are created.").setRequired(true))
    .addRoleOption((o) => o.setName("reviewer").setDescription("Role allowed to review tickets.").setRequired(true)))
  .addSubcommandGroup((g) => g.setName("button").setDescription("Configure ticket entry buttons.")
    .addSubcommand((s) => s.setName("add").setDescription("Attach a ticket button to a bot-authored message.")
      .addStringOption((o) => o.setName("ticket").setDescription("Ticket class.").setRequired(true).setAutocomplete(true))
      .addChannelOption((o) => o.setName("channel").setDescription("Channel containing the message.").setRequired(true))
      .addStringOption((o) => o.setName("id").setDescription("Message ID.").setRequired(true))
      .addStringOption((o) => o.setName("label").setDescription("Button label.").setMinLength(1).setMaxLength(80).setRequired(true))
      .addStringOption((o) => o.setName("style").setDescription("Button style.").setRequired(true).addChoices(
        { name: "Primary", value: "primary" }, { name: "Secondary", value: "secondary" }, { name: "Success", value: "success" }, { name: "Danger", value: "danger" }))))
  .addSubcommandGroup((g) => g.setName("messages").setDescription("Configure ticket messages.")
    .addSubcommand((s) => addMessageOptions(s.setName("set").setDescription("Open a modal to set a ticket message.")))
    .addSubcommand((s) => addMessageOptions(s.setName("clear").setDescription("Clear a ticket message."))))
  .addSubcommand((s) => s.setName("disable").setDescription("Disable a ticket class.").addStringOption(ticketOption))
  .addSubcommand((s) => s.setName("remove").setDescription("Confirm removal of a ticket class and its channels.").addStringOption(ticketOption));

export const ticketCommand = new SlashCommandBuilder()
  .setName("ticket").setDescription("Manage general tickets.").setDefaultMemberPermissions(0)
  .addSubcommand((s) => operationalTicketOption(s.setName("close").setDescription("Close an open general ticket.")))
  .addSubcommand((s) => operationalTicketOption(s.setName("reopen").setDescription("Reopen a closed general ticket.")))
  .addSubcommand((s) => operationalTicketOption(s.setName("delete").setDescription("Permanently delete a closed general ticket channel.")));

function ticketOption(o: any) { return o.setName("ticket").setDescription("Ticket class.").setRequired(true).setAutocomplete(true); }
function operationalTicketOption(s: any) { return s.addStringOption((o: any) => o.setName("ticket").setDescription("Ticket target; omit in its ticket channel.").setRequired(false).setAutocomplete(true)); }
function addMessageOptions(s: any) { return s.addStringOption(ticketOption).addStringOption((o: any) => o.setName("type").setDescription("Message type.").setRequired(true).addChoices({ name: "Initial", value: "initial" }, { name: "Closed", value: "closed" })); }

export async function handleTicketCommand(interaction: ChatInputCommandInteraction, repository: TicketRepository): Promise<void> {
  if (await rejectNonGuildTicketInteraction(interaction)) return;
  const sub = interaction.options.getSubcommand();
  if (sub === "close" || sub === "reopen") return handleTicketOperationalCommand(interaction, repository, sub);
  if (sub === "delete") return handleTicketDeleteCommand(interaction, repository);
}

export async function handleTicketsCommand(interaction: ChatInputCommandInteraction, repository: TicketRepository): Promise<void> {
  if (await rejectNonGuildTicketInteraction(interaction)) return;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  // A modal must be the initial interaction response. Its one required lookup
  // is handled below with a short deadline; every other leaf can acknowledge
  // before any repository or Discord I/O.
  if (!(group === "messages" && sub === "set")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  if (sub === "list") {
    const classes = await repository.listTicketClasses(interaction.guildId!);
    await interaction.editReply((classes.length ? ticketResponse : ticketFeedback)(buildInfoEmbed("Tickets", classes.length ? classes.map((t) => `${t.name} • ${t.enabled ? "Enabled" : "Disabled"}`).join("\n") : "No ticket classes configured."), { edit: true }));
    return;
  }
  if (sub === "show") {
    const ticketClass = await requireTicketClass(interaction, repository); if (!ticketClass) return;
    const categoryName = interaction.guild?.channels.cache.get(ticketClass.ticketCategoryId)?.name;
    await interaction.editReply(ticketResponse(new EmbedBuilder().setColor(INFO_COLOR).setTitle(ticketClass.name).addFields(
      { name: "Status", value: ticketClass.enabled ? "Enabled" : "Disabled" }, { name: "Category", value: categoryName ?? ticketClass.ticketCategoryId },
      { name: "Reviewer", value: formatRole(ticketClass.reviewerRoleId) }, { name: "Button", value: ticketClass.sourceChannelId && ticketClass.sourceMessageId ? `https://discord.com/channels/${ticketClass.discordGuildId}/${ticketClass.sourceChannelId}/${ticketClass.sourceMessageId}` : "Not configured" },
      { name: "Messages", value: `Initial: ${ticketClass.initialMessage ? "Configured" : "Default"}\nClosed: ${ticketClass.closedMessage ? "Configured" : "Default"}` }
    ), { edit: true }));
    return;
  }
  if (group === "button") return handleButtonAdd(interaction, repository);
  if (group === "messages") return handleMessages(interaction, repository, sub);
  if (sub === "create") {
    const category = interaction.options.getChannel("category", true);
    if (category.type !== ChannelType.GuildCategory) return void interaction.editReply(ticketFeedback(buildNotFoundEmbed("Invalid Ticket Category", "Choose a Discord category channel."), { edit: true }));
    const reviewer = interaction.options.getRole("reviewer", true) as Role;
    const created = await repository.createTicketClass({ discordGuildId: interaction.guildId!, name: interaction.options.getString("name", true).trim(), ticketCategoryId: category.id, reviewerRoleId: reviewer.id, createdByDiscordUserId: interaction.user.id });
    await interaction.editReply(ticketFeedback(buildSuccessEmbed("Ticket Created", `Ticket class ${created.name} was created; add an entry button with \`/tickets button add\`.`), { edit: true }));
    return;
  }
  if (sub === "remove") { await beginConversationClassRemoval(interaction, repository.classRemoval); return; }
  const ticketClass = await requireTicketClass(interaction, repository); if (!ticketClass) return;
  if (sub === "disable") { await repository.setTicketEnabled(interaction.guildId!, ticketClass.ticketClassId, false); await interaction.editReply(ticketFeedback(buildSuccessEmbed("Ticket Disabled", `Ticket class ${ticketClass.name} was disabled.`), { edit: true })); return; }
}

export async function handleTicketAutocomplete(interaction: AutocompleteInteraction, repository: TicketRepository): Promise<boolean> {
  if (interaction.commandName !== "ticket" && interaction.commandName !== "tickets") return false;
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const focused = interaction.options.getFocused(true);
  const subcommand = interaction.options.getSubcommand(false);
  if (interaction.commandName === "ticket" && focused.name === "ticket" && (subcommand === "close" || subcommand === "reopen" || subcommand === "delete")) {
    const targets = await repository.listOperationalTicketTargets(interaction.guildId ?? "");
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const roles = new Set(member?.roles.cache.keys() ?? []);
    const labels = createCacheLabels(interaction.guild?.channels.cache ?? new Map(), interaction.client.users.cache);
    await interaction.respond(ticketChoices(subcommand, { userId: interaction.user.id, roleIds: roles }, targets, query, labels));
    return true;
  }
  const classes = (await repository.listTicketClasses(interaction.guildId ?? "")).filter((t) => t.name.toLowerCase().includes(query) || t.ticketClassId.includes(query)).slice(0, 25);
  await interaction.respond(classes.map((t) => ({ name: truncateChoiceName(`${t.enabled ? "Enabled" : "Disabled"} • ${t.name}`), value: t.ticketClassId }))); return true;
}

export async function handleTicketModalSubmit(interaction: ModalSubmitInteraction, repository: TicketRepository): Promise<boolean> {
  if (!interaction.customId.startsWith(MESSAGE_PREFIX)) return false;
  const [id, type] = interaction.customId.slice(MESSAGE_PREFIX.length).split(":");
  if ((type !== "initial" && type !== "closed") || !interaction.inGuild()) return false;
  const message = interaction.fields.getTextInputValue("message").trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await repository.setTicketMessage(interaction.guildId!, id, type, message || undefined);
  await interaction.editReply(ticketFeedback(buildSuccessEmbed("Message Set", `${type === "initial" ? "Initial" : "Closed"} message was updated.`), { edit: true })); return true;
}

export async function handleTicketButton(interaction: ButtonInteraction, repository: TicketRepository): Promise<boolean> {
  if (!interaction.customId.startsWith(PREFIX)) return false;
  if (!interaction.inCachedGuild()) { await interaction.reply(ticketFeedback(buildNotFoundEmbed("Server Only", "Ticket controls can only be used in a Discord server."), { ephemeral: true })); return true; }
  if (interaction.customId.startsWith(OPEN_PREFIX)) { await openTicket(interaction, repository); return true; }
  const [, action, id] = interaction.customId.split(":");
  if (!id || !["close", "reopen", "delete"].includes(action)) { await interaction.reply(ticketFeedback(buildNotFoundEmbed("Invalid Ticket Action", "That ticket control is no longer valid."), { ephemeral: true })); return true; }
  await interaction.deferUpdate();
  const context = await requireContext(interaction, repository, id); if (!context) return true;
  if (!isCanonicalTicketControlSource(interaction, context.ticket.controlMessageId, id)) {
    await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed("Stale Ticket Control", "Use the controls on the current matching ticket message."), { ephemeral: true }));
    return true;
  }
  if (!context.ticket.controlMessageId) await repository.setTicketControlMessageId(interaction.guildId, id, interaction.message.id);
  const member = interaction.member as GuildMember;
  const reviewer = member.roles.cache.has(context.ticketClass.reviewerRoleId);
  const opener = interaction.user.id === context.ticket.openerDiscordUserId;
  if ((action === "close" || action === "reopen") && !reviewer && !opener) return void await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed("Ticket Access Required", "Only the ticket opener or a configured reviewer can use this control."), { ephemeral: true })), true;
  if (action === "delete" && !reviewer) return void await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed("Reviewer Role Required", `Only members with ${formatRole(context.ticketClass.reviewerRoleId)} can delete this ticket.`), { ephemeral: true })), true;
  if (action === "close" || action === "reopen") {
    const result = await runTicketLifecycleOperation({
      action, guild: interaction.guild, guildId: interaction.guildId, ticketId: id,
      actor: { userId: interaction.user.id, roleIds: memberRoleIds(member, context.ticketClass.reviewerRoleId) }, ticketRepository: repository, channel: context.channel,
      presentation: createTicketButtonPresentation(interaction, context.channel)
    });
    if (result.kind === "error") await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed(result.title, result.description), { ephemeral: true }));
    return true;
  }
  if (context.ticket.status !== "closed") return void await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed("Close Ticket First", "This ticket must be closed before it can be deleted."), { ephemeral: true })), true;
  if (action === "delete") {
    const result = await deleteTicketChannel({ guild: interaction.guild, guildId: interaction.guildId, ticketId: id, actor: { userId: interaction.user.id, roleIds: memberRoleIds(member, context.ticketClass.reviewerRoleId) }, ticketRepository: repository, channel: context.channel });
    if (result.kind === "error") await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed(result.title, result.description), { ephemeral: true }));
    return true;
  }
  return true;
}

function createTicketButtonPresentation(interaction: ButtonInteraction<"cached">, channel: import("discord.js").TextChannel): TicketPresentation {
  return {
    renderClosed: async (ticket, ticketClass, description) => {
      const message = await interaction.followUp(buildTicketLifecycleCard(ticket, "closed", formatClosedTicketDescription(description, ticketClass.closedMessage)) as InteractionReplyOptions);
      return message?.id;
    },
    retireCandidate: async (messageId) => {
      if (messageId === interaction.message.id) {
        await retireTicketControlMessage(interaction.message, (payload) => interaction.editReply(payload));
        return;
      }
      const message = await channel.messages.fetch(messageId).catch(() => undefined);
      if (message) await retireTicketControlMessage(message, (payload) => message.edit(payload)).catch(() => undefined);
    },
    renderOpen: async (ticket, _ticketClass, description) => {
      const message = await interaction.followUp(buildTicketLifecycleCard(ticket, "open", description) as InteractionReplyOptions);
      return message?.id;
    }
  };
}
function memberRoleIds(member: GuildMember, reviewerRoleId?: string): Set<string> { const cache = member.roles.cache as unknown as { keys?: () => IterableIterator<string>; has(id: string): boolean }; return cache.keys ? new Set(cache.keys()) : reviewerRoleId && cache.has(reviewerRoleId) ? new Set([reviewerRoleId]) : new Set(); }

async function openTicket(interaction: ButtonInteraction<"cached">, repository: TicketRepository) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await withConversationClassLock("ticket", interaction.guildId, interaction.customId.slice(OPEN_PREFIX.length), () => openTicketLocked(interaction, repository));
}

async function openTicketLocked(interaction: ButtonInteraction<"cached">, repository: TicketRepository) {
  const id = interaction.customId.slice(OPEN_PREFIX.length); const ticketClass = await repository.getTicketClass(interaction.guildId, id);
  if (!ticketClass?.enabled) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Ticket Unavailable", "That ticket option is no longer available."), { edit: true })); return; }
  const ticket = await repository.createTicket({ ticketClassId: id, discordGuildId: interaction.guildId, openerDiscordUserId: interaction.user.id }).catch((error: unknown) => {
    if (error instanceof TicketClassUnavailableError) return undefined;
    throw error;
  });
  if (!ticket) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Ticket Unavailable", "That ticket option is no longer available."), { edit: true })); return; }
  const channel = await interaction.guild.channels.create({ name: buildTicketChannelName(ticketClass.name, interaction.user.username), type: ChannelType.GuildText, parent: ticketClass.ticketCategoryId, permissionOverwrites: buildTicketConversationPermissionOverwrites(
    interaction.guild.roles.everyone.id,
    interaction.user.id,
    ticketClass.reviewerRoleId
  ), reason: "Guild Manager general ticket" });
  await repository.setTicketChannel(interaction.guildId, ticket.ticketId, channel.id);
  const controlMessage = await channel.send(buildTicketControlCard(ticket, ticketClass, "open", { openingMentions: true }));
  await repository.setTicketControlMessageId(interaction.guildId, ticket.ticketId, controlMessage.id);
  await interaction.editReply(ticketFeedback(buildSuccessEmbed("Ticket Opened", `Your ticket is ${channel}.`), { edit: true }));
}

async function handleButtonAdd(interaction: ChatInputCommandInteraction, repository: TicketRepository) {
  const ticketClass = await requireTicketClass(interaction, repository); if (!ticketClass) return;
  const channel = interaction.options.getChannel("channel", true); if (!("messages" in channel)) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Invalid Channel", "Choose a text channel containing the message."), { edit: true })); return; }
  const message = await channel.messages.fetch({ message: interaction.options.getString("id", true).trim(), force: true }).catch(() => undefined);
  if (!message || message.author.id !== interaction.client.user.id) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Bot Message Required", "Ticket buttons can only be attached to messages authored by Guild Manager."), { edit: true })); return; }
  const updated = { ...ticketClass, sourceChannelId: channel.id, sourceMessageId: message.id, buttonLabel: interaction.options.getString("label", true).trim(), buttonStyle: interaction.options.getString("style", true) as TicketButtonStyle };
  const components = mergeEntryButtonComponents(message.components, entryButton(updated)); if (!components) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Message Buttons Unavailable", "Choose a message with room for another button and at most one container."), { edit: true })); return; }
  await repository.configureTicketButton(interaction.guildId!, ticketClass.ticketClassId, channel.id, message.id, updated.buttonLabel!, updated.buttonStyle!); await message.edit({ components, allowedMentions: { parse: [], repliedUser: false } });
  await interaction.editReply(ticketFeedback(buildSuccessEmbed("Ticket Button Added", `The ${ticketClass.name} ticket button was added to ${message.url}.`), { edit: true }));
}

async function handleMessages(interaction: ChatInputCommandInteraction, repository: TicketRepository, sub: string) {
  const ticketClass = sub === "set"
    ? await requireTicketClassForModal(interaction, repository)
    : await requireTicketClass(interaction, repository);
  if (!ticketClass) return; const type = interaction.options.getString("type", true) as TicketMessageType;
  if (sub === "clear") { await repository.setTicketMessage(interaction.guildId!, ticketClass.ticketClassId, type, undefined); await interaction.editReply(ticketFeedback(buildSuccessEmbed("Message Cleared", `${type === "initial" ? "Initial" : "Closed"} message was cleared for ${ticketClass.name}.`), { edit: true })); return; }
  const value = type === "initial" ? ticketClass.initialMessage : ticketClass.closedMessage;
  await interaction.showModal(new ModalBuilder().setCustomId(`${MESSAGE_PREFIX}${ticketClass.ticketClassId}:${type}`).setTitle(`${type === "initial" ? "Initial" : "Closed"} Message`).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(2000).setValue(value ?? ""))));
}

export async function runTicketOperationalLifecycle(input: { action: TicketLifecycleAction; guild: import("discord.js").Guild; guildId: string; ticketId: string; actor: { userId: string; roleIds: ReadonlySet<string> }; repository: TicketRepository; channel?: import("discord.js").TextChannel; presentation: TicketPresentation }) {
  return runTicketLifecycleOperation({ ...input, ticketRepository: input.repository });
}

async function handleTicketOperationalCommand(interaction: ChatInputCommandInteraction, repository: TicketRepository, action: TicketLifecycleAction): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(ticketFeedback(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveTicketTarget(await repository.listOperationalTicketTargets(interaction.guildId), interaction.channelId ?? undefined, interaction.options.getString("ticket") ?? undefined);
  if (resolution.kind !== "resolved") { const [title, description] = ticketTargetResolutionError(resolution.kind); await interaction.editReply(ticketFeedback(buildNotFoundEmbed(title, description), { edit: true })); return; }
  const channel = await resolveOperationalTicketChannel(interaction.guild, resolution.target);
  if (!channel) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Ticket Channel Unavailable", "The retained ticket channel is no longer available."), { edit: true })); return; }
  const result = await runTicketLifecycleOperation({ action, guild: interaction.guild, guildId: interaction.guildId, ticketId: resolution.target.ticketId, actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, ticketRepository: repository, channel, presentation: createTicketCommandPresentation(channel) });
  if (result.kind === "error") { await interaction.editReply(ticketFeedback(buildNotFoundEmbed(result.title, result.description), { edit: true })); return; }
  const target = `<#${channel.id}>`;
  await interaction.editReply(ticketFeedback(buildSuccessEmbed(result.repaired ? (result.kind === "closed" ? "Ticket Already Closed" : "Ticket Already Open") : (result.kind === "closed" ? "Ticket Closed" : "Ticket Reopened"), result.repaired ? `${target} was already ${result.kind === "closed" ? "closed" : "open"}. Its conversation permissions and controls were repaired.` : `${target} was ${result.kind === "closed" ? "closed" : "reopened"}.`), { edit: true }));
}

async function handleTicketDeleteCommand(interaction: ChatInputCommandInteraction, repository: TicketRepository): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(ticketFeedback(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveTicketTarget(await repository.listOperationalTicketTargets(interaction.guildId), interaction.channelId ?? undefined, interaction.options.getString("ticket") ?? undefined);
  if (resolution.kind !== "resolved") { const [title, description] = ticketTargetResolutionError(resolution.kind); await interaction.editReply(ticketFeedback(buildNotFoundEmbed(title, description), { edit: true })); return; }
  const ticket = await repository.getTicket(interaction.guildId, resolution.target.ticketId); const ticketClass = ticket ? await repository.getTicketClass(interaction.guildId, ticket.ticketClassId) : undefined;
  if (!ticket || !ticketClass) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Ticket Not Found", "Choose an active ticket."), { edit: true })); return; }
  if (!memberRoleIds(interaction.member as GuildMember, ticketClass.reviewerRoleId).has(ticketClass.reviewerRoleId)) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Reviewer Role Required", `Only members with ${formatRole(ticketClass.reviewerRoleId)} can perform this action.`), { edit: true })); return; }
  if (ticket.status !== "closed") { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Close Ticket First", "This ticket must be closed before it can be deleted."), { edit: true })); return; }
  const channel = await resolveOperationalTicketChannel(interaction.guild, resolution.target);
  if (!channel) { await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Ticket Channel Unavailable", "The retained ticket channel is no longer available."), { edit: true })); return; }
  const result = await deleteTicketChannel({ guild: interaction.guild, guildId: interaction.guildId, ticketId: ticket.ticketId, actor: { userId: interaction.user.id, roleIds: memberRoleIds(interaction.member as GuildMember, ticketClass.reviewerRoleId) }, ticketRepository: repository, channel });
  if (result.kind === "error") { const description = result.title === "Reviewer Role Required" ? `Only members with <@&${ticketClass.reviewerRoleId}> can perform this action.` : result.description; await interaction.editReply(ticketFeedback(buildNotFoundEmbed(result.title, description), { edit: true })); return; }
  await interaction.editReply(ticketFeedback(buildSuccessEmbed("Ticket Channel Deleted", `${result.channelName} was deleted; the retained ticket record was not deleted.`), { edit: true })).catch(() => undefined);
}

function ticketTargetResolutionError(kind: "required" | "mismatch" | "not_found"): [string, string] { return kind === "required" ? ["Ticket Target Required", "Run this command in a ticket channel or choose a ticket."] : kind === "mismatch" ? ["Ticket Target Mismatch", "The selected ticket does not match this channel. Omit the option or run the command outside a ticket channel."] : ["Ticket Not Found", "Choose an active ticket."]; }
async function resolveOperationalTicketChannel(guild: import("discord.js").Guild, target: TicketTarget) { if (!target.ticketChannelId) return undefined; const channel = guild.channels.cache.get(target.ticketChannelId) ?? await guild.channels.fetch(target.ticketChannelId).catch(() => undefined); return channel?.type === ChannelType.GuildText ? channel : undefined; }
function createTicketCommandPresentation(channel: import("discord.js").TextChannel): TicketPresentation {
  return {
    renderClosed: async (ticket, ticketClass, description) => {
      const candidate = await channel.send(buildTicketLifecycleCard(ticket, "closed", formatClosedTicketDescription(description, ticketClass.closedMessage)));
      return candidate.id;
    },
    retireCandidate: async (messageId) => {
      const message = await channel.messages.fetch(messageId).catch(() => undefined);
      if (message) await retireTicketControlMessage(message, (payload) => message.edit(payload)).catch(() => undefined);
    },
    renderOpen: async (ticket, _ticketClass, description) => {
      const candidate = await channel.send(buildTicketLifecycleCard(ticket, "open", description));
      return candidate.id;
    }
  };
}

async function requireTicketClass(interaction: ChatInputCommandInteraction, repository: TicketRepository) {
  const value = await repository.getTicketClass(interaction.guildId!, interaction.options.getString("ticket", true));
  if (!value) await interaction.editReply(ticketFeedback(buildNotFoundEmbed("Ticket Not Found", "Choose a configured ticket class."), { edit: true }));
  return value;
}

async function requireTicketClassForModal(interaction: ChatInputCommandInteraction, repository: TicketRepository) {
  const lookup = repository.getTicketClass(interaction.guildId!, interaction.options.getString("ticket", true));
  let timeout: NodeJS.Timeout | undefined;
  const unavailable = new Promise<{ kind: "unavailable" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "unavailable" }), 2_000);
  });
  const result = await Promise.race([lookup.then((value) => ({ kind: "value" as const, value })), unavailable]);
  if (timeout) clearTimeout(timeout);
  if (result.kind === "value" && result.value) return result.value;
  // This is deliberately the sole response path for the modal opener. The
  // lookup is read-only and its late completion is ignored.
  await interaction.reply(ticketFeedback(buildNotFoundEmbed("Ticket Not Found", "Choose a configured ticket class."), { ephemeral: true }));
  return undefined;
}
async function requireContext(interaction: ButtonInteraction<"cached">, repository: TicketRepository, id: string) { const ticket = await repository.getTicket(interaction.guildId, id); const channel = interaction.guild.channels.cache.get(interaction.channelId); if (!ticket || ticket.ticketChannelId !== interaction.channelId || ticket.status === "deleted" || channel?.type !== ChannelType.GuildText) { await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed("Ticket Not Found", "This control does not match an active ticket channel."), { ephemeral: true })); return; } const ticketClass = await repository.getTicketClass(interaction.guildId, ticket.ticketClassId); if (!ticketClass) { await replyAfterTicketAcknowledgement(interaction, ticketFeedback(buildNotFoundEmbed("Ticket Class Missing", "This ticket class no longer exists."), { ephemeral: true })); return; } return { ticket, ticketClass, channel }; }

async function replyAfterTicketAcknowledgement(
  interaction: ButtonInteraction<"cached">,
  payload: InteractionReplyOptions
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

function isCanonicalTicketControlSource(interaction: ButtonInteraction<"cached">, storedId: string | undefined, ticketId: string): boolean {
  if (interaction.message.author.id !== interaction.client.user.id) return false;
  if (storedId) return storedId === interaction.message.id;
  // A persisted canonical ID is authoritative.  Pre-persistence legacy cards
  // are adopted only when they contain one of this ticket's exact lifecycle
  // controls; the lifecycle service then validates the stored state and can
  // repair a transition whose previous message edit failed.
  const expected = [`${PREFIX}close:${ticketId}`, `${PREFIX}reopen:${ticketId}`, `${PREFIX}delete:${ticketId}`];
  return expected.some((customId) => messageHasNestedComponentCustomId(interaction.message, customId));
}

type TicketControlState = "open" | "closed";

export function buildTicketControlCard(ticket: { ticketId: string; openerDiscordUserId: string }, ticketClass: TicketClass, state: TicketControlState, options: { openingMentions?: boolean; includeControls?: boolean } = {}) {
  const opener = `<@${ticket.openerDiscordUserId}>`;
  return buildComponentsV2Card({
    accentColor: INFO_COLOR,
    title: ticketClass.name,
    text: [
      `${opener}, this is your private ticket channel.`,
      ...(ticketClass.initialMessage ? [ticketClass.initialMessage] : []),
      `Attn: ${formatRole(ticketClass.reviewerRoleId)}`
    ],
    actionRows: options.includeControls === false ? [] : [state === "open" ? openButtons(ticket.ticketId) : closedButtons(ticket.ticketId)],
    allowedMentions: options.openingMentions
      ? { parse: [], users: [ticket.openerDiscordUserId], roles: [ticketClass.reviewerRoleId], repliedUser: false }
      : { parse: [], repliedUser: false }
  });
}

function buildTicketLifecycleCard(ticket: { ticketId: string }, state: TicketControlState, description: string) {
  return feedbackMessage({
    accentColor: INFO_COLOR,
    cards: [{ title: state === "closed" ? "Ticket Closed" : "Ticket Reopened", description }],
    actionRows: [state === "closed" ? closedButtons(ticket.ticketId) : openButtons(ticket.ticketId)],
    allowActionRows: true,
    allowedMentions: { parse: [], repliedUser: false }
  });
}

function formatClosedTicketDescription(status: string, configuredMessage: string | undefined): string {
  return configuredMessage ? `${status}\n\n${configuredMessage}` : status;
}

const LEGACY_TICKET_CONTROL_FOOTERS = new Set([
  "The ticket opener or reviewers can close this ticket.",
  "The ticket opener or reviewers can reopen this ticket. Reviewers can delete it."
]);

function isLegacyTicketControlFooter(text: string | undefined): boolean {
  return !!text && (LEGACY_TICKET_CONTROL_FOOTERS.has(text)
    || (text.startsWith("*") && text.endsWith("*") && LEGACY_TICKET_CONTROL_FOOTERS.has(text.slice(1, -1))));
}

async function retireTicketControlMessage(
  message: { components?: readonly unknown[]; embeds?: readonly unknown[] },
  edit: (payload: MessageEditOptions) => Promise<unknown>
): Promise<void> {
  const stripControlsAndGuidance = (component: unknown): unknown => {
    const builder = component as { toJSON?: () => unknown } | undefined;
    const json = builder?.toJSON?.() ?? component;
    if (!json || typeof json !== "object") return json;
    const data = json as Record<string, unknown>;
    const children = Array.isArray(data.components)
      ? data.components.filter((child) => (child as { type?: number }).type !== ComponentType.ActionRow).map(stripControlsAndGuidance)
      : undefined;
    const footer = children?.at(-1) as { type?: number; content?: string } | undefined;
    if (data.type === ComponentType.Container && children && children.length > 1
      && footer?.type === ComponentType.TextDisplay && isLegacyTicketControlFooter(footer.content)) children.pop();
    return children ? { ...data, components: children } : data;
  };
  const sourceComponents = message.components ?? [];
  const hasV2Container = sourceComponents.some((component) => {
    const builder = component as { toJSON?: () => { type?: number }; type?: number };
    return (builder.toJSON?.() ?? builder).type === ComponentType.Container;
  });
  if (hasV2Container) {
    const components = sourceComponents.map(stripControlsAndGuidance) as NonNullable<MessageEditOptions["components"]>;
    await edit({ components, content: null, embeds: [], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [], repliedUser: false } });
    return;
  }
  const embed = message.embeds?.[0];
  if (embed) {
    const retired = EmbedBuilder.from(embed as Parameters<typeof EmbedBuilder.from>[0]);
    if (isLegacyTicketControlFooter(retired.toJSON().footer?.text)) retired.setFooter(null);
    await edit(ticketResponse(retired, { edit: true }));
  } else {
    // Ordinary lifecycle cards retain their text and attachments during retirement.
    await edit({ components: [], allowedMentions: { parse: [], repliedUser: false } });
  }
}


function openButtons(id: string) { return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}close:${id}`).setLabel("Close").setStyle(ButtonStyle.Secondary)); }
function closedButtons(id: string) { return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}reopen:${id}`).setLabel("Reopen").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`${PREFIX}delete:${id}`).setLabel("Delete").setStyle(ButtonStyle.Danger)); }
function entryButton(t: TicketClass): APIButtonComponentWithCustomId { return new ButtonBuilder().setCustomId(`${OPEN_PREFIX}${t.ticketClassId}`).setLabel(t.buttonLabel ?? t.name).setStyle(style(t.buttonStyle ?? "primary")).toJSON() as APIButtonComponentWithCustomId; }
function style(value: TicketButtonStyle) { return value === "secondary" ? ButtonStyle.Secondary : value === "success" ? ButtonStyle.Success : value === "danger" ? ButtonStyle.Danger : ButtonStyle.Primary; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ticket"; }
export function buildTicketChannelName(ticketClassName: string, username: string) { return `${slug(ticketClassName)}-${slug(username)}`.slice(0, 95); }

function ticketFeedback(embed: EmbedBuilder, options: { ephemeral?: boolean; edit?: boolean } = {}): ComponentsV2Payload {
  const payload = { cards: [embed], flags: options.ephemeral ? MessageFlags.Ephemeral : 0 };
  return (options.edit ? feedbackEdit(payload) : feedbackReply(payload)) as ComponentsV2Payload;
}
