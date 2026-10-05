import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { GiveawayRecord, createGiveawayRepository } from "../db/giveawayRepository.js";
import { completeFeedbackPrompt, editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import type { Logger } from "../logging/logger.js";
import type { EntryPanelContext, EntrySelection } from "../services/entryPanels/types.js";
import { GiveawayPublicationError, giveawayNotificationProblem, giveawayPermissionProblem, publishGiveaway } from "../services/giveaways/hosting.js";
import {
  buildGiveawayCreatedEmbed,
  buildGiveawayStatusEmbed,
  escapeMarkdownLinkText
} from "../services/giveaways/rendering.js";
import { createGiveawayService } from "../services/giveaways/service.js";
import { UTC_TIME_INPUT_HELP, UTC_TIME_OPTION_DESCRIPTION, buildNextUtcDateChoices, parseUtcDateTime } from "../services/scheduling.js";
import {
  INFO_COLOR,
  INVALID_COLOR,
  SUCCESS_COLOR,
  WARNING_COLOR,
  truncateChoiceName
} from "./configurationHelpers.js";

type GiveawayRepository = ReturnType<typeof createGiveawayRepository>;

const CREATE_MODAL_PREFIX = "giveaway-create:";
const CONFIRM_BUTTON_PREFIX = "giveaway-confirm:";
const MODAL_DRAFT_TTL_MS = 15 * 60 * 1000;
const TITLE_FIELD = "title";
const DESCRIPTION_FIELD = "description";

function asGiveawayReply(
  embed: EmbedBuilder,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
  structured = false
) {
  return feedbackReply({ structured, cards: [embed], actionRows: components, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [], repliedUser: false } });
}

function asGiveawayEdit(
  embed: EmbedBuilder,
  components: ActionRowBuilder<ButtonBuilder>[] = []
) {
  return v2Edit({ cards: [embed], actionRows: components, allowedMentions: { parse: [], repliedUser: false } });
}

interface PendingGiveawayDraft extends EntrySelection {
  discordGuildId: string;
  creatorDiscordUserId: string;
  drawAt: Date;
  winnerCount: number;
  image?: Pick<Attachment, "name" | "url" | "contentType">;
  notificationRoleId?: string;
  expires: number;
  runtimeEpoch: number;
  guildEpoch: number;
  timeout: NodeJS.Timeout;
}

const pendingDrafts = new Map<string, PendingGiveawayDraft>();
interface PendingGiveawayConfirmation {
  discordGuildId: string;
  ownerId: string;
  giveawayId: string;
  action: "draw" | "cancel";
  expires: number;
}
const pendingConfirmations = new Map<string, PendingGiveawayConfirmation>();
let draftRuntimeEpoch = 0;
const draftGuildEpochs = new Map<string, number>();

export function invalidateGiveawayDrafts(guildId?: string): void {
  if (guildId) draftGuildEpochs.set(guildId, (draftGuildEpochs.get(guildId) ?? 0) + 1);
  else draftRuntimeEpoch++;
  for (const [id, draft] of pendingDrafts) if (!guildId || draft.discordGuildId === guildId) takeDraft(id);
  for (const [id, confirmation] of pendingConfirmations) if (!guildId || confirmation.discordGuildId === guildId) pendingConfirmations.delete(id);
}

