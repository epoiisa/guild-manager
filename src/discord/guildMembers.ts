import type { Guild, GuildMember } from "discord.js";

const UNKNOWN_MEMBER_ERROR_CODE = 10_007;

export async function fetchGuildMemberIfPresent(
  guild: Guild,
  discordUserId: string
): Promise<GuildMember | undefined> {
  try {
    return await guild.members.fetch({ user: discordUserId, force: true });
  } catch (error) {
    if (isDiscordErrorCode(error, UNKNOWN_MEMBER_ERROR_CODE)) return undefined;
    throw error;
  }
}

export function isDiscordErrorCode(error: unknown, code: number): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
