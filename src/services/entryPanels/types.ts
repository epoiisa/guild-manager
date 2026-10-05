import type { ButtonInteraction, ChatInputCommandInteraction, Guild, GuildMember, ModalSubmitInteraction, NewsChannel, RoleSelectMenuInteraction, StringSelectMenuInteraction, TextChannel, UserSelectMenuInteraction } from "discord.js";
import type { createEntryPanelRepository } from "../../db/entryPanelRepository.js";

export const ENTRY_FEATURES = ["accounts", "regears", "specialisation", "giveaways"] as const;
export type EntryFeature = typeof ENTRY_FEATURES[number];
export type EntryRole = "accounts_manager";
export const ENTRY_NAMES: Record<EntryFeature, string> = { accounts: "Accounts", regears: "Re-gears", specialisation: "Weapon Specialisation", giveaways: "Giveaways" };
export type EntryInteraction = ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | RoleSelectMenuInteraction;
export interface EntrySelection { discordChannelId: string; configurationRevision: string }
export interface EntryAccess extends EntrySelection { channel: TextChannel | NewsChannel; member: GuildMember }
export interface EntryPanelContext {
  repository: ReturnType<typeof createEntryPanelRepository>;
  checkAccess(interaction: EntryInteraction, feature: EntryFeature, options?: {
    mutation?: boolean;
    expected?: EntrySelection;
    generation?: string;
  }): Promise<EntryAccess | undefined>;
  requireRole(interaction: EntryInteraction, role: EntryRole): Promise<boolean>;
  hasRole(guildId: string, role: EntryRole, member: GuildMember): Promise<boolean>;
  runExclusive<T>(guildId: string, operation: () => Promise<T>): Promise<T>;
  refresh(guild: Guild): Promise<void>;
}

export function entryPanelId(feature: EntryFeature, generation: string, action: string) {
  return `entry-panel:${feature}:${generation}:${action}`;
}
export function parseEntryPanelId(id: string) {
  const match = /^entry-panel:(accounts|regears|specialisation|giveaways):([A-Za-z0-9_-]{1,25}):([a-z0-9_-]+)$/.exec(id);
  return match ? { feature: match[1] as EntryFeature, generation: match[2], action: match[3] } : undefined;
}
