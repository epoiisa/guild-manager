import { AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type SlashCommandStringOption } from "discord.js";
import type { ReviewerDomain, ReviewerRepository } from "../db/reviewerRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { ENTRY_MENTIONS, currentEntryMember } from "../services/entryPanels/access.js";
import type { createEntryPanelService } from "../services/entryPanels/service.js";
import { INVALID_COLOR, REPORT_COLOR, SUCCESS_COLOR } from "./configurationHelpers.js";

const SYSTEMS = ["account", "regear", "specialisation"] as const;
type ManagerSystem = typeof SYSTEMS[number];
const SYSTEM_LABELS: Record<ManagerSystem, string> = { account: "Accounts", regear: "Re-gears", specialisation: "Weapon Specialisation" };
const REVIEWER_DOMAINS: Record<Exclude<ManagerSystem, "account">, ReviewerDomain> = { regear: "regears", specialisation: "specialisation" };
type EntryPanels = ReturnType<typeof createEntryPanelService>;

function systemOption(option: SlashCommandStringOption, required = true) {
  return option.setName("system").setDescription("System to manage.").setRequired(required)
    .addChoices(...SYSTEMS.map(value => ({ name: SYSTEM_LABELS[value], value })));
}

export const managerCommand = new SlashCommandBuilder()
  .setName("manager")
  .setDescription("Configure system manager roles for all Albion Online servers.")
  .setDefaultMemberPermissions(0)
  .addSubcommand(command => command.setName("add").setDescription("Add a system manager role.")
    .addStringOption(option => systemOption(option))
    .addRoleOption(option => option.setName("role").setDescription("Discord manager role.").setRequired(true)))
  .addSubcommand(command => command.setName("remove").setDescription("Remove a system manager role.")
    .addStringOption(option => systemOption(option))
    .addRoleOption(option => option.setName("role").setDescription("Discord manager role.").setRequired(true)))
  .addSubcommand(command => command.setName("list").setDescription("List configured system manager roles.")
    .addStringOption(option => systemOption(option, false)));

export async function handleManagerCommand(interaction: ChatInputCommandInteraction, reviewers: ReviewerRepository, entryPanels: EntryPanels): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await reply(interaction, "Server Only", "This command can only be used in a Discord server.", INVALID_COLOR);
    return;
  }
  const guildId = interaction.guildId;
  const live = entryPanels.captureFence(guildId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await currentEntryMember(interaction);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await reply(interaction, "Administrator Required", "Only a Discord Administrator can configure or list system manager roles.", INVALID_COLOR);
    return;
  }
  if (!live()) return startAgain(interaction);
  const action = interaction.options.getSubcommand();
  const selected = interaction.options.getString("system");
  if ((selected !== null && !SYSTEMS.includes(selected as ManagerSystem)) || (action !== "list" && selected === null)) {
    await reply(interaction, "Invalid System", "Choose Accounts, Re-gears, or Weapon Specialisation.", INVALID_COLOR);
    return;
  }
  const system = selected as ManagerSystem | null;
  const accounts = entryPanels.context.repository;
  if (action === "list") {
    const sections = await Promise.all((system ? [system] : SYSTEMS).map(async current => {
      const roles = current === "account"
        ? await accounts.listRoles(guildId, "accounts_manager")
        : (await reviewers.listBindings(guildId, REVIEWER_DOMAINS[current])).map(binding => binding.discordRoleId);
      return { count: roles.length, text: system && roles.length <= 1
        ? roles.length ? `<@&${roles[0]}> is configured as a manager for ${SYSTEM_LABELS[current]}.` : `No ${SYSTEM_LABELS[current]} manager roles are configured.`
        : `**${SYSTEM_LABELS[current]}**\n${roles.length ? roles.map(id => `<@&${id}>`).join("\n") : "No manager roles configured."}` };
    }));
    if (!live()) return startAgain(interaction);
    const report = sections.map(section => section.text).join("\n\n");
    const files = report.length > 3_800 ? [new AttachmentBuilder(Buffer.from(report, "utf8"), { name: "manager-roles.txt" })] : [];
    await reply(interaction, "Manager Roles", files.length ? "The complete manager role list is attached." : report, REPORT_COLOR, files, !system || sections.some(section => section.count > 1));
    return;
  }
  if (action !== "add" && action !== "remove") return;
  const target = system!;
  const role = interaction.options.getRole("role", true);
  const changed = await entryPanels.runExclusive(guildId, async () => {
    if (!live()) return undefined;
    if (target === "account") return action === "add"
      ? accounts.addRole(guildId, "accounts_manager", role.id)
      : accounts.removeRole(guildId, "accounts_manager", role.id);
    const domain = REVIEWER_DOMAINS[target];
    if (action === "remove") return reviewers.removeBinding(guildId, domain, role.id, interaction.user.id);
    await reviewers.addBinding(guildId, domain, role.id, interaction.user.id);
    return true;
  });
  if (changed === undefined) return startAgain(interaction);
  if (target === "regear" && changed) {
    await interaction.deleteReply().catch(() => undefined);
    return;
  }
  const label = SYSTEM_LABELS[target];
  const mention = `<@&${role.id}>`;
  if (action === "add") {
    await reply(interaction, changed ? "Manager Role Added" : "Manager Role Already Configured",
      `${mention} ${changed ? "can" : "already can"} manage ${label} across all Albion Online servers.`, SUCCESS_COLOR);
  } else {
    await reply(interaction, changed ? "Manager Role Removed" : "Manager Role Not Configured",
      changed ? `The ${label} manager role setting for ${mention} has been removed.` : `${mention} is not configured as a ${label} manager role.`, changed ? SUCCESS_COLOR : INVALID_COLOR);
  }
}

function startAgain(interaction: ChatInputCommandInteraction) {
  return reply(interaction, "Start Again", "Configuration changed while this command was running. Run the command again.", INVALID_COLOR);
}

async function reply(interaction: ChatInputCommandInteraction, title: string, description: string, color: number, files: AttachmentBuilder[] = [], structured = false) {
  const payload = { structured, cards: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)], files, allowedMentions: ENTRY_MENTIONS };
  if (interaction.deferred) await editFeedback(interaction, payload);
  else await interaction.reply(feedbackReply({ ...payload, flags: MessageFlags.Ephemeral }));
}
