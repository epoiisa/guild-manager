import { createContentPanelRepository } from "../db/contentPanelRepository.js";
import { reconcileDeletedApplicationChannel } from "../services/applications/channelDeletionService.js";
import { createEntryPanelService } from "../services/entryPanels/service.js";
import { createEntryPanelRepository } from "../db/entryPanelRepository.js";
import { buildAccountsPanel, createAccountPanelInteractions } from "../commands/accountPanel.js";
import { buildRegearPanel, createRegearPanelInteractions } from "../commands/regearPanel.js";
import { buildWeaponPanel, createWeaponPanelInteractions } from "../commands/weaponPanel.js";
import { buildGiveawayPanel, createGiveawayPanelInteractions } from "../commands/giveawayPanel.js";
import { createContentPanelInteractions } from "../commands/contentPanel.js";
import { Client, Events, GatewayIntentBits, Partials, RESTEvents, type Guild } from "discord.js";
import type { AppConfig } from "../config.js";
import { handleSpecialisationMessageDeleted } from "../commands/weapon.js";
import { createMembershipRepository } from "../db/membershipRepository.js";
import { createAccountRepository } from "../db/accountRepository.js";
import { createApplicationRepository } from "../db/applicationRepository.js";
import { createContentRepository } from "../db/contentRepository.js";
import { createGuildLifecycleRepository } from "../db/guildLifecycleRepository.js";
import { createGiveawayRepository } from "../db/giveawayRepository.js";
import { createMemberUpdateScheduleRepository } from "../db/memberUpdateScheduleRepository.js";
import { createReactionRoleRepository } from "../db/reactionRoleRepository.js";
import { createRegearRepository } from "../db/regearRepository.js";
import { createReviewerRepository } from "../db/reviewerRepository.js";
import { createResetRepository } from "../db/resetRepository.js";
import { createUtcChannelRepository } from "../db/utcChannelRepository.js";
import { createTemporaryVoiceRepository } from "../db/temporaryVoiceRepository.js";
import { createTicketRepository } from "../db/ticketRepository.js";
import { createSpecialisationRepository } from "../db/specialisationRepository.js";
import { createStatusRepository } from "../db/statusRepository.js";
import { createTasksRepository } from "../db/tasksRepository.js";
import { createLogChannelRepository } from "../db/logChannelRepository.js";
import { createLogFeedService } from "../services/logFeed/delivery.js";
import { createLogFeedRuntime } from "../services/logFeed/runtime.js";
import { reconcileMembershipForGuild } from "../services/membership/reconciliation.js";
import type { PostgresPool } from "../db/postgres.js";
import type { Logger } from "../logging/logger.js";
import { createAlbionClient } from "../services/albion/client.js";
import { createContentScheduler } from "../services/content/scheduler.js";
import { createGiveawayScheduler } from "../services/giveaways/scheduler.js";
import { createGiveawayService } from "../services/giveaways/service.js";
import { handleDiscordMemberDeparture } from "../services/membership/discordMemberDepartures.js";
import { createMemberUpdateScheduler } from "../services/membership/memberUpdateScheduler.js";
import { createMembershipDepartureScheduler } from "../services/membership/departureScheduler.js";
import { createMembershipEvidenceCleanupRepository } from "../db/membershipEntitlementCleanup.js";
import { createMembershipEntitlementCleanupService } from "../services/membership/entitlementCleanup.js";
import { createUtcChannelService } from "../services/utcChannel.js";
import { createTemporaryVoiceService } from "../services/temporaryVoice.js";
import { createRegearService } from "../services/regears/service.js";
import { canonicalReactionEmojiKey } from "../services/reactionRoles/emoji.js";
import { createKeyedSerialQueue } from "../services/reactionRoles/keyedSerialQueue.js";
import { createDiscordLifecycle } from "../runtime/discordLifecycle.js";
import { registerActiveGuildCommands, registerActivationOnlyGuildCommands } from "./guildCommandRegistration.js";
import { createInteractionRouter } from "./interactionRouter.js";
import { createReactionEventCoordinator } from "./reactionEventCoordinator.js";
import { sanitizedRateLimitContext } from "./interactionObservability.js";
import { createMemberAccessRepository } from "../db/memberAccessRepository.js";
import { createMemberActionGuard } from "../runtime/memberActionGuard.js";
import { createKickRolesRepository } from "../db/kickRolesRepository.js";
import { createKickActivitiesRepository } from "../db/kickActivitiesRepository.js";
import { createKickActivitiesService } from "../services/membership/kickActivities.js";
import { createKickService } from "../services/membership/kick.js";

