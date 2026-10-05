import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type Role
} from "discord.js";
import type { createGiveawayRepository } from "../db/giveawayRepository.js";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import {
  ReactionRolePlacementConflictError,
  type ReactionRoleConfig,
  type ReactionRoleEmojiPlacement,
  type createReactionRoleRepository
} from "../db/reactionRoleRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import {
  fetchGuildMemberIfPresent,
  isDiscordErrorCode
} from "../discord/guildMembers.js";
import { v2Edit } from "../discord/operationalMessages.js";
import {
  canonicalReactionEmojiKey,
  parseReactionEmojiInput
} from "../services/reactionRoles/emoji.js";
import { reactionRoleConfigChangeKey } from "../services/reactionRoles/subscriptions.js";
import {
  REPORT_COLOR,
  WARNING_COLOR,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatRole,
  normalizeQuery,
  roleName,
  truncateChoiceName
} from "./configurationHelpers.js";

type Repository = ReturnType<typeof createReactionRoleRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type GiveawayRepository = Pick<ReturnType<typeof createGiveawayRepository>, "getOpenByMessage">;
type ReactionRoleConfigQueue = {
  enqueue(key: string, operation: () => Promise<void>): Promise<void>;
};

export const reactionCommand = new SlashCommandBuilder()
  .setName("reaction")
  .setDescription("Manage server-wide reaction roles.")
  .setDefaultMemberPermissions(0)
  .addSubcommandGroup((group) => group
    .setName("roles")
    .setDescription("Configure reaction roles.")
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Configure an existing Discord role.")
      .addRoleOption((option) => option
        .setName("role")
        .setDescription("Discord role.")
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("remove")
      .setDescription("Remove a reaction role from tracked and cached members.")
      .addStringOption(roleOption))
    .addSubcommand((subcommand) => subcommand
      .setName("list")
      .setDescription("List configured reaction roles.")))
  .addSubcommandGroup((group) => group
    .setName("emoji")
    .setDescription("Attach emoji reactions to configured roles.")
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Attach a role emoji to a bot-authored message.")
      .addStringOption(messageOption)
      .addStringOption(roleOption)
      .addStringOption((option) => option
        .setName("emoji")
        .setDescription("One Unicode emoji or an available custom emoji.")
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("remove")
      .setDescription("Remove one configured role emoji.")
      .addStringOption(roleOption)));

function roleOption(option: any) {
  return option
    .setName("role")
    .setDescription("Configured reaction role.")
    .setRequired(true)
    .setAutocomplete(true);
}

function messageOption(option: any) {
  return option
    .setName("message")
    .setDescription("Message link, or ID for a message in this channel.")
    .setRequired(true);
}

export async function handleReactionAutocomplete(
  interaction: AutocompleteInteraction,
  repository: Repository
): Promise<boolean> {
  if (interaction.commandName !== "reaction") return false;
  const focused = interaction.options.getFocused(true);
  const query = normalizeQuery(focused.value);
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  const [configs, placements] = await Promise.all([
    repository.listConfigs(interaction.guildId ?? ""),
    repository.listPlacements(interaction.guildId ?? "")
  ]);
  const placedConfigIds = new Set(placements.map((placement) => placement.reactionRoleConfigId));
  const choices = configs
    .filter((config) => {
      if (group !== "emoji") return true;
      if (subcommand === "add") {
        return !placedConfigIds.has(config.reactionRoleConfigId);
      }
      if (subcommand === "remove") {
        return placedConfigIds.has(config.reactionRoleConfigId);
      }
      return true;
    })
    .filter((config) => roleName(interaction.guild, config.discordRoleId).toLowerCase().includes(query))
    .slice(0, 25);
  await interaction.respond(choices.map((config) => ({
    name: truncateChoiceName(roleName(interaction.guild, config.discordRoleId)),
    value: config.reactionRoleConfigId
  })));
  return true;
}

