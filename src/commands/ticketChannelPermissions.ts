import {
  OverwriteType,
  PermissionFlagsBits,
  type OverwriteResolvable,
  type TextChannel
} from "discord.js";
import { fetchGuildMemberIfPresent, isDiscordErrorCode } from "../discord/guildMembers.js";

const UNKNOWN_PERMISSION_OVERWRITE_ERROR_CODE = 10_009;

export function buildTicketConversationPermissionOverwrites(
  everyoneRoleId: string,
  memberId: string,
  reviewerRoleId: string
): OverwriteResolvable[] {
  const conversationPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles
  ];

  return [
    {
      id: everyoneRoleId,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: memberId,
      type: OverwriteType.Member,
      allow: conversationPermissions
    },
    {
      id: reviewerRoleId,
      type: OverwriteType.Role,
      allow: conversationPermissions
    }
  ];
}

export async function setTicketConversationSendPermission(
  channel: TextChannel,
  memberId: string,
  reviewerRoleId: string,
  allowed: boolean
): Promise<void> {
  const member = await fetchGuildMemberIfPresent(channel.guild, memberId);
  const edits: Array<Promise<unknown>> = [
    channel.permissionOverwrites.edit(
      reviewerRoleId,
      { SendMessages: allowed },
      { type: OverwriteType.Role }
    )
  ];
  if (member) {
    edits.push(channel.permissionOverwrites.edit(
      member.id,
      { SendMessages: allowed },
      { type: OverwriteType.Member }
    ).catch((error) => {
      if (isDiscordErrorCode(error, UNKNOWN_PERMISSION_OVERWRITE_ERROR_CODE)) return undefined;
      throw error;
    }));
  }
  await Promise.all(edits);
}
