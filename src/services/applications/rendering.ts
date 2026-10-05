import { v2Message } from "../../discord/operationalMessages.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import {
  asComponentsV2Edit,
  buildComponentsV2Card,
} from "../../discord/componentsV2.js";
import type {
  ApplicationClass,
  ApplicationStatus,
  CharacterResolutionState,
  OpenApplication,
} from "../../db/applicationRepository.js";
import type { MemberGroup } from "../../db/membershipRepository.js";
import { getAlbionServerLabel, type AlbionServer } from "../albion/servers.js";
import type { AlbionPlayer, AlbionSearchPlayer } from "../albion/types.js";
import { formatCharacterLookupSummary, getCharacterWebsiteUrls } from "../../commands/characterSelection.js";
import {
  INFO_COLOR,
  INVALID_COLOR,
  SUCCESS_COLOR,
  buildInfoEmbed,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatCharacterUserMentionPair,
  formatMemberGroupCombinedLabel,
  formatMemberGroupLabel,
  formatMemberGroupTypeTitle,
  formatRole,
} from "../../commands/configurationHelpers.js";

type ComponentsV2Payload = MessageCreateOptions &
  InteractionReplyOptions &
  MessageEditOptions;

const APPLICATION_CUSTOM_PREFIX = "app:";
const CHARACTER_SELECT_PREFIX = "app:character:";
const REMOTE_CHARACTER_SELECT_PREFIX = "app:remote-character:";
const NOT_LISTED_VALUE = "__not_listed";

const APPLICATION_SELECTION_FOOTER =
  "The applicant can withdraw this application. Reviewers can close it.";
const APPLICATION_REVIEW_FOOTER =
  "The applicant can withdraw this application. Reviewers can close, accept, or reject it.";
const CHARACTER_CONTROL_FOOTER =
  "The applicant or reviewers can retry the search and select or change the character.";
const WAITING_MEMBERSHIP_FOOTER =
  "Reviewers can verify membership or cancel this application.";
const OUTCOME_CLOSE_FOOTER =
  "The applicant or reviewers can close this channel.";
const CLOSED_CHANNEL_FOOTER =
  "The applicant or reviewers can reopen this channel. Reviewers can delete it.";
const REVIEWER_ONLY_FOOTER = "Reviewers only.";

const APPLICATION_CONTROL_FOOTERS = new Set([
  APPLICATION_SELECTION_FOOTER,
  APPLICATION_REVIEW_FOOTER,
  CHARACTER_CONTROL_FOOTER,
  WAITING_MEMBERSHIP_FOOTER,
  OUTCOME_CLOSE_FOOTER,
  CLOSED_CHANNEL_FOOTER,
  REVIEWER_ONLY_FOOTER,
  "Reviewers can accept or reject this application. The applicant can withdraw it.",
]);

/** Recognize only bot-authored control guidance, including retained legacy cards. */
export function isApplicationControlFooter(text: string | undefined): boolean {
  return !!text && (APPLICATION_CONTROL_FOOTERS.has(text)
    || (text.startsWith("*") && text.endsWith("*") && APPLICATION_CONTROL_FOOTERS.has(text.slice(1, -1))));
}

/** Converts the application presentation model to a shared Components V2 card. */
export function buildApplicationV2Card(
  embed: EmbedBuilder,
  actionRows: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] = [],
  options: {
    openingMentions?: { applicantId: string; reviewerRoleId: string };
    edit?: boolean;
    ephemeral?: boolean;
  } = {},
): ComponentsV2Payload {
  const json = embed.toJSON();
  const card = buildComponentsV2Card({
    accentColor: json.color ?? INFO_COLOR,
    title: json.title ?? "Application",
    text: json.description ? [json.description] : [],
    fields: (json.fields ?? []).map((field) => ({
      label: field.name,
      value: field.value,
    })),
    footer: json.footer?.text && (actionRows.length > 0 || !isApplicationControlFooter(json.footer.text))
      ? `*${json.footer.text}*` : undefined,
    actionRows,
    ephemeral: options.ephemeral,
    allowedMentions: options.openingMentions && !options.edit
      ? {
          parse: [],
          users: [options.openingMentions.applicantId],
          roles: [options.openingMentions.reviewerRoleId],
          repliedUser: false,
        }
      : { parse: [], repliedUser: false },
  });
  return (
    options.edit ? asComponentsV2Edit(card) : card
  ) as ComponentsV2Payload;
}