export async function handleReactionCommand(
  interaction: ChatInputCommandInteraction,
  repository: Repository,
  membership: MembershipRepository,
  giveaways?: GiveawayRepository,
  configQueue?: ReactionRoleConfigQueue
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(true);
  const subcommand = interaction.options.getSubcommand(true);

  if (group === "roles" && subcommand === "add") {
    const role = interaction.options.getRole("role", true) as Role;
    const problem = roleProblem(interaction.guild!.members.me!, role);
    if (problem) return replyInvalid(interaction, "Role Not Manageable", problem);
    if ((await membership.listConfiguredRoleIdsForGuild(interaction.guildId!)).includes(role.id)) {
      return replyInvalid(
        interaction,
        "Role Already Managed",
        "This role is already configured as a standard, group-scoped, or reaction role."
      );
    }
    await repository.addConfig(interaction.guildId!, role.id, interaction.user.id);
    return replySuccess(
      interaction,
      "Reaction Role Configured",
      `${formatRole(role.id)} is configured as an opt-in reaction role for managed users.`
    );
  }

  if (group === "roles" && subcommand === "list") {
    return listRoles(interaction, repository);
  }

  if (group === "roles" && subcommand === "remove") {
    return removeRole(
      interaction,
      repository,
      interaction.options.getString("role", true),
      configQueue
    );
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const idOrRoleId = interaction.options.getString("role", true);
  const config = await repository.getConfig(
    interaction.guildId!,
    idOrRoleId
  );
  if (!config) {
    return replyInvalid(
      interaction,
      "Reaction Role Not Found",
      "Choose a configured reaction role from autocomplete."
    );
  }

  const operate = async (currentConfig: ReactionRoleConfig) => {
    if (subcommand === "remove") {
      return removeEmojiPlacement(interaction, repository, currentConfig);
    }
    return addEmojiPlacement(interaction, repository, currentConfig, giveaways);
  };
  if (!configQueue) return operate(config);
  await configQueue.enqueue(
    reactionRoleConfigChangeKey(interaction.guildId!, config.reactionRoleConfigId),
    async () => {
      const currentConfig = await repository.getConfig(
        interaction.guildId!,
        config.reactionRoleConfigId
      );
      if (!currentConfig) {
        await replyInvalid(
          interaction,
          "Reaction Role Not Found",
          "The reaction role was removed before its emoji placement could be changed."
        );
        return;
      }
      await operate(currentConfig);
    }
  );
}

async function addEmojiPlacement(
  interaction: ChatInputCommandInteraction,
  repository: Repository,
  config: ReactionRoleConfig,
  giveaways?: GiveawayRepository
): Promise<void> {
  const existing = await repository.getPlacementForConfig(
    interaction.guildId!,
    config.reactionRoleConfigId
  );
  if (existing) {
    const health = await fetchPlacementMessage(interaction.guild!, existing);
    if (health.status === "missing") {
      await repository.removePlacement(
        interaction.guildId!,
        existing.messageId,
        config.reactionRoleConfigId
      );
    } else if (health.status === "inaccessible") {
      return replyInvalid(
        interaction,
        "Existing Placement Inaccessible",
        "Guild Manager cannot verify the existing placement. Restore channel access or remove it after permissions are corrected."
      );
    } else {
      return replyInvalid(
        interaction,
        "Reaction Role Already Attached",
        `${formatRole(config.discordRoleId)} already has an emoji placement at ${health.message.url}.`
      );
    }
  }

  const reference = parseMessageReference(
    interaction.options.getString("message", true),
    interaction.guildId!,
    interaction.channelId
  );
  if (!reference) {
    return replyInvalid(
      interaction,
      "Message Not Found",
      "Use a message link from this Discord server or a message ID from this channel."
    );
  }
  const target = await fetchTargetMessage(interaction, reference);
  if (!target) return;
  if (giveaways && await giveaways.getOpenByMessage(interaction.guildId!, target.id)) {
    return replyInvalid(
      interaction,
      "Giveaway Message In Use",
      "Active giveaway messages cannot also host reaction roles."
    );
  }

  const permissionProblem = reactionPermissionProblem(
    target,
    interaction.guild!.members.me!
  );
  if (permissionProblem) {
    return replyInvalid(interaction, "Reaction Permissions Missing", permissionProblem);
  }

  const parsedEmoji = parseReactionEmojiInput(
    interaction.options.getString("emoji", true)
  );
  if (!parsedEmoji) {
    return replyInvalid(
      interaction,
      "Invalid Emoji",
      "Provide exactly one standard Unicode emoji or one custom emoji mention available to Guild Manager."
    );
  }
  if (parsedEmoji.customEmojiId) {
    const customEmoji = interaction.client.emojis.resolve(parsedEmoji.customEmojiId)
      ?? await interaction.guild!.emojis.fetch(parsedEmoji.customEmojiId).catch(() => undefined);
    if (!customEmoji?.available) {
      return replyInvalid(
        interaction,
        "Emoji Not Available",
        "Guild Manager cannot access that custom emoji."
      );
    }
    if (
      customEmoji.guild.id !== interaction.guildId
      && target.inGuild()
      && !target.channel.permissionsFor(interaction.guild!.members.me!)?.has(
        PermissionFlagsBits.UseExternalEmojis
      )
    ) {
      return replyInvalid(
        interaction,
        "Emoji Not Available",
        "Guild Manager needs Use External Emoji permission for that custom emoji."
      );
    }
  }

  const mapped = await repository.getPlacementByReaction(
    interaction.guildId!,
    target.id,
    parsedEmoji.emojiKey
  );
  if (mapped) {
    return replyInvalid(
      interaction,
      "Emoji Already Used",
      `${parsedEmoji.displayValue} already maps to ${formatRole(mapped.discordRoleId)} on that message.`
    );
  }

  let seed;
  try {
    seed = await target.react(parsedEmoji.displayValue);
  } catch {
    return replyInvalid(
      interaction,
      "Emoji Not Usable",
      "Discord rejected that reaction. Check the emoji and Guild Manager's channel permissions."
    );
  }

  try {
    const placement = await repository.addPlacement({
      reactionRoleConfigId: config.reactionRoleConfigId,
      discordGuildId: interaction.guildId!,
      channelId: target.channel.id,
      messageId: target.id,
      emojiKey: parsedEmoji.emojiKey,
      emojiDisplayValue: parsedEmoji.displayValue,
      createdByDiscordUserId: interaction.user.id
    });
    if (!placement) {
      await seed.users.remove(interaction.client.user.id).catch(() => undefined);
      return replyInvalid(
        interaction,
        "Reaction Role Not Found",
        "The reaction role was removed before its emoji placement could be saved."
      );
    }
  } catch (error) {
    if (!(error instanceof ReactionRolePlacementConflictError)) {
      await seed.users.remove(interaction.client.user.id).catch(() => undefined);
      throw error;
    }
    const winningMapping = await repository.getPlacementByReaction(
      interaction.guildId!,
      target.id,
      parsedEmoji.emojiKey
    );
    if (!winningMapping) {
      await seed.users.remove(interaction.client.user.id).catch(() => undefined);
    }
    return replyInvalid(
      interaction,
      error.conflict === "role_has_placement"
        ? "Reaction Role Already Attached"
        : "Emoji Already Used",
      error.conflict === "role_has_placement"
        ? "Another placement claimed this reaction role. Refresh and try again."
        : "Another placement claimed that emoji on this message. Refresh and try again."
    );
  }

  const subscriberCount = await repository.countSubscriptions(
    interaction.guildId!,
    config.reactionRoleConfigId
  );
  const warning = subscriberCount > 0
    ? `\n\n${subscriberCount} existing subscriber(s) keep their roles, but Discord cannot recreate their selected reactions on this message.`
    : "";
  return replySuccess(
    interaction,
    "Reaction Emoji Added",
    `${parsedEmoji.displayValue} now grants ${formatRole(config.discordRoleId)} on ${target.url}.${warning}`
  );
}

async function removeEmojiPlacement(
  interaction: ChatInputCommandInteraction,
  repository: Repository,
  config: ReactionRoleConfig
): Promise<void> {
  const placement = await repository.getPlacementForConfig(
    interaction.guildId!,
    config.reactionRoleConfigId
  );
  if (!placement) {
    return replyInvalid(
      interaction,
      "Reaction Emoji Not Found",
      "That reaction role does not have an emoji placement."
    );
  }

  const fetched = await fetchPlacementMessage(interaction.guild!, placement);
  if (fetched.status === "inaccessible") {
    return replyInvalid(
      interaction,
      "Reaction Emoji Inaccessible",
      "Guild Manager cannot access the configured message. Restore channel access before removing the placement."
    );
  }
  if (fetched.status === "found") {
    const reaction = fetched.message.reactions.cache.find(
      (candidate) => canonicalReactionEmojiKey(candidate.emoji) === placement.emojiKey
    );
    if (reaction) {
      try {
        await reaction.remove();
      } catch {
        return replyInvalid(
          interaction,
          "Reaction Emoji Not Removed",
          "Discord rejected reaction cleanup. Check Guild Manager's Manage Messages permission and try again."
        );
      }
    }
  }

  await repository.removePlacement(
    interaction.guildId!,
    placement.messageId,
    config.reactionRoleConfigId
  );
  const location = fetched.status === "found"
    ? fetched.message.url
    : "the deleted message";
  return replySuccess(
    interaction,
    "Reaction Emoji Removed",
    `${placement.emojiDisplayValue} was detached from ${location}. Existing subscriptions and role assignments were preserved.`
  );
}

async function removeRole(
  interaction: ChatInputCommandInteraction,
  repository: Repository,
  idOrRoleId: string,
  configQueue?: ReactionRoleConfigQueue
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = await repository.getConfig(interaction.guildId!, idOrRoleId);
  if (!config) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed(
        "Reaction Role Not Found",
        "Choose a configured reaction role from autocomplete."
      )]
    }, "context");
    return;
  }

  const remove = () => removeConfiguredRole(interaction, repository, config);
  if (configQueue) {
    await configQueue.enqueue(
      reactionRoleConfigChangeKey(interaction.guildId!, config.reactionRoleConfigId),
      async () => {
        const currentConfig = await repository.getConfig(
          interaction.guildId!,
          config.reactionRoleConfigId
        );
        if (!currentConfig) {
          await editFeedback(interaction, {
            cards: [buildNotFoundEmbed(
              "Reaction Role Not Found",
              "Choose a configured reaction role from autocomplete."
            )]
          }, "context");
          return;
        }
        await removeConfiguredRole(interaction, repository, currentConfig);
      }
    );
    return;
  }
  await remove();
}

