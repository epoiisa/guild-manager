import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import type { ContentTemplate, createContentRepository } from "../db/contentRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { v2Reply } from "../discord/operationalMessages.js";
import {
  buildTemplateModalId,
  isTemplateModalSubmit,
  parseRoleLines,
  parseTemplateModalId
} from "../services/content/rendering.js";
import {
  INFO_COLOR,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  rejectNonGuildInteraction,
  truncateChoiceName
} from "./configurationHelpers.js";
import { requireManagedThread } from "./content.js";

type ContentRepository = ReturnType<typeof createContentRepository>;

const NAME_FIELD = "name";
const TITLE_FIELD = "title";
const DESCRIPTION_FIELD = "description";
const ROLES_FIELD = "roles";

export const templateCommand = new SlashCommandBuilder()
  .setName("template")
  .setDescription("Manage reusable content signup templates.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) => subcommand.setName("create").setDescription("Create a content signup template."))
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List content signup templates."))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit a content signup template.")
      .addStringOption((option) =>
        option.setName("template").setDescription("Template to edit.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("show")
      .setDescription("Show a content signup template.")
      .addStringOption((option) =>
        option.setName("template").setDescription("Template to show.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a content signup template.")
      .addStringOption((option) =>
        option.setName("template").setDescription("Template to remove.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) => subcommand.setName("capture").setDescription("Save the current content thread as a template."));

export async function handleTemplateCommand(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "create") {
    await interaction.showModal(buildTemplateModal("Create Template", buildTemplateModalId("create")));
    return;
  }

  if (subcommand === "list") {
    const templates = await repository.listTemplates(interaction.guildId!);
    await interaction.reply(feedbackReply({
      structured: templates.length > 0, cards: [buildTemplateListEmbed(templates)],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  if (subcommand === "capture") {
    const snapshot = await requireManagedThread(interaction, repository);
    if (!snapshot) return;
    await interaction.showModal(buildTemplateModal(
      "Capture Template",
      buildTemplateModalId("capture", snapshot.content.contentId),
      snapshot.content.title,
      snapshot.content.title,
      snapshot.content.description,
      snapshot.slots.map((slot) => slot.label).join("\n")
    ));
    return;
  }

  const template = await requireTemplate(interaction, repository);
  if (!template) return;

  if (subcommand === "show") {
    await interaction.reply(v2Reply({ cards: [buildTemplateShowEmbed(template)], flags: MessageFlags.Ephemeral }));
    return;
  }
  if (subcommand === "remove") {
    await repository.removeTemplate(interaction.guildId!, template.contentTemplateId);
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Template Removed", `Content template ${template.name} was removed.`)], flags: MessageFlags.Ephemeral }));
    return;
  }
  if (subcommand === "edit") {
    await interaction.showModal(buildTemplateModal(
      "Edit Template",
      buildTemplateModalId("edit", template.contentTemplateId),
      template.name,
      template.title,
      template.description,
      template.rolesText
    ));
    return;
  }

  await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Unknown Template Command", "Choose one of the supported template commands.")], flags: MessageFlags.Ephemeral }, "context"));
}

export async function handleTemplateAutocomplete(
  interaction: AutocompleteInteraction,
  repository: ContentRepository
): Promise<boolean> {
  if (interaction.commandName !== "template") return false;
  if (!interaction.guildId) {
    await interaction.respond([]);
    return true;
  }
  const focused = String(interaction.options.getFocused(true).value ?? "").toLocaleLowerCase();
  const templates = await repository.listTemplates(interaction.guildId);
  await interaction.respond(
    templates
      .filter((template) => template.name.toLocaleLowerCase().includes(focused))
      .slice(0, 25)
      .map((template) => ({ name: truncateChoiceName(template.name), value: template.contentTemplateId }))
  );
  return true;
}

export async function handleTemplateModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: ContentRepository
): Promise<boolean> {
  if (!isTemplateModalSubmit(interaction)) return false;
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Server Only", "Templates can only be used in a Discord server.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const parsed = parseTemplateModalId(interaction.customId);
  if (!parsed) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Template Form", "That template form is no longer valid.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const name = interaction.fields.getTextInputValue(NAME_FIELD).trim();
  const title = interaction.fields.getTextInputValue(TITLE_FIELD).trim();
  const description = interaction.fields.getTextInputValue(DESCRIPTION_FIELD).trim();
  const rolesText = interaction.fields.getTextInputValue(ROLES_FIELD);
  if (!name || !title || parseRoleLines(rolesText).length === 0) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Missing Template Details", "Provide a name, title, and at least one role line.")], flags: MessageFlags.Ephemeral }, "context"));
    return true;
  }

  try {
    if (parsed.action === "edit") {
      const updated = await repository.updateTemplate({
        discordGuildId: interaction.guildId,
        contentTemplateId: parsed.templateId!,
        name,
        title,
        description,
        rolesText,
        discordUserId: interaction.user.id
      });
      if (!updated) {
        await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Template Not Found", "Choose an existing content template.")], flags: MessageFlags.Ephemeral }, "context"));
        return true;
      }
      await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Template Updated", `Content template ${updated.name} was updated.`)], flags: MessageFlags.Ephemeral }));
      return true;
    }

    const created = await repository.createTemplate({
      discordGuildId: interaction.guildId,
      name,
      title,
      description,
      rolesText,
      discordUserId: interaction.user.id
    });
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Template Saved", `Content template ${created.name} was saved.`)], flags: MessageFlags.Ephemeral }));
  } catch (error) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Template Not Saved", error instanceof Error ? error.message : "Guild Manager could not save that template.")],
      flags: MessageFlags.Ephemeral
    }, "context"));
  }
  return true;
}

function buildTemplateModal(
  title: string,
  customId: string,
  name = "",
  contentTitle = "",
  description = "",
  rolesText = ""
): ModalBuilder {
  return new ModalBuilder()
    .setTitle(title)
    .setCustomId(customId)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NAME_FIELD)
          .setLabel("Template name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(name.slice(0, 80))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TITLE_FIELD)
          .setLabel("Content title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(contentTitle.slice(0, 100))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(DESCRIPTION_FIELD)
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(2000)
          .setValue(description.slice(0, 2000))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(ROLES_FIELD)
          .setLabel("Roles, one per line")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000)
          .setValue(rolesText.slice(0, 2000))
      )
    );
}

async function requireTemplate(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository
): Promise<ContentTemplate | undefined> {
  const templateId = interaction.options.getString("template", true);
  const template = await repository.getTemplate(interaction.guildId!, templateId);
  if (!template) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Template Not Found", "Choose an existing content template.")], flags: MessageFlags.Ephemeral }, "context"));
    return undefined;
  }
  return template;
}

function buildTemplateListEmbed(templates: ContentTemplate[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Content Templates")
    .setDescription(templates.length > 0 ? templates.map((template) => `- ${template.name}`).join("\n") : "No content templates are configured.");
}

function buildTemplateShowEmbed(template: ContentTemplate): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(template.name)
    .addFields(
      { name: "Title", value: template.title, inline: false },
      { name: "Description", value: template.description || "No description.", inline: false },
      { name: "Roles", value: template.rolesText || "No roles.", inline: false }
    );
}