export function buildUndecidedButtons(
  applicationId: string,
): ActionRowBuilder<ButtonBuilder> {
  return buildIntakeButtons(applicationId, true);
}

export function buildWaitingButtons(
  applicationId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_CUSTOM_PREFIX}verify:${applicationId}`)
      .setLabel("Verify Membership")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_CUSTOM_PREFIX}cancel:${applicationId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildCloseButton(
  applicationId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_CUSTOM_PREFIX}close:${applicationId}`)
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildClosedChannelButtons(
  applicationId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_CUSTOM_PREFIX}reopen:${applicationId}`)
      .setLabel("Reopen")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_CUSTOM_PREFIX}delete:${applicationId}`)
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger),
  );
}

export function buildArchivedApplicationButtons(
  applicationId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLICATION_CUSTOM_PREFIX}delete:${applicationId}`)
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger),
  );
}

export function applicationOpenComponents(
  status: ApplicationStatus,
  applicationId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  if (status === "open") return [buildUndecidedButtons(applicationId)];
  if (status === "awaiting_ingame_membership")
    return [buildWaitingButtons(applicationId)];
  return [buildCloseButton(applicationId)];
}

export function buildApplicationCharacterSelectRow(
  server: AlbionServer,
  applicationId: string,
  players: AlbionSearchPlayer[],
  attempt?: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CHARACTER_SELECT_PREFIX}${applicationId}${attempt === undefined ? "" : `:${attempt}`}`)
      .setPlaceholder("Choose your character")
      .addOptions([
        ...players.slice(0, 24).map((player) => ({
          label: truncateSelectText(player.name),
          description: formatApplicationCharacterSelectDescription(
            player,
            server,
          ),
          value: player.id,
        })),
        {
          label: "My character is not shown here",
          description: "Retry the search from this ticket.",
          value: NOT_LISTED_VALUE,
        },
      ]),
  );
}

export function buildRemoteApplicationCharacterSelectRow(
  server: AlbionServer,
  applicationId: string,
  actorId: string,
  expiry: number,
  attempt: number,
  players: AlbionSearchPlayer[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(
        `${REMOTE_CHARACTER_SELECT_PREFIX}${applicationId}:${actorId}:${expiry.toString(36)}:${attempt.toString(36)}`,
      )
      .setPlaceholder("Choose application character")
      .addOptions([
        ...players.slice(0, 24).map((player) => ({
          label: truncateSelectText(player.name),
          description: formatApplicationCharacterSelectDescription(
            player,
            server,
          ),
          value: player.id,
        })),
        {
          label: "My character is not shown here",
          description:
            "Mark it not shown and retry from the application channel.",
          value: NOT_LISTED_VALUE,
        },
      ]),
  );
}