async function removeConfiguredRole(
  interaction: ChatInputCommandInteraction,
  repository: Repository,
  config: ReactionRoleConfig
): Promise<void> {

  let role: Role | undefined;
  try {
    role = await interaction.guild!.roles.fetch(config.discordRoleId) ?? undefined;
  } catch (error) {
    if (!isDiscordErrorCode(error, 10_011)) throw error;
  }

  let failed = 0;
  if (role) {
    const subscriberIds = await repository.listSubscriberDiscordUserIds(
      interaction.guildId!,
      config.reactionRoleConfigId
    );
    const candidateIds = new Set([
      ...subscriberIds,
      ...role.members.keys()
    ]);
    for (const discordUserId of candidateIds) {
      try {
        const member = await fetchGuildMemberIfPresent(interaction.guild!, discordUserId);
        if (!member?.roles.cache.has(role.id)) continue;
        await member.roles.remove(role, "Reaction role configuration removed");
      } catch {
        failed++;
      }
    }
  }
  if (failed) {
    await interaction.editReply(v2Edit({
      cards: [new EmbedBuilder()
        .setColor(WARNING_COLOR)
        .setTitle("Reaction Role Removal Incomplete")
        .setDescription(
          `Could not remove ${formatRole(config.discordRoleId)} from ${failed} member(s). The configuration was retained so you can correct permissions and retry.`
        )]
    }));
    return;
  }

  let placementWarning = "";
  const placement = await repository.getPlacementForConfig(
    interaction.guildId!,
    config.reactionRoleConfigId
  );
  if (placement) {
    const fetched = await fetchPlacementMessage(interaction.guild!, placement);
    if (fetched.status === "found") {
      const reaction = fetched.message.reactions.cache.find(
        (candidate) => canonicalReactionEmojiKey(candidate.emoji) === placement.emojiKey
      );
      if (reaction) {
        try {
          await reaction.remove();
        } catch {
          placementWarning = "\n\nGuild Manager could not remove the old message reaction; it is now unmapped.";
        }
      }
    } else if (fetched.status === "inaccessible") {
      placementWarning = "\n\nGuild Manager could not access the old message reaction; it is now unmapped.";
    }
  }
  await repository.removeConfig(interaction.guildId!, config.reactionRoleConfigId);
  await editFeedback(interaction, {
    cards: [buildSuccessEmbed(
      "Reaction Role Removed",
      `${formatRole(config.discordRoleId)}, its subscriptions, and emoji placement were removed.${placementWarning}`
    )]
  });
}

