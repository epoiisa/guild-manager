import { withSpecialisationPresentation } from "../services/specialisations/ownership.js";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type Role,
  type SendableChannels
} from "discord.js";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import type { ReviewerRepository } from "../db/reviewerRepository.js";
import {
  SpecialisationOperationError,
  type CharacterSpecialisation,
  type EligibleSpecialisationCharacter,
  type SpecialisationRequest,
  type createSpecialisationRepository
} from "../db/specialisationRepository.js";
import { feedbackEdit, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit, v2Reply } from "../discord/operationalMessages.js";
import type { Logger } from "../logging/logger.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import type { EntryPanelContext } from "../services/entryPanels/types.js";
import {
  SPECIALISATION_CATALOGUE,
  catalogueByKey,
  catalogueModalValue,
  isLevelValidForKind,
  normalizeCatalogueName,
  parseCatalogueSelection,
  type CatalogueEntry,
  type SpecialisationLevel
} from "../services/specialisations/catalogue.js";
import {
  formatSpecialisationCharacterReference,
  groupRecordsByCurrentCatalogue,
  isReviewerAuthorized,
  parseSpecialisationCharacterReference
} from "../services/specialisations/domain.js";
import {
  NO_REVIEWER_NOTICE,
  SPECIALISATION_BUTTON_PREFIX,
  buildFinalSpecialisationCard,
  buildPendingSpecialisationCard,
  buildSpecialisationOutcome,
  inspectPendingSpecialisationProof,
  parseSpecialisationButtonId,
  type SpecialisationDecision
} from "../services/specialisations/rendering.js";
import {
  INVALID_COLOR,
  REPORT_COLOR,
  SUCCESS_COLOR,
  WARNING_COLOR
} from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type SpecialisationRepository = ReturnType<typeof createSpecialisationRepository>;

const CATALOGUE_MODAL_ID = "specialisation:catalogue";
const CATALOGUE_FIELD_ID = "enabled-catalogue";
const AUTHORIZATION_ERROR = "You need a configured weapon specialisation manager role or Discord Administrator permission to use this action.";
const PROOF_MISSING_ERROR = "The review card or its image is missing. Confirm is blocked, but the request can still be dismissed.";
const REPORT_DESCRIPTION_LIMIT = 3_800;
const REPORT_ATTACHMENT_THRESHOLD = 50_000;

