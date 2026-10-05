import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction
} from "discord.js";
import { randomUUID } from "node:crypto";
import type {
  EligibleRegearCharacter,
  RegearClaim,
  RegearClaimFilters,
  RegearContent,
  RegearContentState,
  createRegearRepository
} from "../db/regearRepository.js";
import { RegearOperationError } from "../db/regearRepository.js";
import { completeFeedbackPrompt, editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit, v2Reply } from "../discord/operationalMessages.js";
import {
  ALBION_SERVER_VALUES,
  getAlbionServerLabel,
  isAlbionServer,
  type AlbionServer
} from "../services/albion/servers.js";
import type { EntryPanelContext } from "../services/entryPanels/types.js";
import {
  buildPendingRegearReview,
  buildPendingRegearReviewEdit,
  buildRegearContentAnnouncement,
  buildRegearHistoryEmbed,
  buildRegearStatusEmbed,
  buildRejectedRegearOutcome,
  discordMessageUrl,
  formatAustralianShortDate,
  formatLongDate,
  formatLongDateWithWeekday,
  formatSilver,
  inspectPendingRegearEvidence,
  sanitizeUserText
} from "../services/regears/rendering.js";
import type { createRegearService } from "../services/regears/service.js";
import { UTC_TIME_INPUT_HELP, UTC_TIME_OPTION_DESCRIPTION, parseUtcDateTime } from "../services/scheduling.js";
import {
  INFO_COLOR,
  INVALID_COLOR,
  REPORT_COLOR,
  SUCCESS_COLOR,
  normalizeQuery,
  truncateChoiceName
} from "./configurationHelpers.js";

type RegearRepository = ReturnType<typeof createRegearRepository>;
type RegearService = ReturnType<typeof createRegearService>;

const MODAL_AMOUNT = "regear-amount";
const MODAL_EVIDENCE_1 = "regear-evidence-1";
const MODAL_EVIDENCE_2 = "regear-evidence-2";
const MODAL_REASON = "regear-reason";
const HISTORY_PAGE_SIZE = 10;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const REASON_MAX_LENGTH = 500;

