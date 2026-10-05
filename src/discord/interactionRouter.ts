import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Interaction } from "discord.js";
import { handleAccountAutocomplete, handleAccountCommand, handleCreditCommand, handleDebitCommand, handleGiveCommand, handleStatementCommand, handleTransferCommand } from "../commands/account.js";
import { handleActivateCommand } from "../commands/activate.js";
import { handleAllianceAutocomplete, handleAllianceCommand } from "../commands/alliance.js";
import { handleApplicationAutocomplete, handleApplicationButton, handleApplicationCharacterSelect, handleApplicationCommand, handleApplicationModalSubmit, handleApplicationsCommand, reconcileArchivedMemberGroupApplicationPresentation } from "../commands/application.js";
import { handleBotCommand } from "../commands/bot.js";
import { handleChannelCommand } from "../commands/channel.js";
import { handleCharacterAutocomplete, handleCharacterCommand, handleCharacterLookupSelect, handleCharacterRegisterSelect } from "../commands/character.js";
import { handleClearCommand } from "../commands/clear.js";
import { ERROR_COLOR, INVALID_COLOR } from "../commands/configurationHelpers.js";
import { handleContentAutocomplete, handleContentButton, handleContentModalSubmit, handleContentRoleSelect } from "../commands/content.js";
import type { createContentPanelInteractions } from "../commands/contentPanel.js";
import { handleConversationClassRemovalButton } from "../commands/conversationClassRemoval.js";
import { handleDeactivateButton, handleDeactivateCommand } from "../commands/deactivate.js";
import { handleGiveawayAutocomplete, handleGiveawayButton, handleGiveawayCommand, handleGiveawayModalSubmit, handleGiveawaysCommand } from "../commands/giveaway.js";
import { handleGroupAutocomplete, handleGroupCommand } from "../commands/group.js";
import { handleGuildAutocomplete, handleGuildCommand, handleGuildLookupSelect } from "../commands/guild.js";
import { handleKickCommand } from "../commands/kick.js";
import { handleManagerCommand } from "../commands/manager.js";
import { handleMemberAutocomplete, handleMemberCommand } from "../commands/member.js";
import { handleMemberGroupRemovalButton } from "../commands/memberGroupRemoval.js";
import { handleMessageAutocomplete, handleMessageCommand, handleMessageModalSubmit } from "../commands/message.js";
import { handleJoinCommand, handleLeaveCommand, handlePartyCommand, handleStandbyCommand } from "../commands/party.js";
import { handlePingCommand } from "../commands/ping.js";
import { handlePositionAutocomplete, handlePositionCommand } from "../commands/position.js";
import { handleReactionAutocomplete, handleReactionCommand } from "../commands/reaction.js";
import { handleRegearAutocomplete, handleRegearButton, handleRegearCommand, handleRegearModalSubmit, handleRegearStringSelect, handleRegearmeCommand, handleRegearsCommand } from "../commands/regear.js";
import { handleRegisterAutocomplete, handleRegisterCharacterSelect, handleRegisterCommand } from "../commands/register.js";
import { handleResetButton, handleResetCommand } from "../commands/reset.js";
import { handleScheduleAutocomplete, handleScheduleCommand } from "../commands/schedule.js";
import { handleBalanceCommand, handleMembershipCommand, handleRolesCommand } from "../commands/selfService.js";
import { handleStatusCommand } from "../commands/status.js";
import { handleTasksCommand } from "../commands/tasks.js";
import { handleTemplateAutocomplete, handleTemplateCommand, handleTemplateModalSubmit } from "../commands/template.js";
import { handleTicketAutocomplete, handleTicketButton, handleTicketCommand, handleTicketModalSubmit, handleTicketsCommand } from "../commands/ticket.js";
import { handleUnregisterAutocomplete, handleUnregisterCommand } from "../commands/unregister.js";
import { handleAuditCommand, handleUpdateAutocomplete, handleUpdateCommand } from "../commands/update.js";
import { handleUtcCommand } from "../commands/utc.js";
import { handleSpecialisationButton, handleSpecialisationModalSubmit, handleWeaponAutocomplete, handleWeaponCommand } from "../commands/weapon.js";
import type { AppConfig } from "../config.js";
import { createAccountRepository } from "../db/accountRepository.js";
import { createApplicationRepository } from "../db/applicationRepository.js";
import { createContentRepository } from "../db/contentRepository.js";
import { createGiveawayRepository } from "../db/giveawayRepository.js";
import { createGuildLifecycleRepository } from "../db/guildLifecycleRepository.js";
import { createMemberUpdateScheduleRepository } from "../db/memberUpdateScheduleRepository.js";
import { createMembershipRepository } from "../db/membershipRepository.js";
import type { PostgresPool } from "../db/postgres.js";
import { createReactionRoleRepository } from "../db/reactionRoleRepository.js";
import { createRegearRepository } from "../db/regearRepository.js";
import { createResetRepository } from "../db/resetRepository.js";
import { createReviewerRepository } from "../db/reviewerRepository.js";
import { createSpecialisationRepository } from "../db/specialisationRepository.js";
import { refreshPendingSpecialisationOwnership } from "../services/specialisations/ownership.js";
import type { RegearCharacterObserver } from "../services/regears/service.js";
import type { StatusRepository } from "../db/statusRepository.js";
import type { TasksRepository } from "../db/tasksRepository.js";
import { createTicketRepository } from "../db/ticketRepository.js";
import { logErrorContext, type Logger } from "../logging/logger.js";
import { createAlbionClient } from "../services/albion/client.js";
import type { ContentPanelService } from "../services/content/panel.js";
import { replyEntryState } from "../services/entryPanels/access.js";
import type { createEntryPanelService } from "../services/entryPanels/service.js";
import type { EntryInteraction } from "../services/entryPanels/types.js";
import { buildGiveawayStatusEmbed } from "../services/giveaways/rendering.js";
import { createKeyedSerialQueue } from "../services/reactionRoles/keyedSerialQueue.js";
import { createRegearService } from "../services/regears/service.js";
import { createTemporaryVoiceService } from "../services/temporaryVoice.js";
import { createUtcChannelService } from "../services/utcChannel.js";
import { completeFeedbackPrompt, feedbackEdit, feedbackReply } from "./feedbackMessages.js";
import { registerActivationOnlyGuildCommands, registerActiveGuildCommands } from "./guildCommandRegistration.js";
import {
  SLOW_INTERACTION_ACKNOWLEDGEMENT_WARNING_MILLISECONDS,
  interactionAcknowledgementContext,
  interactionFailureResponseMethod,
  logHandledChatInputCommand,
  logSlowUnacknowledgedInteraction,
  normalizedChatInputCommandRoute,
  normalizedContentComponentRoute
} from "./interactionObservability.js";
import { OperationalMessageLayoutError, v2Edit } from "./operationalMessages.js";
import type { MemberActionGuard } from "../runtime/memberActionGuard.js";
import type { createKickService } from "../services/membership/kick.js";
import { createModalSessions } from "./modalSessions.js";
export interface InteractionRouterDependencies {
  actionGuard: MemberActionGuard;
  kickService: ReturnType<typeof createKickService>;
  modalSessions?: ReturnType<typeof createModalSessions>;
  logChannelRepository?: import("../db/logChannelRepository.js").LogChannelRepository;
  logFeedService?: import("../services/logFeed/delivery.js").LogFeedService;
  logFeedRuntime?: import("../services/logFeed/runtime.js").LogFeedRuntime;
  entryPanelService?: ReturnType<typeof createEntryPanelService>;
  entryPanelInteractions?: Array<{ handle(interaction: EntryInteraction): Promise<boolean> }>;
  contentPanelInteractions?: ReturnType<typeof createContentPanelInteractions>;
  contentPanelService?: ContentPanelService;
  config: AppConfig;
  logger: Logger;
  postgres: PostgresPool;
  startedAt: Date;
  albionClient: ReturnType<typeof createAlbionClient>;
  accountRepository: ReturnType<typeof createAccountRepository>;
  applicationRepository: ReturnType<typeof createApplicationRepository>;
  contentRepository: ReturnType<typeof createContentRepository>;
  giveawayRepository: ReturnType<typeof createGiveawayRepository>;
  membershipRepository: ReturnType<typeof createMembershipRepository>;
  reactionRoleRepository: ReturnType<typeof createReactionRoleRepository>;
  regearRepository: ReturnType<typeof createRegearRepository>;
  reviewerRepository: ReturnType<typeof createReviewerRepository>;
  resetRepository: ReturnType<typeof createResetRepository>;
  lifecycleRepository: ReturnType<typeof createGuildLifecycleRepository>;
  scheduleRepository: ReturnType<typeof createMemberUpdateScheduleRepository>;
  specialisationRepository: ReturnType<typeof createSpecialisationRepository>;
  statusRepository: StatusRepository;
  tasksRepository: TasksRepository;
  ticketRepository: ReturnType<typeof createTicketRepository>;
  regearService: ReturnType<typeof createRegearService>;
  temporaryVoiceService: ReturnType<typeof createTemporaryVoiceService>;
  utcChannelService: ReturnType<typeof createUtcChannelService>;
  reactionRoleConfigQueue: ReturnType<typeof createKeyedSerialQueue>;
}

