import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from "discord.js";
import type { createContentRepository } from "../db/contentRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import type { Logger } from "../logging/logger.js";
import { buildPartyListV2Messages } from "../services/content/rendering.js";
import { UTC_TIME_OPTION_DESCRIPTION } from "../services/scheduling.js";
import {
  buildNotFoundEmbed,
  buildSuccessEmbed,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";
import {
  archiveContent,
  buildArchiveContentResultEmbed,
  buildFinishContentResultEmbed,
  buildStartContentResultEmbed,
  canJoin,
  finishContent,
  handleCreate,
  isHost,
  leaveContent,
  openSignupSelect,
  refreshSignupPresentation,
  requireManagedThread,
  showContentEditModal,
  signupContent,
  startContent
} from "./content.js";
import { handlePartyApprovalReview } from "./partyApproval.js";

type ContentRepository = ReturnType<typeof createContentRepository>;

export const partyCommand = new SlashCommandBuilder()
  .setName("party")
  .setDescription("Host and manage content signup parties.")
  .setDefaultMemberPermissions(0)
  .addSubcommandGroup((group) =>
    group
      .setName("host")
      .setDescription("Host a scheduled or unscheduled content signup party.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("scheduled")
          .setDescription("Create a scheduled content signup party.")
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
          .addStringOption((option) =>
            option
              .setName("template")
              .setDescription("Content template, or Blank to start from an empty form.")
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption((option) => option
            .setName("approval")
            .setDescription("Require host approval for signups.")
            .setRequired(false)
            .addChoices(
              { name: "Host approval not required", value: "false" },
              { name: "Host approval required", value: "true" }
            ))
          .addStringOption((option) => option
            .setName("multisignup")
            .setDescription("Allow multiple users to sign up for each role.")
            .setRequired(false)
            .addChoices(
              { name: "Multi-signup off", value: "false" },
              { name: "Multi-signup on", value: "true" }
            ))
      )
      .addSubcommand((subcommand) => subcommand
        .setName("unscheduled")
        .setDescription("Host a content signup party with no scheduled start.")
        .addStringOption((option) => option
          .setName("template")
          .setDescription("Content template, or Blank to start from an empty form.")
          .setRequired(true)
          .setAutocomplete(true))
        .addStringOption((option) => option
          .setName("approval")
          .setDescription("Require host approval for signups.")
          .setRequired(false)
          .addChoices(
            { name: "Host approval not required", value: "false" },
            { name: "Host approval required", value: "true" }
          ))
        .addStringOption((option) => option
          .setName("multisignup")
          .setDescription("Allow multiple users to sign up for each role.")
          .setRequired(false)
          .addChoices(
            { name: "Multi-signup off", value: "false" },
            { name: "Multi-signup on", value: "true" }
          )))
  )
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List all non-archived content signup parties."))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit the current content signup party.")
      .addStringOption((option) => option.setName("date").setDescription("Optional UTC date.").setAutocomplete(true))
      .addStringOption((option) => option.setName("time").setDescription(`Optional ${UTC_TIME_OPTION_DESCRIPTION}`))
      .addAttachmentOption((option) => option.setName("image").setDescription("Optional builds graphic to replace the current image."))
  )
  .addSubcommand((subcommand) => subcommand.setName("start").setDescription("Start the current content signup party."))
  .addSubcommand((subcommand) => subcommand.setName("end").setDescription("End the current content signup party."))
  .addSubcommand((subcommand) => subcommand.setName("cancel").setDescription("Cancel the current content signup party."))
  .addSubcommand((subcommand) => subcommand.setName("archive").setDescription("Archive the current content signup party."))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("transfer")
      .setDescription("Transfer ownership of the current party.")
      .addUserOption((option) =>
        option.setName("user").setDescription("New party host.").setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add or move a user in the current content signup.")
      .addUserOption((option) =>
        option.setName("user").setDescription("User to add or move.").setRequired(true)
      )
  )
  .addSubcommand((subcommand) => subcommand
    .setName("accept").setDescription("Accept a user's pending signup request.")
    .addUserOption((option) => option.setName("user").setDescription("User whose request to accept.").setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("decline").setDescription("Decline a user's pending signup request.")
    .addUserOption((option) => option.setName("user").setDescription("User whose request to decline.").setRequired(true)))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a user from the current content signup.")
      .addUserOption((option) =>
        option.setName("user").setDescription("User to remove.").setRequired(true)
      )
  );