export const giveawayCommand = new SlashCommandBuilder()
  .setName("giveaway")
  .setDescription("Create and manage giveaways.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a scheduled giveaway in the configured channel.")
      .addStringOption((option) =>
        option
          .setName("date")
          .setDescription("UTC date. Choose one of the next 7 days.")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription(UTC_TIME_OPTION_DESCRIPTION)
          .setRequired(true)
      )
      .addIntegerOption((option) =>
        option
          .setName("winners")
          .setDescription("Number of winners to draw.")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(5)
      )
      .addAttachmentOption((option) =>
        option
          .setName("image")
          .setDescription("Optional image displayed in the giveaway.")
      )
      .addRoleOption((option) =>
        option
          .setName("notification")
          .setDescription("Optional Discord role to notify.")
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("draw")
      .setDescription("Draw one of your open giveaways now.")
      .addStringOption((option) =>
        option.setName("giveaway").setDescription("Open giveaway to draw.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reroll")
      .setDescription("Replace one unavailable winner while retaining the others.")
      .addStringOption((option) =>
        option.setName("giveaway").setDescription("Drawn giveaway to update.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("winner").setDescription("Unavailable winner to replace.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("cancel")
      .setDescription("Cancel one of your open giveaways.")
      .addStringOption((option) =>
        option.setName("giveaway").setDescription("Open giveaway to cancel.").setRequired(true).setAutocomplete(true)
      )
  );


export const giveawaysCommand = new SlashCommandBuilder()
  .setName("giveaways")
  .setDescription("Show open giveaways on this server.")
  .setDefaultMemberPermissions(0);

export async function handleGiveawayCommand(
  interaction: ChatInputCommandInteraction,
  repository: GiveawayRepository,
  logger: Logger,
  entries?: EntryPanelContext
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed(
      "Server Not Cached",
      "Guild Manager could not load this server. Try again in a moment.",
      INVALID_COLOR
    )));
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "create") {
    await handleCreate(interaction, entries);
    return;
  }

  // Every remaining leaf reads persisted giveaway state.  Acknowledge before
  // that read so a slow database cannot exhaust Discord's interaction window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const member = await managementMember(interaction);
  if (!member) return;

  const giveawayId = interaction.options.getString("giveaway", true);
  const giveaway = await repository.getById(interaction.guildId, giveawayId);
  if (!giveaway || !await canManageGiveaway(interaction.user.id, member.permissions, giveaway, repository)) {
    await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
      "Giveaway Not Found",
      "Choose one of your giveaways from autocomplete.",
      INVALID_COLOR
    ));
    return;
  }

  if (subcommand === "reroll") {
    if (giveaway.state !== "drawn") {
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
        "Giveaway Not Drawn",
        "Only a drawn giveaway can be rerolled.",
        INVALID_COLOR
      ));
      return;
    }
    const unavailableWinnerId = interaction.options.getString("winner", true);
    const replacement = await createGiveawayService(repository, logger).reroll(
      interaction.guild,
      giveaway,
      unavailableWinnerId,
      interaction.user.id
    );
    if (replacement === undefined) {
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
        "Winner Not Found",
        "Choose a current winner from autocomplete.",
        INVALID_COLOR
      ));
    } else if (replacement === "") {
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
        "No Replacement Available",
        "No eligible participant remains who has not already won.",
        INVALID_COLOR
      ));
    } else if (replacement.notificationPublished) {
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
        "Winner Redrawn",
        `<@${replacement.replacementDiscordUserId}> replaced <@${unavailableWinnerId}>. The other winners were retained and the notification was posted.`,
        SUCCESS_COLOR
      ));
    } else {
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
        "Winner Redrawn; Notification Not Posted",
        `<@${replacement.replacementDiscordUserId}> replaced <@${unavailableWinnerId}>, but Guild Manager could not post the public notification.`,
        WARNING_COLOR
      ));
    }
    return;
  }

  if (giveaway.state !== "open") {
    await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
      "Giveaway Closed",
      "That giveaway is no longer open.",
      INVALID_COLOR
    ));
    return;
  }

  const action = subcommand === "draw" ? "draw" : "cancel";
  for (const [id, c] of pendingConfirmations) if (c.expires <= Date.now()) pendingConfirmations.delete(id);
  const confirmationId = randomUUID();
  pendingConfirmations.set(confirmationId, { discordGuildId: interaction.guildId, ownerId: interaction.user.id, giveawayId: giveaway.giveawayId, action, expires: Date.now() + MODAL_DRAFT_TTL_MS });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_BUTTON_PREFIX}${confirmationId}:accept`)
      .setLabel(action === "draw" ? "Draw Now" : "Cancel Giveaway")
      .setStyle(action === "draw" ? ButtonStyle.Primary : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_BUTTON_PREFIX}${confirmationId}:dismiss`)
      .setLabel("Keep Giveaway")
      .setStyle(ButtonStyle.Secondary)
  );
  await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
    action === "draw" ? "Draw Giveaway" : "Cancel Giveaway",
    action === "draw"
      ? `Draw “${giveaway.title}” now? This closes entries and selects the winners.`
      : `Cancel “${giveaway.title}”? No winners will be drawn.`,
    INFO_COLOR
  ), [row]);
}

