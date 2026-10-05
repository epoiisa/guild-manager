import {
  AttachmentBuilder,
  MessageFlags,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type InteractionEditReplyOptions
} from "discord.js";
import type {
  MemberGroup,
  MemberGroupProfile,
  createMembershipRepository
} from "../db/membershipRepository.js";
import type { createMemberUpdateScheduleRepository } from "../db/memberUpdateScheduleRepository.js";
import {
  formatCharacterUserTextPair,
  formatMemberGroupLabel,
  formatMemberGroupTypeTitle
} from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;
export type MemberGroupReportScheduleRepository = Pick<ReturnType<typeof createMemberUpdateScheduleRepository>, "getSchedule">;

export async function replyWithMemberGroupReport(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  group: MemberGroup,
  scheduleRepository: MemberGroupReportScheduleRepository
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [profiles, schedule] = await Promise.all([
    membershipRepository.listProfilesForGroupReport(interaction.guildId!, group.memberGroupId),
    scheduleRepository.getSchedule(interaction.guildId!)
  ]);

  const report = await formatMemberGroupReport(interaction.guild, group, profiles, new Date(), Boolean(schedule));

  await interaction.editReply({
    ...report,
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [], repliedUser: false }
  });
}

async function formatMemberGroupReport(
  guild: Guild | null,
  group: MemberGroup,
  profiles: MemberGroupProfile[],
  generatedAt: Date,
  hasSchedule: boolean
): Promise<InteractionEditReplyOptions> {
  // One instant supplies the local Discord timestamp and UTC file metadata.
  const iso = generatedAt.toISOString();
  const timestamp = `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} • ${iso.slice(11, 16)} UTC`;
  const title = `${formatMemberGroupTypeTitle(group.groupType)} Report`;
  const summary = summarizeProfileStates(profiles);
  const textProfileLines = await Promise.all(profiles.map((profile) => formatProfileTextLine(guild, profile, generatedAt, hasSchedule)));
  const reportText = [
    title,
    formatMemberGroupLabel(group),
    timestamp,
    "",
    `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`,
    ...(summary ? [summary] : []),
    "",
    ...(textProfileLines.length ? textProfileLines : ["No member profiles were found for this group."])
  ].join("\n");

  return {
    content: `${formatMemberGroupTypeTitle(group.groupType)} report for ${escapeMarkdown(group.groupName)} at <t:${Math.floor(generatedAt.getTime() / 1000)}:F>.`,
    files: [
      new AttachmentBuilder(Buffer.from(reportText, "utf8"), {
        name: buildReportFilename(group, iso)
      })
    ]
  };
}

function buildReportFilename(group: MemberGroup, iso: string): string {
  const name = group.groupName.normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)?.join("-") || "unnamed";
  const timestamp = `${iso.slice(0, 16).replace(/[-:]/g, "")}Z`;
  return `${group.groupType}-report-${name}-${timestamp}.txt`;
}

async function formatProfileTextLine(guild: Guild | null, profile: MemberGroupProfile, generatedAt: Date, hasSchedule: boolean): Promise<string> {
  const characterName = profile.characterName ?? profile.albionCharacterId;
  const status = formatProfileLifecycle(profile, generatedAt, hasSchedule);
  return profile.discordUserId
    ? `${await formatCharacterUserTextPair(guild, characterName, profile.discordUserId)}${status ? ` • ${status}` : ""}`
    : `${characterName} • ${status || "orphaned"}`;
}

function profileStateLabel(profile: MemberGroupProfile): string {
  if (profile.registrationState) return profile.registrationState;
  if (profile.lifecycleState === "departed") return "departed";
  if (profile.lifecycleState === "unregistered") return "unregistered";
  return profile.discordUserId ? "registered" : "orphaned";
}

function formatProfileLifecycle(profile: MemberGroupProfile, generatedAt: Date, hasSchedule: boolean): string {
  const state = profileStateLabel(profile);
  if (state === "purged") return "purged • no retained entitlements • /character register required";
  const departed = profile.lifecycleState === "departed";
  const parts: string[] = [];
  if (departed) {
    const deadline = profile.departureExpiresAt;
    const expired = deadline && deadline.getTime() <= generatedAt.getTime();
    if (expired && state === "hold") {
      parts.push("departed; grace expired");
    } else {
      parts.push("departed");
      if (expired) {
        parts.push("grace period expired", hasSchedule
          ? "awaiting scheduled update or manual /update"
          : "awaiting manual /update; no update scheduled");
      } else if (deadline) {
        parts.push(`grace period ends ${formatLifecycleTime(deadline)}`);
      }
    }
  }
  if (state === "hold") {
    const deadline = profile.registrationExpiresAt;
    if (deadline && deadline.getTime() <= generatedAt.getTime()) {
      parts.push(`Discord registration hold overdue since ${formatLifecycleTime(deadline)}`, "awaiting automatic cleanup");
    } else if (departed && deadline) {
      parts.push(`Discord registration hold until ${formatLifecycleTime(deadline)}`);
    } else {
      parts.push("registration held after Discord departure",
        deadline ? `recover with /character register before ${formatLifecycleTime(deadline)}` : "/character register required");
    }
  } else if (state === "abandoned") {
    parts.push("Discord registration abandoned", "/character register required");
  } else if (state !== "registered" && state !== "departed") {
    parts.push(state);
  }
  if (profile.lifecycleWarning) parts.push("last lifecycle check failed");
  return parts.join(" • ");
}

function formatLifecycleTime(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)} UTC`;
}

function summarizeProfileStates(profiles: MemberGroupProfile[]): string {
  if (!profiles.some(profile => profile.lifecycleState || profile.registrationState)) return "";
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    const state = profileStateLabel(profile);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return ["registered", "unregistered", "departed", "hold", "abandoned", "purged", "orphaned"]
    .filter(state => counts.has(state)).map(state => `${counts.get(state)} ${state}`).join(" • ");
}