export const weaponCommand = new SlashCommandBuilder()
  .setName("weapon")
  .setDescription("Submit weapon specialisation proof.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) => subcommand
    .setName("100")
    .setDescription("Submit a weapon at level 100.")
    .addStringOption((option) => option.setName("character").setDescription("Your managed character.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("weapon").setDescription("Enabled weapon.").setRequired(true).setAutocomplete(true))
    .addAttachmentOption((option) => option.setName("screenshot").setDescription("Proof screenshot.").setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("800")
    .setDescription("Submit a weapon tree at level 800.")
    .addStringOption((option) => option.setName("character").setDescription("Your managed character.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("tree").setDescription("Enabled weapon tree.").setRequired(true).setAutocomplete(true))
    .addAttachmentOption((option) => option.setName("screenshot").setDescription("Proof screenshot.").setRequired(true)));

export const weaponsCommand = new SlashCommandBuilder()
  .setName("weapons")
  .setDescription("Show your weapon specialisations.")
  .setDefaultMemberPermissions(0);

export const specialisationCommand = new SlashCommandBuilder()
  .setName("specialisation")
  .setDescription("Review and manage weapon specialisations.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) => subcommand.setName("requests").setDescription("List pending requests."))
  .addSubcommand((subcommand) => subcommand
    .setName("review")
    .setDescription("Review a request.")
    .addStringOption((option) => option.setName("request").setDescription("Pending request.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("response").setDescription("Review response.").setRequired(true)
      .addChoices({ name: "Confirm", value: "confirmed" }, { name: "Dismiss", value: "dismissed" })))
  .addSubcommand((subcommand) => subcommand
    .setName("list")
    .setDescription("List confirmed specialisations.")
    .addStringOption((option) => option.setName("character").setDescription("Character.").setAutocomplete(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("add")
    .setDescription("Add a confirmed specialisation.")
    .addStringOption((option) => option.setName("character").setDescription("Character.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("weapon").setDescription("Weapon or tree.").setRequired(true).setAutocomplete(true))
    .addIntegerOption((option) => option.setName("level").setDescription("100 for a weapon or 800 for a tree.").setRequired(true)
      .addChoices({ name: "100", value: 100 }, { name: "800", value: 800 })))
  .addSubcommand((subcommand) => subcommand
    .setName("remove")
    .setDescription("Remove an active specialisation.")
    .addStringOption((option) => option.setName("character").setDescription("Character.").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("specialisation").setDescription("Active weapon or tree.").setRequired(true).setAutocomplete(true)))
  .addSubcommandGroup((group) => group
    .setName("catalogue")
    .setDescription("Manage the enabled catalogue.")
    .addSubcommand((subcommand) => subcommand.setName("reset").setDescription("Review the full catalogue before restoring it."))
    .addSubcommand((subcommand) => subcommand.setName("edit").setDescription("Edit the enabled catalogue.")));

export async function handleWeaponAutocomplete(
  interaction: AutocompleteInteraction,
  _membershipRepository: MembershipRepository,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository
): Promise<boolean> {
  if (!interaction.inCachedGuild() || !["weapon", "specialisation"].includes(interaction.commandName)) return false;
  const focused = interaction.options.getFocused(true);
  const query = normalizeCatalogueName(String(focused.value));

  if (interaction.commandName === "specialisation") {
    const roles = await effectiveReviewerRoleIds(interaction.guild, reviewerRepository);
    if (!reviewerAuthorized(interaction.member, interaction.memberPermissions.has(PermissionFlagsBits.Administrator), roles)) {
      await interaction.respond([]);
      return true;
    }
  }

  const subcommand = interaction.options.getSubcommand();
  const excludedKeys = await repository.exclusionKeys(interaction.guildId);
  if (interaction.commandName === "weapon") {
    if (focused.name === "character") {
      const characters = await repository.listEligibleCharacters(interaction.guildId, interaction.user.id);
      await interaction.respond(characterChoices(characters, query));
      return true;
    }
    const kind = subcommand === "100" ? "weapon" : "tree";
    const reference = parseSpecialisationCharacterReference(interaction.options.getString("character") ?? "");
    if (!reference || !await repository.getEligibleCharacter(
      interaction.guildId,
      interaction.user.id,
      reference.albionServer,
      reference.albionCharacterId
    )) {
      await interaction.respond([]);
      return true;
    }
    const [activeRecords, pendingRequests] = await Promise.all([
      repository.listSpecialisations(interaction.guildId, {
        albionServer: reference.albionServer,
        albionCharacterId: reference.albionCharacterId
      }),
      repository.listRequests(interaction.guildId, {
        state: "pending",
        albionServer: reference.albionServer,
        albionCharacterId: reference.albionCharacterId
      })
    ]);
    const unavailableKeys = unavailableSubmissionTargetKeys(kind, activeRecords, pendingRequests);
    await interaction.respond(catalogueChoices(
      SPECIALISATION_CATALOGUE.filter((entry) =>
        entry.kind === kind
        && !excludedKeys.has(entry.key)
        && !unavailableKeys.has(entry.key)
      ),
      query,
      false
    ));
    return true;
  }

  if (subcommand === "review" && focused.name === "request") {
    const requests = await repository.listRequests(interaction.guildId, { state: "pending" });
    await interaction.respond(requests
      .filter((request) => normalizeCatalogueName(`${request.characterName} ${request.targetDisplayName}`).includes(query))
      .slice(0, 25)
      .map((request) => ({ name: truncateChoice(`${request.characterName} • ${request.targetDisplayName}`), value: request.specialisationRequestId })));
    return true;
  }

  const activeRecords = await repository.listSpecialisations(interaction.guildId);
  if (focused.name === "character") {
    if (subcommand === "add") {
      await interaction.respond(characterChoices(await repository.listEligibleCharacters(interaction.guildId), query));
      return true;
    }
    const records = subcommand === "list"
      ? activeRecords.filter((record) => isCurrentRecord(record, excludedKeys))
      : activeRecords;
    await interaction.respond(recordCharacterChoices(records, query));
    return true;
  }

  if (focused.name === "weapon" && subcommand === "add") {
    const level = interaction.options.getInteger("level");
    const entries = SPECIALISATION_CATALOGUE.filter((entry) =>
      !excludedKeys.has(entry.key)
      && (level === null || isLevelValidForKind(entry.kind, level))
    );
    await interaction.respond(catalogueChoices(entries, query, true));
    return true;
  }

  if (focused.name === "specialisation" && subcommand === "remove") {
    const reference = parseSpecialisationCharacterReference(interaction.options.getString("character") ?? "");
    if (!reference) {
      await interaction.respond([]);
      return true;
    }
    const matches = activeRecords.filter((record) =>
      record.albionServer === reference.albionServer
      && record.albionCharacterId === reference.albionCharacterId
      && normalizeCatalogueName(record.targetDisplayName).includes(query)
    );
    await interaction.respond(uniqueBy(matches, (record) => `${record.targetKey}:${record.level}`)
      .sort((left, right) => (left.targetKind === right.targetKind
        ? compareText(left.targetDisplayName, right.targetDisplayName)
        : left.targetKind === "tree" ? -1 : 1))
      .slice(0, 25)
      .map((record) => ({ name: truncateChoice(`${titleCase(record.targetKind)} • ${record.targetDisplayName}`), value: record.targetKey })));
    return true;
  }

  return false;
}

export async function handleWeaponCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository,
  logger: Logger,
  entries?: EntryPanelContext
): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  if (interaction.commandName === "weapons") {
    await sendWeaponsReport(interaction, membershipRepository, repository);
    return;
  }
  if (interaction.commandName === "weapon") {
    await handleSubmission(interaction, repository, reviewerRepository, logger, entries);
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "requests") {
    if (await requireReviewer(interaction, reviewerRepository)) await handleRequestsReport(interaction, repository);
  } else if (subcommand === "review") {
    const request = await repository.getRequest(interaction.guildId, interaction.options.getString("request", true));
    if (!request) {
      await replyStatus(interaction, "Request Not Found", "Choose a Pending request from autocomplete.", INVALID_COLOR);
      return;
    }
    if (!await requireReviewer(interaction, reviewerRepository)) return;
    const response = interaction.options.getString("response", true);
    if (response !== "confirmed" && response !== "dismissed") {
      await replyStatus(interaction, "Invalid Review Response", "Choose Confirm or Dismiss.", INVALID_COLOR);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const decision: SpecialisationDecision = response;
    const result = await processReview(
      interaction.guild,
      repository,
      interaction.options.getString("request", true),
      decision,
      interaction.user.id,
      logger
    );
    await interaction.editReply(statusEdit(result.title, result.description, result.color));
  } else if (subcommand === "list") {
    await handleReviewerList(interaction, repository, reviewerRepository);
  } else if (subcommand === "add") {
    await handleManualAdd(interaction, repository, reviewerRepository);
  } else if (subcommand === "remove") {
    await handleManualRemove(interaction, repository, reviewerRepository);
  } else if ((subcommand === "reset" || subcommand === "edit") && interaction.options.getSubcommandGroup() === "catalogue") {
    if (await requireReviewer(interaction, reviewerRepository)) {
      await showCatalogueModal(interaction, repository, subcommand === "reset");
    }
  }
}

export async function handleSpecialisationButton(
  interaction: ButtonInteraction,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository,
  logger: Logger,
  isGuildActive: (discordGuildId: string) => Promise<boolean> = async () => true
): Promise<boolean> {
  if (!interaction.customId.startsWith(SPECIALISATION_BUTTON_PREFIX)) return false;
  const parsed = parseSpecialisationButtonId(interaction.customId);
  if (!parsed || !interaction.inCachedGuild()) {
    await interaction.reply(statusMessage("Invalid Request", "This review control is not valid.", INVALID_COLOR));
    return true;
  }
  if (!await isGuildActive(interaction.guildId)) {
    await interaction.reply(statusMessage("Guild Manager Inactive", "Guild Manager is not active on this server.", INVALID_COLOR));
    return true;
  }
  const request = await repository.getRequest(interaction.guildId, parsed.requestId);
  if (!request || request.reviewMessageId !== interaction.message.id) {
    await interaction.reply(statusMessage("Request Not Found", "That review card is not linked to an active request.", INVALID_COLOR));
    return true;
  }
  if (!await requireReviewer(interaction, reviewerRepository)) return true;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await processReview(
    interaction.guild,
    repository,
    parsed.requestId,
    parsed.decision,
    interaction.user.id,
    logger,
    await interaction.message.fetch().catch(() => interaction.message as Message)
  );
  await interaction.editReply(statusEdit(result.title, result.description, result.color));
  return true;
}

export async function handleSpecialisationModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository
): Promise<boolean> {
  if (interaction.customId !== CATALOGUE_MODAL_ID) return false;
  if (!interaction.inCachedGuild()) return true;
  if (!await requireReviewer(interaction, reviewerRepository)) return true;
  const parsed = parseCatalogueSelection(interaction.fields.getTextInputValue(CATALOGUE_FIELD_ID));
  await repository.replaceCatalogueExclusions(interaction.guildId, [...parsed.disabledKeys], interaction.user.id);
  const invalidSummary = parsed.invalidNames.length > 0
    ? `\nDiscarded invalid names (${parsed.invalidNames.length}): ${truncateText(parsed.invalidNames.map((name) => `\`${escapeMarkdown(name)}\``).join(", "), 1_500)}`
    : "";
  await interaction.reply(statusMessage(
    "Specialisation Catalogue Updated",
    `Enabled: ${parsed.enabledKeys.size}\nDisabled: ${parsed.disabledKeys.size}\nDuplicates: ${parsed.duplicateCount}\nDiscarded invalid: ${parsed.invalidNames.length}${invalidSummary}`,
    SUCCESS_COLOR
  ));
  return true;
}

export async function handleSpecialisationMessageDeleted(
  discordGuildId: string,
  messageId: string,
  repository: SpecialisationRepository
): Promise<void> {
  await repository.markReviewMessageDeleted(discordGuildId, messageId);
}

async function handleSubmission(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository,
  logger: Logger,
  entries?: EntryPanelContext
): Promise<void> {
  const access = await entries?.checkAccess(interaction, "specialisation", { mutation: true });
  if (!access) {
    if (!entries) await replyStatus(interaction, "Weapon Specialisation Channel Not Configured", "Ask a Discord Administrator to configure this feature’s channel.", INVALID_COLOR);
    return;
  }
  const kind = interaction.options.getSubcommand() === "100" ? "weapon" : "tree";
  await entries!.runExclusive(interaction.guildId, async () => {
    const current = await entries!.checkAccess(interaction, "specialisation", { mutation: true, expected: access });
    if (!current) return;
    await submitWeaponRequest(interaction, repository, reviewerRepository, logger, {
      kind,
      targetKey: interaction.options.getString(kind, true),
      characterReference: interaction.options.getString("character", true),
      screenshot: interaction.options.getAttachment("screenshot", true)
    }, current.channel, async () => Boolean(await entries!.checkAccess(interaction, "specialisation", { mutation: true, expected: access })));
  });
  await entries!.refresh(interaction.guild);
}

export async function submitWeaponRequest(
  interaction: ChatInputCommandInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository,
  logger: Logger,
  input: { kind: CatalogueEntry["kind"]; targetKey: string; characterReference: string; screenshot: Attachment },
  channel: SendableChannels,
  beforeCommit?: () => Promise<boolean>
): Promise<void> {
  const { kind, screenshot } = input;
  const level: SpecialisationLevel = kind === "weapon" ? 100 : 800;
  const target = catalogueByKey.get(input.targetKey);
  const reference = parseSpecialisationCharacterReference(input.characterReference);
  const excludedKeys = await repository.exclusionKeys(interaction.guildId);
  if (!target || target.kind !== kind || excludedKeys.has(target.key)) {
    await replyStatus(interaction, "Target Not Available", "Choose an enabled target from autocomplete and try again.", INVALID_COLOR);
    return;
  }
  if (!reference) {
    await replyStatus(interaction, "Character Not Available", "Choose one of your actively managed registered characters.", INVALID_COLOR);
    return;
  }
  if (!screenshot.contentType?.toLocaleLowerCase().startsWith("image/")) {
    await replyStatus(interaction, "Image Required", "The screenshot attachment must be an image.", INVALID_COLOR);
    return;
  }
  const character = await repository.getEligibleCharacter(
    interaction.guildId,
    interaction.user.id,
    reference.albionServer,
    reference.albionCharacterId
  );
  if (!character) {
    await replyStatus(interaction, "Character Not Eligible", "Choose one of your actively managed registered characters.", INVALID_COLOR);
    return;
  }

  const reviewerRoleIds = await effectiveReviewerRoleIds(interaction.guild, reviewerRepository);
  const channelCheck = submissionChannelError(interaction.guild, channel, reviewerRoleIds);
  if (channelCheck) {
    await replyStatus(interaction, "Weapon Specialisation Channel Unavailable", "The configured channel is unavailable. Ask a Discord Administrator to check the channel setting.", INVALID_COLOR);
    return;
  }

  if (beforeCommit && !await beforeCommit()) return;
  if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let request: SpecialisationRequest | undefined;
  let card: Message | undefined;
  try {
    request = await repository.reserveRequest({
      discordGuildId: interaction.guildId,
      submittedByDiscordUserId: interaction.user.id,
      albionServer: reference.albionServer,
      albionCharacterId: reference.albionCharacterId,
      target,
      level,
      reviewChannelId: channel.id
    });
    if (beforeCommit && !await beforeCommit()) {
      await repository.deleteUnattachedPendingRequest(interaction.guildId, request.specialisationRequestId);
      return;
    }
    const filename = proofFilename(screenshot.name, screenshot.contentType);
    card = await channel.send({
      ...buildPendingSpecialisationCard(request, `attachment://${filename}`, reviewerRoleIds),
      files: [new AttachmentBuilder(screenshot.url, { name: filename })]
    });
    let proof = inspectPendingSpecialisationProof(card);
    if (!proof && "messages" in channel) {
      const hydrated = await channel.messages.fetch(card.id).catch(() => undefined);
      if (hydrated) {
        card = hydrated;
        proof = inspectPendingSpecialisationProof(hydrated);
      }
    }
    if (!proof) throw new Error("Discord did not retain the uploaded specialisation proof attachment.");
    if (beforeCommit && !await beforeCommit()) {
      await card.delete().catch(() => undefined);
      await repository.deleteUnattachedPendingRequest(interaction.guildId, request.specialisationRequestId);
      return;
    }
    request = await repository.attachReviewMessage(interaction.guildId, request.specialisationRequestId, card.id);
    await interaction.editReply(statusEdit("Specialisation Request Submitted", `Your weapon specialisation request has been submitted. [View Request](https://discord.com/channels/${interaction.guildId}/${channel.id}/${card.id}).`, SUCCESS_COLOR)).catch(() => undefined);
  } catch (error) {
    if (!(error instanceof SpecialisationOperationError)) {
      logger.error("specialisation submission failed", {
        discordGuildId: interaction.guildId,
        specialisationRequestId: request?.specialisationRequestId,
        reviewMessageId: card?.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (request && !request.reviewMessageId) {
      if (card) {
        await card.delete().catch((cleanupError) => logger.warn("specialisation failed card cleanup failed", {
          discordGuildId: interaction.guildId,
          specialisationRequestId: request?.specialisationRequestId,
          reviewMessageId: card?.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }));
      }
      await repository.deleteUnattachedPendingRequest(
        interaction.guildId,
        request.specialisationRequestId
      ).catch((cleanupError) => logger.error("specialisation failed request cleanup failed", {
        discordGuildId: interaction.guildId,
        specialisationRequestId: request?.specialisationRequestId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }));
    }
    const mapped = operationError(error);
    await interaction.editReply(statusEdit(mapped.title, mapped.description, mapped.color));
  }
}

async function processReview(
  guild: Guild,
  repository: SpecialisationRepository,
  requestId: string,
  decision: SpecialisationDecision,
  reviewerId: string,
  logger: Logger,
  knownMessage?: Message
): Promise<{ title: string; description: string; color: number }> {
  return withSpecialisationPresentation(guild.id, requestId, () =>
    processReviewUnlocked(guild, repository, requestId, decision, reviewerId, logger, knownMessage));
}

async function processReviewUnlocked(
  guild: Guild,
  repository: SpecialisationRepository,
  requestId: string,
  decision: SpecialisationDecision,
  reviewerId: string,
  logger: Logger,
  knownMessage?: Message
): Promise<{ title: string; description: string; color: number }> {
  let request = await repository.getRequest(guild.id, requestId);
  if (!request) return { title: "Request Not Found", description: "Choose a Pending request from autocomplete.", color: INVALID_COLOR };
  if (request.state !== "pending") {
    return {
      title: `Request Already ${titleCase(request.state)}`,
      description: `This request was already ${request.state}. No changes were made.`,
      color: request.state === "confirmed" ? SUCCESS_COLOR : INVALID_COLOR
    };
  }

  const fetched = knownMessage
    ? { message: knownMessage, confirmedMissing: false }
    : await fetchReviewMessage(guild, request);
  const message = fetched.message;
  const proof = message ? inspectPendingSpecialisationProof(message) : undefined;
  if (fetched.confirmedMissing && request.reviewMessageId && !request.reviewMessageDeletedAt) {
    await repository.markReviewMessageDeleted(guild.id, request.reviewMessageId).catch(() => undefined);
    request = (await repository.getRequest(guild.id, requestId)) ?? request;
  }
  if (decision === "confirmed" && !proof) {
    return { title: "Proof Missing", description: PROOF_MISSING_ERROR, color: INVALID_COLOR };
  }

  try {
    const result = await repository.decideRequest({
      discordGuildId: guild.id,
      specialisationRequestId: requestId,
      decision,
      reviewerDiscordUserId: reviewerId,
      proofAvailable: Boolean(proof)
    });
    if (!result.changed) {
      return {
        title: `Request Already ${titleCase(result.request.state)}`,
        description: `Another reviewer completed this request first. The retained result is ${titleCase(result.request.state)}.`,
        color: result.request.state === "confirmed" ? SUCCESS_COLOR : INVALID_COLOR
      };
    }
    return await publishReviewOutcome(guild, repository, result.request, decision, logger, message, fetched.confirmedMissing);
  } catch (error) {
    return operationError(error);
  }
}

async function publishReviewOutcome(
  guild: Guild,
  repository: SpecialisationRepository,
  request: SpecialisationRequest,
  decision: SpecialisationDecision,
  logger: Logger,
  message: Message | undefined,
  confirmedMissing: boolean
): Promise<{ title: string; description: string; color: number }> {
  const warning = (description: string) => ({
    title: `Request ${titleCase(decision)}; Presentation Incomplete`,
    description: `The request was ${decision}. ${description}`,
    color: WARNING_COLOR
  });
  if (!message && !confirmedMissing) {
    return warning("Guild Manager could not access the original review card to remove its proof and controls. No result notification was attempted.");
  }
  const retirement = message
    ? await retireDecisionCardWithRetry(message, request, decision, logger)
    : "missing";
  if (retirement === "failed") {
    return warning("The database decision is complete, but Guild Manager could not remove the review card's proof and controls after one retry. No result notification was attempted.");
  }

  // The serialized database decision is the single publication claim. Never
  // retry an outcome send or publish again from an already-decided request.
  try {
    const channel = message?.channel ?? await guild.channels.fetch(request.reviewChannelId);
    if (!channel?.isSendable()) throw new Error("The original specialisation review channel is unavailable.");
    await channel.send(buildSpecialisationOutcome(request, decision));
  } catch (error) {
    logger.error("specialisation outcome delivery not confirmed", {
      discordGuildId: request.discordGuildId,
      specialisationRequestId: request.specialisationRequestId,
      reviewChannelId: request.reviewChannelId,
      decision,
      error: error instanceof Error ? error.message : String(error)
    });
    return warning("Delivery of the new result message could not be confirmed. Any retained review card has no proof or controls. The notification will not be resent automatically.");
  }

  if (message && retirement !== "missing") {
    try {
      await message.delete();
    } catch (error) {
      if (!isConfirmedMissing(error)) {
        logger.warn("specialisation completed review card deletion failed", {
          discordGuildId: request.discordGuildId,
          specialisationRequestId: request.specialisationRequestId,
          reviewMessageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return warning("The new result message was posted, but removal of the original card could not be confirmed. Any retained card has no proof or controls.");
      }
    }
  }
  if (request.reviewMessageId) {
    try {
      await repository.markReviewMessageDeleted(guild.id, request.reviewMessageId);
    } catch (error) {
      logger.warn("specialisation review card deletion state update failed", {
        discordGuildId: request.discordGuildId,
        specialisationRequestId: request.specialisationRequestId,
        reviewMessageId: request.reviewMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return warning("The new result message was posted and the original card is gone, but its removal could not be recorded.");
    }
  }
  return {
    title: `Request ${titleCase(decision)}`,
    description: `The request was ${decision}. The original review card is gone, and a new result message was posted for the submitter.`,
    color: decision === "confirmed" ? SUCCESS_COLOR : INVALID_COLOR
  };
}

async function retireDecisionCardWithRetry(
  message: Message,
  request: SpecialisationRequest,
  decision: SpecialisationDecision,
  logger: Logger
): Promise<"updated" | "missing" | "failed"> {
  const edit = buildFinalSpecialisationCard(request, decision);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await message.edit(edit);
      return "updated";
    } catch (error) {
      if (isConfirmedMissing(error)) return "missing";
      if (attempt === 2) {
        logger.error("specialisation review card update failed", {
          discordGuildId: request.discordGuildId,
          specialisationRequestId: request.specialisationRequestId,
          reviewMessageId: request.reviewMessageId,
          decision,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return "failed";
}

export async function sendWeaponsReport(
  interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached">,
  membershipRepository: MembershipRepository,
  repository: SpecialisationRepository
): Promise<void> {
  const [characters, records, excludedKeys] = await Promise.all([
    membershipRepository.listRegisteredCharacters(interaction.guildId, interaction.user.id),
    repository.listSpecialisationsForOwner(interaction.guildId, interaction.user.id),
    repository.exclusionKeys(interaction.guildId)
  ]);
  const embeds = characters.map((character) => {
    const characterRecords = records.filter((record) =>
      record.albionServer === character.albionServer && record.albionCharacterId === character.albionCharacterId
    );
    const grouped = groupRecordsByCurrentCatalogue(characterRecords, excludedKeys);
    const trees = grouped.current.filter((record) => record.targetKind === "tree").map((record) => `${record.targetDisplayName} • ${record.level}`);
    const weapons = grouped.current.filter((record) => record.targetKind === "weapon").map((record) => `${record.targetDisplayName} • ${record.level}`);
    const outside = grouped.notInCurrentCatalogue.map((record) => `${record.targetKind} • ${record.targetDisplayName} • ${record.level}`);
    return new EmbedBuilder()
      .setColor(REPORT_COLOR)
      .setTitle(`${character.characterName} • ${getAlbionServerLabel(character.albionServer)}`)
      .addFields(
        ...splitField("Trees", trees),
        ...splitField("Weapons", weapons),
        ...(outside.length > 0 ? splitField("Not In Current Catalogue", outside) : [])
      );
  });
  if (embeds.length === 0) {
    await replyStatus(interaction, "Weapon Specialisations", "You have no registered Albion Online characters.", REPORT_COLOR);
    return;
  }
  await replyEmbedPages(interaction, embeds);
}

async function handleRequestsReport(
  interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached">,
  repository: SpecialisationRepository
): Promise<void> {
  if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const requests = await repository.listRequests(interaction.guildId, { state: "pending" });
  if (requests.length === 0) {
    await interaction.editReply(statusEdit("Pending Specialisation Requests", "No pending weapon specialisation requests.", REPORT_COLOR));
    return;
  }
  const fetched = await Promise.all(requests.map((request) => fetchReviewMessage(interaction.guild, request)));
  await Promise.all(requests.map((request, index) => {
    const state = fetched[index];
    return state?.confirmedMissing && request.reviewMessageId && !request.reviewMessageDeletedAt
      ? repository.markReviewMessageDeleted(interaction.guildId, request.reviewMessageId).catch(() => undefined)
      : Promise.resolve(undefined);
  }));
  const missing = fetched.filter((state) => state.confirmedMissing).length;
  const unverified = fetched.filter((state) => !state.message && !state.confirmedMissing).length;
  const lines = requests.map((request, index) => {
    const visible = `${request.characterName} • ${request.targetDisplayName}`;
    return fetched[index]?.message && request.reviewMessageId
      ? `[${escapeMarkdown(visible)}](https://discord.com/channels/${interaction.guildId}/${request.reviewChannelId}/${request.reviewMessageId})`
      : escapeMarkdown(visible);
  });
  const footer = [
    missing > 0 ? `${missing} request${missing === 1 ? " has" : "s have"} a missing review message.` : undefined,
    unverified > 0 ? `${unverified} review message${unverified === 1 ? " could" : "s could"} not be verified.` : undefined
  ].filter(Boolean).join(" ") || undefined;
  await replyLinesReport(interaction, "Pending Specialisation Requests", lines, footer, "specialisation-requests.txt");
}

export async function sendPendingSpecialisationReport(
  interaction: ButtonInteraction<"cached">,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository,
  member: GuildMember
): Promise<void> {
  const roles = await effectiveReviewerRoleIds(interaction.guild, reviewerRepository);
  if (!reviewerAuthorized(member, member.permissions.has(PermissionFlagsBits.Administrator), roles)) {
    await replyStatus(interaction, "Manager Required", "You need a weapon specialisation manager role or Discord Administrator permission to view this queue.", INVALID_COLOR);
    return;
  }
  await handleRequestsReport(interaction, repository);
}

async function handleReviewerList(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository
): Promise<void> {
  const referenceValue = interaction.options.getString("character");
  const reference = referenceValue ? parseSpecialisationCharacterReference(referenceValue) : undefined;
  if (referenceValue && !reference) {
    await replyStatus(interaction, "Character Not Found", "Choose a character from autocomplete.", INVALID_COLOR);
    return;
  }
  if (!await requireReviewer(interaction, reviewerRepository)) return;
  const [records, excludedKeys] = await Promise.all([
    repository.listSpecialisations(interaction.guildId, reference ? {
      albionServer: reference.albionServer,
      albionCharacterId: reference.albionCharacterId
    } : {}),
    repository.exclusionKeys(interaction.guildId)
  ]);
  const current = records.filter((record) => isCurrentRecord(record, excludedKeys));
  const groups = groupByCharacter(current);
  if (current.length === 0) {
    await replyStatus(interaction, "Confirmed Specialisations", "No confirmed weapon specialisations match this selection.", REPORT_COLOR);
    return;
  }
  const lines = [...groups.values()].map((group) => {
    const trees = group.records.filter((record) => record.targetKind === "tree").map((record) => record.targetDisplayName).sort(compareText);
    const weapons = group.records.filter((record) => record.targetKind === "weapon").map((record) => record.targetDisplayName).sort(compareText);
    return `${group.characterName} • ${trees.join(", ") || "None"} • ${weapons.join(", ") || "None"}`;
  });
  await replyLinesReport(interaction, "Confirmed Specialisations", lines, undefined, "specialisation-list.txt");
}

async function handleManualAdd(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository
): Promise<void> {
  const reference = parseSpecialisationCharacterReference(interaction.options.getString("character", true));
  const target = catalogueByKey.get(interaction.options.getString("weapon", true));
  const level = interaction.options.getInteger("level", true);
  const excluded = await repository.exclusionKeys(interaction.guildId);
  if (!reference || !target || excluded.has(target.key) || !isLevelValidForKind(target.kind, level)) {
    await replyStatus(interaction, "Invalid Specialisation", "Choose an enabled target and its matching level from autocomplete.", INVALID_COLOR);
    return;
  }
  if (!await requireReviewer(interaction, reviewerRepository)) return;
  try {
    const record = await repository.addManualSpecialisation({
      discordGuildId: interaction.guildId,
      albionServer: reference.albionServer,
      albionCharacterId: reference.albionCharacterId,
      target,
      level,
      actorDiscordUserId: interaction.user.id
    });
    await replyStatus(interaction, "Specialisation Added", `Added ${record.targetDisplayName} at ${record.level} for ${record.characterName}.`, SUCCESS_COLOR);
  } catch (error) {
    const mapped = operationError(error);
    await replyStatus(interaction, mapped.title, mapped.description, mapped.color);
  }
}

async function handleManualRemove(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: SpecialisationRepository,
  reviewerRepository: ReviewerRepository
): Promise<void> {
  const reference = parseSpecialisationCharacterReference(interaction.options.getString("character", true));
  const targetKey = interaction.options.getString("specialisation", true);
  if (!reference) {
    await replyStatus(interaction, "Invalid Specialisation", "Choose an active record from autocomplete.", INVALID_COLOR);
    return;
  }
  if (!await requireReviewer(interaction, reviewerRepository)) return;
  const records = await repository.listSpecialisations(interaction.guildId, {
    albionServer: reference.albionServer,
    albionCharacterId: reference.albionCharacterId
  });
  const record = records.find((candidate) => candidate.targetKey === targetKey);
  if (!record) {
    await replyStatus(interaction, "Specialisation Not Found", "Choose an active record from autocomplete.", INVALID_COLOR);
    return;
  }
  try {
    const removed = await repository.removeSpecialisation(interaction.guildId, record.characterSpecialisationId, interaction.user.id);
    await replyStatus(interaction, "Specialisation Removed", `Removed ${removed.targetDisplayName} at ${removed.level} for ${removed.characterName}.`, SUCCESS_COLOR);
  } catch (error) {
    const mapped = operationError(error);
    await replyStatus(interaction, mapped.title, mapped.description, mapped.color);
  }
}

async function showCatalogueModal(
  interaction: ChatInputCommandInteraction<"cached">,
  repository: SpecialisationRepository,
  reset: boolean
): Promise<void> {
  const value = catalogueModalValue(reset ? new Set() : await repository.exclusionKeys(interaction.guildId));
  const input = new TextInputBuilder()
    .setCustomId(CATALOGUE_FIELD_ID)
    .setLabel("Enabled names, one per line")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(4_000);
  if (value) input.setValue(value);
  await interaction.showModal(new ModalBuilder()
    .setCustomId(CATALOGUE_MODAL_ID)
    .setTitle(reset ? "Restore Specialisation Catalogue" : "Specialisation Catalogue")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
}

async function fetchReviewMessage(
  guild: Guild,
  request: SpecialisationRequest
): Promise<{ message?: Message; confirmedMissing: boolean }> {
  if (!request.reviewMessageId || request.reviewMessageDeletedAt) return { confirmedMissing: true };
  try {
    const channel = await guild.channels.fetch(request.reviewChannelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return { confirmedMissing: true };
    return { message: await channel.messages.fetch(request.reviewMessageId), confirmedMissing: false };
  } catch (error) {
    return { confirmedMissing: isConfirmedMissing(error) };
  }
}

async function effectiveReviewerRoleIds(guild: Guild, repository: ReviewerRepository): Promise<string[]> {
  const configured = await repository.effectiveRoleIds(guild.id, "specialisation");
  const roles = await Promise.all(configured.map(async (roleId) => guild.roles.cache.get(roleId) ?? guild.roles.fetch(roleId).catch(() => null)));
  return roles.filter((role): role is Role => Boolean(role) && !role!.managed && role!.id !== guild.id).map((role) => role.id).sort();
}

function reviewerAuthorized(member: GuildMember, administrator: boolean, reviewerRoleIds: readonly string[] = []): boolean {
  return isReviewerAuthorized(administrator, new Set(member.roles.cache.keys()), reviewerRoleIds);
}

async function requireReviewer(
  interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  repository: ReviewerRepository
): Promise<boolean> {
  const administrator = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
  const roleIds = await effectiveReviewerRoleIds(interaction.guild, repository);
  if (reviewerAuthorized(interaction.member, administrator, roleIds)) return true;
  await interaction.reply(statusMessage("Manager Access Required", AUTHORIZATION_ERROR, INVALID_COLOR));
  return false;
}

function submissionChannelError(
  guild: Guild,
  channel: SendableChannels,
  reviewerRoleIds: readonly string[]
): string | undefined {
  const botMember = guild.members.me;
  if (!channel || !channel.isSendable() || !("permissionsFor" in channel) || !("messages" in channel) || !botMember) {
    return "Guild Manager cannot post a review card in this channel.";
  }
  const permissions = channel.permissionsFor(botMember);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return "Guild Manager needs View Channel in this channel.";
  const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!permissions.has(sendPermission)) return `Guild Manager needs ${channel.isThread() ? "Send Messages in Threads" : "Send Messages"} in this channel.`;
  if (!permissions.has(PermissionFlagsBits.AttachFiles)) return "Guild Manager needs Attach Files in this channel.";
  if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) return "Guild Manager needs Read Message History in this channel.";
  if (reviewerRoleIds.some((roleId) => !guild.roles.cache.get(roleId)?.mentionable) && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return "Every configured manager role must be mentionable here, or Guild Manager needs Mention Everyone.";
  }
  return undefined;
}

function operationError(error: unknown): { title: string; description: string; color: number } {
  if (!(error instanceof SpecialisationOperationError)) {
    return { title: "Specialisation Not Updated", description: "Guild Manager could not complete that operation. Try again.", color: INVALID_COLOR };
  }
  const messages: Record<SpecialisationOperationError["code"], [string, string]> = {
    active_exists: ["Specialisation Already Confirmed", "That character already has this active specialisation."],
    active_not_found: ["Specialisation Not Found", "That active specialisation no longer exists."],
    character_ineligible: ["Character Not Eligible", "Choose an actively registered, managed character."],
    pending_exists: ["Request Already Pending", "Review the existing Pending request before adding or submitting this specialisation."],
    proof_missing: ["Proof Missing", PROOF_MISSING_ERROR],
    request_not_found: ["Request Not Found", "Choose a Pending request from autocomplete."],
    submitter_ineligible: ["Character Not Eligible", "The character has no current registered owner with an active member-group profile. The request remains Pending during membership recovery and can be dismissed."],
    target_disabled: ["Target Not Available", "That target is no longer enabled. Choose an enabled target from autocomplete and try again."]
  };
  return { title: messages[error.code][0], description: messages[error.code][1], color: INVALID_COLOR };
}

function statusMessage(title: string, description: string, color: number) {
  return feedbackReply({ cards: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [], repliedUser: false } });
}

function statusEdit(title: string, description: string, color: number, actionRows: ActionRowBuilder<ButtonBuilder>[] = []) {
  return feedbackEdit({ structured: color === WARNING_COLOR, cards: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)], actionRows, allowedMentions: { parse: [], repliedUser: false } });
}

async function replyStatus(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction,
  title: string,
  description: string,
  color: number
): Promise<void> {
  if (interaction.deferred) await interaction.editReply(statusEdit(title, description, color));
  else await interaction.reply(statusMessage(title, description, color));
}

async function replyEmbedPages(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction, embeds: EmbedBuilder[]): Promise<void> {
  for (let index = 0; index < embeds.length; index += 10) {
    const response = {
      cards: embeds.slice(index, index + 10),
      flags: MessageFlags.Ephemeral as const,
      allowedMentions: { parse: [] as never[], repliedUser: false }
    };
    if (index === 0 && interaction.deferred) {
      await interaction.editReply(v2Edit(response));
    } else if (index === 0) await interaction.reply(v2Reply(response));
    else await interaction.followUp(v2Reply(response));
  }
}

async function replyLinesReport(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction,
  title: string,
  lines: string[],
  footer: string | undefined,
  attachmentName: string
): Promise<void> {
  const complete = lines.join("\n") || "None";
  if (complete.length > REPORT_ATTACHMENT_THRESHOLD) {
    const embed = new EmbedBuilder().setColor(REPORT_COLOR).setTitle(title).setDescription("The complete report is attached.");
    if (footer) embed.setFooter({ text: footer });
    const response = {
      cards: [embed],
      files: [new AttachmentBuilder(Buffer.from(complete, "utf8"), { name: attachmentName })],
      flags: MessageFlags.Ephemeral as const,
      allowedMentions: { parse: [], repliedUser: false }
    };
    if (interaction.deferred) {
      await interaction.editReply(v2Edit(response));
    } else {
      await interaction.reply(v2Reply(response));
    }
    return;
  }
  const chunks = splitText(complete, REPORT_DESCRIPTION_LIMIT);
  const embeds = chunks.map((description, index) => {
    const embed = new EmbedBuilder()
      .setColor(REPORT_COLOR)
      .setTitle(chunks.length === 1 ? title : `${title} • ${index + 1}/${chunks.length}`)
      .setDescription(description);
    if (footer) embed.setFooter({ text: footer });
    return embed;
  });
  await replyEmbedPages(interaction, embeds);
}

function splitField(name: string, lines: string[]) {
  const chunks = splitText(lines.join("\n") || "None", 1_024);
  return chunks.map((value, index) => ({ name: index === 0 ? name : `${name} (continued)`, value }));
}

function splitText(value: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const rawLine of value.split("\n")) {
    let line = rawLine || " ";
    while (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : ["None"];
}

function characterChoices(characters: EligibleSpecialisationCharacter[], query: string) {
  return characters
    .filter((character) => normalizeCatalogueName(`${character.characterName} ${getAlbionServerLabel(character.albionServer)}`).includes(query))
    .slice(0, 25)
    .map((character) => ({
      name: truncateChoice(`${character.characterName} • ${getAlbionServerLabel(character.albionServer)}`),
      value: formatSpecialisationCharacterReference(character)
    }));
}

function recordCharacterChoices(records: CharacterSpecialisation[], query: string) {
  return uniqueBy(records, (record) => `${record.albionServer}:${record.albionCharacterId}`)
    .filter((record) => normalizeCatalogueName(`${record.characterName} ${getAlbionServerLabel(record.albionServer)}`).includes(query))
    .slice(0, 25)
    .map((record) => ({
      name: truncateChoice(`${record.characterName} • ${getAlbionServerLabel(record.albionServer)}`),
      value: `${record.albionServer}:${record.albionCharacterId}`
    }));
}

function catalogueChoices(entries: readonly CatalogueEntry[], query: string, includeKind: boolean) {
  return entries
    .filter((entry) => normalizeCatalogueName(entry.name).includes(query))
    .slice(0, 25)
    .map((entry) => ({ name: truncateChoice(includeKind ? `${titleCase(entry.kind)} • ${entry.name}` : entry.name), value: entry.key }));
}

export function unavailableSubmissionTargetKeys(
  kind: CatalogueEntry["kind"],
  activeRecords: readonly CharacterSpecialisation[],
  pendingRequests: readonly SpecialisationRequest[]
): Set<string> {
  const unavailable = new Set<string>();
  const targets = [...activeRecords, ...pendingRequests];
  if (kind === "weapon") {
    for (const target of targets) {
      if (target.targetKind === "weapon") {
        unavailable.add(target.targetKey);
        continue;
      }
      for (const entry of SPECIALISATION_CATALOGUE) {
        if (entry.kind === "weapon" && entry.treeKey === target.targetKey) unavailable.add(entry.key);
      }
    }
    return unavailable;
  }

  for (const record of activeRecords) {
    if (record.targetKind === "tree") unavailable.add(record.targetKey);
  }
  for (const request of pendingRequests) {
    const entry = catalogueByKey.get(request.targetKey);
    if (entry?.kind === "tree") unavailable.add(entry.key);
    if (entry?.kind === "weapon" && entry.treeKey) unavailable.add(entry.treeKey);
  }
  return unavailable;
}

function groupByCharacter(records: CharacterSpecialisation[]) {
  const groups = new Map<string, { characterName: string; records: CharacterSpecialisation[] }>();
  for (const record of records) {
    const key = `${record.albionServer}:${record.albionCharacterId}`;
    const group = groups.get(key) ?? { characterName: record.characterName, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  return groups;
}

function isCurrentRecord(record: CharacterSpecialisation, excludedKeys: ReadonlySet<string>): boolean {
  const target = catalogueByKey.get(record.targetKey);
  return Boolean(target && target.kind === record.targetKind && isLevelValidForKind(record.targetKind, record.level) && !excludedKeys.has(record.targetKey));
}

function proofFilename(originalName: string, contentType: string): string {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(originalName)?.[1]
    ?? contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "")
    ?? "png";
  return `specialisation-proof.${extension.toLocaleLowerCase()}`;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function truncateChoice(value: string): string {
  return value.length <= 100 ? value : `${value.slice(0, 99)}…`;
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toLocaleUpperCase()}${value.slice(1)}`;
}

function compareText(left: string, right: string): number {
  return left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase()) || left.localeCompare(right);
}

function isConfirmedMissing(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: number }).code
    : undefined;
  return code === 10003 || code === 10008;
}

export { CATALOGUE_MODAL_ID, NO_REVIEWER_NOTICE };