export async function handleGiveawaysCommand(
  interaction: ChatInputCommandInteraction,
  repository: GiveawayRepository
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed(
      "Server Not Cached",
      "Guild Manager could not load this server. Try again in a moment.",
      INVALID_COLOR
    )));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const giveaways = await repository.listOpen(interaction.guildId);
  if (giveaways.length === 0) {
    await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
      "Giveaways",
      "There are no open giveaways."
    ));
    return;
  }

  const lines: string[] = [];
  for (const giveaway of giveaways) {
    const count = (await repository.listEligibleParticipantIds(interaction.guildId, giveaway.giveawayId)).length;
    const timestamp = Math.floor(giveaway.drawAt.getTime() / 1000);
    const link = `https://discord.com/channels/${interaction.guildId}/${giveaway.channelId}/${giveaway.originalMessageId}`;
    lines.push(`- [${escapeMarkdownLinkText(giveaway.title)}](${link}) • <@${giveaway.creatorDiscordUserId}> • <t:${timestamp}:F> (<t:${timestamp}:R>) • ${count} participant${count === 1 ? "" : "s"}`);
  }
  const descriptions = splitLines(lines, 3900, 37);
  await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
    "Giveaways",
    descriptions[0]
  ), [], true);
  for (const description of descriptions.slice(1)) {
    await interaction.followUp(asGiveawayReply(buildGiveawayStatusEmbed(
      "Giveaways (continued)",
      description
    ), [], true));
  }
}

export async function handleGiveawayAutocomplete(
  interaction: AutocompleteInteraction,
  repository: GiveawayRepository
): Promise<boolean> {
  if (interaction.commandName !== "giveaway") return false;
  const focused = interaction.options.getFocused(true);
  if (focused.name === "date") {
    await interaction.respond(buildNextUtcDateChoices());
    return true;
  }
  if (!interaction.guildId) {
    await interaction.respond([]);
    return true;
  }

  const subcommand = interaction.options.getSubcommand();
  if (focused.name === "giveaway") {
    const states = subcommand === "reroll" ? ["drawn" as const] : ["open" as const];
    const creatorFilter = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ? undefined
      : interaction.user.id;
    const giveaways = await repository.listOwned(interaction.guildId, creatorFilter, states);
    const query = String(focused.value).toLocaleLowerCase();
    await interaction.respond(giveaways
      .filter((giveaway) => giveaway.title.toLocaleLowerCase().includes(query) || giveaway.giveawayId.includes(query))
      .map((giveaway) => ({
        name: truncateChoiceName(`${giveaway.title} • ${giveaway.drawAt.toISOString().slice(0, 16).replace("T", " ")} UTC`),
        value: giveaway.giveawayId
      })));
    return true;
  }
  if (focused.name === "winner") {
    const giveawayId = interaction.options.getString("giveaway");
    if (!giveawayId) {
      await interaction.respond([]);
      return true;
    }
    const winners = (await repository.listWinners(interaction.guildId, giveawayId))
      .filter((winner) => winner.status === "current");
    // Autocomplete interactions cannot be deferred.  Never make serial REST
    // user fetches here; cached names are a best effort and IDs are stable.
    const choices = winners.slice(0, 25).map((winner) => {
      const user = interaction.client.users.cache.get(winner.discordUserId);
      return {
        name: truncateChoiceName(`@${user?.username ?? winner.discordUserId}`),
        value: winner.discordUserId
      };
    });
    await interaction.respond(choices);
    return true;
  }
  return false;
}

export async function handleGiveawayModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: GiveawayRepository,
  logger: Logger,
  entries?: EntryPanelContext
): Promise<boolean> {
  if (!interaction.customId.startsWith(CREATE_MODAL_PREFIX)) return false;
  if (!interaction.inCachedGuild()) return true;
  const draftId = interaction.customId.slice(CREATE_MODAL_PREFIX.length);
  const draft = pendingDrafts.get(draftId);
  if (!draft || draft.expires <= Date.now() || draft.discordGuildId !== interaction.guildId || draft.creatorDiscordUserId !== interaction.user.id) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed(
      "Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR
    )));
    return true;
  }
  takeDraft(draftId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!entries) {
    await editGiveawayFeedback(interaction, giveawayChannelNotConfigured());
    return true;
  }
  let created = false;
  await entries.runExclusive(interaction.guildId, async () => {
    const current = () => draft.expires > Date.now() && draft.runtimeEpoch === draftRuntimeEpoch && draft.guildEpoch === (draftGuildEpochs.get(draft.discordGuildId) ?? 0);
    const expired = async () => {
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR));
      return undefined;
    };
    const validate = async () => {
      if (!current()) return expired();
      const access = await entries.checkAccess(interaction, "giveaways", { mutation: true, expected: draft });
      if (!access) return undefined;
      return current() ? access : expired();
    };
    const access = await validate();
    if (!access) return;
    try {
      const result = await publishGiveaway({
        guild: interaction.guild,
        channel: access.channel,
        creatorDiscordUserId: interaction.user.id,
        title: interaction.fields.getTextInputValue(TITLE_FIELD).trim(),
        description: interaction.fields.getTextInputValue(DESCRIPTION_FIELD).trim(),
        drawAt: draft.drawAt,
        winnerCount: draft.winnerCount,
        image: draft.image,
        notificationRoleId: draft.notificationRoleId,
        repository,
        logger,
        validate: async () => Boolean(await validate())
      });
      if (!result) return;
      created = true;
      await editGiveawayFeedback(interaction, buildGiveawayCreatedEmbed({ ...result.giveaway, messageUrl: result.messageUrl }));
    } catch (error) {
      if (!(error instanceof GiveawayPublicationError)) throw error;
      await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(error.title, error.message, INVALID_COLOR));
    }
  });
  if (created) await entries.refresh(interaction.guild).catch((error) => logger.warn("giveaway panel refresh failed after creation", { guildId: interaction.guildId, error: error instanceof Error ? error.message : String(error) }));
  return true;
}