export function buildCharacterRecoveryButtons(
  applicationId: string,
  _state: CharacterResolutionState,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `${APPLICATION_CUSTOM_PREFIX}retry-character:${applicationId}`,
      )
      .setLabel("Retry Character Search")
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildInitialApplicationEmbed(
  application: ApplicationClass,
  openApplication: OpenApplication,
  group: MemberGroup | undefined,
): EmbedBuilder {
  const targetName = group?.groupName ?? openApplication.targetMemberGroupName ?? application.name;
  const selected = hasValidApplicationSelection(openApplication);
  const embed = new EmbedBuilder().setColor(INFO_COLOR).setTitle(`${targetName} Application`);
  if (!selected) return embed
    .setDescription(`<@${openApplication.applicantDiscordUserId}>, please select your character from the dropdown menu below.`)
    .setFooter({ text: APPLICATION_SELECTION_FOOTER });
  const type = group?.groupType ?? openApplication.targetMemberGroupType ?? "group";
  const websiteUrls = getCharacterWebsiteUrls(application.albionServer, openApplication.selectedCharacterName!);
  return embed.addFields(
    { name: "Applicant", value: `<@${openApplication.applicantDiscordUserId}>` },
    { name: "Character", value: [
      formatCharacterLookupSummary(application.albionServer, {
        id: openApplication.selectedAlbionCharacterId!,
        name: openApplication.selectedCharacterName!,
        guildName: openApplication.selectedCharacterGuildName,
        allianceName: openApplication.selectedCharacterAllianceName,
        allianceTag: openApplication.selectedCharacterAllianceTag,
      }),
      `[AlbionDB](${websiteUrls.albionDb})`,
      `[Killboard1](${websiteUrls.killboard})`,
    ].join(" • ") },
    { name: formatMemberGroupTypeTitle(type), value: formatMemberGroupCombinedLabel({ groupName: targetName, groupType: type, albionServer: application.albionServer }) },
    { name: "Reviewers", value: formatRole(application.reviewerRoleId) },
  ).setFooter({ text: APPLICATION_REVIEW_FOOTER });
}

export function buildApplicationControlReplacementEmbed(
  application: ApplicationClass,
  openApplication: OpenApplication,
): EmbedBuilder {
  if (openApplication.status === "open")
    return buildInitialApplicationEmbed(
      application,
      openApplication,
      undefined,
    );
  if (openApplication.status === "awaiting_ingame_membership") {
    return withControlFooter(
      buildInfoEmbed(
        "Waiting For In-Game Membership",
        "Final registration is waiting for the selected character to satisfy the configured in-game membership requirement.",
      ),
      WAITING_MEMBERSHIP_FOOTER,
    );
  }
  if (openApplication.status === "accepted") {
    return withControlFooter(
      buildSuccessEmbed(
        "Application Accepted",
        formatAcceptedApplicationDescription(
          openApplication.reviewerDiscordUserId,
          application.acceptanceMessage,
        ),
      ),
      OUTCOME_CLOSE_FOOTER,
    );
  }
  if (openApplication.status === "rejected") {
    return withControlFooter(
      buildNotFoundEmbed(
        "Application Rejected",
        formatRejectedApplicationDescription(
          openApplication.reviewerDiscordUserId,
          application.rejectionMessage,
        ),
      ),
      OUTCOME_CLOSE_FOOTER,
    );
  }
  return withControlFooter(
    buildInfoEmbed(
      "Application Withdrawn",
      "The applicant withdrew this application.",
    ),
    OUTCOME_CLOSE_FOOTER,
  );
}

export function buildWaitingApplicationEmbed(
  description: string,
): EmbedBuilder {
  return withControlFooter(
    buildInfoEmbed("Waiting For In-Game Membership", description),
    WAITING_MEMBERSHIP_FOOTER,
  );
}

export function buildAcceptedApplicationEmbed(
  description: string,
): EmbedBuilder {
  return withControlFooter(
    buildSuccessEmbed("Application Accepted", description),
    OUTCOME_CLOSE_FOOTER,
  );
}

export function buildRejectedApplicationEmbed(
  description: string,
): EmbedBuilder {
  return withControlFooter(
    buildNotFoundEmbed("Application Rejected", description),
    OUTCOME_CLOSE_FOOTER,
  );
}

export function buildWithdrawnApplicationEmbed(
  description: string,
): EmbedBuilder {
  return withControlFooter(
    buildInfoEmbed("Application Withdrawn", description),
    OUTCOME_CLOSE_FOOTER,
  );
}

export function buildClosedApplicationEmbed(description: string): EmbedBuilder {
  return withControlFooter(
    buildInfoEmbed("Application Closed", description),
    CLOSED_CHANNEL_FOOTER,
  );
}

export function buildReopenedApplicationEmbed(
  description: string,
): EmbedBuilder {
  return withControlFooter(buildInfoEmbed("Application Reopened", description), OUTCOME_CLOSE_FOOTER);
}

