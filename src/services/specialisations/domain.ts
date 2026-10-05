import type { CharacterSpecialisation, SpecialisationRequest } from "../../db/specialisationRepository.js";
import { isAlbionServer, type AlbionServer } from "../albion/servers.js";
import {
  catalogueByKey,
  isLevelValidForKind,
  type CatalogueEntry,
  type SpecialisationKind,
  type SpecialisationLevel
} from "./catalogue.js";

export interface SpecialisationCharacterReference {
  albionServer: AlbionServer;
  albionCharacterId: string;
}

export interface SpecialisationRecordCatalogueGroups {
  current: CharacterSpecialisation[];
  notInCurrentCatalogue: CharacterSpecialisation[];
}

export type ConfirmationBlockReason = "proof_missing" | "submitter_ineligible";

export function parseSpecialisationCharacterReference(
  value: string
): SpecialisationCharacterReference | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const server = value.slice(0, separator);
  const albionCharacterId = value.slice(separator + 1).trim();
  if (!isAlbionServer(server) || !albionCharacterId) return undefined;
  return { albionServer: server, albionCharacterId };
}

export function formatSpecialisationCharacterReference(
  reference: SpecialisationCharacterReference
): string {
  return `${reference.albionServer}:${reference.albionCharacterId}`;
}

export function resolveEnabledTarget(
  targetKey: string,
  kind: SpecialisationKind,
  level: number,
  excludedKeys: ReadonlySet<string>
): CatalogueEntry | undefined {
  const target = catalogueByKey.get(targetKey);
  if (!target || target.kind !== kind || !isLevelValidForKind(kind, level)) return undefined;
  return excludedKeys.has(target.key) ? undefined : target;
}

export function isReviewerAuthorized(
  administrator: boolean,
  memberRoleIds: ReadonlySet<string>,
  configuredReviewerRoleIds: readonly string[] | string = []
): boolean {
  if (administrator) return true;
  return (typeof configuredReviewerRoleIds === "string" ? [configuredReviewerRoleIds] : configuredReviewerRoleIds)
    .some((roleId) => memberRoleIds.has(roleId));
}

export function confirmationBlockReason(
  request: SpecialisationRequest,
  proofAvailable: boolean,
  submitterEligible: boolean
): ConfirmationBlockReason | undefined {
  if (!proofAvailable || !request.reviewMessageId || request.reviewMessageDeletedAt) return "proof_missing";
  if (!submitterEligible) return "submitter_ineligible";
  return undefined;
}

export function groupRecordsByCurrentCatalogue(
  records: readonly CharacterSpecialisation[],
  excludedKeys: ReadonlySet<string>
): SpecialisationRecordCatalogueGroups {
  const current: CharacterSpecialisation[] = [];
  const notInCurrentCatalogue: CharacterSpecialisation[] = [];
  for (const record of records) {
    const canonical = catalogueByKey.get(record.targetKey);
    if (
      canonical
      && canonical.kind === record.targetKind
      && isLevelValidForKind(record.targetKind, record.level)
      && !excludedKeys.has(record.targetKey)
    ) {
      current.push(record);
    } else {
      notInCurrentCatalogue.push(record);
    }
  }
  return { current, notInCurrentCatalogue };
}

export function expectedLevel(kind: SpecialisationKind): SpecialisationLevel {
  return kind === "weapon" ? 100 : 800;
}