const INACTIVE_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface ClientDependencies {
  config: AppConfig;
  logger: Logger;
  postgres: PostgresPool;
  startedAt: Date;
  onFatalError(error: Error): void;
}

export interface DiscordRuntime {
  client: Client;
  stop(reason: string): void;
}

export function createDiscordClient(dependencies: ClientDependencies): DiscordRuntime {
  const memberAccessRepository = createMemberAccessRepository(dependencies.postgres);
  const actionGuard = createMemberActionGuard(memberAccessRepository);
  const albionClient = createAlbionClient({ logger: dependencies.logger });
  const accountRepository = createAccountRepository(dependencies.postgres);
  const applicationRepository = createApplicationRepository(dependencies.postgres);
  const contentRepository = createContentRepository(dependencies.postgres);
  const giveawayRepository = createGiveawayRepository(dependencies.postgres);
  const membershipRepository = createMembershipRepository(dependencies.postgres);
  const logChannelRepository = createLogChannelRepository(dependencies.postgres);
  const logFeedService = createLogFeedService(logChannelRepository, dependencies.logger);
  const logFeedRuntime = createLogFeedRuntime(logChannelRepository, logFeedService, dependencies.logger);
  const reactionRoleRepository = createReactionRoleRepository(dependencies.postgres);
  const regearRepository = createRegearRepository(dependencies.postgres);
  const reviewerRepository = createReviewerRepository(dependencies.postgres);
  const rawResetRepository = createResetRepository(dependencies.postgres);
  const rawLifecycleRepository = createGuildLifecycleRepository(dependencies.postgres);
  const contentPanelRepository = createContentPanelRepository(dependencies.postgres);
  const entryPanelRepository = createEntryPanelRepository(dependencies.postgres);
  const entryPanelService = createEntryPanelService({ repository: entryPanelRepository, content: contentRepository,
    contentPanels: contentPanelRepository, logger: dependencies.logger, isGuildActive: rawLifecycleRepository.isGuildActive,
    hasRegisteredCharacter: async (guildId, userId) => (await membershipRepository.listRegisteredCharacters(guildId, userId)).length > 0,
    render: async (feature, guildId, channelId, generation) => {
      if (feature === "accounts") return buildAccountsPanel(generation);
      if (feature === "regears") return buildRegearPanel(await regearRepository.listContents(guildId, undefined, "open"), generation);
      if (feature === "specialisation") return buildWeaponPanel(generation);
      return buildGiveawayPanel((await giveawayRepository.listOpen(guildId)).filter(g => g.channelId === channelId), generation).payload;
    }
  });
  const contentPanelService = entryPanelService.content;
  const contentPanelInteractions = createContentPanelInteractions({ repository: contentRepository,
    listPanelContent: contentPanelRepository.listPanelContent, logger: dependencies.logger,
    panel: contentPanelService, isGuildActive: rawLifecycleRepository.isGuildActive });
  function invalidateContent(guildId: string) {
    contentPanelInteractions.invalidateGuild(guildId);
    entryPanelService.invalidateGuild(guildId);
    for (const controller of entryPanelInteractions) controller.invalidateGuild(guildId);
  }
  async function invalidateAndRun<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    return runContentInvalidatingOperation(contentPanelService, invalidateContent, guildId, operation);
  }
  const resetRepository = { ...rawResetRepository,
    purgeGuildData: (guildId: string) => invalidateAndRun(guildId, () => rawResetRepository.purgeGuildData(guildId)) };
  const lifecycleRepository = { ...rawLifecycleRepository,
    purgeGuildImmediately: (guildId: string) => invalidateAndRun(guildId, () => rawLifecycleRepository.purgeGuildImmediately(guildId)),
    markGuildInactive: (input: Parameters<typeof rawLifecycleRepository.markGuildInactive>[0]) =>
      invalidateAndRun(input.discordGuildId, () => rawLifecycleRepository.markGuildInactive(input)),
    purgeDueInactiveGuilds: () => rawLifecycleRepository.purgeDueInactiveGuilds(invalidateAndRun)
  };
  const scheduleRepository = createMemberUpdateScheduleRepository(dependencies.postgres);
  const utcChannelRepository = createUtcChannelRepository(dependencies.postgres);
  const temporaryVoiceRepository = createTemporaryVoiceRepository(dependencies.postgres);
  const ticketRepository = createTicketRepository(dependencies.postgres);
  const specialisationRepository = createSpecialisationRepository(dependencies.postgres);
  const statusRepository = createStatusRepository(dependencies.postgres);
  const tasksRepository = createTasksRepository(dependencies.postgres);
  const memberUpdateScheduler = createMemberUpdateScheduler(
    scheduleRepository,
    membershipRepository,
    albionClient,
    dependencies.logger,
    { reconcileMembershipForGuild: (guild, albion, membership) => actionGuard.runSystem(guild.id, () => logFeedRuntime.run(guild,
      () => reconcileMembershipForGuild(guild, albion, membership), { kind: "reconciliation" })) }
  );
  const membershipEvidenceCleanup = createMembershipEntitlementCleanupService(
    createMembershipEvidenceCleanupRepository(dependencies.postgres), dependencies.logger
  );
  const membershipDepartureScheduler = createMembershipDepartureScheduler({
    membershipRepository, lifecycleRepository, reactionRoleRepository, logger: dependencies.logger,
    cleanupEvidence: guild => membershipEvidenceCleanup.reconcileGuild(guild),
    runLogged: async (guild, work) => {
      await actionGuard.runSystem(guild.id, () => logFeedRuntime.run(guild, work));
      if (!(await memberAccessRepository.listPendingKickCleanups(guild.id)).length) return;
      // Acquire separately after ordinary maintenance releases its shared lease.
      // Recovery must not overlap a retry that re-arms source cleanup state.
      await actionGuard.runSystem(guild.id, () => logFeedRuntime.run(guild, async () => {
        const warnings = await kickService.reconcileGuild(guild);
        if (warnings.length) dependencies.logger.warn("kick cleanup remains pending", { guildId: guild.id, failedOperations: warnings.length });
      }), true);
    }
  });
  const contentScheduler = createContentScheduler(contentRepository, dependencies.logger, contentPanelService, actionGuard);
  const giveawayScheduler = createGiveawayScheduler(giveawayRepository, dependencies.logger, actionGuard);
  const giveawayService = createGiveawayService(giveawayRepository, dependencies.logger);
  const utcChannelService = createUtcChannelService(utcChannelRepository, dependencies.logger);
  const temporaryVoiceService = createTemporaryVoiceService(temporaryVoiceRepository, dependencies.logger, actionGuard);
  const regearService = createRegearService(regearRepository, dependencies.logger);
  const kickActivitiesRepository = createKickActivitiesRepository(dependencies.postgres);
  const kickService = createKickService({
    membershipRepository, memberAccessRepository,
    kickRolesRepository: createKickRolesRepository(dependencies.postgres),
    activityRepository: kickActivitiesRepository,
    activityCleanup: createKickActivitiesService(kickActivitiesRepository, {
      contentRepository, giveawayRepository, giveawayService, logger: dependencies.logger
    })
  });
  const entryPanelInteractions = [
    createAccountPanelInteractions({ repository: accountRepository, entries: entryPanelService.context }),
    createRegearPanelInteractions({ repository: regearRepository, entries: entryPanelService.context }),
    createWeaponPanelInteractions({ repository: specialisationRepository, membershipRepository, reviewerRepository, logger: dependencies.logger, entries: entryPanelService.context }),
    createGiveawayPanelInteractions({ repository: giveawayRepository, logger: dependencies.logger, entries: entryPanelService.context })
  ];
  const reactionRoleConfigQueue = createKeyedSerialQueue();
  const interactionRouter = createInteractionRouter({
    actionGuard, kickService,
    config: dependencies.config, logger: dependencies.logger, postgres: dependencies.postgres, startedAt: dependencies.startedAt,
    contentPanelService, contentPanelInteractions, entryPanelService, entryPanelInteractions,
    logChannelRepository, logFeedService, logFeedRuntime,
    albionClient, accountRepository, applicationRepository, contentRepository, giveawayRepository, membershipRepository,
    reactionRoleRepository, regearRepository, reviewerRepository, resetRepository, lifecycleRepository, scheduleRepository,
    specialisationRepository, statusRepository, tasksRepository, ticketRepository, regearService, temporaryVoiceService, utcChannelService, reactionRoleConfigQueue
  });
  const reactionEvents = createReactionEventCoordinator({
    actionGuard,
    logger: dependencies.logger, lifecycleRepository, membershipRepository, reactionRoleRepository, giveawayRepository, giveawayService,
    reactionRoleConfigQueue
  });
  let inactivePurgeInterval: NodeJS.Timeout | undefined;
  let completedInitialReady = false;
  const disconnectedShards = new Set<number>();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
  });
  const lifecycle = createDiscordLifecycle({
    logger: dependencies.logger,
    startWork: startRuntimeWork,
    stopWork: stopRuntimeWork,
    onWatchdogExpired: () => dependencies.onFatalError(
      new Error("Discord remained disconnected beyond the runtime watchdog threshold")
    )
  });

  client.rest.on(RESTEvents.RateLimited, (rateLimit) => {
    dependencies.logger.warn("discord REST rate limited", sanitizedRateLimitContext(rateLimit));
  });

  client.once(Events.ClientReady, (readyClient) => {
    completedInitialReady = true;
    dependencies.logger.info("discord logged in", {
      botUserId: readyClient.user.id,
      botUsername: readyClient.user.tag,
      guildCount: readyClient.guilds.cache.size
    });

    lifecycle.connected("ready");

    for (const guild of readyClient.guilds.cache.values()) {
      void syncGuildCommands(guild).catch((error) => {
        logGuildCommandRegistrationError(guild.id, guild.name, error);
      });
      void validateReactionRolePlacements(guild);
      void temporaryVoiceService.reconcileGuild(guild).catch((error) => {
        dependencies.logger.error("temporary voice reconciliation failed", {
          guildId: guild.id,
          guildName: guild.name,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    disconnectedShards.add(shardId);
    dependencies.logger.warn("discord shard disconnected", {
      shardId,
      code: event.code,
      reason: event.reason || undefined
    });
    lifecycle.disconnected("shard-disconnect", shardId);
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    disconnectedShards.add(shardId);
    dependencies.logger.debug("discord shard reconnecting", { shardId });
    lifecycle.disconnected("shard-reconnecting", shardId);
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    disconnectedShards.delete(shardId);
    dependencies.logger.debug("discord shard resumed", { shardId, replayedEvents });
    if (disconnectedShards.size === 0 && lifecycle.connected("shard-resume", shardId)) {
      reconcileAfterReconnect();
    }
  });

  client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
    if (!completedInitialReady || !client.isReady()) return;
    disconnectedShards.delete(shardId);
    dependencies.logger.debug("discord shard ready after reconnect", {
      shardId,
      unavailableGuildCount: unavailableGuilds?.size ?? 0
    });
    if (disconnectedShards.size === 0 && lifecycle.connected("shard-ready", shardId)) {
      reconcileAfterReconnect();
    }
  });

  client.on(Events.Invalidated, () => {
    dependencies.logger.error("discord session invalidated");
    dependencies.onFatalError(new Error("Discord session invalidated"));
  });

  client.on(Events.Error, (error) => {
    dependencies.logger.error("discord client error", { error: error.message });
  });

  client.on(Events.ShardError, (error, shardId) => {
    dependencies.logger.error("discord shard error", { shardId, error: error.message });
  });

  client.on(Events.GuildCreate, (guild) => {
    void (async () => {
      const lifecycle = await lifecycleRepository.getGuildLifecycle(guild.id);
      if (lifecycle?.status === "inactive") {
        if (lifecycle.purgeAfter && lifecycle.purgeAfter <= new Date()) {
          const purged = await invalidateAndRun(guild.id, async () => {
            const current = await rawLifecycleRepository.getGuildLifecycle(guild.id);
            if (current?.status !== "inactive" || !current.purgeAfter || current.purgeAfter > new Date()) return false;
            await rawLifecycleRepository.purgeGuildImmediately(guild.id);
            return true;
          });
          if (!purged) { await syncGuildCommands(guild); return; }
          await registerActivationOnlyGuildCommands(guild, dependencies.config, dependencies.logger);
          dependencies.logger.info("purged expired inactive guild on rejoin", {
            guildId: guild.id,
            guildName: guild.name
          });
          return;
        }

        const reactivatedLifecycle = await lifecycleRepository.clearInactiveState(guild.id, guild.name);
        if (reactivatedLifecycle) {
          await registerActiveGuildCommands(guild, dependencies.config, dependencies.logger);
          dependencies.logger.info("guild rejoined before inactive purge", {
            guildId: guild.id,
            guildName: guild.name
          });
          return;
        }
      }

      await registerActivationOnlyGuildCommands(guild, dependencies.config, dependencies.logger);
    })().catch((error) => {
      logGuildCommandRegistrationError(guild.id, guild.name, error);
    });
  });

  client.on(Events.GuildDelete, (guild) => {
    void lifecycleRepository.markGuildInactive({
      discordGuildId: guild.id,
      guildName: guild.name
    }).then((lifecycle) => {
      if (!lifecycle) {
        dependencies.logger.info("ignored removed unactivated guild", {
          guildId: guild.id,
          guildName: guild.name
        });
        return;
      }

      dependencies.logger.info("marked removed guild inactive", {
        guildId: guild.id,
        guildName: guild.name,
        purgeAfter: lifecycle.purgeAfter?.toISOString()
      });
    }).catch((error) => {
      dependencies.logger.error("failed to mark removed guild inactive", {
        guildId: guild.id,
        guildName: guild.name,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  client.on(Events.GuildMemberAdd, (member) => {
    reconcileBlockedMemberAccess(member.guild, member.id);
    void lifecycleRepository.isGuildActive(member.guild.id).then(async active => {
      if (active) await logFeedService.send(member.guild, [`<@${member.id}> joined the server.`]);
    }).catch(() => dependencies.logger.warn("log feed member join unavailable", { guildId: member.guild.id }));
  });

  client.on(Events.GuildMemberUpdate, (_previous, member) => {
    reconcileBlockedMemberAccess(member.guild, member.id);
  });

  function reconcileBlockedMemberAccess(guild: Guild, userId: string): void {
    void memberAccessRepository.isMemberBlocked(guild.id, userId).then(async blocked => {
      if (!blocked) return;
      await actionGuard.runSystem(guild.id, async () => {
        if (!await memberAccessRepository.isMemberBlocked(guild.id, userId)) return;
        const warnings = await kickService.reconcileUser(guild, userId);
        if (warnings.length) dependencies.logger.warn("blocked member access cleanup remains pending", {
          guildId: guild.id, discordUserId: userId, failedOperations: warnings.length
        });
      }, true);
    }).catch(error => dependencies.logger.error("blocked member access reconciliation failed", {
      guildId: guild.id, discordUserId: userId, error: error instanceof Error ? error.message : String(error)
    }));
  }

  client.on(Events.GuildMemberRemove, (member) => {
    void giveawayRepository.removeUserFromOpenGiveaways(member.guild.id, member.id).then(async () => {
      for (const giveaway of await giveawayRepository.listOpen(member.guild.id)) {
        reactionEvents.scheduleGiveawayRender(member.guild, giveaway);
      }
    }).catch((error) => dependencies.logger.error("giveaway member departure cleanup failed", {
      guildId: member.guild.id,
      discordUserId: member.id,
      error: error instanceof Error ? error.message : String(error)
    }));
    void actionGuard.runSystem(member.guild.id, () => handleDiscordMemberDeparture(
      member,
      lifecycleRepository,
      membershipRepository,
      reactionRoleRepository,
      dependencies.logger,
      { runtime: logFeedRuntime, applicationRepository }
    )).catch((error) => {
      dependencies.logger.error("member departure cleanup failed", {
        guildId: member.guild.id,
        guildName: member.guild.name,
        discordUserId: member.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void lifecycleRepository.isGuildActive(newState.guild.id).then((isActive) => {
      if (!isActive) return;
      return temporaryVoiceService.handleVoiceStateUpdate(oldState, newState);
    }).catch((error) => {
      dependencies.logger.error("temporary voice state update failed", {
        guildId: newState.guild.id,
        guildName: newState.guild.name,
        discordUserId: newState.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.isDMBased()) {
      void giveawayRepository.markChannelDeleted(channel.guild.id, channel.id);
      void actionGuard.runSystem(channel.guild.id, () => Promise.all([
        reconcileDeletedApplicationChannel(channel.guild, channel.id, applicationRepository),
        ticketRepository.markTicketChannelDeleted(channel.guild.id, channel.id)
      ])).then(([{ application, warnings }, ticket]) => {
        if (warnings.length) dependencies.logger.warn("application channel deletion role reconciliation incomplete", {
          guildId: channel.guild.id, channelId: channel.id, applicationId: application?.applicationId,
          failedOperations: warnings.length
        });
        if (!application && !ticket) return;
        dependencies.logger.info("reconciled deleted ticket channel", {
          guildId: channel.guild.id,
          channelId: channel.id,
          applicationId: application?.applicationId,
          ticketId: ticket?.ticketId
        });
      }).catch((error) => {
        dependencies.logger.error("ticket channel deletion reconciliation failed", {
          guildId: channel.guild.id,
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      void temporaryVoiceService.handleChannelDelete(channel).catch((error) => {
        dependencies.logger.error("temporary voice channel deletion cleanup failed", {
          guildId: channel.guild.id,
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });

  client.on(Events.MessageDelete, (message) => {
    if (!message.guildId) return;
    if (message.guild) {
      void regearService.handleMessageDeleted(message.guild, message.id).catch((error) => dependencies.logger.error("re-gear message deletion reconciliation failed", {
        guildId: message.guildId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
    void giveawayRepository.markOriginalMessageDeleted(message.guildId, message.id);
    void handleSpecialisationMessageDeleted(message.guildId, message.id, specialisationRepository)
      .catch((error) => dependencies.logger.error("specialisation message deletion reconciliation failed", {
        guildId: message.guildId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error)
      }));
    void reactionRoleRepository.removePlacementsForMessage(message.guildId, message.id).then((count) => {
      if (count) dependencies.logger.info("removed deleted reaction-role message placements", { guildId: message.guildId, messageId: message.id, count });
    }).catch((error) => dependencies.logger.error("reaction-role message cleanup failed", { guildId: message.guildId, messageId: message.id, error: error instanceof Error ? error.message : String(error) }));
  });

  client.on(Events.MessageBulkDelete, (messages) => {
    for (const message of messages.values()) {
      if (message.guildId) {
        if (message.guild) {
          void regearService.handleMessageDeleted(message.guild, message.id).catch((error) => dependencies.logger.error("re-gear bulk message deletion reconciliation failed", {
            guildId: message.guildId,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
        void giveawayRepository.markOriginalMessageDeleted(message.guildId, message.id);
        void handleSpecialisationMessageDeleted(message.guildId, message.id, specialisationRepository)
          .catch((error) => dependencies.logger.error("specialisation bulk message deletion reconciliation failed", {
            guildId: message.guildId,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error)
          }));
        void reactionRoleRepository.removePlacementsForMessage(message.guildId, message.id);
      }
    }
  });

  client.on(Events.MessageReactionAdd, (reaction, user, details) => {
    if (!details.burst) reactionEvents.handleReactionChange(reaction, user, true);
  });
  client.on(Events.MessageReactionRemove, (reaction, user, details) => {
    if (!details.burst) reactionEvents.handleReactionChange(reaction, user, false);
  });
  client.on(Events.MessageReactionRemoveAll, (message) => reactionEvents.handleRemoveAll(message));
  client.on(Events.MessageReactionRemoveEmoji, (reaction) => reactionEvents.handleRemoveEmoji(reaction));

  client.on(Events.InteractionCreate, (interaction) => {
    void interactionRouter.handleInteraction(interaction);
  });

  return {
    client,
    stop(reason: string): void {
      interactionRouter.stop();
      actionGuard.stop();
      lifecycle.stop(reason);
    }
  };

  function startRuntimeWork(): void {
    entryPanelService.start();
    for (const controller of entryPanelInteractions) if ("start" in controller && typeof controller.start === "function") controller.start();
    contentPanelInteractions.start();
    void purgeDueInactiveGuilds();
    if (!inactivePurgeInterval) {
      inactivePurgeInterval = setInterval(() => void purgeDueInactiveGuilds(), INACTIVE_PURGE_INTERVAL_MS);
    }
    const getGuilds = () => client.guilds.cache.values();
    memberUpdateScheduler.startScheduler(getGuilds);
    membershipDepartureScheduler.startScheduler(getGuilds);
    contentScheduler.startScheduler(getGuilds);
    giveawayScheduler.startScheduler(getGuilds);
    regearService.startScheduler(getGuilds);
    utcChannelService.startScheduler(getGuilds);
  }

  function stopRuntimeWork(): void {
    contentPanelInteractions.stop();
    entryPanelService.stop();
    for (const controller of entryPanelInteractions) controller.stop();
    if (inactivePurgeInterval) {
      clearInterval(inactivePurgeInterval);
      inactivePurgeInterval = undefined;
    }
    memberUpdateScheduler.stopScheduler();
    membershipDepartureScheduler.stopScheduler();
    contentScheduler.stopScheduler();
    giveawayScheduler.stopScheduler();
    regearService.stopScheduler();
    utcChannelService.stopScheduler();
    reactionEvents.stop();
  }

  function reconcileAfterReconnect(): void {
    for (const guild of client.guilds.cache.values()) {
      void temporaryVoiceService.reconcileGuild(guild).catch((error) => {
        dependencies.logger.error("temporary voice reconciliation failed after reconnect", {
          guildId: guild.id,
          guildName: guild.name,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      void regearService.reconcileGuild(guild).catch((error) => {
        dependencies.logger.error("re-gear reconciliation failed after reconnect", {
          guildId: guild.id,
          guildName: guild.name,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  async function validateReactionRolePlacements(guild: Guild): Promise<void> {
    if (!await lifecycleRepository.isGuildActive(guild.id)) return;
    const placements = await reactionRoleRepository.listPlacements(guild.id);
    for (const placement of placements) {
      try {
        const channel = await guild.channels.fetch(placement.channelId);
        if (!channel) {
          await reactionRoleRepository.removePlacement(
            guild.id,
            placement.messageId,
            placement.reactionRoleConfigId
          );
          continue;
        }
        if (!channel.isTextBased() || !("messages" in channel)) {
          dependencies.logger.warn("reaction-role placement channel is inaccessible", {
            guildId: guild.id,
            channelId: placement.channelId,
            messageId: placement.messageId,
            reactionRoleConfigId: placement.reactionRoleConfigId
          });
          continue;
        }
        const message = await channel.messages.fetch(placement.messageId);
        const reaction = message.reactions.cache.find(
          (candidate) => canonicalReactionEmojiKey(candidate.emoji) === placement.emojiKey
        );
        if (!reaction) {
          dependencies.logger.warn("reaction-role placement is missing its seeded reaction", {
            guildId: guild.id,
            channelId: placement.channelId,
            messageId: placement.messageId,
            reactionRoleConfigId: placement.reactionRoleConfigId,
            emojiKey: placement.emojiKey
          });
        }
        if (
          placement.emojiKey.startsWith("custom:")
          && !client.emojis.resolve(placement.emojiKey.slice("custom:".length))
        ) {
          dependencies.logger.warn("reaction-role placement custom emoji is unavailable", {
            guildId: guild.id,
            channelId: placement.channelId,
            messageId: placement.messageId,
            reactionRoleConfigId: placement.reactionRoleConfigId,
            emojiKey: placement.emojiKey
          });
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: number }).code
          : undefined;
        if (code === 10003 || code === 10008) {
          await reactionRoleRepository.removePlacement(
            guild.id,
            placement.messageId,
            placement.reactionRoleConfigId
          );
          dependencies.logger.info("removed stale reaction-role placement", {
            guildId: guild.id,
            channelId: placement.channelId,
            messageId: placement.messageId,
            reactionRoleConfigId: placement.reactionRoleConfigId
          });
          continue;
        }
        dependencies.logger.warn("reaction-role placement validation failed", {
          guildId: guild.id,
          channelId: placement.channelId,
          messageId: placement.messageId,
          reactionRoleConfigId: placement.reactionRoleConfigId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async function syncGuildCommands(guild: Guild): Promise<void> {
    if (await lifecycleRepository.isGuildActive(guild.id)) {
      await registerActiveGuildCommands(guild, dependencies.config, dependencies.logger);
      return;
    }

    await registerActivationOnlyGuildCommands(guild, dependencies.config, dependencies.logger);
  }

  async function purgeDueInactiveGuilds(): Promise<void> {
    try {
      const purgedGuildIds = await lifecycleRepository.purgeDueInactiveGuilds();
      if (purgedGuildIds.length > 0) {
        dependencies.logger.info("purged inactive guild data", {
          guildIds: purgedGuildIds
        });
      }
    } catch (error) {
      dependencies.logger.error("inactive guild purge failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function logGuildCommandRegistrationError(guildId: string, guildName: string, error: unknown): void {
    dependencies.logger.error("guild command registration failed", {
      guildId,
      guildName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Fence both existing work and work admitted while a destructive transition waits/runs.
export async function runContentInvalidatingOperation<T>(
  queue: { runExclusive<R>(guildId: string, operation: () => Promise<R>): Promise<R> },
  invalidate: (guildId: string) => void,
  guildId: string,
  operation: () => Promise<T>
): Promise<T> {
  invalidate(guildId);
  return queue.runExclusive(guildId, async () => {
    invalidate(guildId);
    try { return await operation(); }
    finally { invalidate(guildId); }
  });
}