export const regearCommand = new SlashCommandBuilder()
  .setName("regear")
  .setDescription("Administer re-gear content and requests.")
  .setDefaultMemberPermissions(0)
  .addSubcommandGroup((group) => group
    .setName("content")
    .setDescription("Manage re-gear content records.")
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Open content for re-gear requests.")
      .addStringOption((option) => option.setName("name").setDescription("Re-gear content name.").setRequired(true).setMinLength(1).setMaxLength(100))
      .addStringOption((option) => option.setName("date").setDescription("Content date in D/M/YYYY or YYYY-MM-DD format.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("time").setDescription(`Optional ${UTC_TIME_OPTION_DESCRIPTION}`)))
    .addSubcommand((subcommand) => subcommand
      .setName("close")
      .setDescription("Close re-gear content to new requests.")
      .addStringOption((option) => option.setName("content").setDescription("Open re-gear content.").setRequired(true).setAutocomplete(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("reopen")
      .setDescription("Reopen closed re-gear content.")
      .addStringOption((option) => option.setName("content").setDescription("Closed re-gear content.").setRequired(true).setAutocomplete(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("list")
      .setDescription("List re-gear content records.")
      .addStringOption((option) => option.setName("server").setDescription("Optional Albion Online server.").setAutocomplete(true))
      .addStringOption((option) => option.setName("state").setDescription("Optional content state.").addChoices(
        { name: "Open", value: "open" },
        { name: "Closed", value: "closed" },
        { name: "All", value: "all" }
      ))))
  .addSubcommand((subcommand) => subcommand
    .setName("report")
    .setDescription("Report Pending and Accepted re-gear requests.")
    .addStringOption((option) => option.setName("content").setDescription("Optional re-gear content.").setAutocomplete(true))
    .addUserOption((option) => option.setName("user").setDescription("Optional current character owner."))
    .addStringOption((option) => option.setName("status").setDescription("Request state.").addChoices(
      { name: "Pending", value: "pending" },
      { name: "Accepted", value: "accepted" },
      { name: "All", value: "all" }
    ))
    .addStringOption((option) => option.setName("server").setDescription("Optional Albion Online server.").setAutocomplete(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("view")
    .setDescription("View and repair a re-gear request presentation.")
    .addStringOption((option) => option.setName("claim").setDescription("Accessible re-gear request.").setRequired(true).setAutocomplete(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("accept")
    .setDescription("Accept and credit a Pending re-gear request.")
    .addStringOption((option) => option.setName("claim").setDescription("Pending re-gear request.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("amount").setDescription("Optional positive whole-silver amount."))
    .addStringOption((option) => option.setName("reason").setDescription("Required when the accepted amount changes.").setMaxLength(REASON_MAX_LENGTH)))
  .addSubcommand((subcommand) => subcommand
    .setName("reject")
    .setDescription("Reject and remove a Pending re-gear request.")
    .addStringOption((option) => option.setName("claim").setDescription("Pending re-gear request.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("reason").setDescription("Optional concise reason.").setMaxLength(REASON_MAX_LENGTH)));


export const regearsCommand = new SlashCommandBuilder()
  .setName("regears")
  .setDescription("Show your Pending and Accepted re-gear requests.")
  .setDefaultMemberPermissions(0);

export const regearmeCommand = new SlashCommandBuilder()
  .setName("regearme")
  .setDescription("Submit a re-gear request.")
  .setDefaultMemberPermissions(0);

export async function handleRegearCommand(
  interaction: ChatInputCommandInteraction,
  repository: RegearRepository,
  service: RegearService,
  entries?: EntryPanelContext
): Promise<void> {
  if (!interaction.inCachedGuild()) return replyServerOnly(interaction);
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (group === "content") {
    await handleContentCommand(interaction, repository, subcommand, entries);
    return;
  }
  if (subcommand === "report") {
    await handleReportCommand(interaction, repository);
    return;
  }
  if (subcommand === "view") {
    await handleViewCommand(interaction, repository, service);
    return;
  }
  if (subcommand === "accept") {
    const rawAmount = interaction.options.getString("amount");
    const amount = rawAmount === null ? undefined : parseWholeSilver(rawAmount);
    if (rawAmount !== null && amount === undefined) {
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Invalid Amount", amountValidationMessage(), INVALID_COLOR)));
      return;
    }
    await resolveAcceptedClaim(interaction, repository, service, interaction.options.getString("claim", true), amount, interaction.options.getString("reason")?.trim());
    return;
  }
  if (subcommand === "reject") {
    await resolveRejectedClaim(interaction, repository, service, interaction.options.getString("claim", true), interaction.options.getString("reason")?.trim());
  }
}

export async function handleRegearsCommand(
  interaction: ChatInputCommandInteraction,
  repository: RegearRepository
): Promise<void> {
  if (!interaction.inGuild()) return replyServerOnly(interaction);
  await sendRegearHistory(interaction, repository, 0);
}

export async function handleRegearmeCommand(
  interaction: ChatInputCommandInteraction,
  repository: RegearRepository
): Promise<void> {
  if (!interaction.inCachedGuild()) return replyServerOnly(interaction);
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR)));
}

export async function handleRegearAutocomplete(
  interaction: AutocompleteInteraction,
  repository: RegearRepository
): Promise<boolean> {
  if (interaction.commandName !== "regear") return false;
  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    const query = normalizeQuery(focused.value);
    await interaction.respond(ALBION_SERVER_VALUES
      .filter((server) => `${server} ${getAlbionServerLabel(server)}`.toLocaleLowerCase().includes(query))
      .map((server) => ({ name: getAlbionServerLabel(server), value: server })));
    return true;
  }
  if (interaction.commandName !== "regear" || !interaction.guildId) return false;
  if (focused.name === "date") {
    await interaction.respond(buildRegearContentDateChoices(new Date(), String(focused.value)));
    return true;
  }
  const servers = await repository.listEffectiveAdminServers(interaction.guildId, reviewerRoleIds(interaction));
  if (focused.name === "content") {
    const subcommand = interaction.options.getSubcommand(false);
    const requiredState: RegearContentState | undefined = subcommand === "close" ? "open" : subcommand === "reopen" ? "closed" : undefined;
    const contents = (await repository.listContents(interaction.guildId))
      .filter((content) => servers.includes(content.albionServer))
      .filter((content) => !requiredState || content.state === requiredState)
      .filter((content) => contentChoiceLabel(content).toLocaleLowerCase().includes(normalizeQuery(focused.value)))
      .slice(0, 25);
    await interaction.respond(contents.map((content) => ({ name: truncateChoiceName(contentChoiceLabel(content)), value: content.regearContentId })));
    return true;
  }
  if (focused.name === "claim") {
    const subcommand = interaction.options.getSubcommand(false);
    const filters: RegearClaimFilters = subcommand === "accept" || subcommand === "reject" ? { status: "pending" } : { status: "all" };
    const claims = await repository.listClaimsForAdministrator(interaction.guildId, reviewerRoleIds(interaction), filters);
    const multiServer = new Set(claims.map((claim) => claim.albionServer)).size > 1;
    const query = normalizeQuery(focused.value);
    await interaction.respond(claims
      .filter((claim) => claimChoiceLabel(claim, multiServer).toLocaleLowerCase().includes(query))
      .slice(0, 25)
      .map((claim) => ({ name: truncateChoiceName(claimChoiceLabel(claim, multiServer)), value: claim.regearClaimId })));
    return true;
  }
  return false;
}

export async function handleRegearStringSelect(
  interaction: StringSelectMenuInteraction,
  repository: RegearRepository
): Promise<boolean> {
  if (!interaction.customId.startsWith("regear:server:")) return false;
  if (!interaction.inCachedGuild()) return true;
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR)));
  return true;
}

export async function handleRegearButton(
  interaction: ButtonInteraction,
  repository: RegearRepository,
  service: RegearService
): Promise<boolean> {
  if (!interaction.customId.startsWith("regear:")) return false;
  if (!interaction.inCachedGuild()) return true;

  if (interaction.customId.startsWith("regear:submit:")) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR)));
    return true;
  }

  if (interaction.customId.startsWith("regear:history:")) {
    const [, , ownerId, rawPage] = interaction.customId.split(":");
    if (ownerId !== interaction.user.id) {
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Controls Not Yours", "Only the report owner can use these controls.", INVALID_COLOR)));
      return true;
    }
    await updateHistory(interaction, repository, Number.parseInt(rawPage, 10));
    return true;
  }

  // Retire private confirmation controls posted by an older runtime.
  if (/^regear:(confirm|cancel)-withdraw:/.test(interaction.customId)) {
    const [, , , ownerId] = interaction.customId.split(":");
    if (ownerId !== interaction.user.id) return unauthorizedButton(interaction);
    await completeFeedbackPrompt(interaction, {
      cards: [buildRegearStatusEmbed("Re-Gear Controls Expired", "Use Withdraw on the request message to withdraw it.")],
      actionRows: [],
      allowedMentions: { parse: [], repliedUser: false }
    });
    return true;
  }

  const actionMatch = /^regear:(withdraw|accept|reject):(.+)$/.exec(interaction.customId);
  if (!actionMatch) return true;
  const [, action, claimId] = actionMatch;
  const claim = await repository.getClaim(interaction.guildId, claimId);
  if (!claim || claim.status !== "pending") {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Request Unavailable", "That request is missing or has already been resolved.", INVALID_COLOR)));
    return true;
  }
  if (action === "withdraw") {
    if (claim.reviewMessageId !== interaction.message.id || claim.reviewChannelId !== interaction.channelId) {
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Controls Expired", "Use Withdraw on the request message to withdraw it.", INVALID_COLOR)));
      return true;
    }
    if (claim.currentOwnerDiscordUserId !== interaction.user.id) {
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Withdraw Not Allowed", "Only the character's current eligible owner may withdraw this request.", INVALID_COLOR)));
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const removed = await repository.withdrawPendingClaim(interaction.guildId, claimId, interaction.user.id);
      await deleteReviewMessage(interaction.guild, removed);
      await dismissActionReply(interaction);
    } catch (error) {
      await editOperationError(interaction, error);
    }
    return true;
  }
  if (!await repository.isEffectiveAdministrator(interaction.guildId, reviewerRoleIds(interaction))) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Access Required", "You need a configured re-gear manager role or Discord Administrator permission.", INVALID_COLOR)));
    return true;
  }
  if (!await requirePendingEvidence(interaction, service, claim)) return true;
  await interaction.showModal(action === "accept" ? buildAcceptModal(claim, interaction.user.id) : buildRejectModal(claim, interaction.user.id));
  return true;
}

export async function handleRegearModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: RegearRepository,
  service: RegearService
): Promise<boolean> {
  const isClaimModal = interaction.customId.startsWith("rgc:")
    || interaction.customId.startsWith("regear:claim-modal:");
  if (!interaction.customId.startsWith("regear:") && !isClaimModal) return false;
  if (!interaction.inCachedGuild()) return true;
  if (isClaimModal) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR)));
    return true;
  }
  const accepted = /^regear:accept-modal:([^:]+):([^:]+)$/.exec(interaction.customId);
  if (accepted) {
    if (accepted[2] !== interaction.user.id) {
      await unauthorizedModal(interaction);
      return true;
    }
    const amount = parseWholeSilver(interaction.fields.getTextInputValue(MODAL_AMOUNT));
    if (amount === undefined) {
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Invalid Amount", amountValidationMessage(), INVALID_COLOR)));
      return true;
    }
    await resolveAcceptedClaim(interaction, repository, service, accepted[1], amount, interaction.fields.getTextInputValue(MODAL_REASON).trim());
    return true;
  }
  const rejected = /^regear:reject-modal:([^:]+):([^:]+)$/.exec(interaction.customId);
  if (rejected) {
    if (rejected[2] !== interaction.user.id) {
      await unauthorizedModal(interaction);
      return true;
    }
    await resolveRejectedClaim(interaction, repository, service, rejected[1], interaction.fields.getTextInputValue(MODAL_REASON).trim());
    return true;
  }
  return true;
}

