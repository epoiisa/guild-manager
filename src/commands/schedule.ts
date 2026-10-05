import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import type {
  MemberUpdateScheduleCadence,
  MemberUpdateScheduleRecord,
  createMemberUpdateScheduleRepository
} from "../db/memberUpdateScheduleRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { v2Reply } from "../discord/operationalMessages.js";
import { UTC_TIME_INPUT_HELP, UTC_TIME_OPTION_DESCRIPTION, parseUtcTime } from "../services/scheduling.js";
import {
  INFO_COLOR,
  INVALID_COLOR,
  buildInfoEmbed,
  buildSuccessEmbed,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";

type MemberUpdateScheduleRepository = ReturnType<typeof createMemberUpdateScheduleRepository>;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SCHEDULE_DAY_CHOICES = [
  { name: "Daily", value: "daily" },
  ...WEEKDAYS.map((day) => ({ name: day, value: day.toLowerCase() }))
];

interface ScheduleRequest {
  cadence: MemberUpdateScheduleCadence;
  weekday: number | null;
  hourUtc: number;
  minuteUtc: number;
}

export const scheduleCommand = new SlashCommandBuilder()
  .setName("schedule")
  .setDescription("Manage automatic member updates.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Schedule automatic member updates.")
      .addStringOption((option) =>
        option
          .setName("day")
          .setDescription("Daily or one UTC weekday.")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription(UTC_TIME_OPTION_DESCRIPTION)
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove the automatic member update schedule.")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("view")
      .setDescription("View the automatic member update schedule.")
  );

export async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduleRepository: MemberUpdateScheduleRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) {
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "set") {
    await handleScheduleSet(interaction, scheduleRepository);
    return;
  }

  if (subcommand === "remove") {
    await handleScheduleRemove(interaction, scheduleRepository);
    return;
  }

  if (subcommand === "view") {
    await handleScheduleView(interaction, scheduleRepository);
    return;
  }

  await interaction.reply(feedbackReply({
    cards: [
      new EmbedBuilder()
        .setColor(INVALID_COLOR)
        .setTitle("Unknown Schedule Command")
        .setDescription("Choose `/schedule set`, `/schedule remove`, or `/schedule view`.")
    ],
    flags: MessageFlags.Ephemeral
  }, "context"));
}

export async function handleScheduleAutocomplete(interaction: AutocompleteInteraction): Promise<boolean> {
  if (interaction.commandName !== "schedule") {
    return false;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "day") {
    await interaction.respond([]);
    return true;
  }

  const query = String(focused.value ?? "").toLocaleLowerCase();
  await interaction.respond(
    SCHEDULE_DAY_CHOICES
      .filter((choice) => choice.name.toLocaleLowerCase().includes(query) || choice.value.includes(query))
      .slice(0, 25)
  );
  return true;
}

async function handleScheduleSet(
  interaction: ChatInputCommandInteraction,
  scheduleRepository: MemberUpdateScheduleRepository
): Promise<void> {
  const request = parseScheduleRequest(
    interaction.options.getString("day", true),
    interaction.options.getString("time", true)
  );

  if (!request) {
    await interaction.reply(v2Reply({
      cards: [
        new EmbedBuilder()
          .setColor(INVALID_COLOR)
          .setTitle("Invalid Schedule")
          .setDescription(`Choose Daily or one UTC weekday. ${UTC_TIME_INPUT_HELP}`)
      ],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const schedule = await scheduleRepository.upsertSchedule({
    discordGuildId: interaction.guildId!,
    cadence: request.cadence,
    weekday: request.weekday,
    hourUtc: request.hourUtc,
    minuteUtc: request.minuteUtc,
    createdByDiscordUserId: interaction.user.id
  });

  await interaction.reply(feedbackReply({
    cards: [
      buildSuccessEmbed(
        "Member Update Schedule Set",
        `Automatic member updates will run ${formatSchedule(schedule)}.`
      )
    ],
    flags: MessageFlags.Ephemeral
  }));
}

async function handleScheduleRemove(
  interaction: ChatInputCommandInteraction,
  scheduleRepository: MemberUpdateScheduleRepository
): Promise<void> {
  const removed = await scheduleRepository.removeSchedule(interaction.guildId!);
  const embed = removed
    ? buildSuccessEmbed("Member Update Schedule Removed", "Automatic member updates are no longer scheduled.")
    : buildInfoEmbed("No Member Update Schedule", "No automatic member update schedule is currently set.");

  await interaction.reply(feedbackReply({
    cards: [embed],
    flags: MessageFlags.Ephemeral
  }));
}

async function handleScheduleView(
  interaction: ChatInputCommandInteraction,
  scheduleRepository: MemberUpdateScheduleRepository
): Promise<void> {
  const schedule = await scheduleRepository.getSchedule(interaction.guildId!);
  const embed = schedule ? buildScheduleViewEmbed(schedule) : buildInfoEmbed(
    "No Member Update Schedule",
    "No automatic member update schedule is currently set."
  );

  await interaction.reply(feedbackReply({
    cards: [embed],
    flags: MessageFlags.Ephemeral
  }));
}

export function parseScheduleRequest(dayValue: string, timeValue: string): ScheduleRequest | undefined {
  const day = parseScheduleDay(dayValue);
  const time = parseUtcTime(timeValue);

  if (!day || !time) {
    return undefined;
  }

  return {
    cadence: day.cadence,
    weekday: day.weekday === null ? null : (day.weekday + time.dayOffset) % 7,
    hourUtc: time.hour,
    minuteUtc: time.minute
  };
}

function parseScheduleDay(value: string): { cadence: "daily"; weekday: null } | { cadence: "weekly"; weekday: number } | undefined {
  const normalized = value.trim().toLocaleLowerCase();

  if (normalized === "daily") {
    return { cadence: "daily", weekday: null };
  }

  const weekday = WEEKDAYS.findIndex((day) => day.toLocaleLowerCase() === normalized);
  return weekday >= 0 ? { cadence: "weekly", weekday } : undefined;
}

function buildScheduleViewEmbed(schedule: MemberUpdateScheduleRecord): EmbedBuilder {
  const fields = [
    { name: "Schedule", value: formatSchedule(schedule), inline: false },
    { name: "Last run", value: formatOptionalTimestamp(schedule.lastRunAt), inline: true }
  ];

  if (schedule.lastError) {
    fields.push({ name: "Last error", value: schedule.lastError.slice(0, 1024), inline: false });
  }

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Member Update Schedule")
    .addFields(fields);
}

export function formatSchedule(schedule: Pick<MemberUpdateScheduleRecord, "cadence" | "weekday" | "hourUtc" | "minuteUtc">): string {
  return `${formatScheduleDay(schedule.cadence, schedule.weekday)} at ${formatUtcTime(schedule.hourUtc, schedule.minuteUtc)}`;
}

function formatScheduleDay(cadence: MemberUpdateScheduleCadence, weekday: number | null): string {
  return cadence === "daily" ? "Daily" : weekday === null ? "Unknown" : WEEKDAYS[weekday];
}

function formatUtcTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC`;
}

function formatOptionalTimestamp(date: Date | null): string {
  if (!date) {
    return "Never";
  }

  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}
