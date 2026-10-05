import {
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationClass } from "../db/applicationRepository.js";
import type { MemberGroup } from "../db/membershipRepository.js";
import { assertStandardMessage } from "../testSupport/messageAssertions.js";
import {
  handleApplicationButton,
  handleApplicationModalSubmit
} from "./application.js";

const application: ApplicationClass = {
  applicationClassId: "class-1",
  discordGuildId: "guild-1",
  name: "Guild Application",
  outcomeType: "member_group",
  memberGroupId: "group-1",
  albionServer: "europe",
  ticketCategoryId: "category-1",
  reviewerRoleId: "reviewer-role",
  questions: [],
  enabled: true,
  createdByDiscordUserId: "creator"
};

const activeGroup: MemberGroup = {
  memberGroupId: "group-1",
  discordGuildId: "guild-1",
  albionServer: "europe",
  groupType: "guild",
  groupName: "Guild One"
};

test("application entry button replies with the approved ephemeral one-line response for an active target-group member", async () => {
  const replies: unknown[] = [];
  const shownModals: unknown[] = [];
  const membershipLookups: unknown[][] = [];
  const interaction = {
    customId: "app:open:class-1",
    guildId: "guild-1",
    user: { id: "applicant" },
    inCachedGuild: () => true,
    reply: async (payload: unknown) => { replies.push(payload); },
    showModal: async (modal: unknown) => { shownModals.push(modal); }
  };

  const handled = await handleApplicationButton(
    interaction as unknown as ButtonInteraction,
    { getApplicationClass: async () => application } as unknown as Parameters<typeof handleApplicationButton>[1],
    {
      getActiveMemberGroupForUser: async (...args: unknown[]) => {
        membershipLookups.push(args);
        return activeGroup;
      }
    } as unknown as Parameters<typeof handleApplicationButton>[2],
    {} as Parameters<typeof handleApplicationButton>[3]
  );

  assert.equal(handled, true);
  assert.deepEqual(membershipLookups, [["guild-1", "group-1", "applicant"]]);
  assert.equal(shownModals.length, 0);
  assert.equal(replies.length, 1);
  assertAlreadyRegisteredReply(replies[0]);
});

test("application entry button opens the modal when no active target-group membership exists", async () => {
  const replies: unknown[] = [];
  const shownModals: Array<{ toJSON(): { custom_id?: string } }> = [];
  const interaction = {
    customId: "app:open:class-1",
    guildId: "guild-1",
    user: { id: "applicant" },
    inCachedGuild: () => true,
    reply: async (payload: unknown) => { replies.push(payload); },
    showModal: async (modal: { toJSON(): { custom_id?: string } }) => { shownModals.push(modal); }
  };

  await handleApplicationButton(
    interaction as unknown as ButtonInteraction,
    { getApplicationClass: async () => application } as unknown as Parameters<typeof handleApplicationButton>[1],
    { getActiveMemberGroupForUser: async () => undefined } as unknown as Parameters<typeof handleApplicationButton>[2],
    {} as Parameters<typeof handleApplicationButton>[3]
  );

  assert.equal(replies.length, 0);
  assert.equal(shownModals.length, 1);
  assert.equal(shownModals[0].toJSON().custom_id, "app:submit:class-1");
});

test("application submission repeats the membership check before creating a ticket", async () => {
  const edits: unknown[] = [];
  let deferred = false;
  const interaction = {
    customId: "app:submit:class-1",
    guildId: "guild-1",
    user: { id: "applicant" },
    inCachedGuild: () => true,
    get deferred() { return deferred; },
    replied: false,
    reply: async () => assert.fail("submission should acknowledge before checking membership"),
    deferReply: async () => { deferred = true; },
    editReply: async (payload: unknown) => { edits.push(payload); }
  };

  const handled = await handleApplicationModalSubmit(
    interaction as unknown as ModalSubmitInteraction,
    { getApplicationClass: async () => application } as unknown as Parameters<typeof handleApplicationModalSubmit>[1],
    { getActiveMemberGroupForUser: async () => activeGroup } as unknown as Parameters<typeof handleApplicationModalSubmit>[2],
    {} as Parameters<typeof handleApplicationModalSubmit>[3]
  );

  assert.equal(handled, true);
  assert.equal(deferred, true);
  assert.equal(edits.length, 1);
  assertAlreadyRegisteredReply(edits[0], false);
});