async function handleContentCommand(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: RegearRepository,
  subcommand: string,
  entries?: EntryPanelContext
): Promise<void> {
  if (subcommand === "add") {
    const serverValue = interaction.options.getString("server", true);
    if (!isAlbionServer(serverValue)) return replyInvalidServer(interaction);
    const date = parseContentDate(interaction.options.getString("date", true));
    const rawTime = interaction.options.getString("time");
    const contentAt = date && rawTime !== null ? parseUtcContentTime(date, rawTime) : undefined;
    if (!date || (rawTime !== null && !contentAt)) {
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Invalid Content Date Or Time", `Use D/M/YYYY or YYYY-MM-DD for the date. ${UTC_TIME_INPUT_HELP}`, INVALID_COLOR), [], true));
      return;
    }
    const access = await entries?.checkAccess(interaction, "regears", { mutation: true });
    if (!access) {
      if (!entries) await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-gears Channel Not Configured", "Ask a Discord Administrator to configure this feature’s channel.", INVALID_COLOR)));
      return;
    }
    const channel = access.channel;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const created = await entries!.runExclusive(interaction.guildId, async () => {
        if (!await entries!.checkAccess(interaction, "regears", { mutation: true, expected: access })) return false;
        await repository.createContent({
          discordGuildId: interaction.guildId,
          albionServer: serverValue,
          name: interaction.options.getString("name", true).trim(),
          contentDate: contentAt?.toISOString().slice(0, 10) ?? date,
          contentAt,
          channelId: channel.id,
          actorDiscordUserId: interaction.user.id,
          actorDiscordRoleIds: reviewerRoleIds(interaction)
        });
        return true;
      });
      if (!created) return;
      await entries!.refresh(interaction.guild);
      await dismissActionReply(interaction);
    } catch (error) {
      await editOperationError(interaction, error);
    }
    return;
  }

  if (subcommand === "list") {
    const serverValue = interaction.options.getString("server");
    if (serverValue && !isAlbionServer(serverValue)) return replyInvalidServer(interaction);
    const rawState = interaction.options.getString("state");
    const state = rawState === "open" || rawState === "closed" ? rawState : undefined;
    const effectiveServers = await repository.listEffectiveAdminServers(interaction.guildId, reviewerRoleIds(interaction));
    const contents = (await repository.listContents(interaction.guildId, serverValue && isAlbionServer(serverValue) ? serverValue : undefined, state))
      .filter((content) => effectiveServers.includes(content.albionServer));
    const lines = contents.map((content) => `**${sanitizeUserText(content.name)}** • ${formatAustralianShortDate(content.contentDate)} • ${getAlbionServerLabel(content.albionServer)} • ${capitalize(content.state)}`);
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Content", lines.join("\n") || "No accessible re-gear content records were found.", REPORT_COLOR), [], lines.length > 0));
    return;
  }

  if (subcommand !== "close" && subcommand !== "reopen") {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Start Again", "This control is no longer current. Open the latest entry panel and start again.", INVALID_COLOR)));
    return;
  }
  const contentId = interaction.options.getString("content", true);
  const content = await repository.getContent(interaction.guildId, contentId);
  if (!content || !await repository.isEffectiveAdministrator(interaction.guildId, reviewerRoleIds(interaction))) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Content Not Found", "Choose accessible re-gear content from autocomplete.", INVALID_COLOR)));
    return;
  }
  const access = subcommand === "reopen" ? await entries?.checkAccess(interaction, "regears", { mutation: true }) : undefined;
  if (subcommand === "reopen" && !access) {
    if (!entries) await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-gears Channel Not Configured", "Ask a Discord Administrator to configure this feature’s channel.", INVALID_COLOR)));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const update = async () => {
      if (subcommand === "reopen" && !await entries!.checkAccess(interaction, "regears", { mutation: true, expected: access })) return false;
      const updated = subcommand === "close"
        ? await repository.closeContent(interaction.guildId, contentId, interaction.user.id, reviewerRoleIds(interaction))
        : await repository.reopenContent(interaction.guildId, contentId, interaction.user.id, reviewerRoleIds(interaction));
      await refreshContentAnnouncement(interaction.guild, updated);
      return true;
    };
    if (!await (entries ? entries.runExclusive(interaction.guildId, update) : update())) return;
    if (entries) await entries.refresh(interaction.guild);
    await dismissActionReply(interaction);
  } catch (error) {
    await editOperationError(interaction, error);
  }
}

