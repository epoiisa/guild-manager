import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType } from "discord.js";
import { refreshPendingSpecialisationOwnership, withSpecialisationPresentation } from "./ownership.js";

function fixture() {
  let state = "pending";
  const edits: unknown[] = [];
  const request = { specialisationRequestId: "request", discordGuildId: "guild", state, submittedByDiscordUserId: "old-owner",
    currentOwnerDiscordUserId: "new-owner", characterName: "Character", targetDisplayName: "Battleaxe", albionServer: "asia",
    reviewChannelId: "channel", reviewMessageId: "message" };
  const repository = {
    listRequests: async () => [request],
    getRequest: async () => ({ ...request, state })
  } as never;
  const reviewers = { effectiveRoleIds: async () => ["reviewer"] } as never;
  const message = {
    components: [{ type: ComponentType.Container, components: [{ type: ComponentType.MediaGallery, items: [{
      description: "Weapon specialisation proof", media: { attachment_id: "proof", url: "https://example.com/proof.png", content_type: "image/png" }
    }] }] }], attachments: new Map(), edit: async (edit: unknown) => { edits.push(edit); }
  };
  const guild = { id: "guild", channels: { fetch: async () => ({ isTextBased: () => true, messages: { fetch: async () => message } }) } } as never;
  return { repository, reviewers, guild, edits, complete: () => { state = "confirmed"; } };
}

test("recovery refresh preserves proof and silently shows current ownership", async () => {
  const f = fixture();
  assert.deepEqual(await refreshPendingSpecialisationOwnership(f.guild, f.repository, f.reviewers, "asia", "character"), []);
  assert.equal(f.edits.length, 1);
  const edit = f.edits[0] as { components: unknown[]; attachments: unknown[]; allowedMentions: unknown };
  assert.deepEqual(edit.attachments, [{ id: "proof" }]);
  assert.deepEqual(edit.allowedMentions, { parse: [], repliedUser: false });
  assert.match(JSON.stringify(edit), /<@new-owner>/);
  assert.doesNotMatch(JSON.stringify(edit), /<@old-owner>/);
});

test("recovery refresh queued behind review cannot restore proof or controls on the completed card", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const review = withSpecialisationPresentation("guild", "request", async () => { await wait; f.complete(); });
  const refresh = refreshPendingSpecialisationOwnership(f.guild, f.repository, f.reviewers, "asia", "character");
  release();
  await review;
  assert.deepEqual(await refresh, []);
  assert.equal(f.edits.length, 0);
});

test("presentation failure returns a sanitized warning without undoing registration", async () => {
  const f = fixture();
  const guild = { id: "guild", channels: { fetch: async () => { throw new Error("sensitive detail"); } } } as never;
  const warnings = await refreshPendingSpecialisationOwnership(guild, f.repository, f.reviewers, "asia", "character");
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /sensitive detail/);
  assert.equal(f.edits.length, 0);
});