export function createInteractionRouter(dependencies: InteractionRouterDependencies) {
  const modalSessions = dependencies.modalSessions ?? createModalSessions();
  const {
    albionClient, accountRepository, applicationRepository, contentRepository,
    giveawayRepository, membershipRepository, reactionRoleRepository, regearRepository,
    reviewerRepository, resetRepository, lifecycleRepository, scheduleRepository,
    specialisationRepository, statusRepository, tasksRepository, ticketRepository, regearService, temporaryVoiceService,
    utcChannelService, reactionRoleConfigQueue
  } = dependencies;

  const registrationObserver: RegearCharacterObserver = {
    async observeCharacterRegistration(guild, server, characterId) {
      const observation = await regearService.observeCharacterRegistration(guild, server, characterId);
      const warnings = await refreshPendingSpecialisationOwnership(guild, specialisationRepository, reviewerRepository, server, characterId);
      for (const warning of warnings) dependencies.logger.warn("character review presentation incomplete", {
        discordGuildId: guild.id, warning: warning.message
      });
      return { ...observation, warnings: [...observation.warnings ?? [], ...warnings] };
    }
  };

  async function handleInteraction(interaction: Interaction): Promise<void> {
    const chatInputStartedAt = interaction.isChatInputCommand() ? Date.now() : undefined;
    let chatInputOutcome: "completed" | "unhandled_error" = "completed";
    const slowAcknowledgementWarning = interaction.isRepliable() || interaction.isAutocomplete()
      ? setTimeout(() => logSlowUnacknowledgedInteraction(dependencies.logger, interaction), SLOW_INTERACTION_ACKNOWLEDGEMENT_WARNING_MILLISECONDS)
      : undefined;
    try {
      const invoke = async () => {
        if (interaction.guildId && "customId" in interaction) {
          const lastKick = await dependencies.actionGuard.lastKickedAt(interaction.guildId, interaction.user.id);
          if (interaction.isModalSubmit()) {
            const session = modalSessions.take(interaction.customId, interaction.guildId, interaction.user.id, lastKick);
            if (!session) {
              await denyAction(interaction, "This form is no longer current. Start again from the command or latest panel.");
              return;
            }
            (interaction as { customId: string }).customId = session.customId;
          } else if (lastKick && isActorOwnedControl(interaction)
            && (!("message" in interaction) || !Number.isFinite(interaction.message.createdTimestamp)
              || interaction.message.createdTimestamp <= lastKick.getTime())) {
            await denyAction(interaction, "This control was issued before your access was revoked. Start again from the command or latest panel.");
            return;
          }
        }
        const restore = envelopeModal(interaction);
        try {
          if (dependencies.logFeedRuntime) await dependencies.logFeedRuntime.interaction(interaction, () => route(interaction));
          else await route(interaction);
        } finally { restore(); }
      };
      if (!interaction.guildId) await invoke();
      else {
        const exclusive = interaction.isChatInputCommand() && interaction.commandName === "kick";
        if (!exclusive && dependencies.actionGuard.isExclusivePending(interaction.guildId)) {
          await denyAction(interaction, "Guild Manager is finishing a member access change. Try again shortly.");
          return;
        }
        if (exclusive && !interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await dependencies.actionGuard.run(interaction.guildId, interaction.user.id, invoke, exclusive);
        if (!result.allowed) await denyAction(interaction, "Your Guild Manager access has been revoked on this Discord server. An officer must explicitly reconnect you.");
      }
    } catch (error) {
      chatInputOutcome = "unhandled_error";
      dependencies.logger.error("interaction failed", {
        interactionType: getInteractionType(interaction),
        interactionRoute: getInteractionRoute(interaction),
        guildId: interaction.guildId,
        ...interactionAcknowledgementContext(interaction),
        ...logErrorContext(error, true)
      });
      if (interaction.isAutocomplete()) {
        if (!interaction.responded) await sendInteractionFailureFallback(interaction, "autocomplete_respond", () => interaction.respond([]));
        return;
      }
      if (!interaction.isRepliable()) return;
      const responseMethod = interactionFailureResponseMethod(interaction);
      // Build inside the same guarded boundary as delivery so a local layout
      // failure receives the narrowly scoped emergency response too.
      await sendInteractionFailureFallback(interaction, responseMethod, async () => {
        const response = interactionFailureResponse(interaction);
        if (responseMethod === "edit_reply") {
          // deferUpdate addresses an existing card; a private deferReply is empty.
          if ("message" in interaction && interaction.message?.flags?.has(MessageFlags.IsComponentsV2) && interaction.ephemeral !== true) {
            if (interaction.message.flags.has(MessageFlags.Ephemeral)) return completeFeedbackPrompt(interaction, { text: "Guild Manager could not complete that command.", accentColor: ERROR_COLOR });
            return interaction.editReply(v2Edit({ text: "Guild Manager could not complete that command.", accentColor: ERROR_COLOR }));
          }
          return interaction.editReply(feedbackEdit({ text: "Guild Manager could not complete that command.", accentColor: ERROR_COLOR }));
        }
        if (responseMethod === "follow_up") return interaction.followUp(response);
        return interaction.reply(response);
      });
    } finally {
      if (slowAcknowledgementWarning) clearTimeout(slowAcknowledgementWarning);
      if (chatInputStartedAt !== undefined && interaction.isChatInputCommand()) {
        logHandledChatInputCommand(dependencies.logger, interaction, chatInputStartedAt, chatInputOutcome);
      }
    }
  }

  function envelopeModal(interaction: Interaction): () => void {
    if (!interaction.guildId || !("showModal" in interaction)) return () => undefined;
    const original = interaction.showModal;
    interaction.showModal = ((...args: unknown[]) => {
      const modal = args[0] as { toJSON?: () => { custom_id: string }; custom_id: string };
      const data = typeof modal.toJSON === "function" ? modal.toJSON() : modal;
      args[0] = { ...data, custom_id: modalSessions.issue(interaction.guildId!, interaction.user.id, data.custom_id, interaction.createdTimestamp) };
      return Reflect.apply(original, interaction, args);
    }) as typeof interaction.showModal;
    return () => { interaction.showModal = original; };
  }

  async function denyAction(interaction: Interaction, text: string): Promise<void> {
    if (interaction.isAutocomplete()) {
      if (!interaction.responded) await interaction.respond([]);
    } else if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.editReply(feedbackEdit({ text, accentColor: INVALID_COLOR }));
      else await interaction.reply(feedbackReply({ text, accentColor: INVALID_COLOR, flags: MessageFlags.Ephemeral }));
    }
  }

  async function sendInteractionFailureFallback(
    interaction: Interaction,
    responseMethod: "autocomplete_respond" | "edit_reply" | "follow_up" | "reply",
    send: () => Promise<unknown>
  ): Promise<void> {
    try {
      await send();
    } catch (fallbackError) {
      if (interaction.isRepliable() && isDefinitivePresentationFailure(fallbackError)) {
        // This is a new private message, never a V2-to-text edit. Do not repeat
        // the business action or retry an ambiguous network failure.
        const plain = { content: "Guild Manager could not complete that command.", flags: MessageFlags.Ephemeral as const, allowedMentions: { parse: [] as never[], repliedUser: false } };
        try {
          if (interaction.deferred || interaction.replied) await interaction.followUp(plain);
          else await interaction.reply(plain);
          return;
        } catch { /* Keep the original sanitized presentation failure below. */ }
      }
      dependencies.logger.error("interaction failure fallback response failed", {
        interactionType: getInteractionType(interaction),
        interactionRoute: getInteractionRoute(interaction),
        guildId: interaction.guildId,
        responseMethod,
        ...interactionAcknowledgementContext(interaction),
        ...logErrorContext(fallbackError, true)
      });
    }
  }

  async function route(interaction: Interaction): Promise<void> {
      if (isEntryPanelInteraction(interaction) && (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit())) {
        if (!interaction.inGuild() || !await lifecycleRepository.isGuildActive(interaction.guildId)) {
          await replyEntryState(interaction as EntryInteraction, "Start Again", "This control is no longer current. Open the latest entry panel and start again.");
          return;
        }
        for (const handler of dependencies.entryPanelInteractions ?? []) {
          if (await handler.handle(interaction as EntryInteraction)) return;
        }
        await replyEntryState(interaction as EntryInteraction, "Start Again", "This control is no longer current. Open the latest entry panel and start again.");
        return;
      }
      if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
        && typeof interaction.customId === "string" && normalizedContentComponentRoute(interaction.customId)) {
        if (!interaction.inGuild() || !await lifecycleRepository.isGuildActive(interaction.guildId)) {
          await interaction.reply(contentPanelFailure("Guild Manager is not active on this server."));
          return;
        }
        const handlers = dependencies.contentPanelInteractions;
        if (!handlers) throw new Error("Content hosting is unavailable.");
        if (interaction.isButton()) await handlers.handleButton(interaction);
        else if (interaction.isStringSelectMenu()) await handlers.handleSelect(interaction);
        else if (interaction.isModalSubmit()) await handlers.handleModal(interaction);
        return;
      }

      if ((interaction.isAutocomplete() || interaction.isStringSelectMenu()) && interaction.inGuild()) {
        const isActiveGuild = await lifecycleRepository.isGuildActive(interaction.guildId);
        if (!isActiveGuild) {
          if (interaction.isAutocomplete()) {
            await interaction.respond([]);
          } else {
            await interaction.reply(feedbackReply({
              text: "Guild Manager is not active on this server.", accentColor: INVALID_COLOR,
              flags: MessageFlags.Ephemeral
            }));
          }
          return;
        }
      }

      if (interaction.isAutocomplete()) {
        if (await handleMessageAutocomplete(interaction)) return;
        if (await handleWeaponAutocomplete(interaction, membershipRepository, specialisationRepository, reviewerRepository)) return;
        if (await handleRegearAutocomplete(interaction, regearRepository)) return;
        if (await handleAccountAutocomplete(interaction, accountRepository, dependencies.entryPanelService?.context)) return;
        if (await handleRegisterAutocomplete(interaction)) {
          return;
        }
        if (await handleUnregisterAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleCharacterAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleMemberAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleUpdateAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleScheduleAutocomplete(interaction)) {
          return;
        }
        if (await handleGiveawayAutocomplete(interaction, giveawayRepository)) return;
        if (await handleTemplateAutocomplete(interaction, contentRepository)) {
          return;
        }
        if (await handleContentAutocomplete(interaction, contentRepository)) {
          return;
        }
        if (await handleGuildAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleAllianceAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleGroupAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleApplicationAutocomplete(interaction, applicationRepository, membershipRepository)) {
          return;
        }
        if (await handleTicketAutocomplete(interaction, ticketRepository)) return;
        if (await handlePositionAutocomplete(interaction, membershipRepository)) {
          return;
        }
        if (await handleReactionAutocomplete(interaction, reactionRoleRepository)) return;
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (await handleRegearStringSelect(interaction, regearRepository)) return;
        if (await handleCharacterLookupSelect(interaction, albionClient)) {
          return;
        }
        if (await handleGuildLookupSelect(interaction, albionClient)) {
          return;
        }
        if (await handleRegisterCharacterSelect(interaction, albionClient, membershipRepository, registrationObserver)) {
          return;
        }
        if (await handleCharacterRegisterSelect(interaction, albionClient, membershipRepository, registrationObserver)) {
          return;
        }
        if (await handleApplicationCharacterSelect(interaction, applicationRepository, membershipRepository, albionClient)) {
          return;
        }
        if (await handleContentRoleSelect(interaction, contentRepository)) {
          return;
        }
        return;
      }

      if (interaction.isButton()) {
        if (await handleSpecialisationButton(
          interaction,
          specialisationRepository,
          reviewerRepository,
          dependencies.logger,
          (discordGuildId) => lifecycleRepository.isGuildActive(discordGuildId)
        )) return;
        if (await handleRegearButton(interaction, regearRepository, regearService)) return;
        if (await handleGiveawayButton(interaction, giveawayRepository, dependencies.logger, dependencies.entryPanelService?.context)) return;
        if (await handleConversationClassRemovalButton(interaction, applicationRepository, ticketRepository, membershipRepository, dependencies.logger)) return;
        if (await handleMemberGroupRemovalButton(
          interaction,
          membershipRepository,
          (result) => reconcileArchivedMemberGroupApplicationPresentation(
            interaction.guild!,
            applicationRepository,
            membershipRepository,
            result
          )
        )) return;
        if (await handleResetButton(interaction, resetRepository, async () => {
          dependencies.logger.warn("Discord guild data reset completed", {
            discordGuildId: interaction.guildId,
            actorDiscordUserId: interaction.user.id
          });
        }, async () => {
          if (interaction.guild) await temporaryVoiceService.deleteAllTemporaryChannels(interaction.guild);
        }, dependencies.logFeedRuntime)) {
          return;
        }
        if (await handleDeactivateButton(interaction, lifecycleRepository, async () => {
          if (interaction.guild) {
            await registerActivationOnlyGuildCommands(interaction.guild, dependencies.config, dependencies.logger);
          }
        }, async () => {
          if (interaction.guild) await utcChannelService.remove(interaction.guild);
        }, dependencies.logFeedRuntime)) {
          return;
        }
        if (await handleApplicationButton(interaction, applicationRepository, membershipRepository, albionClient, registrationObserver)) {
          return;
        }
        if (await handleTicketButton(interaction, ticketRepository)) return;
        if (await handleContentButton(interaction, contentRepository, dependencies.logger)) {
          return;
        }
      }

      if (interaction.isModalSubmit()) {
        if (!interaction.inGuild()) {
          await interaction.reply(isGiveawayInteraction(interaction)
            ? giveawayErrorMessage("Server Only", "Guild Manager commands can only be used from a Discord server.")
            : feedbackReply({
              text: "Guild Manager commands can only be used from a Discord server.", accentColor: INVALID_COLOR,
              flags: MessageFlags.Ephemeral
            }));
          return;
        }

        const isActiveGuild = await lifecycleRepository.isGuildActive(interaction.guildId);
        if (!isActiveGuild) {
          await interaction.reply(isGiveawayInteraction(interaction)
            ? giveawayErrorMessage("Guild Manager Inactive", "Guild Manager is not active on this server.")
            : feedbackReply({
              text: "Guild Manager is not active on this server.", accentColor: INVALID_COLOR,
              flags: MessageFlags.Ephemeral
            }));
          return;
        }

        if (await handleMessageModalSubmit(interaction, dependencies.logger)) {
          return;
        }
        if (await handleSpecialisationModalSubmit(interaction, specialisationRepository, reviewerRepository)) return;
        if (await handleRegearModalSubmit(interaction, regearRepository, regearService)) return;
        if (await handleApplicationModalSubmit(interaction, applicationRepository, membershipRepository, albionClient)) {
          return;
        }
        if (await handleTicketModalSubmit(interaction, ticketRepository)) return;
        if (await handleTemplateModalSubmit(interaction, contentRepository)) {
          return;
        }
        const contentFence = dependencies.contentPanelService?.captureFence(interaction.guildId);
        if (await handleContentModalSubmit(interaction, contentRepository, dependencies.logger, dependencies.contentPanelService ? {
          runExclusive: dependencies.contentPanelService.runExclusive,
          validate: async (submission) => {
            if (contentFence && !contentFence()) throw new Error("This hosting request is no longer available. Start again.");
            if (!await lifecycleRepository.isGuildActive(submission.guildId)) throw new Error("Guild Manager is not active on this server.");
            if (contentFence && !contentFence()) throw new Error("This hosting request is no longer available. Start again.");
          }
        } : undefined)) {
          return;
        }
        if (await handleGiveawayModalSubmit(
          interaction,
          giveawayRepository,
          dependencies.logger,
          dependencies.entryPanelService?.context
        )) return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (!interaction.inGuild()) {
        await interaction.reply(isGiveawayInteraction(interaction)
          ? giveawayErrorMessage("Server Only", "Guild Manager commands can only be used from a Discord server.")
          : feedbackReply({
            text: "Guild Manager commands can only be used from a Discord server.", accentColor: INVALID_COLOR,
            flags: MessageFlags.Ephemeral
          }));
        return;
      }

      const isActiveGuild = await lifecycleRepository.isGuildActive(interaction.guildId);
      if (!isActiveGuild && interaction.commandName !== "activate") {
        if (interaction.deferred) {
          await denyAction(interaction, "Guild Manager is not active on this server.");
          return;
        }
        await interaction.reply(isGiveawayInteraction(interaction)
          ? giveawayErrorMessage("Guild Manager Inactive", "Guild Manager is not active on this server.")
          : feedbackReply({
            text: "Guild Manager is not active on this server.", accentColor: INVALID_COLOR,
            flags: MessageFlags.Ephemeral
          }));
        return;
      }

      if (interaction.commandName === "channel" || interaction.commandName === "manager") {
        if (!dependencies.entryPanelService) {
          await replyEntryState(interaction, "Configuration Unavailable", "Guild Manager could not load configuration services. Try again in a moment.");
          return;
        }
        if (interaction.commandName === "channel") {
          await handleChannelCommand(interaction, { contentRepository, entryPanelService: dependencies.entryPanelService, temporaryVoiceService,
            logChannelRepository: dependencies.logChannelRepository, logFeedService: dependencies.logFeedService });
        } else {
          await handleManagerCommand(interaction, reviewerRepository, dependencies.entryPanelService);
        }
        return;
      }
      if (interaction.commandName === "regearme" && dependencies.entryPanelInteractions) {
        for (const handler of dependencies.entryPanelInteractions) if (await handler.handle(interaction)) return;
      }

      if (isActiveGuild && interaction.commandName === "activate") {
        await interaction.reply(feedbackReply({
          text: "Guild Manager is already active on this server.",
          flags: MessageFlags.Ephemeral
        }));
        return;
      }

      if (interaction.commandName === "activate") {
        await handleActivateCommand(interaction, lifecycleRepository, async () => {
          if (interaction.guild) {
            await registerActiveGuildCommands(interaction.guild, dependencies.config, dependencies.logger);
          }
        });
        return;
      }
      if (["weapon", "weapons", "specialisation"].includes(interaction.commandName)) {
        await handleWeaponCommand(interaction, membershipRepository, specialisationRepository, reviewerRepository, dependencies.logger, dependencies.entryPanelService?.context);
        return;
      }

      if (interaction.commandName === "deactivate") {
        await handleDeactivateCommand(interaction);
        return;
      }

      if (interaction.commandName === "reset") {
        await handleResetCommand(interaction);
        return;
      }

      if (interaction.commandName === "regear") {
        await handleRegearCommand(interaction, regearRepository, regearService, dependencies.entryPanelService?.context);
        return;
      }

      if (interaction.commandName === "regears") {
        await handleRegearsCommand(interaction, regearRepository);
        return;
      }

      if (interaction.commandName === "regearme") {
        await handleRegearmeCommand(interaction, regearRepository);
        return;
      }

      if (interaction.commandName === "account") {
        await handleAccountCommand(interaction, accountRepository, dependencies.entryPanelService?.context);
        return;
      }

      if (interaction.commandName === "statement") {
        await handleStatementCommand(interaction, accountRepository, membershipRepository);
        return;
      }

      if (interaction.commandName === "balance") {
        await handleBalanceCommand(interaction, accountRepository);
        return;
      }

      if (interaction.commandName === "credit") {
        await handleCreditCommand(interaction, accountRepository, dependencies.entryPanelService?.context);
        return;
      }

      if (interaction.commandName === "debit") {
        await handleDebitCommand(interaction, accountRepository, dependencies.entryPanelService?.context);
        return;
      }

      if (interaction.commandName === "transfer") {
        await handleTransferCommand(interaction, accountRepository, dependencies.entryPanelService?.context);
        return;
      }

      if (interaction.commandName === "give") {
        await handleGiveCommand(interaction, accountRepository);
        return;
      }

      if (interaction.commandName === "character") {
        await handleCharacterCommand(interaction, albionClient, membershipRepository, registrationObserver);
        return;
      }

      if (interaction.commandName === "bot") {
        await handleBotCommand(interaction, dependencies.logger);
        return;
      }

      if (interaction.commandName === "clear") {
        await handleClearCommand(interaction);
        return;
      }

      if (interaction.commandName === "register") {
        await handleRegisterCommand(interaction, albionClient, membershipRepository, registrationObserver);
        return;
      }

      if (interaction.commandName === "unregister") {
        await handleUnregisterCommand(interaction, membershipRepository, registrationObserver);
        return;
      }

      if (interaction.commandName === "member") {
        await handleMemberCommand(interaction, membershipRepository, accountRepository);
        return;
      }

      if (interaction.commandName === "membership") {
        await handleMembershipCommand(interaction, membershipRepository, accountRepository);
        return;
      }

      if (interaction.commandName === "message") {
        await handleMessageCommand(interaction, dependencies.logger);
        return;
      }

      if (interaction.commandName === "audit") {
        await handleAuditCommand(interaction, albionClient, membershipRepository);
        return;
      }

      if (interaction.commandName === "update") {
        await handleUpdateCommand(interaction, albionClient, membershipRepository);
        return;
      }

      if (interaction.commandName === "schedule") {
        await handleScheduleCommand(interaction, scheduleRepository);
        return;
      }

      if (interaction.commandName === "template") {
        await handleTemplateCommand(interaction, contentRepository);
        return;
      }

      if (interaction.commandName === "party") {
        await handlePartyCommand(interaction, contentRepository, dependencies.logger);
        return;
      }

      if (interaction.commandName === "join") {
        await handleJoinCommand(interaction, contentRepository);
        return;
      }

      if (interaction.commandName === "leave") {
        await handleLeaveCommand(interaction, contentRepository);
        return;
      }

      if (interaction.commandName === "standby") {
        await handleStandbyCommand(interaction, contentRepository);
        return;
      }

      if (interaction.commandName === "kick") {
        await handleKickCommand(interaction, membershipRepository, dependencies.kickService);
        return;
      }

      if (interaction.commandName === "guild") {
        await handleGuildCommand(interaction, albionClient, membershipRepository, scheduleRepository);
        return;
      }

      if (interaction.commandName === "alliance") {
        await handleAllianceCommand(interaction, albionClient, membershipRepository, scheduleRepository);
        return;
      }

      if (interaction.commandName === "application") {
        await handleApplicationCommand(interaction, applicationRepository, membershipRepository, albionClient, registrationObserver);
        return;
      }

      if (interaction.commandName === "applications") {
        await handleApplicationsCommand(interaction, applicationRepository, membershipRepository);
        return;
      }

      if (interaction.commandName === "ticket") {
        await handleTicketCommand(interaction, ticketRepository);
        return;
      }

      if (interaction.commandName === "tickets") {
        await handleTicketsCommand(interaction, ticketRepository);
        return;
      }

      if (interaction.commandName === "group") {
        await handleGroupCommand(interaction, membershipRepository, scheduleRepository);
        return;
      }

      if (interaction.commandName === "giveaway") {
        await handleGiveawayCommand(
          interaction,
          giveawayRepository,
          dependencies.logger,
          dependencies.entryPanelService?.context
        );
        return;
      }

      if (interaction.commandName === "giveaways") {
        await handleGiveawaysCommand(interaction, giveawayRepository);
        return;
      }

      if (interaction.commandName === "position") {
        await handlePositionCommand(interaction, membershipRepository);
        return;
      }

      if (interaction.commandName === "reaction") {
        await handleReactionCommand(interaction, reactionRoleRepository, membershipRepository, giveawayRepository, reactionRoleConfigQueue);
        return;
      }

      if (interaction.commandName === "roles") {
        await handleRolesCommand(interaction, membershipRepository);
        return;
      }

      if (interaction.commandName === "status") {
        await handleStatusCommand(interaction, statusRepository);
        return;
      }

      if (interaction.commandName === "tasks") {
        await handleTasksCommand(interaction, tasksRepository);
        return;
      }

      if (interaction.commandName === "ping") {
        await handlePingCommand(interaction, {
          config: dependencies.config,
          postgres: dependencies.postgres,
          startedAt: dependencies.startedAt
        });
        return;
      }

      if (interaction.commandName === "utc") {
        await handleUtcCommand(interaction, utcChannelService);
        return;
      }


      dependencies.logger.warn("unknown command received", {
        commandName: interaction.commandName,
        guildId: interaction.guildId
      });
  }

  return { handleInteraction, stop: () => modalSessions.stop() };
}

