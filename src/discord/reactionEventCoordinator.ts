import type { Guild, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { createGiveawayRepository } from "../db/giveawayRepository.js";
import { createGuildLifecycleRepository } from "../db/guildLifecycleRepository.js";
import { createMembershipRepository } from "../db/membershipRepository.js";
import { createReactionRoleRepository } from "../db/reactionRoleRepository.js";
import type { Logger } from "../logging/logger.js";
import { createGiveawayService, giveawayReactionAction, isGiveawayEntryEmojiKey, shouldRemoveClosedGiveawayReaction } from "../services/giveaways/service.js";
import { reconcileConfiguredRoles } from "../services/membership/discordMemberUpdates.js";
import { canonicalReactionEmojiKey } from "../services/reactionRoles/emoji.js";
import { createKeyedSerialQueue } from "../services/reactionRoles/keyedSerialQueue.js";
import { botReactionRemovalSuppressor, reactionChangeKey, reactionRoleConfigChangeKey, reactionSubscriptionAction } from "../services/reactionRoles/subscriptions.js";
import type { MemberActionGuard } from "../runtime/memberActionGuard.js";
export interface ReactionEventCoordinatorDependencies {
  actionGuard: MemberActionGuard;
  logger: Logger;
  lifecycleRepository: ReturnType<typeof createGuildLifecycleRepository>;
  membershipRepository: ReturnType<typeof createMembershipRepository>;
  reactionRoleRepository: ReturnType<typeof createReactionRoleRepository>;
  giveawayRepository: ReturnType<typeof createGiveawayRepository>;
  giveawayService: ReturnType<typeof createGiveawayService>;
  reactionRoleConfigQueue: ReturnType<typeof createKeyedSerialQueue>;
}

export function createReactionEventCoordinator(dependencies: ReactionEventCoordinatorDependencies) {
  const { lifecycleRepository, membershipRepository, reactionRoleRepository, giveawayRepository, giveawayService, reactionRoleConfigQueue } = dependencies;
  const reactionChangeQueue = createKeyedSerialQueue();
  const giveawayRenderTimeouts = new Map<string, NodeJS.Timeout>();

  function handleReactionChange(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    subscribe: boolean
  ): void {
    if (user.bot || !reaction.message.guildId) return;
    const emojiKey = canonicalReactionEmojiKey(reaction.emoji);
    if (!emojiKey) return;
    const key = reactionChangeKey(
      reaction.message.guildId,
      reaction.message.id,
      emojiKey,
      user.id
    );
    if (!subscribe && botReactionRemovalSuppressor.consume(key)) return;
    void reactionChangeQueue
      .enqueue(key, async () => {
        await dependencies.actionGuard.run(reaction.message.guildId!, user.id,
          () => processReactionChange(reaction, user, emojiKey, subscribe, key));
      })
      .catch((error) => {
        dependencies.logger.error("reaction-role event failed", {
          guildId: reaction.message.guildId,
          messageId: reaction.message.id,
          discordUserId: user.id,
          emojiKey,
          subscribe,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async function processReactionChange(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    emojiKey: string,
    subscribe: boolean,
    changeKey: string
  ): Promise<void> {
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }
    if (user.partial) {
      user = await user.fetch();
    }
    if (user.bot || !reaction.message.guildId) return;
    const guild = reaction.message.guild;
    if (!guild || !await lifecycleRepository.isGuildActive(guild.id)) return;
    const placement = await reactionRoleRepository.getPlacementByReaction(
      guild.id,
      reaction.message.id,
      emojiKey
    );
    const giveaway = await giveawayRepository.getByMessage(guild.id, reaction.message.id);
    if (giveaway?.state === "open") {
      const isEntryEmoji = isGiveawayEntryEmojiKey(emojiKey);
      const isManagedUser = isEntryEmoji && subscribe
        ? await giveawayRepository.isManagedUser(guild.id, user.id)
        : false;
      const action = giveawayReactionAction(
        emojiKey,
        subscribe,
        isManagedUser
      );
      if (action === "join") {
        await giveawayRepository.addReaction(guild.id, giveaway.giveawayId, user.id, emojiKey);
      } else if (action === "leave") {
        await giveawayRepository.removeReaction(guild.id, giveaway.giveawayId, user.id, emojiKey);
      }
      if (action !== "ignore") scheduleGiveawayRender(guild, giveaway);
      return;
    }
    if (giveaway && isGiveawayEntryEmojiKey(emojiKey)) {
      if (shouldRemoveClosedGiveawayReaction(giveaway.state, emojiKey, subscribe)) {
        try {
          await reaction.users.remove(user.id);
        } catch (error) {
          dependencies.logger.warn("could not remove a gift reaction from a closed giveaway", {
            guildId: guild.id,
            giveawayId: giveaway.giveawayId,
            messageId: reaction.message.id,
            discordUserId: user.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return;
    }
    if (!placement) return;

    await reactionRoleConfigQueue.enqueue(
      reactionRoleConfigChangeKey(guild.id, placement.reactionRoleConfigId),
      () => processConfiguredReactionRoleChange(guild, reaction, user, placement.reactionRoleConfigId, emojiKey, subscribe, changeKey)
    );
  }

  async function processConfiguredReactionRoleChange(
    guild: Guild,
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    reactionRoleConfigId: string,
    emojiKey: string,
    subscribe: boolean,
    changeKey: string
  ): Promise<void> {

    const isManagedUser = await reactionRoleRepository.isManagedUser(guild.id, user.id);
    const subscriptionAction = reactionSubscriptionAction(subscribe, isManagedUser);

    if (subscriptionAction === "preserve_dormant" && subscribe) {
      botReactionRemovalSuppressor.mark(changeKey);
      try {
        await reaction.users.remove(user.id);
      } catch (error) {
        botReactionRemovalSuppressor.cancel(changeKey);
        dependencies.logger.warn("could not remove unmanaged user's reaction-role reaction", {
          guildId: guild.id,
          messageId: reaction.message.id,
          discordUserId: user.id,
          emojiKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (subscriptionAction === "subscribe") {
      try {
        await retryReactionPersistence(() => reactionRoleRepository.subscribe(
          guild.id,
          reactionRoleConfigId,
          user.id
        ));
      } catch (error) {
        await reaction.users.remove(user.id).catch(() => undefined);
        throw error;
      }
    } else if (subscriptionAction === "unsubscribe") {
      await retryReactionPersistence(() => reactionRoleRepository.unsubscribe(
        guild.id,
        reactionRoleConfigId,
        user.id
      ));
    }

    const warnings = await reconcileConfiguredRoles(guild, membershipRepository, user.id);
    for (const warning of warnings) {
      dependencies.logger.warn("reaction-role reconciliation warning", {
        guildId: guild.id,
        messageId: reaction.message.id,
        discordUserId: user.id,
        emojiKey,
        subscribe,
        warning: warning.message
      });
    }
  }

  async function retryReactionPersistence<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      return operation();
    }
  }

  function scheduleGiveawayRender(guild: Guild, giveaway: import("../db/giveawayRepository.js").GiveawayRecord): void {
    const key = `${guild.id}:${giveaway.giveawayId}`;
    const existing = giveawayRenderTimeouts.get(key);
    if (existing) clearTimeout(existing);
    giveawayRenderTimeouts.set(key, setTimeout(() => {
      giveawayRenderTimeouts.delete(key);
      void giveawayService.refreshOpenMessage(guild, giveaway).catch((error) => {
        dependencies.logger.error("giveaway participant render failed", {
          guildId: guild.id,
          giveawayId: giveaway.giveawayId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 1500));
  }

  function handleRemoveAll(message: { guildId: string | null; id: string; guild: Guild | null }): void {
    if (!message.guildId) return;
    void giveawayRepository.removeReactionsForMessage(message.guildId, message.id).then(async () => {
      const giveaway = await giveawayRepository.getOpenByMessage(message.guildId!, message.id);
      if (giveaway && message.guild) scheduleGiveawayRender(message.guild, giveaway);
    });
  }

  function handleRemoveEmoji(reaction: MessageReaction | PartialMessageReaction): void {
    if (!reaction.message.guildId) return;
    const emojiKey = canonicalReactionEmojiKey(reaction.emoji);
    if (!emojiKey || !isGiveawayEntryEmojiKey(emojiKey)) return;
    void giveawayRepository.removeReactionsForMessage(reaction.message.guildId, reaction.message.id, emojiKey).then(async () => {
      const giveaway = await giveawayRepository.getOpenByMessage(reaction.message.guildId!, reaction.message.id);
      if (giveaway && reaction.message.guild) scheduleGiveawayRender(reaction.message.guild, giveaway);
    });
  }

  function stop(): void {
    for (const timeout of giveawayRenderTimeouts.values()) clearTimeout(timeout);
    giveawayRenderTimeouts.clear();
  }

  return { handleReactionChange, handleRemoveAll, handleRemoveEmoji, scheduleGiveawayRender, stop };
}