async function handleReportCommand(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: RegearRepository
): Promise<void> {
  const serverValue = interaction.options.getString("server");
  if (serverValue && !isAlbionServer(serverValue)) return replyInvalidServer(interaction);
  const status = interaction.options.getString("status") as RegearClaimFilters["status"] ?? "pending";
  const claims = await repository.listClaimsForAdministrator(interaction.guildId, reviewerRoleIds(interaction), {
    contentId: interaction.options.getString("content") ?? undefined,
    ownerDiscordUserId: interaction.options.getUser("user")?.id,
    status,
    albionServer: serverValue && isAlbionServer(serverValue) ? serverValue : undefined
  });
  const pending = claims.filter((claim) => claim.status === "pending");
  const accepted = claims.filter((claim) => claim.status === "accepted");
  const summary = [
    `Pending requested value: ${formatSilver(pending.reduce((sum, claim) => sum + claim.requestedValue, 0n))} (${pending.length})`,
    `Accepted value credited: ${formatSilver(accepted.reduce((sum, claim) => sum + (claim.acceptedValue ?? 0n), 0n))} (${accepted.length})`
  ];
  const details = buildReportDetails(claims);
  const body = [...summary, "", details || "No matching re-gear requests were found."].join("\n");
  if (body.length <= 4000) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Report", body, REPORT_COLOR), [], true));
    return;
  }
  await interaction.reply(v2Reply({
    cards: [buildRegearStatusEmbed("Re-Gear Report", summary.join("\n"), REPORT_COLOR)],
    files: [new AttachmentBuilder(Buffer.from(body, "utf8"), { name: "regear-report.txt" })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [], repliedUser: false }
  }));
}

async function handleViewCommand(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: RegearRepository,
  service: RegearService
): Promise<void> {
  const claim = await requireAccessibleClaim(interaction, repository, interaction.options.getString("claim", true));
  if (!claim) return;
  let messageUrl: string | undefined;
  if (claim.status === "pending") {
    const message = await service.reconcilePendingClaim(interaction.guild, claim);
    if (!message) {
      const retained = await repository.getClaim(interaction.guildId, claim.regearClaimId);
      await interaction.reply(ephemeralResponse(buildRegearStatusEmbed(retained ? "Review Evidence Unavailable" : "Review Evidence Missing", retained ? "Guild Manager could not verify the review evidence. The Pending request was retained; try again when the review channel is available." : "The invalid Pending request was removed and its owner was notified.", INVALID_COLOR)));
      return;
    }
    messageUrl = message.url;
  } else {
    const outcome = await service.repairAcceptedOutcome(interaction.guild, claim);
    messageUrl = outcome?.url;
  }
  const amount = claim.status === "accepted"
    ? `${formatSilver(claim.acceptedValue ?? claim.requestedValue)} • Accepted value credited`
    : `${formatSilver(claim.requestedValue)} • Pending requested value`;
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed(
    `Re-Gear • ${capitalize(claim.status)}`,
    [
      `${sanitizeUserText(claim.characterName)} • ${getAlbionServerLabel(claim.albionServer)}`,
      `${sanitizeUserText(claim.contentName)} • ${formatLongDate(claim.contentDate)}`,
      amount,
      claim.currentOwnerDiscordUserId ? `Current owner: <@${claim.currentOwnerDiscordUserId}>` : "Current owner: None",
      messageUrl ?? "Outcome presentation is unavailable and can be repaired after channel permissions are restored."
    ].join("\n"),
    claim.status === "accepted" ? SUCCESS_COLOR : INFO_COLOR
  ), claim.currentOwnerDiscordUserId ? [claim.currentOwnerDiscordUserId] : []));
}