test("application provisioning deletes its new channel when target removal wins the final lock", async () => {
  const edits: unknown[] = [];
  const events: string[] = [];
  const sentMessages: unknown[] = [];
  const openApplication = {
    applicationId: "application-1",
    applicationClassId: application.applicationClassId,
    discordGuildId: application.discordGuildId,
    applicantDiscordUserId: "applicant",
    submittedCharacterName: "Applicant Character",
    modalAnswers: [],
    albionServer: "europe",
    characterResolutionState: "unresolved",
    characterSearchAttemptCount: 0,
    status: "open",
    channelStatus: "open"
  };
  const ticket = {
    id: "ticket-1",
    send: async (payload: unknown) => { sentMessages.push(payload); return { id: "control-1" }; },
    delete: async () => { events.push("delete-channel"); },
    toString: () => "<#ticket-1>"
  };
  const guild = {
    id: "guild-1",
    roles: { everyone: { id: "everyone" } },
    channels: { create: async () => ticket },
    client: { user: { id: "bot" } },
    members: { fetch: async () => undefined }
  };
  const interaction = {
    customId: "app:submit:class-1",
    guildId: "guild-1",
    guild,
    user: { id: "applicant" },
    member: { id: "applicant", user: { username: "applicant" }, roles: { add: async () => undefined } },
    fields: { getTextInputValue: () => "Applicant Character" },
    inCachedGuild: () => true,
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { edits.push(payload); }
  };
  const repository = {
    getApplicationClass: async () => application,
    createOpenApplication: async () => openApplication,
    setOpenApplicationTicketChannel: async () => openApplication,
    setApplicationControlMessageId: async () => openApplication,
    setCharacterResolutionMessageId: async () => openApplication,
    getOpenApplication: async () => openApplication,
    beginApplicationCharacterSearch: async () => undefined,
    isOpenApplicationClassOperational: async () => false,
    hasOpenApplicationRequiringRole: async () => false,
    markApplicationChannelDeleted: async () => { events.push("mark-deleted"); return openApplication; }
  };

  await handleApplicationModalSubmit(
    interaction as unknown as ModalSubmitInteraction,
    repository as unknown as Parameters<typeof handleApplicationModalSubmit>[1],
    {
      getActiveMemberGroupForUser: async () => undefined,
      listMemberGroups: async () => [activeGroup],
      listQualifiedRoleIdsForUser: async () => [],
      listRegisteredCharactersByName: async () => []
    } as unknown as Parameters<typeof handleApplicationModalSubmit>[2],
    { searchCharacters: async () => ({ players: [] }) } as unknown as Parameters<typeof handleApplicationModalSubmit>[3]
  );

  assert.deepEqual(events, ["delete-channel", "mark-deleted"]);
  const initialMessage = sentMessages[0] as { components?: Array<{ toJSON(): { components: Array<{ content?: string }> } }>; allowedMentions?: unknown; flags?: number };
  assert.equal(initialMessage.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(
    initialMessage.components?.[0]?.toJSON().components.map((component) => component.content).filter(Boolean),
    [
      "# Guild One Application",
      "<@applicant>, searching for your Albion Online character…",
      "*The applicant can withdraw this application. Reviewers can close it.*"
    ]
  );
  assert.deepEqual(initialMessage.allowedMentions, { parse: [], repliedUser: false, users: ["applicant"] });
  const final = assertStandardMessage(edits.at(-1));
  assert.match(final.content, /target member group was removed/);
});

function assertAlreadyRegisteredReply(payload: unknown, ephemeral = true): void {
  const reply = assertStandardMessage(payload);
  assert.equal(reply.flags, MessageFlags.SuppressEmbeds | (ephemeral ? MessageFlags.Ephemeral : 0));
  assert.equal(reply.content, "You are already registered to Guild One • Europe. No application was opened.");
}