export async function handleGiveawayButton(
  interaction: ButtonInteraction,
  repository: GiveawayRepository,
  logger: Logger,
  entries?: EntryPanelContext
): Promise<boolean> {
  if (!interaction.customId.startsWith(CONFIRM_BUTTON_PREFIX)) return false;
  if (!interaction.inCachedGuild()) return true;
  const [id, response] = interaction.customId.slice(CONFIRM_BUTTON_PREFIX.length).split(":");
  const confirmation = pendingConfirmations.get(id);
  if (!confirmation || confirmation.discordGuildId !== interaction.guildId || confirmation.expires <= Date.now() || !["accept", "dismiss"].includes(response)) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR)));
    return true;
  }
  if (interaction.user.id !== confirmation.ownerId) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed(
      "Confirmation Not Yours",
      "Only the command user can use these controls.",
      INVALID_COLOR
    )));
    return true;
  }
  pendingConfirmations.delete(id);
  if (response === "dismiss") {
    await completeGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
      "Giveaway Kept",
      "Giveaway kept; no changes were made."
    ));
    return true;
  }
  await interaction.deferUpdate();
  const member = await managementMember(interaction);
  if (!member) return true;
  const giveaway = await repository.getById(interaction.guildId, confirmation.giveawayId);
  if (!giveaway || !await canManageGiveaway(interaction.user.id, member.permissions, giveaway, repository) || giveaway.state !== "open") {
    await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed(
      "Giveaway Not Available",
      "That giveaway is no longer open.",
      INVALID_COLOR
    ));
    return true;
  }
  if (confirmation.action === "draw") {
    const result = await createGiveawayService(repository, logger).draw(interaction.guild, giveaway, interaction.user.id);
    await editGiveawayFeedback(interaction, result === "drawn"
      ? buildGiveawayStatusEmbed(
        "Giveaway Drawn",
        "The giveaway draw announcement was posted.",
        SUCCESS_COLOR
      )
      : buildGiveawayStatusEmbed(
        "Giveaway Not Drawn",
        "The giveaway message is missing or the giveaway was already closed.",
        INVALID_COLOR
      ));
    if (result !== "already_closed") await entries?.refresh(interaction.guild).catch(() => undefined);
    return true;
  }
  if (confirmation.action === "cancel") {
    const result = await createGiveawayService(repository, logger).cancel(
      interaction.guild,
      giveaway,
      interaction.user.id
    );
    const response = result === "cancelled"
      ? buildGiveawayStatusEmbed(
        "Giveaway Cancelled",
        "The giveaway was cancelled and its public message was closed.",
        SUCCESS_COLOR
      )
      : result === "message_close_failed" || result === "message_missing"
        ? buildGiveawayStatusEmbed(
          "Giveaway Cancelled; Message Not Closed",
          "The giveaway was cancelled, but Guild Manager could not close its public message.",
          WARNING_COLOR
        )
        : buildGiveawayStatusEmbed(
          "Giveaway Not Cancelled",
          "That giveaway is no longer open.",
          INVALID_COLOR
        );
    await editGiveawayFeedback(interaction, response);
    if (result !== "already_closed") await entries?.refresh(interaction.guild).catch(() => undefined);
    return true;
  }
  return true;
}