export async function submitRegearRequest(
  interaction: ModalSubmitInteraction<"cached">,
  repository: RegearRepository,
  selection: { server: AlbionServer; contentId: string; characterId: string },
  channel: SendableChannels,
  beforeCommit?: () => Promise<boolean>
): Promise<void> {
  const { server, contentId, characterId } = selection;
  const amount = parseWholeSilver(interaction.fields.getTextInputValue(MODAL_AMOUNT));
  const evidence1 = [...interaction.fields.getUploadedFiles(MODAL_EVIDENCE_1, true).values()];
  const evidence2 = [...interaction.fields.getUploadedFiles(MODAL_EVIDENCE_2, true).values()];
  if (amount === undefined) {
    await replySubmissionEmbed(interaction, buildRegearStatusEmbed("Invalid Amount", amountValidationMessage(), INVALID_COLOR));
    return;
  }
  if (!validEvidence(evidence1) || !validEvidence(evidence2)) {
    await replySubmissionEmbed(interaction, buildRegearStatusEmbed("Invalid Review Evidence", "Upload exactly one image in each Evidence field.", INVALID_COLOR));
    return;
  }
  const [content, characters] = await Promise.all([
    repository.getContent(interaction.guildId, contentId),
    repository.listEligibleCharactersForUser(interaction.guildId, interaction.user.id, server)
  ]);
  const character = characters.find((candidate) => candidate.albionCharacterId === characterId);
  if (!content || content.albionServer !== server || content.state !== "open") {
    await replySubmissionEmbed(interaction, buildRegearStatusEmbed("Content Closed", "That content is no longer open for re-gear requests. Choose another content item.", INVALID_COLOR));
    return;
  }
  if (!character) {
    await replySubmissionEmbed(interaction, buildRegearStatusEmbed("Character No Longer Eligible", "The selected character must still be registered to you with active member-group membership on this server.", INVALID_COLOR));
    return;
  }
  if (beforeCommit && !await beforeCommit()) return;
  if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reviewerRoleIds = await repository.listReviewerRoleIds(interaction.guildId);
  const claimId = randomUUID();
  const names: [string, string] = [evidenceName(1, evidence1[0]), evidenceName(2, evidence2[0])];
  const draft = draftClaim(claimId, content, character, interaction.user.id, amount, channel.id);
  let review;
  try {
    if (beforeCommit && !await beforeCommit()) return;
    review = await channel.send({
      ...buildPendingRegearReview(draft, [`attachment://${names[0]}`, `attachment://${names[1]}`], true, reviewerRoleIds),
      files: [
        new AttachmentBuilder(evidence1[0].url, { name: names[0] }),
        new AttachmentBuilder(evidence2[0].url, { name: names[1] })
      ]
    });
  } catch (error) {
    await editFeedback(interaction, {
      cards: [buildRegearStatusEmbed(
        "Review Evidence Not Uploaded",
        isOversizedUploadError(error)
          ? "One or both images are too large for Guild Manager to re-upload. Reduce their file size and submit again."
          : "Guild Manager could not re-upload the two images to the review channel. Check channel permissions and try again.",
        INVALID_COLOR
      )]
    }, "context");
    return;
  }
  try {
    let evidence = inspectPendingRegearEvidence(review);
    if (!evidence && "messages" in channel) {
      const hydrated = await channel.messages.fetch(review.id).catch(() => undefined);
      if (hydrated) evidence = inspectPendingRegearEvidence(hydrated);
    }
    if (!evidence) {
      await review.delete().catch(() => undefined);
      await editFeedback(interaction, {
        cards: [buildRegearStatusEmbed(
          "Review Evidence Not Confirmed",
          "Guild Manager could not confirm both re-uploaded review images. No re-gear request was created; submit it again.",
          INVALID_COLOR
        )]
      }, "context");
      return;
    }
    if (beforeCommit && !await beforeCommit()) {
      await review.delete().catch(() => undefined);
      return;
    }
    const claim = await repository.createPendingClaim({
      regearClaimId: claimId,
      discordGuildId: interaction.guildId,
      regearContentId: content.regearContentId,
      albionServer: server,
      albionCharacterId: character.albionCharacterId,
      expectedOwnerDiscordUserId: interaction.user.id,
      requestedValue: amount,
      reviewChannelId: channel.id,
      reviewMessageId: review.id
    });
    await review.edit(buildPendingRegearReviewEdit(claim, evidence, false, reviewerRoleIds));
    await editFeedback(interaction, {
      cards: [buildRegearStatusEmbed("Re-gear Request Submitted", `Your re-gear request has been submitted. [View Request](${discordMessageUrl(interaction.guildId, channel.id, review.id)}).`, SUCCESS_COLOR)],
      allowedMentions: { parse: [], repliedUser: false }
    }).catch(() => undefined);
  } catch (error) {
    await repository.removePendingClaim(interaction.guildId, claimId).catch(() => undefined);
    await review.delete().catch(() => undefined);
    await editOperationError(interaction, error);
  }
}

async function replySubmissionEmbed(interaction: ModalSubmitInteraction, embed: EmbedBuilder) {
  if (interaction.deferred) await editFeedback(interaction, { cards: [embed], actionRows: [], allowedMentions: { parse: [], repliedUser: false } });
  else await interaction.reply(ephemeralResponse(embed));
}

async function resolveAcceptedClaim(
  interaction: ChatInputCommandInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  repository: RegearRepository,
  service: RegearService,
  claimId: string,
  amount?: bigint,
  reason?: string
): Promise<void> {
  const claim = await requireAccessibleClaim(interaction, repository, claimId);
  if (!claim) return;
  if (claim.status !== "pending") {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Already Accepted", "This request has already been accepted and credited.", INVALID_COLOR)));
    return;
  }
  if (!await requirePendingEvidence(interaction, service, claim)) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await repository.acceptPendingClaim(interaction.guildId, claimId, interaction.user.id, reviewerRoleIds(interaction), amount, reason);
    const outcome = await service.repairAcceptedOutcome(interaction.guild, result.claim);
    if (!outcome) {
      await interaction.editReply(v2Edit({
        cards: [buildRegearStatusEmbed(
          "Re-Gear Accepted; Outcome Missing",
          `${formatSilver(result.claim.acceptedValue ?? result.claim.requestedValue)} was credited to ${sanitizeUserText(result.claim.characterName)}'s account. The Accepted outcome can be rebuilt with \`/regear view\` after channel permissions are restored.`,
          INVALID_COLOR
        )],
        allowedMentions: { parse: [], repliedUser: false }
      }));
      return;
    }
    await dismissActionReply(interaction);
  } catch (error) {
    await editOperationError(interaction, error);
  }
}