async function listRoles(
  interaction: ChatInputCommandInteraction,
  repository: Repository
): Promise<void> {
  const [configs, placements, subscriptionCounts] = await Promise.all([
    repository.listConfigs(interaction.guildId!),
    repository.listPlacements(interaction.guildId!),
    repository.listSubscriptionCounts(interaction.guildId!)
  ]);
  const placementByConfig = new Map(
    placements.map((placement) => [placement.reactionRoleConfigId, placement])
  );
  const statuses = await Promise.all(configs.map(async (config) => {
    const placement = placementByConfig.get(config.reactionRoleConfigId);
    return {
      config,
      placement: await describePlacement(interaction.guild!, placement),
      subscriberCount: subscriptionCounts.get(config.reactionRoleConfigId) ?? 0
    };
  }));
  await interaction.reply(feedbackReply({
    structured: statuses.length > 0,
    cards: [new EmbedBuilder()
      .setColor(REPORT_COLOR)
      .setTitle("Reaction Roles")
      .setDescription(statuses.map((status) =>
        `${formatRole(status.config.discordRoleId)} • ${status.subscriberCount} subscriber(s)\n${status.placement}`
      ).join("\n\n") || "No reaction roles are configured.")],
    flags: MessageFlags.Ephemeral
  }));
}