async function handleCreate(
  interaction: ChatInputCommandInteraction<"cached">,
  entries?: EntryPanelContext
): Promise<void> {
  if (!entries) {
    await interaction.reply(asGiveawayReply(giveawayChannelNotConfigured()));
    return;
  }
  const access = await entries.checkAccess(interaction, "giveaways", { mutation: true });
  if (!access) return;
  const drawAt = parseUtcDateTime(interaction.options.getString("date", true), interaction.options.getString("time", true));
  if (!drawAt || drawAt <= new Date()) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed(
      "Invalid Draw Time", !drawAt ? `Choose an autocomplete date. ${UTC_TIME_INPUT_HELP}` : "Choose a future UTC draw time.", INVALID_COLOR
    ), [], !drawAt));
    return;
  }
  const image = interaction.options.getAttachment("image");
  if (image && !image.contentType?.toLocaleLowerCase().startsWith("image/")) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed("Invalid Giveaway Image", "The giveaway attachment must be an image.", INVALID_COLOR)));
    return;
  }
  if (giveawayPermissionProblem(access.channel, interaction.guild.members.me, Boolean(image))) {
    await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed("Giveaways Channel Unavailable", "The configured channel is unavailable. Ask a Discord Administrator to check the channel setting.", INVALID_COLOR)));
    return;
  }
  const notificationRole = interaction.options.getRole("notification");
  if (notificationRole) {
    const problem = giveawayNotificationProblem(access.channel, interaction.guild.members.me, notificationRole.mentionable);
    if (problem) {
      await interaction.reply(asGiveawayReply(buildGiveawayStatusEmbed("Giveaway Notification Unavailable", problem, INVALID_COLOR)));
      return;
    }
  }
  const draftId = createDraft({
    discordChannelId: access.discordChannelId,
    configurationRevision: access.configurationRevision,
    discordGuildId: interaction.guildId,
    creatorDiscordUserId: interaction.user.id,
    drawAt,
    winnerCount: interaction.options.getInteger("winners", true),
    image: image ? { name: image.name, url: image.url, contentType: image.contentType } : undefined,
    notificationRoleId: notificationRole?.id
  });
  const modal = new ModalBuilder().setCustomId(`${CREATE_MODAL_PREFIX}${draftId}`).setTitle("Create Giveaway");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(TITLE_FIELD).setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(DESCRIPTION_FIELD).setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
    )
  );
  await interaction.showModal(modal);
}

function giveawayChannelNotConfigured() {
  return buildGiveawayStatusEmbed("Giveaways Channel Not Configured", "Ask a Discord Administrator to configure this feature’s channel.", INVALID_COLOR);
}

async function canManageGiveaway(
  discordUserId: string,
  permissions: Readonly<{ has(permission: bigint): boolean }> | null,
  giveaway: GiveawayRecord,
  repository: GiveawayRepository
): Promise<boolean> {
  if (await repository.isHostAuthorityRevoked(giveaway.discordGuildId, discordUserId, giveaway.giveawayId)) return false;
  return giveaway.creatorDiscordUserId === discordUserId
    || Boolean(permissions?.has(PermissionFlagsBits.Administrator));
}

async function managementMember(interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached">): Promise<GuildMember | undefined> {
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => undefined);
  if (member && !member.user.bot && (member.communicationDisabledUntilTimestamp ?? 0) <= Date.now()) return member;
  await editGiveawayFeedback(interaction, buildGiveawayStatusEmbed("Giveaway Unavailable", "You must be a current Discord member who is not timed out to manage giveaways.", INVALID_COLOR));
  return undefined;
}

function createDraft(input: Omit<PendingGiveawayDraft, "timeout" | "expires" | "runtimeEpoch" | "guildEpoch">): string {
  const id = randomUUID();
  const timeout = setTimeout(() => pendingDrafts.delete(id), MODAL_DRAFT_TTL_MS);
  timeout.unref();
  pendingDrafts.set(id, { ...input, expires: Date.now() + MODAL_DRAFT_TTL_MS, runtimeEpoch: draftRuntimeEpoch, guildEpoch: draftGuildEpochs.get(input.discordGuildId) ?? 0, timeout });
  return id;
}

function takeDraft(id: string): PendingGiveawayDraft | undefined {
  const draft = pendingDrafts.get(id);
  if (draft) {
    pendingDrafts.delete(id);
    clearTimeout(draft.timeout);
  }
  return draft;
}


function splitLines(lines: string[], maximumLength: number, maximumLines: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentLineCount = 0;
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if ((next.length > maximumLength || currentLineCount >= maximumLines) && current) {
      chunks.push(current);
      current = line;
      currentLineCount = 1;
    } else {
      current = next;
      currentLineCount += 1;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function editGiveawayFeedback(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction, embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = [], structured = false) {
  await editFeedback(interaction, { cards: [embed], actionRows: components, structured });
}
async function completeGiveawayFeedback(interaction: ButtonInteraction, embed: EmbedBuilder) {
  await completeFeedbackPrompt(interaction, { cards: [embed] });
}
