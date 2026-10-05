import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterSpecialisation, SpecialisationRequest } from "../../db/specialisationRepository.js";
import { catalogueByKey } from "./catalogue.js";
import {
  confirmationBlockReason,
  formatSpecialisationCharacterReference,
  groupRecordsByCurrentCatalogue,
  isReviewerAuthorized,
  parseSpecialisationCharacterReference,
  resolveEnabledTarget
} from "./domain.js";

const now = new Date("2026-08-16T00:00:00Z");
const pendingRequest: SpecialisationRequest = {
  specialisationRequestId: "request-1",
  discordGuildId: "guild-1",
  submittedByDiscordUserId: "user-1",
  currentOwnerDiscordUserId: "user-1",
  albionServer: "europe",
  albionCharacterId: "character-1",
  characterName: "Character",
  targetKey: "weapon:battleaxe",
  targetKind: "weapon",
  targetDisplayName: "Battleaxe",
  level: 100,
  state: "pending",
  reviewChannelId: "channel-1",
  reviewMessageId: "message-1",
  createdAt: now,
  updatedAt: now
};

function record(overrides: Partial<CharacterSpecialisation> = {}): CharacterSpecialisation {
  return {
    characterSpecialisationId: "specialisation-1",
    discordGuildId: "guild-1",
    albionServer: "europe",
    albionCharacterId: "character-1",
    characterName: "Character",
    targetKey: "weapon:battleaxe",
    targetKind: "weapon",
    targetDisplayName: "Battleaxe",
    level: 100,
    source: "manual",
    recordedByDiscordUserId: "reviewer-1",
    recordedAt: now,
    ...overrides
  };
}

test("character references preserve the stable server and Albion character ID", () => {
  const reference = parseSpecialisationCharacterReference("europe:character:with:colons");
  assert.deepEqual(reference, { albionServer: "europe", albionCharacterId: "character:with:colons" });
  assert.equal(reference && formatSpecialisationCharacterReference(reference), "europe:character:with:colons");
  assert.equal(parseSpecialisationCharacterReference("unknown:character"), undefined);
  assert.equal(parseSpecialisationCharacterReference("europe:"), undefined);
});

test("target resolution enforces current catalogue, kind, level, and guild exclusion", () => {
  assert.equal(resolveEnabledTarget("weapon:battleaxe", "weapon", 100, new Set())?.name, "Battleaxe");
  assert.equal(resolveEnabledTarget("weapon:battleaxe", "tree", 800, new Set()), undefined);
  assert.equal(resolveEnabledTarget("weapon:battleaxe", "weapon", 800, new Set()), undefined);
  assert.equal(resolveEnabledTarget("weapon:battleaxe", "weapon", 100, new Set(["weapon:battleaxe"])), undefined);
});

test("reviewer authority requires the configured role unless Administrator applies", () => {
  assert.equal(isReviewerAuthorized(true, new Set(), undefined), true);
  assert.equal(isReviewerAuthorized(false, new Set(["role-1"]), "role-1"), true);
  assert.equal(isReviewerAuthorized(false, new Set(["role-2"]), "role-1"), false);
  assert.equal(isReviewerAuthorized(false, new Set(["role-1"]), undefined), false);
});

test("confirmation eligibility distinguishes missing proof from membership loss", () => {
  assert.equal(confirmationBlockReason(pendingRequest, true, true), undefined);
  assert.equal(confirmationBlockReason(pendingRequest, false, true), "proof_missing");
  assert.equal(confirmationBlockReason({ ...pendingRequest, reviewMessageDeletedAt: now }, true, true), "proof_missing");
  assert.equal(confirmationBlockReason(pendingRequest, true, false), "submitter_ineligible");
});

test("member reports retain disabled and no-longer-canonical records separately", () => {
  const current = record();
  const disabled = record({ characterSpecialisationId: "specialisation-2", targetKey: "weapon:warbow", targetDisplayName: "Warbow" });
  const removedFromCode = record({ characterSpecialisationId: "specialisation-3", targetKey: "weapon:legacy", targetDisplayName: "Legacy Weapon" });
  assert.ok(catalogueByKey.has(current.targetKey));

  const grouped = groupRecordsByCurrentCatalogue(
    [current, disabled, removedFromCode],
    new Set([disabled.targetKey])
  );
  assert.deepEqual(grouped.current.map((item) => item.characterSpecialisationId), ["specialisation-1"]);
  assert.deepEqual(
    grouped.notInCurrentCatalogue.map((item) => item.characterSpecialisationId),
    ["specialisation-2", "specialisation-3"]
  );
});
