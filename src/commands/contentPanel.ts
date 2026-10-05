import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { createContentPanelRepository } from "../db/contentPanelRepository.js";
import type { createContentRepository } from "../db/contentRepository.js";
import { completeFeedbackPrompt, editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import type { Logger } from "../logging/logger.js";
import { provisionContent } from "../services/content/hosting.js";
import {
  buildContentPanelListPage,
  parseContentPanelId,
} from "../services/content/panelRendering.js";
import { approvalRoleValidationError, buildContentCreatedMessage, parseRoleLines } from "../services/content/rendering.js";
import {
  UTC_TIME_INPUT_HELP,
  buildNextUtcDateChoices,
  parseUtcDateTime,
} from "../services/scheduling.js";
import { INFO_COLOR } from "./configurationHelpers.js";
import { buildContentModal } from "./content.js";
const PREFIX = "content-host:";
const mentions = {
  parse: [] as never[],
  users: [],
  roles: [],
  repliedUser: false,
};
type Interaction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;
interface Draft {
  id: string;
  guild: string;
  owner: string;
  channel: string;
  revision: string;
  expires: number;
  scheduled: boolean;
  date: string;
  template: string;
  approvalRequired: boolean;
  multiSignupEnabled: boolean;
  page: number;
  form: number;
  state: "setup" | "form" | "submitting" | "done" | "failed";
  title: string;
  description: string;
  roles: string;
  time: string;
  confirmation?: ReturnType<typeof buildContentCreatedMessage>;
  formSelection?: Readonly<{ date: string; template: string; approvalRequired: boolean; multiSignupEnabled: boolean }>;
}
export interface ContentPanelInteractionDependencies {
  repository: ReturnType<typeof createContentRepository>;
  listPanelContent: ReturnType<
    typeof createContentPanelRepository
  >["listPanelContent"];
  logger: Logger;
  panel: {
    runExclusive<T>(guildId: string, task: () => Promise<T>): Promise<T>;
    isCurrentPanel(
      guildId: string,
      channelId: string,
      messageId: string,
      generation: string,
    ): Promise<boolean>;
  };
  isGuildActive?: (guildId: string) => Promise<boolean>;
  now?: () => number;
}
function response(
  text: string,
  rows: (
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [],
) {
  const container = new ContainerBuilder()
    .setAccentColor(INFO_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  for (const row of rows) {
    container.addActionRowComponents(row.toJSON());
  }
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: mentions,
  };
}
export function createContentPanelInteractions({
  repository,
  listPanelContent,
  logger,
  panel,
  isGuildActive,
  now = Date.now,
}: ContentPanelInteractionDependencies) {
  let stopped = false;
  let runtimeEpoch = 0;
  const guildEpochs = new Map<string, number>();
  const drafts = new Map<string, Draft>();
  function captureFence(guildId: string | null) {
    const active = !stopped;
    const runtime = runtimeEpoch;
    const guild = guildId ? (guildEpochs.get(guildId) ?? 0) : 0;
    return () =>
      active &&
      !stopped &&
      runtime === runtimeEpoch &&
      guild === (guildId ? (guildEpochs.get(guildId) ?? 0) : 0);
  }
  function live(d: Draft) {
    return !stopped && drafts.get(d.id) === d && d.expires > now();
  }
  const invalid =
    "This hosting setup has expired or is no longer available. Use the latest Content message in this channel.";
  const button = (d: Draft, action: string, label: string, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${d.id}:${action}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  async function access(i: Interaction, d?: Draft) {
    const current = captureFence(i.guildId);
    if (
      stopped ||
      !i.inCachedGuild() ||
      i.user.bot ||
      (isGuildActive && !(await isGuildActive(i.guildId)))
    )
      return undefined;
    const config = await repository.getContentChannel(i.guildId);
    if (
      !config ||
      (d &&
        (config.configurationRevision !== d.revision ||
          config.discordChannelId !== d.channel))
    )
      return undefined;
    const member = await i.guild.members
      .fetch({ user: i.user.id, force: true })
      .catch(() => null);
    const channel = await i.guild.channels
      .fetch(config.discordChannelId)
      .catch(() => null);
    if (
      !member ||
      member.user.bot ||
      (member.communicationDisabledUntilTimestamp ?? 0) > now() ||
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement) ||
      !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
    )
      return undefined;
    if (!current() || (d && !live(d))) return undefined;
    return { config, channel };
  }
  function find(i: Interaction) {
    const [, id] = i.customId.split(":");
    const d = drafts.get(id);
    if (
      stopped ||
      !d ||
      d.guild !== i.guildId ||
      d.channel !== i.channelId ||
      d.owner !== i.user.id ||
      d.expires <= now()
    )
      return undefined;
    return d;
  }
  async function setup(d: Draft) {
    const templates = await repository.listTemplates(d.guild);
    if (!live(d)) return response(invalid);
    const pages = Math.max(1, Math.ceil(templates.length / 24));
    d.page = Math.min(d.page, pages - 1);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}${d.id}:template`)
      .setPlaceholder("Choose a template")
      .addOptions(
        { label: "No template", value: "blank", default: d.template === "blank" },
        ...templates.slice(d.page * 24, d.page * 24 + 24).map((t) => ({
          label: t.name.slice(0, 100),
          value: t.contentTemplateId,
          default: d.template === t.contentTemplateId,
        })),
      );
    const rows: (
      | ActionRowBuilder<ButtonBuilder>
      | ActionRowBuilder<StringSelectMenuBuilder>
    )[] = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    ];
    if (pages > 1)
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(d, "previous", "Previous templates", d.page === 0),
          button(d, "next", "Next templates", d.page === pages - 1),
        ),
      );
    if (d.scheduled)
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`${PREFIX}${d.id}:date`)
            .setPlaceholder("Date (UTC)")
            .addOptions(
              ...buildNextUtcDateChoices(new Date(now())).map((c) => ({
                label: c.name,
                value: c.value,
                default: c.value === d.date,
              })),
            ),
        ),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}${d.id}:approval`)
          .setPlaceholder("Host approval")
          .addOptions(
            { label: "Host approval not required", description: "Members join immediately.", value: "false", default: !d.approvalRequired },
            { label: "Host approval required", description: "The host accepts each signup request.", value: "true", default: d.approvalRequired },
          ),
      ),
    );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}${d.id}:multisignup`)
          .setPlaceholder("Multi-signup")
          .addOptions(
            { label: "Multi-signup off", description: "One confirmed user per role.", value: "false", default: !d.multiSignupEnabled },
            { label: "Multi-signup on", description: "Multiple confirmed users per role.", value: "true", default: d.multiSignupEnabled },
          ),
      ),
    );
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(d, "continue", "Continue", d.scheduled && !d.date),
        button(d, "cancel", "Cancel"),
      ),
    );
    return response(
      `## Host ${d.scheduled ? "Scheduled" : "Unscheduled"}\nChoose a template${d.scheduled ? ", UTC date" : ""}, host approval, and multi-signup, then Continue.`,
      rows,
    );
  }
  async function listPage(d: Draft, page: number) {
    const entries = await listPanelContent(d.guild, d.channel, new Date(now()));
    if (!live(d)) return response(invalid);
    return {
      ...buildContentPanelListPage(entries, d.id, page, new Date(now())),
      flags: MessageFlags.IsComponentsV2 as const,
    };
  }
  async function reject(i: Interaction, text = invalid) {
    if (i.deferred || i.replied) await editFeedback(i, { text, allowedMentions: mentions });
    else await i.reply(feedbackReply({ text, allowedMentions: mentions, flags: MessageFlags.Ephemeral }));
  }
  async function confirmCreated(i: Interaction, confirmation: ReturnType<typeof buildContentCreatedMessage>) {
    if (i.deferred || i.replied) await i.editReply(confirmation);
    else await i.reply({ ...confirmation, flags: MessageFlags.Ephemeral | confirmation.flags });
  }
  async function handleButton(i: ButtonInteraction): Promise<boolean> {
    const current = captureFence(i.guildId);
    const publicId = parseContentPanelId(i.customId);
    if (!publicId && !i.customId.startsWith(PREFIX)) {
      if (i.customId.startsWith("content-panel:")) {
        await reject(i);
        return true;
      }
      return false;
    }
    if (publicId) {
      if (publicId.action === "page") await i.deferUpdate();
      else await i.deferReply({ flags: MessageFlags.Ephemeral });
      const listDraft =
        publicId.action === "page"
          ? drafts.get(publicId.generation)
          : undefined;
      if (publicId.action === "page") {
        if (
          stopped ||
          !listDraft ||
          listDraft.channel !== i.channelId ||
          listDraft.owner !== i.user.id ||
          listDraft.guild !== i.guildId ||
          listDraft.expires <= now() ||
          !(await access(i, listDraft))
        ) {
          await reject(i);
          return true;
        }
        await i.editReply(await listPage(listDraft, publicId.page ?? 0));
        return true;
      }
      const a = await access(i);
      if (
        !a ||
        !(await panel.isCurrentPanel(
          i.guildId!,
          i.channelId,
          i.message.id,
          publicId.generation,
        )) ||
        !current()
      ) {
        await reject(i, "Use the latest Content message in this channel.");
        return true;
      }
      for (const [id, d] of drafts) if (d.expires <= now()) drafts.delete(id);
      const d: Draft = {
        id: randomUUID().slice(0, 18),
        guild: i.guildId!,
        owner: i.user.id,
        channel: a.channel.id,
        revision: a.config.configurationRevision,
        expires: now() + 15 * 60000,
        scheduled: publicId.action === "scheduled",
        date: "",
        template: "blank",
        approvalRequired: false,
        multiSignupEnabled: false,
        page: 0,
        form: 0,
        state: "setup",
        title: "",
        description: "",
        roles: "",
        time: "",
      };
      if (!current()) {
        await reject(i);
        return true;
      }
      drafts.set(d.id, d);
      if (publicId.action === "list") {
        await i.editReply(await listPage(d, 0));
        return true;
      }
      await i.editReply(await setup(d));
      return true;
    }
    const action =
      /^content-host:[a-z0-9-]+:(continue|retry|cancel|next|previous)$/.exec(
        i.customId,
      )?.[1];
    const d = find(i);
    if (!action || !d) {
      await reject(i);
      return true;
    }
    if (d.state === "done") {
      await confirmCreated(i, d.confirmation!);
      return true;
    }
    if (d.state === "submitting" || d.state === "failed") {
      await reject(
        i,
        "This creation is being resolved. Do not submit another party from this setup.",
      );
      return true;
    }
    if (action === "cancel") {
      drafts.delete(d.id);
      await completeFeedbackPrompt(i, { text: "Hosting cancelled. Use the public hosting buttons to begin again." });
      return true;
    }
    if (action === "continue" || action === "retry") {
      if (d.scheduled && !d.date) {
        await reject(i, "Select a Date (UTC) before continuing.");
        return true;
      }
      d.form++;
      d.state = "form";
      d.formSelection = Object.freeze({ date: d.date, template: d.template, approvalRequired: d.approvalRequired, multiSignupEnabled: d.multiSignupEnabled });
      await i.showModal(
        buildContentModal(
          "Host Content",
          `${PREFIX}${d.id}:submit:${d.form}`,
          d.title,
          d.description,
          d.roles,
          {
            graphic: true,
            ...(d.scheduled ? { time: d.time, date: d.date } : {}),
          },
        ),
      );
      return true;
    }
    if (!live(d) || d.state !== "setup") {
      await reject(
        i,
        "A details form is open. Submit it or open a replacement with Continue.",
      );
      return true;
    }
    await i.deferUpdate();
    if (!(await access(i, d))) {
      await reject(i);
      return true;
    }
    d.page = Math.max(0, d.page + (action === "next" ? 1 : -1));
    await i.editReply(await setup(d));
    return true;
  }
  async function handleSelect(
    i: StringSelectMenuInteraction,
  ): Promise<boolean> {
    if (!i.customId.startsWith(PREFIX)) return false;
    await i.deferUpdate();
    const action = /^content-host:[a-z0-9-]+:(template|date|approval|multisignup)$/.exec(
      i.customId,
    )?.[1];
    const d = find(i);
    if (!action || !d || d.state !== "setup" || !(await access(i, d))) {
      await reject(i);
      return true;
    }
    if (!live(d) || d.state !== "setup") {
      await reject(i);
      return true;
    }
    if (action === "template") {
      const value = i.values[0];
      const template =
        value === "blank"
          ? undefined
          : await repository.getTemplate(d.guild, value);
      if (value !== "blank" && !template) {
        await reject(i, "That template is no longer available.");
        return true;
      }
      // The REST response may arrive after another client has opened a form.
      if (!live(d) || d.state !== "setup") {
        await reject(i);
        return true;
      }
      d.template = value;
      d.title = template?.title ?? "";
      d.description = template?.description ?? "";
      d.roles = template?.rolesText ?? "";
    } else if (action === "approval" && ["true", "false"].includes(i.values[0])) {
      d.approvalRequired = i.values[0] === "true";
    } else if (action === "multisignup" && ["true", "false"].includes(i.values[0])) {
      d.multiSignupEnabled = i.values[0] === "true";
    } else if (
      action === "date" &&
      buildNextUtcDateChoices(new Date(now())).some(
        (c) => c.value === i.values[0],
      )
    )
      d.date = i.values[0];
    await i.editReply(await setup(d));
    return true;
  }
  async function handleModal(i: ModalSubmitInteraction): Promise<boolean> {
    if (!i.customId.startsWith(PREFIX)) return false;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const submission = /^content-host:[a-z0-9-]+:submit:([1-9][0-9]*)$/.exec(
      i.customId,
    );
    const d = find(i);
    if (
      !submission ||
      !d ||
      d.state !== "form" ||
      String(d.form) !== submission[1]
    ) {
      if (d?.state === "done") await confirmCreated(i, d.confirmation!);
      else await reject(i);
      return true;
    }
    const selection = d.formSelection!;
    d.state = "submitting";
    await panel.runExclusive(d.guild, async () => {
      const a = await access(i, d);
      if (!a || !drafts.has(d.id)) {
        drafts.delete(d.id);
        await reject(i);
        return;
      }
      d.title = i.fields.getTextInputValue("title").trim();
      d.description = i.fields.getTextInputValue("description").trim();
      d.roles = i.fields.getTextInputValue("roles");
      d.time = d.scheduled ? i.fields.getTextInputValue("time") : "";
      if (
        selection.template !== "blank" &&
        !(await repository.getTemplate(d.guild, selection.template))
      ) {
        if (!live(d)) {
          await reject(i);
          return;
        }
        d.state = "setup";
        d.template = "blank";
        await i.editReply(
          response(
            "That template was deleted. Your text is retained; Retry uses Blank. Reattach any graphic.",
            [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                button(d, "retry", "Retry"),
                button(d, "cancel", "Cancel"),
              ),
            ],
          ),
        );
        return;
      }
      if (!live(d)) {
        await reject(i);
        return;
      }
      const roles = parseRoleLines(d.roles);
      const start = d.scheduled
        ? parseUtcDateTime(selection.date, d.time)
        : null;
      const graphics = [
        ...(i.fields.getUploadedFiles("builds-graphic", false)?.values() ?? []),
      ];
      const error = approvalRoleValidationError(roles, selection.approvalRequired) ?? (
        !d.title || roles.length < 1 || roles.length > 25
          ? "Provide a title and between 1 and 25 role lines."
          : d.scheduled && (!start || start.getTime() <= now())
            ? `Choose a future UTC start. ${UTC_TIME_INPUT_HELP}`
            : graphics.length > 1 ||
                (graphics.length === 1 &&
                  !graphics[0].contentType?.startsWith("image/"))
              ? "Upload one image file."
              : undefined);
      if (error) {
        d.state = "setup";
        await i.editReply(
          response(
            `${error}\nYour text is retained. Reattach any graphic in the next form.`,
            [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                button(d, "retry", "Retry"),
                button(d, "cancel", "Cancel"),
              ),
            ],
          ),
        );
        return;
      }
      try {
        const result = await provisionContent({
          repository,
          logger,
          parentChannel: a.channel,
          guildId: d.guild,
          hostUserId: d.owner,
          title: d.title,
          description: d.description,
          roleLabels: roles,
          scheduledStartAt: start ?? null,
          approvalRequired: selection.approvalRequired,
          multiSignupEnabled: selection.multiSignupEnabled,
          graphic: graphics[0],
          validate: async () => {
            if (
              d.expires <= now() ||
              !drafts.has(d.id) ||
              !(await access(i, d)) ||
              !live(d)
            )
              throw new Error("Hosting configuration or access changed.");
          },
        });
        d.confirmation = buildContentCreatedMessage(result.snapshot.content, result.announcementUrl);
        d.state = "done";
      } catch (error) {
        d.state = "failed";
        logger.error("button content creation failed", {
          guildId: d.guild,
          error: error instanceof Error ? error.message : String(error),
        });
        await reject(
          i,
          "Creation failed. Ask an administrator to inspect the channel before hosting again.",
        );
        return;
      }
      await confirmCreated(i, d.confirmation!);
    });
    return true;
  }
  return {
    handleButton,
    handleSelect,
    handleModal,
    invalidateGuild(guildId: string) {
      guildEpochs.set(guildId, (guildEpochs.get(guildId) ?? 0) + 1);
      for (const [id, d] of drafts) if (d.guild === guildId) drafts.delete(id);
    },
    start() {
      stopped = false;
    },
    stop() {
      runtimeEpoch++;
      stopped = true;
      drafts.clear();
    },
  };
}