async function describePlacement(
  guild: Guild,
  placement: ReactionRoleEmojiPlacement | undefined
): Promise<string> {
  if (!placement) return "Unattached";
  const fetched = await fetchPlacementMessage(guild, placement);
  if (fetched.status === "missing") {
    return `${placement.emojiDisplayValue} • Missing message`;
  }
  if (fetched.status === "inaccessible") {
    return `${placement.emojiDisplayValue} • Inaccessible message`;
  }
  const seeded = fetched.message.reactions.cache.some(
    (reaction) => canonicalReactionEmojiKey(reaction.emoji) === placement.emojiKey
  );
  return `${placement.emojiDisplayValue} • ${seeded ? "" : "Missing reaction • "}[message](${fetched.message.url})`;
}

async function fetchTargetMessage(
  interaction: ChatInputCommandInteraction,
  reference: MessageReference
): Promise<Message | undefined> {
  const channel = await interaction.guild!.channels.fetch(reference.channelId).catch(() => undefined);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    await replyInvalid(
      interaction,
      "Message Not Found",
      "Use a message link or an ID from a text channel Guild Manager can access."
    );
    return undefined;
  }
  const message = await channel.messages.fetch(reference.messageId).catch(() => undefined);
  if (!message) {
    await replyInvalid(
      interaction,
      "Message Not Found",
      "Guild Manager could not find that message."
    );
    return undefined;
  }
  if (message.author.id !== interaction.client.user.id) {
    await replyInvalid(
      interaction,
      "Bot Message Required",
      "Choose a message authored by Guild Manager."
    );
    return undefined;
  }
  return message;
}