export function buildArchivedApplicationEmbed(): EmbedBuilder {
  return withControlFooter(
    buildInfoEmbed(
      "Application Target Removed",
      "The target member group was removed. This application and its decision are retained as history, and the channel is closed.",
    ),
    REVIEWER_ONLY_FOOTER,
  );
}

export function buildCharacterMatchesEmbed(
  server: AlbionServer,
  query: string,
  players: AlbionSearchPlayer[],
  attemptCount: number,
): EmbedBuilder {
  if (players.length === 0)
    return buildCharacterSearchStatusEmbed(
      "No Character Matches",
      query,
      attemptCount,
      `No Albion Online characters were found on ${getAlbionServerLabel(server)}. Correct the name and try again. The applicant or a reviewer can retry the search.`,
    );
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Character Selection")
    .setDescription(
      players
        .map(
          (player, index) =>
            `${index + 1}. ${player.name} • ${getAlbionServerLabel(server)} • \`${player.id}\``,
        )
        .join("\n"),
    )
    .addFields(
      { name: "Latest Search", value: query, inline: true },
      { name: "Search Attempts", value: String(attemptCount), inline: true },
    )
    .setFooter({ text: CHARACTER_CONTROL_FOOTER });
}

export function buildCharacterResolvedEmbed(
  server: AlbionServer,
  player: AlbionPlayer,
  title: string,
  attemptCount: number,
  verifiedAllianceDisplay?: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(title)
    .addFields(
      { name: "Character", value: player.name },
      { name: "Server", value: getAlbionServerLabel(server), inline: true },
      { name: "Guild", value: player.guildName ?? "none", inline: true },
      {
        name: "Alliance",
        value: verifiedAllianceDisplay ?? player.allianceName ?? "none",
        inline: true,
      },
      { name: "Character ID", value: `\`${player.id}\`` },
      { name: "Search Attempts", value: String(attemptCount) },
    )
    .setFooter({ text: CHARACTER_CONTROL_FOOTER });
}

export function buildCharacterSearchStatusEmbed(
  title: string,
  query: string,
  attemptCount: number,
  description: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INVALID_COLOR)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: "Latest Search", value: query, inline: true },
      { name: "Search Attempts", value: String(attemptCount), inline: true },
      { name: "Status", value: "No character selected" },
    )
    .setFooter({ text: CHARACTER_CONTROL_FOOTER });
}

export function buildApplicationListEmbed(
  classes: ApplicationClass[],
): EmbedBuilder {
  return buildInfoEmbed(
    "Applications",
    classes.length === 0
      ? "No application classes configured."
      : classes
          .map(
            (application) =>
              `${application.name} • ${application.enabled ? "Enabled" : "Disabled"} • ${getAlbionServerLabel(application.albionServer)}`,
          )
          .join("\n"),
  );
}

export function buildApplicationShowEmbed(
  application: ApplicationClass,
  group: MemberGroup | undefined,
  categoryName: string | undefined,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(application.name)
    .addFields(
      { name: "Status", value: application.enabled ? "Enabled" : "Disabled" },
      { name: "Server", value: getAlbionServerLabel(application.albionServer) },
      {
        name: formatApplicationGroupFieldName(group),
        value: formatApplicationGroup(group, application.memberGroupId),
      },
      { name: "Category", value: categoryName ?? application.ticketCategoryId },
      { name: "Reviewer", value: formatRole(application.reviewerRoleId) },
      {
        name: "Role",
        value: application.activeRoleId
          ? formatRole(application.activeRoleId)
          : "None",
      },
      { name: "Button", value: formatApplicationButtonLink(application) },
      {
        name: "Questions",
        value:
          application.questions.length === 0
            ? "Character Name only."
            : application.questions
                .map((question) => question.label)
                .join("\n"),
      },
    );
}

export function formatApplicationGroup(
  group: MemberGroup | undefined,
  memberGroupId: string | undefined,
): string {
  return !group
    ? memberGroupId
      ? "Unavailable"
      : "Not configured"
    : formatMemberGroupLabel(group);
}

export function buildApplicationChannelName(
  applicationName: string,
  username: string,
): string {
  return `application-${slugify(applicationName)}-${slugify(username)}`.slice(
    0,
    95,
  );
}