function isActorOwnedControl(interaction: Interaction): boolean {
  if (!("customId" in interaction)) return false;
  if ("message" in interaction && interaction.message?.flags?.has(MessageFlags.Ephemeral)) return true;
  // These confirmations/selectors derive their authority from the originating
  // actor's command. Persistent shared cards instead recheck current role/owner.
  return /^(gm-reset:|gm-deactivate:|member-group-(?:delete|remove):|class-remove:|albion-character:|cs:|giveaway-confirm:|account-entry:|regear-entry:|weapon-entry:|giveaway-entry:|content-host:|content:slot:)/.test(interaction.customId);
}

export function interactionFailureResponse(interaction: Interaction) {
  const message = "Guild Manager could not complete that command.";
  return isGiveawayInteraction(interaction)
    ? giveawayErrorMessage("Giveaway Command Failed", message, ERROR_COLOR)
    : feedbackReply({ text: message, accentColor: ERROR_COLOR, flags: MessageFlags.Ephemeral });
}

function isGiveawayInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "giveaway" || interaction.commandName === "giveaways") return true;
    return interaction.commandName === "reaction" && interaction.options.getSubcommandGroup(false) === "giveaway";
  }
  return (interaction.isButton() && interaction.customId.startsWith("giveaway-confirm:"))
    || (interaction.isModalSubmit() && interaction.customId.startsWith("giveaway-create:"));
}

