import type { Logger } from "../logging/logger.js";
import type { RateLimitData } from "@discordjs/rest";

export const SLOW_INTERACTION_ACKNOWLEDGEMENT_WARNING_MILLISECONDS = 2_500;

type ChatInputCommandRouteSource = {
  commandName: string;
  options: {
    getSubcommandGroup(required?: boolean): string | null;
    getSubcommand(required?: boolean): string | null;
  };
};

export type ChatInputCommandOutcome = "completed" | "unhandled_error";

type InteractionAcknowledgementSource = {
  createdTimestamp: number;
  deferred?: boolean;
  replied?: boolean;
  responded?: boolean;
};

type InteractionFailureResponseSource = {
  deferred: boolean;
  replied: boolean;
  ephemeral?: boolean | null;
};

export type InteractionFailureResponseMethod = "edit_reply" | "follow_up" | "reply";

export function interactionFailureResponseMethod(
  interaction: InteractionFailureResponseSource
): InteractionFailureResponseMethod {
  if (!interaction.deferred && !interaction.replied) return "reply";
  if (interaction.deferred && !interaction.replied && interaction.ephemeral !== null && interaction.ephemeral !== undefined) {
    return "edit_reply";
  }
  return "follow_up";
}

export function interactionAcknowledgementContext(
  interaction: InteractionAcknowledgementSource,
  nowMilliseconds = Date.now()
): Record<string, boolean | number> {
  const deferred = interaction.deferred === true;
  const replied = interaction.replied === true;
  const responded = interaction.responded === true;
  return {
    interactionAgeMilliseconds: Math.max(0, nowMilliseconds - interaction.createdTimestamp),
    interactionAcknowledged: deferred || replied || responded,
    interactionDeferred: deferred,
    interactionReplied: replied,
    interactionResponded: responded
  };
}

export function logSlowUnacknowledgedInteraction(
  logger: Logger,
  interaction: InteractionAcknowledgementSource & { guildId: string | null },
  nowMilliseconds = Date.now()
): void {
  const acknowledgement = interactionAcknowledgementContext(interaction, nowMilliseconds);
  if (acknowledgement.interactionAcknowledged) return;

  logger.warn("interaction is approaching its acknowledgement deadline", {
    guildId: interaction.guildId,
    ...acknowledgement
  });
}

export function sanitizedRateLimitContext(rateLimit: RateLimitData): Record<string, boolean | number | string> {
  return {
    global: rateLimit.global,
    bucketHash: rateLimit.hash,
    limit: rateLimit.limit,
    method: rateLimit.method,
    route: sanitizeDiscordRoute(rateLimit.route),
    retryAfterMilliseconds: rateLimit.retryAfter,
    scope: rateLimit.scope,
    sublimitTimeoutMilliseconds: rateLimit.sublimitTimeout,
    timeToResetMilliseconds: rateLimit.timeToReset
  };
}

function sanitizeDiscordRoute(route: string): string {
  const segments = route.split("?")[0].split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const parent = segments[index - 1];
    const grandparent = segments[index - 2];
    if (parent === "webhooks" || parent === "interactions") {
      segments[index] = ":id";
      continue;
    }
    if (grandparent === "webhooks" || grandparent === "interactions") {
      segments[index] = ":token";
      continue;
    }
    if (/^\d{15,22}$/.test(segments[index])) segments[index] = ":id";
  }
  return segments.join("/");
}

export function normalizedChatInputCommandRoute(interaction: ChatInputCommandRouteSource): string {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  return [interaction.commandName, subcommandGroup, subcommand].filter((part): part is string => Boolean(part)).join(" ");
}

export function logHandledChatInputCommand(
  logger: Logger,
  interaction: ChatInputCommandRouteSource & { guildId: string | null },
  startedAtMilliseconds: number,
  outcome: ChatInputCommandOutcome,
  nowMilliseconds = Date.now()
): void {
  logger.info("chat input command handled", {
    commandRoute: normalizedChatInputCommandRoute(interaction),
    guildId: interaction.guildId,
    durationMilliseconds: Math.max(0, nowMilliseconds - startedAtMilliseconds),
    outcome
  });
}

// Keep generation and private draft identifiers out of telemetry routes.
export function normalizedContentComponentRoute(customId: string): string | undefined {
  if (customId.startsWith("content-panel:")) return "content-panel";
  if (customId.startsWith("content-host:")) return "content-host";
  return undefined;
}