export const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription("Join the current content signup.")
  .setDefaultMemberPermissions(0);

export const leaveCommand = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("Leave the current content signup.")
  .setDefaultMemberPermissions(0);

export const standbyCommand = new SlashCommandBuilder()
  .setName("standby")
  .setDescription("Join standby for the current content signup.")
  .setDefaultMemberPermissions(0);

export async function handlePartyCommand(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository,
  logger: Logger
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const subcommand = interaction.options.getSubcommand();
  if (interaction.options.getSubcommandGroup(false) === "host") {
    await handleCreate(interaction, repository, subcommand === "unscheduled");
    return;
  }
  if (subcommand === "list") {
    const messages = buildPartyListV2Messages(
      await repository.listUnarchivedContent(interaction.guildId!)
    );
    await interaction.reply(messages[0]);
    for (const message of messages.slice(1)) {
      await interaction.followUp(message);
    }
    return;
  }

  const snapshot = await requireManagedThread(interaction, repository);
  if (!snapshot) return;

  if (subcommand === "accept" || subcommand === "decline") {
    await handlePartyApprovalReview(interaction, repository, snapshot, subcommand, interaction.options.getUser("user", true).id);
    return;
  }

  if (!await isHost(interaction.user.id, snapshot, repository)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Host Only", "Only the party host can use that command.")], flags: MessageFlags.Ephemeral }));
    return;
  }

  if (subcommand === "edit") {
    await showContentEditModal(interaction, snapshot, {
      date: interaction.options.getString("date"),
      time: interaction.options.getString("time"),
      image: interaction.options.getAttachment("image")
    });
    return;
  }
  if (subcommand === "start") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await startContent(interaction, repository, logger, snapshot);
    await editFeedback(interaction, { structured: result === "notification-failed" || result === "notification-uncertain", cards: [buildStartContentResultEmbed(result)] });
    return;
  }
  if (subcommand === "end" || subcommand === "cancel") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await finishContent(interaction, repository, snapshot, subcommand);
    await editFeedback(interaction, { cards: [buildFinishContentResultEmbed(subcommand, result)] });
    return;
  }
  if (subcommand === "archive") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await archiveContent(interaction, repository, logger, snapshot);
    await editFeedback(interaction, { cards: [buildArchiveContentResultEmbed(result)] });
    return;
  }
  if (subcommand === "transfer") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser("user", true);
    const updated = await repository.setHost(interaction.guildId!, snapshot.content.contentId, user.id, interaction.user.id);
    if (!updated) {
      await editFeedback(interaction, { cards: [buildNotFoundEmbed("Party Not Updated", "That content signup is not active or you are no longer its host.")] });
      return;
    }
    const complete = await refreshSignupPresentation(interaction, repository, snapshot);
    await editFeedback(interaction, { cards: [buildSuccessEmbed("Party Host Updated", `<@${user.id}> is now the party host.${complete ? "" : " Some messages could not be updated. Guild Manager will repair them."}`)] });
    return;
  }

  const user = interaction.options.getUser("user", true);
  if (subcommand === "add") {
    await openSignupSelect(interaction, repository, snapshot, user.id, true);
    return;
  }
  if (subcommand === "remove") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = await leaveContent(interaction, repository, snapshot, user.id, interaction.user.id, true);
    await editFeedback(interaction, { cards: [embed] });
    return;
  }

  await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Unknown Party Command", "Choose one of the supported party commands.")], flags: MessageFlags.Ephemeral }, "context"));
}

export async function handleJoinCommand(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const snapshot = await requireManagedThread(interaction, repository);
  if (!snapshot) return;
  await openSignupSelect(interaction, repository, snapshot, interaction.user.id);
}

export async function handleLeaveCommand(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const snapshot = await requireManagedThread(interaction, repository);
  if (!snapshot) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = await leaveContent(interaction, repository, snapshot, interaction.user.id, interaction.user.id);
  await editFeedback(interaction, { cards: [embed] });
}

export async function handleStandbyCommand(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const snapshot = await requireManagedThread(interaction, repository);
  if (!snapshot) return;
  if (!canJoin(snapshot)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Signups Closed", "This content signup is no longer open.")], flags: MessageFlags.Ephemeral }));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = await signupContent(interaction, repository, snapshot, interaction.user.id, null);
  await editFeedback(interaction, { cards: [embed] });
}