export function withControlFooter(
  embed: EmbedBuilder,
  text: string,
): EmbedBuilder {
  return embed.setFooter({ text });
}
export function formatWarnings(warnings: Array<{ message: string }>): string {
  return warnings.length > 0
    ? `\n\n${warnings.map((warning) => warning.message).join("\n")}`
    : "";
}
export function formatAcceptedApplicationDescription(
  reviewerDiscordUserId: string | undefined,
  configuredMessage?: string,
  registrationDescription?: string,
): string {
  const attribution = formatApplicationDecisionAttribution(
    "accepted",
    reviewerDiscordUserId,
  );
  if (configuredMessage && registrationDescription)
    return `${attribution}\n\n${configuredMessage}\n\n${registrationDescription}`;
  if (configuredMessage) return `${attribution}\n\n${configuredMessage}`;
  if (registrationDescription)
    return `${attribution}\n\n${registrationDescription}`;
  return attribution;
}
export function formatRejectedApplicationDescription(
  reviewerDiscordUserId: string | undefined,
  configuredMessage?: string,
): string {
  const attribution = formatApplicationDecisionAttribution(
    "rejected",
    reviewerDiscordUserId,
  );
  return configuredMessage
    ? `${attribution}\n\n${configuredMessage}`
    : attribution;
}

function formatCharacterResolutionSummary(
  state: CharacterResolutionState,
): string {
  if (state === "selected") return "Selected";
  if (state === "not_listed") return "Not shown";
  if (state === "registered_to_other_user") return "Ownership conflict";
  return "Pending";
}
function formatApplicationGroupFieldName(
  group: MemberGroup | undefined,
): string {
  return formatMemberGroupTypeTitle(group?.groupType ?? "group");
}
function formatApplicationCharacterCandidate(
  player: AlbionSearchPlayer,
  server: AlbionServer,
  characterId = player.id,
): string {
  const alliance = player.allianceName
    ? `${player.allianceName}${player.allianceTag ? ` [${player.allianceTag}]` : ""}`
    : player.allianceTag
      ? `[${player.allianceTag}]`
      : undefined;
  return [player.guildName, alliance, getAlbionServerLabel(server), characterId]
    .filter(Boolean)
    .join(" • ");
}
function formatApplicationCharacterSelectDescription(
  player: AlbionSearchPlayer,
  server: AlbionServer,
): string {
  const suffix = `${getAlbionServerLabel(server)} • ${player.id}`;
  const candidate = formatApplicationCharacterCandidate(player, server);
  const prefix =
    candidate === suffix ? "" : candidate.slice(0, -(suffix.length + 3));
  if (!prefix) return truncateSelectText(suffix);
  const description = `${prefix} • ${suffix}`;
  if (description.length <= 100) return description;
  const prefixLimit = 100 - suffix.length - 3;
  return prefixLimit < 4
    ? truncateSelectText(suffix)
    : `${truncateSelectText(prefix, prefixLimit)} • ${suffix}`;
}
function formatApplicationButtonLink(application: ApplicationClass): string {
  return !application.sourceChannelId || !application.sourceMessageId
    ? "Not configured"
    : `https://discord.com/channels/${application.discordGuildId}/${application.sourceChannelId}/${application.sourceMessageId}`;
}
function formatApplicationDecisionAttribution(
  decision: "accepted" | "rejected",
  reviewerDiscordUserId: string | undefined,
): string {
  return reviewerDiscordUserId
    ? `Application ${decision} by <@${reviewerDiscordUserId}>.`
    : "Reviewer information is unavailable for this retained application.";
}
function slugify(value: string): string {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "ticket"
  );
}
function truncateSelectText(value: string, limit = 100): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}


export function hasValidApplicationSelection(application: OpenApplication): boolean {
  return application.characterResolutionState === "selected"
    && !!application.selectedAlbionCharacterId && !!application.selectedCharacterName
    && (!application.selectedCharacterOwnerDiscordUserId || application.selectedCharacterOwnerDiscordUserId === application.applicantDiscordUserId);
}

