import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";
import type { SpecialisationRequest } from "../../db/specialisationRepository.js";
import { INFO_COLOR, INVALID_COLOR, SUCCESS_COLOR } from "../../commands/configurationHelpers.js";
import { feedbackMessage } from "../../discord/feedbackMessages.js";
import { getAlbionServerLabel } from "../albion/servers.js";

export const SPECIALISATION_BUTTON_PREFIX = "specialisation:";
export const NO_REVIEWER_NOTICE = "No manager role is configured. Use `/manager add specialisation` to set one.";

export interface PendingSpecialisationProof {
  attachmentId: string;
  attachmentUrl: string;
}

export type SpecialisationDecision = "confirmed" | "dismissed";

export function buildPendingSpecialisationCard(
  request: SpecialisationRequest,
  proofUrl: string,
  reviewerRoleIds: readonly string[] | string = [],
  notifyReviewer = true
): MessageCreateOptions & MessageEditOptions {
  const reviewerRoleIdsUnique = [...new Set(typeof reviewerRoleIds === "string" ? [reviewerRoleIds] : reviewerRoleIds)].sort();
  const notification = reviewerRoleIdsUnique.length > 0
    ? `${reviewerRoleIdsUnique.map((roleId) => `<@&${roleId}>`).join(" ")} Review this request.`
    : NO_REVIEWER_NOTICE;
  const container = baseContainer(request, "Pending", INFO_COLOR)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(proofUrl).setDescription("Weapon specialisation proof")
      )
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(notification))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSpecialisationButtonId("confirmed", request.specialisationRequestId))
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildSpecialisationButtonId("dismissed", request.specialisationRequestId))
          .setLabel("Dismiss")
          .setStyle(ButtonStyle.Danger)
      )
    );
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: reviewerRoleIdsUnique.length > 0 && notifyReviewer
      ? { parse: [], roles: reviewerRoleIdsUnique, repliedUser: false }
      : { parse: [], repliedUser: false }
  };
}

export function buildPendingSpecialisationCardEdit(
  request: SpecialisationRequest,
  proof: PendingSpecialisationProof,
  reviewerRoleIds: readonly string[] | string = []
): MessageEditOptions {
  return {
    // attachment:// resolves filenames; the fetched proof URL identifies the
    // existing image while the attachment list retains it by ID.
    ...buildPendingSpecialisationCard(request, proof.attachmentUrl, reviewerRoleIds, false),
    attachments: [{ id: proof.attachmentId }]
  };
}

export function buildFinalSpecialisationCard(
  request: SpecialisationRequest,
  decision: SpecialisationDecision
): MessageEditOptions {
  const status = decision === "confirmed" ? "Confirmed" : "Dismissed";
  const verb = decision === "confirmed" ? "confirmed" : "dismissed";
  return {
    components: [baseContainer(
      request,
      status,
      decision === "confirmed" ? SUCCESS_COLOR : INVALID_COLOR
    ).addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `The weapon specialisation request was ${verb}.`
      )
    )],
    flags: MessageFlags.IsComponentsV2,
    attachments: [],
    // A truthful, proof-free fallback while the new outcome is published.
    // Only the new message may notify the submitter.
    allowedMentions: { parse: [], repliedUser: false }
  };
}

export function buildSpecialisationOutcome(
  request: SpecialisationRequest,
  decision: SpecialisationDecision
): MessageCreateOptions {
  const owner = requestOwner(request);
  return feedbackMessage({
    text: `${owner ? `<@${owner}>, your` : "The"} ${escapeMarkdown(request.targetDisplayName)} specialisation request for ${escapeMarkdown(request.characterName)} (${getAlbionServerLabel(request.albionServer)}) was ${decision}.`,
    accentColor: decision === "confirmed" ? SUCCESS_COLOR : INVALID_COLOR,
    allowedMentions: {
      parse: [],
      users: owner ? [owner] : [],
      repliedUser: false
    }
  });
}

export function buildSpecialisationButtonId(
  decision: SpecialisationDecision,
  requestId: string
): string {
  return `${SPECIALISATION_BUTTON_PREFIX}${decision}:${requestId}`;
}

export function parseSpecialisationButtonId(
  customId: string
): { decision: SpecialisationDecision; requestId: string } | undefined {
  const match = /^specialisation:(confirmed|dismissed):([^:]+)$/.exec(customId);
  return match
    ? { decision: match[1] as SpecialisationDecision, requestId: match[2] }
    : undefined;
}

export function inspectPendingSpecialisationProof(
  message: Pick<Message, "components" | "attachments">
): PendingSpecialisationProof | undefined {
  const galleries = findMediaGalleries(message.components);
  if (galleries.length !== 1 || galleries[0].items.length !== 1) return undefined;
  const item = galleries[0].items[0];
  const media = "data" in item.media ? item.media.data : item.media;
  const attachmentId = media.attachment_id?.trim() || media.id?.trim();
  if (
    item.description !== "Weapon specialisation proof"
    || !attachmentId
    || !media.url?.trim()
    || !media.content_type?.toLocaleLowerCase().startsWith("image/")
  ) return undefined;

  // Components V2 uploads are canonicalised in the Media Gallery's API media
  // metadata and Discord does not necessarily populate Message#attachments.
  // The exact one-item gallery shape above is therefore the proof authority.
  return { attachmentId, attachmentUrl: media.url };
}

function baseContainer(
  request: SpecialisationRequest,
  status: "Pending" | "Confirmed" | "Dismissed",
  color: number
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Weapon Specialisation Request"),
      new TextDisplayBuilder().setContent(
        `${requestOwner(request) ? `<@${requestOwner(request)}>` : "Unregistered"} • ${escapeMarkdown(request.characterName)} (${getAlbionServerLabel(request.albionServer)}) • ${escapeMarkdown(request.targetDisplayName)} • ${status}`
      )
    );
}

function requestOwner(request: SpecialisationRequest): string | undefined {
  return request.currentOwnerDiscordUserId;
}

interface MediaGalleryShape {
  items: Array<{
    description: string | null;
    media: MediaShape | { data: MediaShape };
  }>;
}

interface MediaShape {
  attachment_id?: string;
  id?: string;
  url?: string;
  content_type?: string | null;
}

function findMediaGalleries(
  components: readonly { components?: readonly unknown[]; items?: unknown[]; type?: number }[]
): MediaGalleryShape[] {
  const found: MediaGalleryShape[] = [];
  for (const component of components) {
    if (component.type === ComponentType.MediaGallery && Array.isArray(component.items)) {
      found.push(component as never);
    }
    if (Array.isArray(component.components)) {
      found.push(...findMediaGalleries(component.components as never));
    }
  }
  return found;
}