async function resolveRejectedClaim(
  interaction: ChatInputCommandInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  repository: RegearRepository,
  service: RegearService,
  claimId: string,
  reason?: string
): Promise<void> {
  const claim = await requireAccessibleClaim(interaction, repository, claimId);
  if (!claim) return;
  if (claim.status !== "pending") {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Request Unavailable", "That request has already been resolved.", INVALID_COLOR)));
    return;
  }
  if (!await requirePendingEvidence(interaction, service, claim)) return;
  const channel = await fetchSendableChannel(interaction.guild, claim.reviewChannelId);
  if (!channel) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Outcome Channel Unavailable", "The rejection was not recorded because Guild Manager cannot post the Rejected outcome.", INVALID_COLOR)));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const current = await repository.getClaim(interaction.guildId, claimId) ?? claim;
  const outcome = await channel.send(buildRejectedRegearOutcome(current, interaction.user.id, reason));
  try {
    const removed = await repository.rejectPendingClaim(interaction.guildId, claimId, interaction.user.id, reviewerRoleIds(interaction));
    await deleteReviewMessage(interaction.guild, removed);
    await dismissActionReply(interaction);
  } catch (error) {
    await outcome.delete().catch(() => undefined);
    await editOperationError(interaction, error);
  }
}

async function requirePendingEvidence(
  interaction: ChatInputCommandInteraction<"cached"> | ModalSubmitInteraction<"cached"> | ButtonInteraction<"cached">,
  service: RegearService,
  claim: RegearClaim
): Promise<boolean> {
  const fetched = await service.fetchPendingReviewMessage(interaction.guild, claim);
  if (fetched.state === "valid") return true;
  if (fetched.state === "missing") {
    await service.removeMissingEvidence(interaction.guild, claim);
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Review Evidence Missing", "The invalid Pending request was removed and cannot be accepted or rejected.", INVALID_COLOR)));
  } else {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Review Evidence Unavailable", "Guild Manager could not verify the review evidence. The Pending request was retained; try again when the review channel is available.", INVALID_COLOR)));
  }
  return false;
}

async function requireAccessibleClaim(
  interaction: ChatInputCommandInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  repository: RegearRepository,
  claimId: string
): Promise<RegearClaim | undefined> {
  const claim = await repository.getClaim(interaction.guildId, claimId);
  if (!claim || !await repository.isEffectiveAdministrator(interaction.guildId, reviewerRoleIds(interaction))) {
    await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Re-Gear Request Not Found", "Choose an accessible request from autocomplete.", INVALID_COLOR)));
    return undefined;
  }
  return claim;
}

export async function sendRegearHistory(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  repository: RegearRepository,
  page: number
): Promise<void> {
  const claims = await repository.listClaimsForOwner(interaction.guildId!, interaction.user.id);
  const pageCount = Math.max(1, Math.ceil(claims.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const payload = {
    cards: [buildRegearHistoryEmbed(claims.slice(safePage * HISTORY_PAGE_SIZE, (safePage + 1) * HISTORY_PAGE_SIZE), safePage, pageCount)],
    actionRows: historyButtons(interaction.user.id, safePage, pageCount),
    allowedMentions: { parse: [] as never[], repliedUser: false }
  };
  if (interaction.deferred) await interaction.editReply(v2Edit(payload));
  else await interaction.reply(v2Reply({ ...payload, flags: MessageFlags.Ephemeral }));
}

async function updateHistory(
  interaction: ButtonInteraction<"cached">,
  repository: RegearRepository,
  page: number
): Promise<void> {
  const claims = await repository.listClaimsForOwner(interaction.guildId, interaction.user.id);
  const pageCount = Math.max(1, Math.ceil(claims.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(Number.isFinite(page) ? page : 0, 0), pageCount - 1);
  await interaction.update(v2Edit({
    cards: [buildRegearHistoryEmbed(claims.slice(safePage * HISTORY_PAGE_SIZE, (safePage + 1) * HISTORY_PAGE_SIZE), safePage, pageCount)],
    actionRows: historyButtons(interaction.user.id, safePage, pageCount),
    allowedMentions: { parse: [], repliedUser: false }
  }));
}

function historyButtons(userId: string, page: number, pageCount: number): ActionRowBuilder<ButtonBuilder>[] {
  if (pageCount <= 1) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`regear:history:${userId}:${page - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`regear:history:${userId}:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1)
  )];
}

/** Maps Discord's current member state into the persisted reviewer-role check. */
function reviewerRoleIds(interaction: any): string[] {
  const roles = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : Array.isArray(interaction.member?.roles) ? [...interaction.member.roles] : [];
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) roles.push("__guild_manager_discord_administrator__");
  return roles;
}