export type ApplicationIntakeCardOptions = {
  players?: AlbionSearchPlayer[];
  statusText?: string;
  searching?: boolean;
  publishReview?: boolean;
  openingApplicantId?: string;
};

export function buildIntakeButtons(applicationId: string, selected: boolean): ActionRowBuilder<ButtonBuilder> {
  const button = (action: string, label: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`${APPLICATION_CUSTOM_PREFIX}${action}:${applicationId}`).setLabel(label).setStyle(style);
  return new ActionRowBuilder<ButtonBuilder>().addComponents([
    button("retry-character", "Retry Character Search", ButtonStyle.Primary),
    ...(selected
      ? [button("withdraw", "Withdraw"), button("close", "Close"), button("accept", "Accept", ButtonStyle.Success), button("reject", "Reject", ButtonStyle.Danger)]
      : [button("close", "Close"), button("withdraw", "Withdraw")]),
  ]);
}

export function buildApplicationIntakeCard(
  application: ApplicationClass,
  openApplication: OpenApplication,
  group?: MemberGroup,
  options: ApplicationIntakeCardOptions = {},
): ComponentsV2Payload {
  const selected = hasValidApplicationSelection(openApplication);
  const embed = buildInitialApplicationEmbed(application, openApplication, group);
  if (options.searching) embed.setDescription(`<@${openApplication.applicantDiscordUserId}>, searching for your Albion Online character…`);
  else if (options.statusText) {
    if (selected) embed.addFields({ name: "Character Search", value: options.statusText });
    else embed.setDescription(`<@${openApplication.applicantDiscordUserId}>, ${options.statusText}`);
  }
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (!selected && !options.searching && options.players?.length) rows.push(
    buildApplicationCharacterSelectRow(application.albionServer, openApplication.applicationId, options.players, openApplication.characterSearchAttemptCount),
  );
  rows.push(buildIntakeButtons(openApplication.applicationId, selected));
  const payload = buildApplicationV2Card(embed, rows);
  if (options.openingApplicantId) payload.allowedMentions = { parse: [], repliedUser: false, users: [options.openingApplicantId] };
  return payload;
}

/** Configuration Markdown is preserved verbatim in one accented container. */
export function buildApplicationInstructionsMessage(text: string): MessageCreateOptions {
  return v2Message({ text, accentColor: INFO_COLOR });
}

/** Preserve configured Markdown and deliberate recipients inside an accented card. */
export function buildApplicationStandaloneText(text: string, notifyRoleId?: string): MessageCreateOptions {
  return v2Message({ text, accentColor: INFO_COLOR,
    allowedMentions: { parse: [], repliedUser: false, ...(notifyRoleId ? { roles: [notifyRoleId] } : {}) } });
}

/** Preserve every answer character and order within Discord's 4000-character V2 budget. */
export function buildApplicationAnswerMessages(answers: OpenApplication["modalAnswers"]): MessageCreateOptions[] {
  const title = "# Application Answers";
  const messages: MessageCreateOptions[] = [];
  let container = new ContainerBuilder().setAccentColor(INFO_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(title));
  let used = title.length;
  let count = 1;
  const flush = () => {
    if (count === 1) return;
    messages.push({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [], repliedUser: false } });
    container = new ContainerBuilder().setAccentColor(INFO_COLOR).addTextDisplayComponents(new TextDisplayBuilder().setContent(title));
    used = title.length; count = 1;
  };
  for (const answer of answers.filter((item) => item.answer.length > 0)) {
    let remaining = `**${answer.question}**\n${answer.answer}`;
    while (remaining.length) {
      if (used === 4000 || count === 38) flush();
      let length = Math.min(remaining.length, 4000 - used);
      // A Discord message must not end halfway through an emoji surrogate pair.
      const last = remaining.charCodeAt(length - 1);
      if (length < remaining.length && last >= 0xd800 && last <= 0xdbff) length--;
      if (!length) { flush(); continue; }
      const part = remaining.slice(0, length);
      remaining = remaining.slice(part.length);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(part));
      used += part.length; count++;
      if (remaining.length) flush();
    }
  }
  flush();
  return messages;
}