function giveawayErrorMessage(title: string, description: string, color = INVALID_COLOR) {
  return feedbackReply({ cards: [buildGiveawayStatusEmbed(title, description, color)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [], repliedUser: false } }, "context");
}

function getInteractionType(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) return "chat_input";
  if (interaction.isAutocomplete()) return "autocomplete";
  if (interaction.isButton()) return "button";
  if (interaction.isModalSubmit()) return "modal_submit";
  if (interaction.isStringSelectMenu()) return "string_select";
  return interaction.type.toString();
}

function getInteractionRoute(interaction: Interaction): string {
  return interaction.isChatInputCommand()
    ? normalizedChatInputCommandRoute(interaction)
    : ("customId" in interaction ? normalizedContentComponentRoute(interaction.customId) : undefined) ?? getInteractionType(interaction);
}

function isContentPanelInteraction(interaction: Interaction): boolean {
  return "customId" in interaction && typeof interaction.customId === "string"
    && normalizedContentComponentRoute(interaction.customId) !== undefined;
}
function contentPanelFailure(message: string) {
  return {
    components: [new ContainerBuilder().setAccentColor(INVALID_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(message))],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] as never[], users: [], roles: [], repliedUser: false }
  };
}

function isEntryPanelInteraction(interaction: Interaction): boolean {
  return "customId" in interaction && /^(entry-panel|account-entry|regear-entry|weapon-entry|giveaway-panel|giveaway-entry):/.test(interaction.customId);
}

/** Only a rejected payload or local presentation failure permits a text fallback. */
export function isDefinitivePresentationFailure(error: unknown): boolean {
  return error instanceof OperationalMessageLayoutError
    || (!!error && typeof error === "object" && "code" in error && error.code === 50035);
}