type PlacementFetchResult =
  | { status: "found"; message: Message }
  | { status: "missing" }
  | { status: "inaccessible" };

async function fetchPlacementMessage(
  guild: Guild,
  placement: Pick<ReactionRoleEmojiPlacement, "channelId" | "messageId">
): Promise<PlacementFetchResult> {
  let channel;
  try {
    channel = await guild.channels.fetch(placement.channelId);
  } catch (error) {
    return isConfirmedMissing(error) ? { status: "missing" } : { status: "inaccessible" };
  }
  if (!channel) return { status: "missing" };
  if (!channel.isTextBased() || !("messages" in channel)) return { status: "inaccessible" };
  try {
    return { status: "found", message: await channel.messages.fetch(placement.messageId) };
  } catch (error) {
    return isConfirmedMissing(error) ? { status: "missing" } : { status: "inaccessible" };
  }
}

function parseMessageReference(
  input: string,
  discordGuildId: string,
  currentChannelId: string
): MessageReference | undefined {
  const value = input.trim();
  const link = value.match(/(?:https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/)?channels\/(\d+)\/(\d+)\/(\d+)$/i);
  if (link) {
    if (link[1] !== discordGuildId) return undefined;
    return { channelId: link[2], messageId: link[3] };
  }
  if (/^\d+$/.test(value)) {
    return { channelId: currentChannelId, messageId: value };
  }
  return undefined;
}

function reactionPermissionProblem(message: Message, bot: GuildMember): string | undefined {
  if (!message.inGuild()) return "Choose a message in this Discord server.";
  const permissions = message.channel.permissionsFor(bot);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    return "Guild Manager needs View Channel permission.";
  }
  if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    return "Guild Manager needs Read Message History permission.";
  }
  if (!permissions.has(PermissionFlagsBits.AddReactions)) {
    return "Guild Manager needs Add Reactions permission.";
  }
  if (!permissions.has(PermissionFlagsBits.ManageMessages)) {
    return "Guild Manager needs Manage Messages permission to remove invalid reactions.";
  }
  return undefined;
}

function roleProblem(bot: GuildMember, role: Role): string | undefined {
  if (role.id === role.guild.id) return "The @everyone role cannot be configured.";
  if (role.managed) return "Discord-managed roles cannot be assigned by the bot.";
  if (bot.roles.highest.comparePositionTo(role) <= 0) {
    return "Move Guild Manager's highest role above this role first.";
  }
  return undefined;
}

async function replyInvalid(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string
): Promise<void> {
  const response = { cards: [buildNotFoundEmbed(title, description)] };
  if (interaction.deferred) await editFeedback(interaction, response, "context");
  else await interaction.reply(feedbackReply({ ...response, flags: MessageFlags.Ephemeral }, "context"));
}

async function replySuccess(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string
): Promise<void> {
  const response = { cards: [buildSuccessEmbed(title, description)] };
  if (interaction.deferred) await editFeedback(interaction, response);
  else await interaction.reply(feedbackReply({ ...response, flags: MessageFlags.Ephemeral }));
}

function isConfirmedMissing(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: number }).code
    : undefined;
  return code === 10003 || code === 10008;
}

interface MessageReference {
  channelId: string;
  messageId: string;
}
