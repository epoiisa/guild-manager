import {
  AttachmentBuilder,
  type Attachment,
  type TextChannel,
  type NewsChannel,
} from "discord.js";
import type {
  createContentRepository,
  ContentSnapshot,
} from "../../db/contentRepository.js";
import type { Logger } from "../../logging/logger.js";
import {
  approvalRoleValidationError,
  buildContentAnnouncementV2Message,
  buildContentControlV2Message,
  buildContentDetailsV2Message,
} from "./rendering.js";
import { buildThreadTitle } from "./threadTitle.js";
export async function provisionContent({
  repository,
  logger,
  parentChannel,
  guildId,
  hostUserId,
  title,
  description,
  roleLabels,
  scheduledStartAt,
  approvalRequired = false,
  multiSignupEnabled = false,
  graphic,
  validate,
}: {
  repository: ReturnType<typeof createContentRepository>;
  logger: Logger;
  parentChannel: TextChannel | NewsChannel;
  guildId: string;
  hostUserId: string;
  title: string;
  description: string;
  roleLabels: string[];
  scheduledStartAt: Date | null;
  approvalRequired?: boolean;
  multiSignupEnabled?: boolean;
  graphic?: Attachment;
  validate?: () => Promise<void>;
}) {
  if (!title.trim() || roleLabels.length < 1 || roleLabels.length > 25)
    throw new Error("Provide a title and between 1 and 25 role lines.");
  const roleError = approvalRoleValidationError(roleLabels, approvalRequired);
  if (roleError) throw new Error(roleError);
  if (scheduledStartAt && scheduledStartAt.getTime() <= Date.now())
    throw new Error("The UTC start time must still be in the future.");
  await validate?.();
  const message = await parentChannel.send(
    buildContentAnnouncementV2Message({
      title,
      description,
      scheduledStartAt,
    }),
  );
  let thread: Awaited<ReturnType<typeof message.startThread>> | undefined;
  let snapshot: ContentSnapshot | undefined;
  try {
    thread = await message.startThread({
      name: buildThreadTitle(title, scheduledStartAt),
      reason: "Create Guild Manager content signup thread",
    });
    await validate?.();
    snapshot = await repository.createContent({
      discordGuildId: guildId,
      sourceChannelId: parentChannel.id,
      threadChannelId: thread.id,
      hostDiscordUserId: hostUserId,
      title,
      description,
      scheduledStartAt,
      approvalRequired,
      multiSignupEnabled,
      postedAt: message.createdAt,
      roleLabels,
      graphicAttachmentName: graphic
        ? normalizedGraphicName(graphic)
        : undefined,
    });
    const detailsMessage = await thread.send({
      ...buildContentDetailsV2Message(snapshot.content),
      files: graphic
        ? [
            new AttachmentBuilder(graphic.url, {
              name: snapshot.content.graphicAttachmentName!,
            }),
          ]
        : [],
    });
    const controlMessage = await thread.send(buildContentControlV2Message(snapshot));
    await controlMessage.pin(
      "Pin Guild Manager content signup roles and controls",
    );
    await validate?.();
    await repository.setContentMessageIds(
      guildId,
      snapshot.content.contentId,
      message.id,
      controlMessage.id,
      detailsMessage.id,
    );
    await validate?.();
    logger.info("created content signup post and thread", {
      guildId: guildId,
      threadId: thread.id,
      announcementMessageId: message.id,
      controlMessageId: controlMessage.id,
      detailsMessageId: detailsMessage.id,
    });
    return {
      snapshot,
      announcementUrl: `https://discord.com/channels/${guildId}/${parentChannel.id}/${message.id}`,
    };
  } catch (error) {
    let cleanupFailed = false;
    if (snapshot) {
      await repository
        .deleteContent(guildId, snapshot.content.contentId)
        .catch(() => {
          cleanupFailed = true;
        });
    }
    await thread
      ?.delete("Roll back incomplete Guild Manager content signup thread")
      .catch(() => {
        cleanupFailed = true;
      });
    await message.delete().catch(() => {
      cleanupFailed = true;
    });
    if (cleanupFailed)
      throw new Error(
        "Creation failed and cleanup is uncertain. Ask an administrator to inspect the channel before hosting again.",
        { cause: error },
      );
    throw error;
  }
}
function normalizedGraphicName(attachment: Attachment): string {
  const extension = attachment.contentType?.toLocaleLowerCase().includes("png")
    ? ".png"
    : attachment.contentType?.toLocaleLowerCase().includes("gif")
      ? ".gif"
      : attachment.contentType?.toLocaleLowerCase().includes("webp")
        ? ".webp"
        : ".jpg";
  return `content-builds-graphic${extension}`;
}