export async function submissionOptions(
  repository: RegearRepository,
  discordGuildId: string,
  discordUserId: string,
  onlyServer?: AlbionServer
) {
  const characters = await repository.listEligibleCharactersForUser(discordGuildId, discordUserId, onlyServer);
  const characterServers = new Set(characters.map((character) => character.albionServer));
  const contents = (await repository.listContents(discordGuildId, onlyServer, "open"))
    .filter((content) => characterServers.has(content.albionServer));
  const contentServers = new Set(contents.map((content) => content.albionServer));
  const servers = ALBION_SERVER_VALUES.filter((server) => characterServers.has(server) && contentServers.has(server));
  return { characters, contents, servers };
}

function buildAcceptModal(claim: RegearClaim, reviewerId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`regear:accept-modal:${claim.regearClaimId}:${reviewerId}`)
    .setTitle("Accept Re-Gear")
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${sanitizeUserText(claim.characterName)} • ${sanitizeUserText(claim.contentName)}**\nRequested: ${formatSilver(claim.requestedValue)}`
    ))
    .addLabelComponents(
      new LabelBuilder().setLabel("Accepted Amount").setDescription("Prefilled with the requested amount.").setTextInputComponent(
        new TextInputBuilder().setCustomId(MODAL_AMOUNT).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30).setValue(formatSilver(claim.requestedValue))
      ),
      new LabelBuilder().setLabel("Reason").setDescription("Required when the accepted amount differs.").setTextInputComponent(
        new TextInputBuilder().setCustomId(MODAL_REASON).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(REASON_MAX_LENGTH)
      )
    );
}

function buildRejectModal(claim: RegearClaim, reviewerId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`regear:reject-modal:${claim.regearClaimId}:${reviewerId}`)
    .setTitle("Reject Re-Gear")
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${sanitizeUserText(claim.characterName)} • ${sanitizeUserText(claim.contentName)}**\nRequested: ${formatSilver(claim.requestedValue)}`
    ))
    .addLabelComponents(
      new LabelBuilder().setLabel("Reason").setDescription("Optional concise reason.").setTextInputComponent(
        new TextInputBuilder().setCustomId(MODAL_REASON).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(REASON_MAX_LENGTH)
      )
    );
}

function draftClaim(
  id: string,
  content: RegearContent,
  character: EligibleRegearCharacter,
  userId: string,
  requestedValue: bigint,
  reviewChannelId: string
): RegearClaim {
  const now = new Date();
  return {
    regearClaimId: id,
    discordGuildId: content.discordGuildId,
    regearContentId: content.regearContentId,
    albionServer: content.albionServer,
    albionCharacterId: character.albionCharacterId,
    characterName: character.characterName,
    currentOwnerDiscordUserId: userId,
    originalSubmitterDiscordUserId: userId,
    requestedValue,
    status: "pending",
    reviewChannelId,
    reviewMessageId: "staging",
    submittedAt: now,
    updatedAt: now,
    contentName: content.name,
    contentDate: content.contentDate,
    contentAt: content.contentAt,
    contentState: content.state,
    contentChannelId: content.channelId
  };
}

function buildReportDetails(claims: RegearClaim[]): string {
  const byContent = new Map<string, RegearClaim[]>();
  for (const claim of claims) {
    const key = `${claim.regearContentId}:${claim.albionServer}`;
    const existing = byContent.get(key) ?? [];
    existing.push(claim);
    byContent.set(key, existing);
  }
  return [...byContent.values()].map((contentClaims) => {
    const first = contentClaims[0];
    const rows = contentClaims.map((claim) => {
      const owner = claim.currentOwnerDiscordUserId ? `<@${claim.currentOwnerDiscordUserId}>` : "No current owner";
      const amount = claim.status === "accepted" ? claim.acceptedValue ?? claim.requestedValue : claim.requestedValue;
      const language = claim.status === "accepted" ? "Accepted value credited" : "Pending requested value";
      const channelId = claim.status === "accepted" ? claim.outcomeChannelId : claim.reviewChannelId;
      const messageId = claim.status === "accepted" ? claim.outcomeMessageId : claim.reviewMessageId;
      const link = channelId && messageId ? ` • ${discordMessageUrl(claim.discordGuildId, channelId, messageId)}` : "";
      return `  ${owner} • ${sanitizeUserText(claim.characterName)} • ${language}: ${formatSilver(amount)}${link}`;
    });
    return `${sanitizeUserText(first.contentName)} • ${formatAustralianShortDate(first.contentDate)} • ${getAlbionServerLabel(first.albionServer)}\n${rows.join("\n")}`;
  }).join("\n\n");
}

function contentChoiceLabel(content: RegearContent): string {
  return `${content.name} • ${formatAustralianShortDate(content.contentDate)} • ${getAlbionServerLabel(content.albionServer)} • ${capitalize(content.state)}`;
}

function claimChoiceLabel(claim: RegearClaim, includeServer: boolean): string {
  const amount = claim.status === "accepted" ? claim.acceptedValue ?? claim.requestedValue : claim.requestedValue;
  return `${claim.characterName} • ${claim.contentName} ${formatAustralianShortDate(claim.contentDate)} • ${formatSilver(amount)} • ${capitalize(claim.status)}${includeServer ? ` • ${getAlbionServerLabel(claim.albionServer)}` : ""}`;
}

export function parseWholeSilver(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!/^\d(?:[\d ,]*\d)?$/.test(trimmed) && !/^\d$/.test(trimmed)) return undefined;
  const normalized = trimmed.replaceAll(",", "").replaceAll(" ", "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const amount = BigInt(normalized);
  return amount > 0n && amount <= MAX_BIGINT ? amount : undefined;
}

export function parseContentDate(value: string): string | undefined {
  const trimmed = value.trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else if (au) {
    day = Number(au[1]); month = Number(au[2]); year = Number(au[3]);
  } else return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

export function buildRegearContentDateChoices(
  now = new Date(),
  query = ""
): Array<{ name: string; value: string }> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return Array.from({ length: 15 }, (_, index) => {
    const date = new Date(today + (index - 7) * 86_400_000);
    const value = date.toISOString().slice(0, 10);
    return {
      name: formatLongDateWithWeekday(value),
      value
    };
  }).filter((choice) => choice.name.toLocaleLowerCase().includes(normalizedQuery) || choice.value.includes(normalizedQuery));
}

export function parseUtcContentTime(contentDate: string, value: string): Date | undefined {
  return parseUtcDateTime(contentDate, value);
}

function validEvidence(files: Attachment[]): files is [Attachment] {
  return files.length === 1 && Boolean(files[0].contentType?.toLocaleLowerCase().startsWith("image/"));
}

function evidenceName(index: 1 | 2, attachment: Attachment): string {
  const extension = attachment.contentType?.includes("png") ? ".png"
    : attachment.contentType?.includes("gif") ? ".gif"
      : attachment.contentType?.includes("webp") ? ".webp"
        : ".jpg";
  return `regear-evidence-${index}${extension}`;
}

function amountValidationMessage(): string {
  return "Enter a positive whole-silver value using digits with optional commas or spaces. Signs, decimals, exponent notation, abbreviations, zero, and overflow are not accepted.";
}

function isOversizedUploadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "40005" || code === "50045";
}

async function refreshContentAnnouncement(guild: ChatInputCommandInteraction<"cached">["guild"], content: RegearContent): Promise<boolean> {
  if (!content.announcementMessageId) return false;
  const message = await fetchMessage(guild, content.channelId, content.announcementMessageId);
  if (!message) return false;
  await message.edit(buildRegearContentAnnouncement(content));
  return true;
}

async function fetchMessage(guild: ChatInputCommandInteraction<"cached">["guild"], channelId: string, messageId: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => undefined);
  if (!channel?.isTextBased() || !("messages" in channel)) return undefined;
  return channel.messages.fetch(messageId).catch(() => undefined);
}

async function fetchSendableChannel(guild: ChatInputCommandInteraction<"cached">["guild"], channelId: string): Promise<SendableChannels | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => undefined);
  return channel?.isSendable() ? channel : undefined;
}

async function deleteReviewMessage(guild: ChatInputCommandInteraction<"cached">["guild"], claim: RegearClaim): Promise<void> {
  const message = await fetchMessage(guild, claim.reviewChannelId, claim.reviewMessageId);
  await message?.delete().catch(() => undefined);
}

function ephemeralResponse(embed: EmbedBuilder, allowedUserIds: string[] = [], structured = false) {
  return feedbackReply({
    structured,
    cards: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: allowedUserIds.length > 0
      ? { parse: [] as never[], users: allowedUserIds, repliedUser: false }
      : { parse: [] as never[], repliedUser: false }
  });
}

async function replyServerOnly(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Server Only", "This command can only be used in a Discord server.", INVALID_COLOR)));
}

async function replyInvalidServer(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Invalid Albion Online Server", `Choose an Albion Online server: ${ALBION_SERVER_VALUES.map(getAlbionServerLabel).join(", ")}.`, INVALID_COLOR)));
}

async function unauthorizedButton(interaction: ButtonInteraction): Promise<true> {
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Controls Not Yours", "Only the person who started this action can use these controls.", INVALID_COLOR)));
  return true;
}

async function unauthorizedModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.reply(ephemeralResponse(buildRegearStatusEmbed("Submission Not Allowed", "This re-gear form belongs to another user or is no longer valid.", INVALID_COLOR)));
}

async function dismissActionReply(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction
): Promise<void> {
  // Only the private deferred reply is removed. Cleanup failure must not undo a completed action.
  await interaction.deleteReply().catch(() => undefined);
}

async function editOperationError(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction,
  error: unknown
): Promise<void> {
  if (!(error instanceof RegearOperationError)) throw error;
  const [title, message] = operationErrorText(error);
  await editFeedback(interaction, { cards: [buildRegearStatusEmbed(title, message, INVALID_COLOR)], actionRows: [], allowedMentions: { parse: [], repliedUser: false } }, "context");
}

function operationErrorText(error: RegearOperationError): [string, string] {
  const messages: Record<RegearOperationError["code"], [string, string]> = {
    admin_ineligible: ["Re-Gear Access Required", "You need a configured re-gear manager role or Discord Administrator permission."],
    content_limit: ["Open Re-Gear Content Limit Reached", "This server already has 25 Open re-gear content records. Close older content before opening or reopening another."],
    content_not_found: ["Re-Gear Content Not Found", "Choose accessible re-gear content from autocomplete."],
    content_closed: ["Content Closed", "That content is no longer open for re-gear requests. Choose another content item."],
    claim_not_found: ["Re-Gear Request Not Found", "The request is missing or no longer available."],
    claim_resolved: ["Re-Gear Request Resolved", "The request has already been resolved."],
    character_ineligible: ["Character Not Eligible", "The exact character must have a current registration and active member-group profile on the content server."],
    owner_changed: ["Character Owner Changed", "The character owner changed after this form opened. Start the submission again as the current eligible owner."],
    not_owner: ["Withdraw Not Allowed", "Only the character's current eligible owner may withdraw this request."],
    reason_required: ["Adjustment Reason Required", "Enter a reason when the accepted amount differs from the requested amount."],
    invalid_amount: ["Invalid Amount", amountValidationMessage()],
    account_not_found: ["Character Account Missing", "The character account must be reconciled before this request can be accepted."],
    account_frozen: ["Character Account Frozen", "Unfreeze the character account before accepting this request."],
    account_closed: ["Character Account Closed", "Restore the character's account eligibility before accepting this request."]
  };
  return messages[error.code];
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}
