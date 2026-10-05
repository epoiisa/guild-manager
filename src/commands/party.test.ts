import { ApplicationCommandOptionType, ChannelType, ComponentType, MessageFlags, type EmbedBuilder, type ModalBuilder } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentSnapshot } from "../db/contentRepository.js";
import { activeGuildCommands } from "../discord/commands.js";
import {
  STANDBY_SIGNUP_VALUE,
  buildContentAnnouncementV2Message,
  buildContentCancellationMessage,
  buildContentCancellationMessages,
  buildContentControlV2Message,
  buildContentCreateModalId,
  buildContentDetailsV2Message,
  buildContentRescheduleMessage,
  buildContentRescheduleMessages,
  buildPartyListV2Messages,
  buildRoleSlotSelectRows,
  buildRoleSlotSelectValue,
  buildStartNotification,
  buildStartNotifications,
  parseContentModalId
} from "../services/content/rendering.js";
import { messageDescription, messageRows, messageSummary, messageText } from "../testSupport/messageAssertions.js";
import {
  buildThreadTitle,
  formatMovedToStandbyNote,
  handleContentAutocomplete,
  handleContentButton,
  handleContentModalSubmit,
  handleContentRoleSelect,
  isContentInteractionChannel,
  openSignupSelect,
  showContentEditModal
} from "./content.js";
import { handleJoinCommand, handleLeaveCommand, handlePartyCommand, handleStandbyCommand, joinCommand, leaveCommand, partyCommand, standbyCommand } from "./party.js";

test("a reconnected former host cannot use retained party management commands", async () => {
  const replies: unknown[] = [];
  const snapshot = contentSnapshot();
  await handlePartyCommand({
    inGuild: () => true, guildId: "guild-1", channelId: snapshot.content.threadChannelId,
    user: { id: snapshot.content.hostDiscordUserId },
    options: { getSubcommand: () => "archive", getSubcommandGroup: () => null },
    reply: async (payload: unknown) => { replies.push(payload); }
  } as never, {
    getContentByThread: async () => snapshot,
    isHostAuthorityRevoked: async () => true,
    markArchived: async () => assert.fail("revoked host must not archive the old activity")
  } as never, { debug() {}, info() {}, warn() {}, error() {} });
  assert.match(messageText(replies[0]), /Only the party host/);
});

test("multi-signup selectors include occupied roles and preserve the current numbered identity", () => {
  const snapshot = contentSnapshot();
  snapshot.slots[1].label = snapshot.slots[0].label;
  const choices = (user: string, host = false) => buildRoleSlotSelectRows(snapshot, user, host)
    .flatMap(row => row.toJSON().components[0].options);
  assert.deepEqual(choices("new-user").map(o => o.label), ["2. Tank"]);
  assert.deepEqual(choices("user-1").map(o => [o.label, o.default]), [["1. Tank", true], ["2. Tank", false]]);
  snapshot.content.multiSignupEnabled = true;
  for (const host of [false, true]) {
    assert.deepEqual(choices("new-user", host).map(o => o.label), ["1. Tank", "2. Tank", "3. DPS"]);
    assert.equal(choices("user-1", host).filter(o => o.default).length, 1);
    assert.equal(choices("new-user", host).some(o => o.value === STANDBY_SIGNUP_VALUE), false);
  }
});

for (const hostAssignment of [false, true]) {
  test(`all-filled Off mode returns private guidance without an empty menu, host=${hostAssignment}`, async () => {
    const snapshot = contentSnapshot();
    snapshot.slots.splice(1, 1);
    const replies: any[] = [];
    await openSignupSelect({ reply: async (p: unknown) => { replies.push(p); } } as never,
      { isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot } as never, snapshot, "new-user", hostAssignment);
    assert.equal(messageDescription(replies[0]), hostAssignment
      ? "All roles are filled for <@new-user>. They can use the Standby button or /standby."
      : "All roles are filled. Use the Standby button or /standby.");
    assert.equal(messageRows(replies[0]).length, 0);
    assert.ok(replies[0].flags & MessageFlags.Ephemeral);
  });
}

for (const approval of [false, true]) for (const host of [false, true]) {
  test(`old Standby menus cannot assign or request, approval=${approval}, host=${host}`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.approvalRequired = approval;
    const replies: any[] = [];
    await handleContentRoleSelect({
      customId: `content:slot:content-1:requester${host ? ":host" : ""}`, values: [STANDBY_SIGNUP_VALUE],
      inCachedGuild: () => true, guildId: "guild-1", channelId: "party-thread",
      user: { id: host ? "host-1" : "requester" }, reply: async (p: unknown) => { replies.push(p); }
    } as never, {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot,
      requestSignup: async () => assert.fail("An old Standby menu must not mutate signups or requests")
    } as never);
    assert.equal(messageDescription(replies[0]), "Use the Standby button or /standby.");
  });
}

test("both roster renderers group every user by numbered role and keep Standby separate", () => {
  const snapshot = contentSnapshot();
  snapshot.content.multiSignupEnabled = true;
  snapshot.slots[1].label = "Tank";
  snapshot.signups.push(
    { ...snapshot.signups[0], contentSignupId: "third", discordUserId: "third" },
    { ...snapshot.signups[0], contentSignupId: "fourth", discordUserId: "fourth", contentRoleSlotId: "slot-2" },
    { ...snapshot.signups[0], contentSignupId: "standby", discordUserId: "standby", contentRoleSlotId: null, signupType: "standby" }
  );
  const roster = messageText(buildContentControlV2Message(snapshot));
  assert.match(roster, /1\. Tank — <@user-1> <@third>\n2\. Tank — <@fourth>/);
  assert.match(roster, /\*\*Standby\*\*\n<@standby>/);
  assert.match(roster, /\*\*Host approval\*\* Not required/);
  assert.match(roster, /\*\*Multi-signup\*\* On/);
  snapshot.content.startedAt = new Date("2099-08-10T11:00:00Z");
  const start = messageText(buildStartNotifications(snapshot)[0]);
  assert.match(start, /1\. Tank <@user-1> <@third>\n2\. Tank <@fourth>/);
  assert.match(start, /\*\*Standby\*\*\n<@standby>/);
  for (const text of [roster, start]) {
    for (const signup of snapshot.signups) assert.equal(text.split(`<@${signup.discordUserId}>`).length - 1, 1);
    assert.doesNotMatch(text, /4\. Standby/);
  }
});

function largeParty(count: number): ContentSnapshot {
  const snapshot = contentSnapshot();
  snapshot.content.multiSignupEnabled = true;
  snapshot.content.startedAt = new Date("2099-08-10T11:00:00Z");
  snapshot.signups = Array.from({ length: count }, (_, index) => ({
    ...snapshot.signups[0], contentSignupId: String(index), discordUserId: String(100000000000000000n + BigInt(index)),
    signupType: index % 5 === 0 ? "standby" : "role",
    contentRoleSlotId: index % 5 === 0 ? null : "slot-1"
  }));
  return snapshot;
}

test("overflow roster keeps every signup and both settings in its report and visible controls", () => {
  const snapshot = largeParty(250);
  const payload = buildContentControlV2Message(snapshot);
  const visible = messageText(payload);
  assert.match(visible, /\*\*Host approval\*\* Not required/);
  assert.match(visible, /\*\*Multi-signup\*\* On/);
  assert.deepEqual(messageRows(payload)[0].components.map((c: any) => c.label), ["Join", "Standby", "Leave"]);
  const report = (payload.files![0] as { attachment: Buffer }).attachment.toString("utf8");
  assert.match(report, /\*\*Standby\*\*/);
  assert.match(report, /\*\*Host approval\*\* Not required/);
  assert.match(report, /\*\*Multi-signup\*\* On/);
  for (const user of snapshot.signups) assert.equal(report.split(`<@${user.discordUserId}>`).length - 1, 1);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("an oversized Standby section also uses the complete report fallback", () => {
  const snapshot = largeParty(250);
  for (const signup of snapshot.signups) { signup.signupType = "standby"; signup.contentRoleSlotId = null; }
  const message = buildContentControlV2Message(snapshot);
  const report = (message.files![0] as { attachment: Buffer }).attachment.toString("utf8");
  assert.match(report, /\*\*Standby\*\*/);
  for (const signup of snapshot.signups) assert.ok(report.includes(`<@${signup.discordUserId}>`));
  assert.ok(messageText(message).length < 4000);
});

test("empty or multiple role selections are rejected before any lookup or mutation", async () => {
  for (const values of [[], ["slot-1", "slot-2"]]) {
    const replies: any[] = [];
    await handleContentRoleSelect({
      customId: "content:slot:content-1:user-1", values, inCachedGuild: () => true,
      reply: async (payload: unknown) => { replies.push(payload); }
    } as never, {} as never);
    assert.equal(messageDescription(replies[0]), "That role selection is no longer valid.");
  }
});

for (const count of [99, 100, 101, 250]) {
  test(`party notifications preserve ${count} signups with one bounded start message`, () => {
    const snapshot = largeParty(count);
    for (const build of [buildStartNotifications, buildContentRescheduleMessages, buildContentCancellationMessages]) {
      const messages = build(snapshot);
      const recipients = messages.flatMap(m => [...m.allowedMentions!.users!]);
      const expected = snapshot.signups.map(s => s.discordUserId);
      assert.deepEqual(recipients, build === buildStartNotifications ? expected.slice(0, 100) : expected);
      if (build === buildStartNotifications) assert.equal(messages.length, 1);
      for (const [index, message] of messages.entries()) {
        const text = messageText(message);
        assert.ok(text.length <= 4000);
        assert.ok(message.allowedMentions!.users!.length <= 100);
        for (const user of message.allowedMentions!.users!) assert.ok(text.includes(`<@${user}>`));
        if (index > 0) {
          assert.match(text, /Avalonian Dungeon/);
          assert.equal(messageRows(message).length, 0);
        }
        const components = JSON.parse(JSON.stringify(message.components));
        const size = (items: any[]): number => items.reduce((n, item) => n + 1 + size(item.components ?? []), 0);
        assert.ok(size(components) <= 40);
      }
      if (count === 250) assert.ok(messages[0].files?.length);
      if (build === buildContentRescheduleMessages) {
        assert.match(messageText(messages[0]), /Activity Details Updated/);
        assert.match(messageText(messages[0]), /Avalonian Dungeon/);
        assert.match(messageText(messages[0]), /<t:[0-9]+:F>/);
      }
      if (build === buildContentCancellationMessages) assert.equal(messageRows(messages[0])[0].components[0].label, "Archive");
    }
  });
}

test("creation modal settings fit the custom-ID limit with a full template UUID and timestamp", () => {
  for (const approval of [false, true]) for (const multi of [false, true]) {
    const date = new Date("2099-09-18T12:34:00.000Z");
    const id = buildContentCreateModalId("12345678-1234-1234-1234-123456789012", date, approval, multi);
    assert.ok(id.length <= 100);
    const parsed = parseContentModalId(id)!;
    assert.equal(parsed.approvalRequired ?? false, approval);
    assert.equal(parsed.multiSignupEnabled ?? false, multi);
    assert.equal(parsed.scheduledStartAt!.toISOString(), date.toISOString());
  }
  assert.equal(parseContentModalId("content-modal:create:none:unscheduled:approval")?.multiSignupEnabled ?? false, false);
});

test("party commands expose the approved hidden operational surface", () => {
  const party = partyCommand.toJSON();
  const join = joinCommand.toJSON();
  const leave = leaveCommand.toJSON();
  const standby = standbyCommand.toJSON();

  assert.equal(party.default_member_permissions, "0");
  assert.deepEqual(
    party.options?.map((option) => option.name),
    ["host", "list", "edit", "start", "end", "cancel", "archive", "transfer", "add", "accept", "decline", "remove"]
  );
  const host = party.options?.find((option) => option.name === "host") as { options?: Array<{ name: string; options?: Array<{ name: string; type: number; required?: boolean; autocomplete?: boolean; choices?: Array<{ name: string; value: string }> }> }> };
  assert.deepEqual(host.options?.map((option) => option.name), ["scheduled", "unscheduled"]);
  assert.deepEqual(host.options?.[1].options?.map(({ name, required, autocomplete }) => ({ name, required, autocomplete })), [{ name: "template", required: true, autocomplete: true }, { name: "approval", required: false, autocomplete: undefined }, { name: "multisignup", required: false, autocomplete: undefined }]);
  const create = host.options?.[0] as { options?: Array<{ name: string; required?: boolean; autocomplete?: boolean }> } | undefined;
  assert.deepEqual(create?.options?.map((option) => ({ name: option.name, required: option.required ?? false, autocomplete: option.autocomplete ?? false })), [
    { name: "date", required: true, autocomplete: true },
    { name: "time", required: true, autocomplete: false },
    { name: "template", required: true, autocomplete: true },
    { name: "approval", required: false, autocomplete: false },
    { name: "multisignup", required: false, autocomplete: false }
  ]);
  for (const mode of host.options ?? []) {
    const approval = mode.options?.find((option) => option.name === "approval");
    assert.equal(approval?.type, ApplicationCommandOptionType.String);
    assert.deepEqual(approval?.choices?.map(({ name, value }) => ({ name, value })), [
      { name: "Host approval not required", value: "false" },
      { name: "Host approval required", value: "true" }
    ]);
    const multi = mode.options?.find(option => option.name === "multisignup");
    assert.equal(multi?.type, ApplicationCommandOptionType.String);
    assert.deepEqual(multi?.choices?.map(({ name, value }) => ({ name, value })), [
      { name: "Multi-signup off", value: "false" },
      { name: "Multi-signup on", value: "true" }
    ]);
  }
  const transfer = party.options?.find((option) => option.name === "transfer");
  assert.equal(transfer?.description, "Transfer ownership of the current party.");
  const edit = party.options?.find((option) => option.name === "edit") as { options?: Array<{ name: string; required?: boolean; autocomplete?: boolean }> } | undefined;
  assert.deepEqual(edit?.options?.map((option) => ({ name: option.name, required: option.required ?? false, autocomplete: option.autocomplete ?? false })), [
    { name: "date", required: false, autocomplete: true },
    { name: "time", required: false, autocomplete: false },
    { name: "image", required: false, autocomplete: false }
  ]);

  assert.deepEqual(
    [join, leave, standby].map(({ name, default_member_permissions, options }) => ({
      name,
      default_member_permissions,
      options: options ?? []
    })),
    [
      { name: "join", default_member_permissions: "0", options: [] },
      { name: "leave", default_member_permissions: "0", options: [] },
      { name: "standby", default_member_permissions: "0", options: [] }
    ]
  );

  assert.deepEqual(
    ["party", "join", "leave", "standby"].map((name) =>
      activeGuildCommands.find((command) => command.name === name)?.name
    ),
    ["party", "join", "leave", "standby"]
  );
  assert.equal(activeGuildCommands.some(command => command.name === "content"), false);
});

test("party template autocomplete keeps Blank first and reserves room within 25 choices", async () => {
  const templates = Array.from({ length: 30 }, (_, index) => ({
    contentTemplateId: `template-${index + 1}`,
    name: `Roam ${index + 1}`
  }));
  for (const scenario of [
    { templates: [], focused: "", expected: [] },
    { templates, focused: "", expected: templates.slice(0, 24) },
    { templates, focused: "rOaM 30", expected: [templates[29]] },
    { templates, focused: "missing", expected: [] }
  ]) {
    const responses: Array<Array<{ name: string; value: string }>> = [];
    const interaction = {
      commandName: "party",
      guildId: "guild-1",
      options: { getFocused: () => ({ name: "template", value: scenario.focused }) },
      respond: async (choices: Array<{ name: string; value: string }>) => { responses.push(choices); }
    } as unknown as Parameters<typeof handleContentAutocomplete>[0];
    const repository = {
      listTemplates: async (guildId: string) => {
        assert.equal(guildId, "guild-1");
        return scenario.templates;
      }
    } as unknown as Parameters<typeof handleContentAutocomplete>[1];

    assert.equal(await handleContentAutocomplete(interaction, repository), true);
    assert.deepEqual(responses, [[
      { name: "Blank", value: "blank" },
      ...scenario.expected.map((template) => ({ name: template.name, value: template.contentTemplateId }))
    ]]);
  }
});

for (const mode of ["scheduled", "unscheduled"] as const) {
for (const selection of ["blank", "saved", "missing"] as const) {
  test(`party host ${mode} handles a ${selection} template selection`, async () => {
    const template = {
      contentTemplateId: "template-1",
      title: "Roads Roam",
      description: "Bring swaps and food.",
      rolesText: "Tank\nHealer\nDPS"
    };
    const values = { date: "2099-08-10", time: "12:00", template: selection === "blank" ? "blank" : template.contentTemplateId };
    const modals: ModalBuilder[] = [];
    const replies: Array<{ embeds: EmbedBuilder[]; flags: number }> = [];
    const lookups: string[] = [];
    const interaction = {
      inGuild: () => true,
      guildId: "guild-1",
      options: {
        getSubcommandGroup: () => "host",
        getSubcommand: () => mode,
        getString: (name: keyof typeof values | "approval" | "multisignup", required?: boolean) => {
          if (name === "approval" || name === "multisignup") {
            assert.equal(required, undefined);
            return null;
          }
          assert.equal(required, true);
          if (mode === "unscheduled") assert.equal(name, "template");
          return values[name];
        }
      },
      showModal: async (modal: ModalBuilder) => { modals.push(modal); },
      reply: async (payload: typeof replies[number]) => { replies.push(payload); }
    } as unknown as Parameters<typeof handlePartyCommand>[0];
    const repository = {
      getTemplate: async (guildId: string, templateId: string) => {
        assert.equal(guildId, "guild-1");
        lookups.push(templateId);
        return selection === "saved" ? template : undefined;
      }
    } as unknown as Parameters<typeof handlePartyCommand>[1];

    await handlePartyCommand(interaction, repository, {} as Parameters<typeof handlePartyCommand>[2]);

    assert.deepEqual(lookups, selection === "blank" ? [] : [template.contentTemplateId]);
    if (selection === "missing") {
      assert.equal(modals.length, 0);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
      assert.equal(messageSummary(replies[0]), "Choose Blank or an existing content template.");
      assert.equal(messageDescription(replies[0]), "Choose Blank or an existing content template.");
      return;
    }

    assert.equal(replies.length, 0);
    assert.equal(modals.length, 1);
    const modal = modals[0].toJSON();
    assert.equal(modal.custom_id, buildContentCreateModalId(
      selection === "saved" ? template.contentTemplateId : undefined,
      mode === "scheduled" ? new Date("2099-08-10T12:00:00.000Z") : null
    ));
    assert.deepEqual(modal.components.flatMap((component) =>
      component.type === ComponentType.ActionRow
        ? component.components.map((input) => ({ field: input.custom_id, value: input.value }))
        : []
    ), [
      { field: "title", value: selection === "saved" ? template.title : "" },
      { field: "description", value: selection === "saved" ? template.description : "" },
      { field: "roles", value: selection === "saved" ? template.rolesText : "" }
    ]);
  });
}
}

test("party edit confirmations report moved signups with correct grammar", () => {
  assert.equal(formatMovedToStandbyNote(0), "");
  assert.equal(formatMovedToStandbyNote(1), " 1 signup was moved to Standby because its role was removed.");
  assert.equal(formatMovedToStandbyNote(5), " 5 signups were moved to Standby because their roles were removed.");
});

for (const [time, expected] of [
  ["9", "2099-08-10T09:00:00.000Z"],
  ["09", "2099-08-10T09:00:00.000Z"],
  ["9:05", "2099-08-10T09:05:00.000Z"],
  ["00", "2099-08-10T00:00:00.000Z"],
  ["24", "2099-08-11T00:00:00.000Z"],
  ["24:00", "2099-08-11T00:00:00.000Z"],
  ["unscheduled", "unscheduled"]
]) {
  test(`party hosting ${time} persists the UTC instant through its modal and pins Roles`, async () => {
    const pins: string[] = [];
    const storedMessageIds: string[][] = [];
    const controlMessage = {
      id: "control-1",
      pin: async (reason: string) => {
        pins.push(reason);
      }
    };
    const thread = {
      id: "party-thread",
      send: async (payload: unknown) => JSON.stringify(payload).includes("# Roles") ? controlMessage : { id: "details-1" },
      delete: async () => undefined,
      toString: () => "<#party-thread>"
    };
    const announcementMessage = {
      id: "announcement-1",
      createdAt: new Date("2026-09-10T01:00:00Z"),
      edit: async () => undefined,
      startThread: async (options: { name: string }) => {
        if (time === "unscheduled") assert.equal(options.name, "Avalonian Dungeon");
        return thread;
      },
      delete: async () => undefined
    };
    const parentChannel = {
      id: "content-channel",
      type: ChannelType.GuildText,
      send: async () => announcementMessage
    };
    const snapshot = contentSnapshot();
    let customId = "";
    await handlePartyCommand({
      inGuild: () => true,
      guildId: "guild-1",
      options: {
        getSubcommandGroup: () => "host",
        getSubcommand: () => time === "unscheduled" ? "unscheduled" : "scheduled",
        getBoolean: () => null,
        getString: (name: string) => ({ date: "2099-08-10", time, template: "blank" })[name]
      },
      showModal: async (modal: ModalBuilder) => { customId = modal.toJSON().custom_id; }
    } as unknown as Parameters<typeof handlePartyCommand>[0], {} as never, {} as never);
    assert.equal(customId, buildContentCreateModalId(undefined, time === "unscheduled" ? null : new Date(expected)));
    const persisted: string[] = [];
    let confirmation: unknown;
    const interaction = {
      customId,
      inCachedGuild: () => true,
      guildId: "guild-1",
      guild: { channels: { fetch: async () => null } },
      channel: parentChannel,
      user: { id: "host-1" },
      fields: {
        getTextInputValue: (field: string) => ({
          title: "Avalonian Dungeon",
          description: "Bring swaps and food.",
          roles: "Tank\nHealer\nDPS"
        })[field] ?? "",
        getUploadedFiles: () => undefined
      },
      deferReply: async (options: unknown) => { assert.deepEqual(options, { flags: MessageFlags.Ephemeral }); },
      editReply: async (payload: unknown) => { confirmation = payload; }
    } as unknown as Parameters<typeof handleContentModalSubmit>[0];
    const repository = {
      getContentChannel: async () => undefined,
      createContent: async (input: { scheduledStartAt: Date | null; postedAt: Date }) => {
        assert.deepEqual(input.postedAt, announcementMessage.createdAt);
        persisted.push(input.scheduledStartAt?.toISOString() ?? "unscheduled");
        snapshot.content.scheduledStartAt = input.scheduledStartAt;
        return snapshot;
      },
      setContentMessageIds: async (...ids: string[]) => {
        storedMessageIds.push(ids);
      },
      deleteContent: async () => undefined
    } as unknown as Parameters<typeof handleContentModalSubmit>[1];
    const logger = { info: () => undefined } as unknown as Parameters<typeof handleContentModalSubmit>[2];

    assert.equal(await handleContentModalSubmit(interaction, repository, logger), true);
    assert.deepEqual(persisted, [expected]);
    assert.deepEqual(pins, ["Pin Guild Manager content signup roles and controls"]);
    assert.deepEqual(storedMessageIds, [["guild-1", "content-1", "announcement-1", "control-1", "details-1"]]);
    const timestamp = time === "unscheduled" ? null : new Date(expected).getTime() / 1000;
    assert.deepEqual(confirmation, {
      content: `Created [Avalonian Dungeon](https://discord.com/channels/guild-1/content-channel/announcement-1), ${timestamp === null ? "unscheduled" : `scheduled for <t:${timestamp}:F> (<t:${timestamp}:R>)`}.`,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
    });
  });
}

test("content announcements contain only title and scheduled timestamps", () => {
  const message = buildContentAnnouncementV2Message({
    title: "Avalonian Dungeon",
    description: "Bring swaps and food.",
    scheduledStartAt: new Date("2026-08-10T12:00:00.000Z")
  });
  const container = (message.components?.[0] as { toJSON(): unknown }).toJSON() as {
    type: number;
    components: Array<{ type: number; content?: string }>;
  };

  assert.equal(message.content, undefined);
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal(container.type, ComponentType.Container);
  assert.deepEqual(
    container.components.map((component) => component.content),
    [
      "# Avalonian Dungeon",
      "<t:1786363200:F> (<t:1786363200:R>)"
    ]
  );
  assert.equal(container.components.some((component) => component.type === ComponentType.ActionRow), false);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
});

test("party lists use private paginated Components V2 with linked UTC schedule summaries", () => {
  const now = new Date("2026-08-20T01:00:00.000Z");
  const messages = buildPartyListV2Messages([
    contentItem("scheduled", "upcoming-later", "Crystal League", "2026-08-21T15:30:00.000Z", "host-2"),
    contentItem("scheduled", "upcoming-today", "Avalonian Dungeon", "2026-08-20T12:00:00.000Z", "host-1"),
    contentItem("active", "started", "Group Dungeon", "2026-08-20T00:30:00.000Z", "host-3"),
    contentItem("ended", "ended-older", "Roads Roam", "2026-08-18T09:00:00.000Z", "host-4"),
    contentItem("ended", "ended-newer", "Faction Warfare", "2026-08-19T18:00:00.000Z", "host-5"),
    contentItem("cancelled", "cancelled", "Hellgate", "2026-08-17T07:05:00.000Z", "host-6"),
    contentItem("archived", "archived", "Hidden Party", "2026-08-16T04:00:00.000Z", "host-7")
  ], now);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  assert.deepEqual(messages[0].allowedMentions, { parse: [], repliedUser: false });
  const container = (messages[0].components?.[0] as { toJSON(): unknown }).toJSON() as {
    type: number;
    accent_color: number;
    components: Array<{ type: number; content?: string }>;
  };
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, 0x64748b);
  assert.deepEqual(
    container.components.map((component) => component.content),
    [
      "# Parties",
      "## Upcoming\n- [Avalonian Dungeon](https://discord.com/channels/guild-1/thread-upcoming-today) • Today • 12:00 UTC • <@host-1>\n- [Crystal League](https://discord.com/channels/guild-1/thread-upcoming-later) • Friday 21 Aug • 15:30 UTC • <@host-2>",
      "## Unscheduled\n- None",
      "## Started\n- [Group Dungeon](https://discord.com/channels/guild-1/thread-started) • Today • 00:30 UTC • <@host-3>",
      "## Ended\n- [Faction Warfare](https://discord.com/channels/guild-1/thread-ended-newer) • Wednesday 19 Aug • 18:00 UTC • <@host-5>\n- [Roads Roam](https://discord.com/channels/guild-1/thread-ended-older) • Tuesday 18 Aug • 09:00 UTC • <@host-4>",
      "## Cancelled\n- [Hellgate](https://discord.com/channels/guild-1/thread-cancelled) • Monday 17 Aug • 07:05 UTC • <@host-6>",
      "*Archived parties are not shown.*"
    ]
  );
  assert.equal(container.components.some((component) => component.content?.includes("Hidden Party")), false);
});

test("party lists preserve empty sections and paginate without omitting parties", () => {
  const empty = buildPartyListV2Messages([], new Date("2026-08-20T00:00:00.000Z"));
  const emptyContainer = (empty[0].components?.[0] as { toJSON(): unknown }).toJSON() as {
    components: Array<{ content?: string }>;
  };
  assert.deepEqual(
    emptyContainer.components.map((component) => component.content),
    [
      "# Parties",
      "## Upcoming\n- None",
      "## Unscheduled\n- None",
      "## Started\n- None",
      "## Ended\n- None",
      "## Cancelled\n- None",
      "*Archived parties are not shown.*"
    ]
  );

  const items = Array.from({ length: 80 }, (_, index) =>
    contentItem(
      "scheduled",
      `party-${String(index).padStart(2, "0")}`,
      `Party ${String(index).padStart(2, "0")} ${"x".repeat(70)}`,
      new Date(Date.UTC(2026, 7, 21, 0, index)).toISOString(),
      `host-${index}`
    )
  );
  const pages = buildPartyListV2Messages(items, new Date("2026-08-20T00:00:00.000Z"));
  assert.ok(pages.length > 1);
  const text = pages.map((message, index) => {
    assert.equal(message.flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
    const value = (message.components?.[0] as { toJSON(): unknown }).toJSON() as {
      components: Array<{ content?: string }>;
    };
    const contents = value.components.map((component) => component.content ?? "");
    assert.equal(contents[0], `# Parties • ${index + 1}/${pages.length}`);
    assert.ok(contents.reduce((total, content) => total + content.length, 0) <= 3800);
    return contents.join("\n");
  }).join("\n");
  assert.equal((text.match(/https:\/\/discord\.com\/channels\/guild-1\/thread-party-/g) ?? []).length, items.length);
});

test("/party list is guild-wide and sends every private page", async () => {
  const replies: unknown[] = [];
  const followUps: unknown[] = [];
  const guildIds: string[] = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    options: { getSubcommandGroup: () => null, getSubcommand: () => "list" },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    followUp: async (payload: unknown) => {
      followUps.push(payload);
    }
  } as unknown as Parameters<typeof handlePartyCommand>[0];
  const repository = {
    listUnarchivedContent: async (guildId: string) => {
      guildIds.push(guildId);
      return [];
    }
  } as unknown as Parameters<typeof handlePartyCommand>[1];

  await handlePartyCommand(interaction, repository, {} as Parameters<typeof handlePartyCommand>[2]);

  assert.deepEqual(guildIds, ["guild-1"]);
  assert.equal(replies.length, 1);
  assert.equal(followUps.length, 0);
});

test("thread roles and controls use the approved Components V2 presentation", () => {
  const message = buildContentControlV2Message(contentSnapshot());
  const container = (message.components?.[0] as { toJSON(): unknown }).toJSON() as {
    type: number;
    components: Array<{
      type: number;
      content?: string;
      components?: Array<{ type: number; label?: string; custom_id?: string }>;
    }>;
  };

  assert.equal(message.content, undefined);
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal(container.type, ComponentType.Container);
  assert.deepEqual(
    container.components.filter((component) => component.type === ComponentType.TextDisplay).map((component) => component.content),
    [
      "# Roles",
      "1. Tank — <@user-1>\n2. Healer\n3. DPS — <@user-2>",
      "**Host approval** Not required",
      "**Multi-signup** Off"
    ]
  );
  assert.deepEqual(container.components.filter(component => component.type === ComponentType.ActionRow)
    .map(row => row.components!.map(button => button.label)), [["Join", "Standby", "Leave"]]);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
});

for (const state of ["scheduled", "unscheduled", "active", "ended", "cancelled", "archived"] as const) {
  test(`${state} parties keep host controls on details and signup controls on roles`, () => {
    const snapshot = contentSnapshot(state);
    const labels = (message: ReturnType<typeof buildContentAnnouncementV2Message>) => {
      const container = (message.components![0] as { toJSON(): {
        components: Array<{ type: number; components?: Array<{ label?: string }> }>
      } }).toJSON();
      return container.components.filter((component) => component.type === ComponentType.ActionRow)
        .map((row) => row.components!.map((button) => button.label));
    };
    const open = state === "scheduled" || state === "unscheduled" || state === "active";
    assert.deepEqual(labels(buildContentAnnouncementV2Message(snapshot.content)), []);
    assert.deepEqual(labels(buildContentDetailsV2Message(snapshot.content)),
      open ? [[state === "active" ? "End" : "Start", "Edit", "Cancel"]] : []);
    assert.deepEqual(labels(buildContentControlV2Message(snapshot)), open ? [["Join", "Standby", "Leave"]] : []);
  });
}

for (const transferred of [false, true]) {
  test(`details Edit opens the existing form and rechecks ownership on submit (transferred=${transferred})`, async () => {
    const snapshot = contentSnapshot();
    const modals: ModalBuilder[] = [];
    const replies: Array<{ embeds: EmbedBuilder[] }> = [];
    const updates: Array<{ title: string; description: string; roleLabels: string[]; scheduledStartAt?: Date; graphicAttachmentName?: string }> = [];
    const presentationEdits: unknown[] = [];
    const message = { pinned: false, pin: async () => undefined, author: { id: "bot" }, edit: async (payload: unknown) => { presentationEdits.push(payload); } };
    const interaction = {
      customId: "content:edit:content-1", inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", message: { id: "details-1" },
      user: { id: "host-1" },
      guild: { client: { user: { id: "bot" } }, channels: { fetch: async () => ({
        client: { user: { id: "bot" } }, isThread: () => true, messages: { fetch: async ({ message: id }: { message: string }) => ({ ...message, id }) }, send: async () => undefined
      }) } },
      showModal: async (modal: ModalBuilder) => { modals.push(modal); },
      reply: async (payload: typeof replies[number]) => { replies.push(payload); }
    };
    const repository = {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async (guildId: string, contentId: string) => {
        assert.equal(guildId, "guild-1");
        assert.equal(contentId, "content-1");
        return snapshot;
      },
      updateContentDetails: async (input: typeof updates[number]) => {
        updates.push(input);
        return { snapshot, movedToStandbyCount: 0 };
      },
      markRendered: async () => undefined
    } as unknown as Parameters<typeof handleContentButton>[1];
    await handleContentButton(interaction as unknown as Parameters<typeof handleContentButton>[0], repository, {} as never);
    assert.equal(replies.length, 0);
    assert.equal(updates.length, 0);
    assert.equal(modals.length, 1);
    const modal = modals[0].toJSON();
    const fields = modal.components as Array<{ components: Array<{ custom_id: string; value: string }> }>;
    assert.deepEqual(fields.flatMap((row) => row.components.map((field) => [field.custom_id, field.value])), [
      ["title", snapshot.content.title], ["description", snapshot.content.description], ["roles", "Tank\nHealer\nDPS"]
    ]);
    if (transferred) snapshot.content.hostDiscordUserId = "new-host";
    await handleContentModalSubmit({
      ...interaction, customId: modal.custom_id,
      fields: { getTextInputValue: (name: string) => ({ title: "Updated Party", description: "Updated details", roles: "Tank\nHealer" })[name] },
      deferReply: async () => undefined,
      editReply: async (payload: typeof replies[number]) => { replies.push(payload); }
    } as unknown as Parameters<typeof handleContentModalSubmit>[0], repository, {} as never);
    if (transferred) {
      assert.equal(messageSummary(replies[0]), "Only the party host can edit this signup.");
      assert.equal(updates.length, 0);
      assert.equal(presentationEdits.length, 0);
    } else {
      assert.equal(messageSummary(replies[0]), "The content signup was updated.");
      assert.equal(updates.length, 1);
      assert.equal(updates[0].title, "Updated Party");
      assert.equal(updates[0].description, "Updated details");
      assert.deepEqual(updates[0].roleLabels, ["Tank", "Healer"]);
      assert.equal(updates[0].scheduledStartAt, undefined);
      assert.equal(updates[0].graphicAttachmentName, undefined);
      assert.equal(presentationEdits.length, 3);
    }
  });
}

for (const action of ["start", "end", "edit", "cancel", "join", "standby", "leave"] as const) {
  for (const parent of [false, true]) {
    test(`${action} rejects a button on the wrong party message (parent=${parent})`, async () => {
      const signup = ["join", "standby", "leave"].includes(action);
      const replies: Array<{ embeds: EmbedBuilder[] }> = [];
      await handleContentButton({
        customId: `content:${action}:content-1`, inCachedGuild: () => true,
        guildId: "guild-1", channelId: parent ? "content-channel" : "party-thread",
        message: { id: parent ? "announcement-1" : signup ? "details-1" : "control-1" }, user: { id: "host-1" },
        reply: async (payload: typeof replies[number]) => { replies.push(payload); }
      } as unknown as Parameters<typeof handleContentButton>[0], {
        isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => contentSnapshot()
      } as unknown as Parameters<typeof handleContentButton>[1], {} as never);
      assert.equal(messageSummary(replies[0]), `Use the buttons on the current ${signup ? "roles" : "details"} message inside the party thread.`);
      assert.equal(messageDescription(replies[0]),
        `Use the buttons on the current ${signup ? "roles" : "details"} message inside the party thread.`);
    });
  }
}

test("the details message contains description, host, graphic and host controls in order", () => {
  const snapshot = contentSnapshot();
  snapshot.content.graphicAttachmentName = "content-builds-graphic.png";
  const message = buildContentDetailsV2Message(snapshot.content);
  const container = (message.components?.[0] as { toJSON(): unknown }).toJSON() as {
    components: Array<{ type: number; items?: Array<{ media?: { url?: string } }>; content?: string }>;
  };
  assert.equal(container.components[0]?.content, "Bring swaps and food.");
  assert.equal(container.components[1]?.content, "**Host** <@host-1>");
  assert.equal(container.components[2]?.type, ComponentType.MediaGallery);
  assert.equal(container.components[2]?.items?.[0]?.media?.url, "attachment://content-builds-graphic.png");
  assert.equal(container.components[3]?.type, ComponentType.ActionRow);
  assert.doesNotMatch(JSON.stringify(buildContentControlV2Message(snapshot)), /graphic|Host\*\*|Bring swaps/);
});

test("standby signups render once below the actual roles and include every standby user", () => {
  const snapshot = contentSnapshot();
  snapshot.signups.push(
    {
      contentSignupId: "signup-3",
      contentId: "content-1",
      contentRoleSlotId: null,
      discordGuildId: "guild-1",
      discordUserId: "user-3",
      signupType: "standby",
      state: "active",
      removedAt: null,
      removedByDiscordUserId: null
    },
    {
      contentSignupId: "signup-4",
      contentId: "content-1",
      contentRoleSlotId: null,
      discordGuildId: "guild-1",
      discordUserId: "user-4",
      signupType: "standby",
      state: "active",
      removedAt: null,
      removedByDiscordUserId: null
    }
  );

  const control = buildContentControlV2Message(snapshot);
  const container = (control.components?.[0] as { toJSON(): unknown }).toJSON() as {
    components: Array<{ type: number; content?: string }>;
  };
  assert.deepEqual(
    container.components
      .filter((component) => component.type === ComponentType.TextDisplay)
      .map((component) => component.content),
    [
      "# Roles",
      "1. Tank — <@user-1>\n2. Healer\n3. DPS — <@user-2>",
      "**Standby**\n<@user-3> <@user-4>",
      "**Host approval** Not required",
      "**Multi-signup** Off"
    ]
  );

  snapshot.content.startedAt = new Date("2099-08-10T11:00:00Z");
  const started = messageText(buildStartNotification(snapshot));
  assert.match(started, /1\. Tank <@user-1>\n2\. Healer\n3\. DPS <@user-2>\n\*\*Standby\*\*\n<@user-3> <@user-4>/);
  assert.doesNotMatch(started, /## Roles|## Standby/);

  const cancellation = buildContentCancellationMessage(snapshot);
  assert.deepEqual(cancellation.allowedMentions, { parse: [], repliedUser: false, users: ["user-1", "user-2", "user-3", "user-4"] });
});

test("role selection excludes Standby and fits all 25 actual roles in one menu", () => {
  const snapshot = contentSnapshot();
  snapshot.slots = Array.from({ length: 25 }, (_, index) => ({
    contentRoleSlotId: `slot-${index + 1}`,
    contentId: "content-1",
    discordGuildId: "guild-1",
    slotIndex: index + 1,
    label: `Role ${index + 1}`
  }));
  snapshot.signups = [];

  const rows = buildRoleSlotSelectRows(snapshot, "user-3");
  const options = rows.flatMap((row) => {
    const json = row.toJSON() as { components: Array<{ options?: Array<{ label: string; value: string }> }> };
    return json.components.flatMap((component) => component.options ?? []);
  });

  assert.equal(rows.length, 1);
  assert.equal(options.length, 25);
  assert.equal(options.at(-1)?.label, "25. Role 25");
  assert.equal(options.some(option => option.value === STANDBY_SIGNUP_VALUE), false);
});

test("an old Standby selector is rejected without changing any signup or request", async () => {
  const snapshot = contentSnapshot();
  snapshot.signups.push({
    contentSignupId: "signup-3",
    contentId: "content-1",
    contentRoleSlotId: null,
    discordGuildId: "guild-1",
    discordUserId: "user-3",
    signupType: "standby",
    state: "active",
    removedAt: null,
    removedByDiscordUserId: null
  });
  const replies: unknown[] = [];
  const deferredReplies: unknown[] = [];
  const editedReplies: Array<{ embeds: Array<{ toJSON(): { description?: string } }> }> = [];
  const upserts: Array<{ roleSlotId: string | null; discordUserId: string }> = [];
  let snapshotReads = 0;
  const interaction = {
    customId: "content:slot:content-1:user-4",
    values: [STANDBY_SIGNUP_VALUE],
    inCachedGuild: () => true,
    guildId: "guild-1",
    channelId: "party-thread",
    user: { id: "user-4" },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    deferReply: async (payload: unknown) => {
      deferredReplies.push(payload);
    },
    editReply: async (payload: { embeds: Array<{ toJSON(): { description?: string } }> }) => {
      editedReplies.push(payload);
    }
  } as unknown as Parameters<typeof handleContentRoleSelect>[0];
  const repository = {
    isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? snapshot : undefined;
    },
    requestSignup: async ({ roleSlotId, discordUserId }: { roleSlotId: string | null; discordUserId: string }) => {
      upserts.push({ roleSlotId, discordUserId });
      return { status: "signed_up" };
    }
  } as unknown as Parameters<typeof handleContentRoleSelect>[1];

  const handled = await handleContentRoleSelect(interaction, repository);

  assert.equal(handled, true);
  assert.equal(messageDescription(replies[0]), "Use the Standby button or /standby.");
  assert.equal(deferredReplies.length, 0);
  assert.deepEqual(upserts, []);
  assert.deepEqual(editedReplies, []);
});

test("the Standby button directly moves its user onto standby", async () => {
  const snapshot = contentSnapshot();
  const deferredReplies: unknown[] = [];
  const editedReplies: Array<{ embeds: Array<{ toJSON(): { description?: string } }> }> = [];
  const upserts: Array<{ roleSlotId: string | null; discordUserId: string }> = [];
  let snapshotReads = 0;
  const interaction = {
    customId: "content:standby:content-1",
    inCachedGuild: () => true,
    guildId: "guild-1",
    channelId: "party-thread",
    message: { id: "control-1" },
    user: { id: "user-4" },
    deferReply: async (payload: unknown) => {
      deferredReplies.push(payload);
    },
    editReply: async (payload: { embeds: Array<{ toJSON(): { description?: string } }> }) => {
      editedReplies.push(payload);
    }
  } as unknown as Parameters<typeof handleContentButton>[0];
  const repository = {
    isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? snapshot : undefined;
    },
    requestSignup: async ({ roleSlotId, discordUserId }: { roleSlotId: string | null; discordUserId: string }) => {
      upserts.push({ roleSlotId, discordUserId });
      return { status: "signed_up" };
    }
  } as unknown as Parameters<typeof handleContentButton>[1];

  const handled = await handleContentButton(
    interaction,
    repository,
    {} as Parameters<typeof handleContentButton>[2]
  );

  assert.equal(handled, true);
  assert.equal(deferredReplies.length, 1);
  assert.deepEqual(upserts, [{ roleSlotId: null, discordUserId: "user-4" }]);
  assert.equal(messageDescription(editedReplies[0]), "You were signed up as Standby.");
});

test("the /standby command directly moves its user onto standby", async () => {
  const snapshot = contentSnapshot();
  const deferredReplies: unknown[] = [];
  const editedReplies: Array<{ embeds: Array<{ toJSON(): { description?: string } }> }> = [];
  const upserts: Array<{ roleSlotId: string | null; discordUserId: string }> = [];
  let snapshotReads = 0;
  const interaction = {
    inGuild: () => true,
    inCachedGuild: () => true,
    guildId: "guild-1",
    channelId: "party-thread",
    user: { id: "user-4" },
    deferReply: async (payload: unknown) => {
      deferredReplies.push(payload);
    },
    editReply: async (payload: { embeds: Array<{ toJSON(): { description?: string } }> }) => {
      editedReplies.push(payload);
    }
  } as unknown as Parameters<typeof handleStandbyCommand>[0];
  const repository = {
    isHostAuthorityRevoked: async () => false, getContentByThread: async () => snapshot,
    getContentSnapshot: async () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? snapshot : undefined;
    },
    requestSignup: async ({ roleSlotId, discordUserId }: { roleSlotId: string | null; discordUserId: string }) => {
      upserts.push({ roleSlotId, discordUserId });
      return { status: "signed_up" };
    }
  } as unknown as Parameters<typeof handleStandbyCommand>[1];

  await handleStandbyCommand(interaction, repository);

  assert.equal(deferredReplies.length, 1);
  assert.deepEqual(upserts, [{ roleSlotId: null, discordUserId: "user-4" }]);
  assert.equal(messageDescription(editedReplies[0]), "You were signed up as Standby.");
});

test("short content cancellation uses ordinary text and retains Archive and exact recipients", () => {
  const message = buildContentCancellationMessage(contentSnapshot("cancelled"));
  assert.equal(message.content, "Content cancelled. <@user-1> <@user-2>");
  assert.equal(message.flags, MessageFlags.SuppressEmbeds);
  const row = messageRows(message)[0];
  assert.deepEqual(row.components.map(({ type, custom_id, label }: any) => ({ type, custom_id, label })),
    [{ type: ComponentType.Button, custom_id: "content:archive:content-1", label: "Archive" }]);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false, users: ["user-1", "user-2"] });
});

for (const recipients of [5, 6]) {
  test(`public party notices preserve all ${recipients} recipients across the standard/V2 boundary`, () => {
    const snapshot = contentSnapshot();
    snapshot.signups = Array.from({ length: recipients }, (_, index) => ({ ...snapshot.signups[0],
      contentSignupId: `signup-${index}`, discordUserId: `user-${index}`, signupType: index === recipients - 1 ? "standby" : "role" }));
    const cancel = buildContentCancellationMessage(snapshot);
    const reschedule = buildContentRescheduleMessage(snapshot);
    for (const payload of [cancel, reschedule]) {
      assert.equal(payload.flags, recipients === 5 ? MessageFlags.SuppressEmbeds : MessageFlags.IsComponentsV2);
      assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false, users: snapshot.signups.map(signup => signup.discordUserId) });
      assert.match(messageText(payload), new RegExp(`<@user-${recipients - 1}>`));
    }
    assert.equal(messageRows(cancel)[0].components[0].custom_id, "content:archive:content-1");
    assert.match(messageText(reschedule), /<t:\d+:F> \(<t:\d+:R>\)/u);
  });
}

test("long or multiline rescheduling titles retain their complete structured presentation", () => {
  for (const title of ["🦊".repeat(300), "**Party**\n@everyone"]) {
    const snapshot = contentSnapshot();
    snapshot.content.title = title;
    const payload = buildContentRescheduleMessage(snapshot);
    assert.equal(payload.flags, MessageFlags.IsComponentsV2);
    assert.match(messageText(payload), /<@user-2>/u);
    assert.deepEqual(payload.allowedMentions?.parse, []);
    if (title.startsWith("🦊")) assert.ok(messageText(payload).includes(title));
  }
});

test("future thread titles include their UTC weekday until that day is reached", () => {
  const scheduledStartAt = new Date("2026-08-10T12:00:00.000Z");

  assert.equal(
    buildThreadTitle("Avalonian Dungeon", scheduledStartAt, new Date("2026-08-09T23:59:59.999Z")),
    "Avalonian Dungeon Monday 12 UTC"
  );
  assert.equal(
    buildThreadTitle("Avalonian Dungeon", scheduledStartAt, new Date("2026-08-10T00:00:00.000Z")),
    "Avalonian Dungeon 12 UTC"
  );
  assert.equal(
    buildThreadTitle("Avalonian Dungeon", new Date("2026-08-11T12:30:00.000Z"), new Date("2026-08-10T00:00:00.000Z")),
    "Avalonian Dungeon Tuesday 1230 UTC"
  );
});

test("party interactions accept their announcement channel and attached thread", () => {
  const snapshot = contentSnapshot();

  assert.equal(isContentInteractionChannel(snapshot, "content-channel"), true);
  assert.equal(isContentInteractionChannel(snapshot, "party-thread"), true);
  assert.equal(isContentInteractionChannel(snapshot, "another-channel"), false);
});

test("terminal Archive buttons work outside the canonical roles message", async () => {
  for (const state of ["ended", "cancelled"] as const) {
    const snapshot = contentSnapshot(state);
    const replies: unknown[] = [];
    const deferredReplies: unknown[] = [];
    const editedReplies: unknown[] = [];
    const threadUpdates: string[] = [];
    const archivedStates: string[] = [];
    const interaction = {
      customId: "content:archive:content-1",
      inCachedGuild: () => true,
      guildId: "guild-1",
      channelId: "party-thread",
      message: { id: "terminal-message-1" },
      user: { id: "host-1" },
      client: {
        channels: {
          fetch: async () => ({
            isThread: () => true,
            setLocked: async () => {
              threadUpdates.push("locked");
            },
            setArchived: async () => {
              threadUpdates.push("archived");
            }
          })
        }
      },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
      deferReply: async (payload: unknown) => {
        deferredReplies.push(payload);
      },
      editReply: async (payload: unknown) => {
        editedReplies.push(payload);
      }
    } as unknown as Parameters<typeof handleContentButton>[0];
    const repository = {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot,
      markArchived: async () => {
        archivedStates.push(state);
        return { ...snapshot.content, state: "archived" as const };
      }
    } as unknown as Parameters<typeof handleContentButton>[1];

    const handled = await handleContentButton(
      interaction,
      repository,
      {} as Parameters<typeof handleContentButton>[2]
    );

    assert.equal(handled, true);
    assert.deepEqual(replies, []);
    assert.equal(deferredReplies.length, 1);
    assert.equal(editedReplies.length, 1);
    assert.deepEqual(threadUpdates, ["locked", "archived"]);
    assert.deepEqual(archivedStates, [state]);
  }
});

test("noncanonical active controls remain stale", async () => {
  const replies: Array<{ embeds: Array<{ toJSON(): { title?: string } }> }> = [];
  const interaction = {
    customId: "content:cancel:content-1",
    inCachedGuild: () => true,
    guildId: "guild-1",
    channelId: "party-thread",
    message: { id: "stale-message-1" },
    user: { id: "host-1" },
    reply: async (payload: { embeds: Array<{ toJSON(): { title?: string } }> }) => {
      replies.push(payload);
    }
  } as unknown as Parameters<typeof handleContentButton>[0];
  const repository = {
    isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => contentSnapshot()
  } as unknown as Parameters<typeof handleContentButton>[1];

  const handled = await handleContentButton(
    interaction,
    repository,
    {} as Parameters<typeof handleContentButton>[2]
  );

  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.equal(messageSummary(replies[0]), "Use the buttons on the current details message inside the party thread.");
});

function contentItem(
  state: ContentSnapshot["content"]["state"],
  contentId: string,
  title: string,
  scheduledStartAt: string,
  hostDiscordUserId: string
): ContentSnapshot["content"] {
  return {
    ...contentSnapshot(state).content,
    contentId,
    threadChannelId: `thread-${contentId}`,
    title,
    scheduledStartAt: new Date(scheduledStartAt),
    hostDiscordUserId
  };
}

function contentSnapshot(state: ContentSnapshot["content"]["state"] = "scheduled"): ContentSnapshot {
  return {
    content: {
      contentId: "content-1",
      discordGuildId: "guild-1",
      sourceChannelId: "content-channel",
      threadChannelId: "party-thread",
      hostDiscordUserId: "host-1",
      title: "Avalonian Dungeon",
      description: "Bring swaps and food.",
      scheduledStartAt: new Date("2099-08-10T12:00:00.000Z"),
      state,
      announcementMessageId: "announcement-1",
      detailsMessageId: "details-1",
      controlMessageId: "control-1",
      startNotificationMessageId: null,
      lastRenderedAt: null,
      startedAt: null,
      endedAt: null,
      cancelledAt: null,
      archivedAt: null,
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      updatedAt: new Date("2026-08-09T12:00:00.000Z")
    },
    slots: [
      { contentRoleSlotId: "slot-1", contentId: "content-1", discordGuildId: "guild-1", slotIndex: 1, label: "Tank" },
      { contentRoleSlotId: "slot-2", contentId: "content-1", discordGuildId: "guild-1", slotIndex: 2, label: "Healer" },
      { contentRoleSlotId: "slot-3", contentId: "content-1", discordGuildId: "guild-1", slotIndex: 3, label: "DPS" }
    ],
    signups: [
      {
        contentSignupId: "signup-1",
        contentId: "content-1",
        contentRoleSlotId: "slot-1",
        discordGuildId: "guild-1",
        discordUserId: "user-1",
        signupType: "role",
        state: "active",
        removedAt: null,
        removedByDiscordUserId: null
      },
      {
        contentSignupId: "signup-2",
        contentId: "content-1",
        contentRoleSlotId: "slot-3",
        discordGuildId: "guild-1",
        discordUserId: "user-2",
        signupType: "role",
        state: "active",
        removedAt: null,
        removedByDiscordUserId: null
      }
    ]
  };
}

for (const scenario of [
  { time: "24", expected: "2099-08-11T00:00:00.000Z" },
  { date: "2099-08-12", expected: "2099-08-12T00:00:00.000Z" },
  { date: "2099-08-12", existing: "2099-08-10T09:30:00.000Z", expected: "2099-08-12T09:30:00.000Z" },
  { time: "24:01", error: "Invalid Start Time" },
  { date: "2000-01-01", time: "24", error: "Invalid Start Time" },
  { time: "24", state: "active" as const, error: "Content Schedule Locked" }
]) {
  test(`party partial edit ${JSON.stringify(scenario)} preserves schedule validation`, async () => {
    const snapshot = contentSnapshot(scenario.state);
    snapshot.content.scheduledStartAt = new Date(scenario.existing ?? "2099-08-10T00:00:00.000Z");
    const modals: ModalBuilder[] = [];
    const replies: Array<{ embeds: EmbedBuilder[] }> = [];
    const updates: Array<{ scheduledStartAt?: Date; requireScheduledState?: boolean }> = [];
    const repository = {
      isHostAuthorityRevoked: async () => false, getContentByThread: async () => snapshot,
      getContentSnapshot: async () => snapshot,
      updateContentDetails: async (input: typeof updates[number]) => { updates.push(input); return undefined; }
    } as unknown as Parameters<typeof handlePartyCommand>[1];
    const interaction = {
      inGuild: () => true, inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: "host-1" },
      options: {
        getSubcommandGroup: () => null, getSubcommand: () => "edit",
        getBoolean: () => null,
        getString: (name: string) => name === "date" ? scenario.date ?? null : scenario.time ?? null,
        getAttachment: () => null
      },
      showModal: async (modal: ModalBuilder) => { modals.push(modal); },
      reply: async (payload: typeof replies[number]) => { replies.push(payload); }
    } as unknown as Parameters<typeof handlePartyCommand>[0];
    await handlePartyCommand(interaction, repository, {} as never);
    if (scenario.error) {
      assert.equal(modals.length, 0);
      assert.equal(messageSummary(replies[0]), scenario.error === "Invalid Start Time" ? scenario.time === "24:01" ? "Invalid Start Time" : "The resulting UTC start time must be in the future." : "Date, time, and builds graphic cannot be changed after content starts.");
      assert.equal(updates.length, 0);
      return;
    }
    assert.equal(modals.length, 1);
    await handleContentModalSubmit({
      ...interaction, customId: modals[0].toJSON().custom_id,
      fields: { getTextInputValue: (name: string) => name === "title" ? "Party" : "Tank", getUploadedFiles: () => undefined },
      deferReply: async () => undefined, editReply: async () => undefined
    } as unknown as Parameters<typeof handleContentModalSubmit>[0], repository, {} as never);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].scheduledStartAt?.toISOString(), scenario.expected);
    assert.equal(updates[0].requireScheduledState, true);
  });
}

for (const state of ["unscheduled", "active", "ended", "cancelled"] as const) {
  test(`unscheduled ${state} presentation contains no fabricated timestamps`, () => {
    const snapshot = contentSnapshot(state);
    snapshot.content.scheduledStartAt = null;
    const message = buildContentAnnouncementV2Message(snapshot.content);
    const container = (message.components![0] as { toJSON(): { components: Array<{ content?: string }> } }).toJSON();
    assert.deepEqual(container.components.flatMap((component) => component.content ?? []), ["-# UNSCHEDULED", "# Avalonian Dungeon"]);
    assert.equal(buildThreadTitle(snapshot.content.title, null), "Avalonian Dungeon");
    const list = JSON.stringify(buildPartyListV2Messages([snapshot.content]));
    assert.match(list, /Unscheduled • <@host-1>/);
    assert.doesNotMatch(list, /UTC|<t:/);
    const controls = JSON.stringify(buildContentDetailsV2Message(snapshot.content));
    assert.equal(controls.includes('"label":"Start"'), state === "unscheduled");
    assert.equal(controls.includes('"label":"End"'), state === "active");
  });
}

test("unscheduled modal IDs round trip alongside legacy scheduled IDs", () => {
  assert.deepEqual(parseContentModalId(buildContentCreateModalId("template-1", null)), {
    action: "create", templateId: "template-1", scheduledStartAt: null
  });
  const date = new Date("2099-08-10T12:00:00Z");
  assert.deepEqual(parseContentModalId(buildContentCreateModalId(undefined, date)), {
    action: "create", templateId: undefined, scheduledStartAt: date
  });
  assert.equal(parseContentModalId("content-modal:create:none:unscheduled:unexpected"), undefined);
});

test("unscheduled waiting edits reject schedule conversion and accept graphics", async () => {
  for (const options of [{ date: "2099-08-10" }, { time: "12" }, { image: { contentType: "image/png", url: "https://example.test/image.png" } }, {}]) {
    const snapshot = contentSnapshot("unscheduled");
    snapshot.content.scheduledStartAt = null;
    const replies: Array<{ embeds: EmbedBuilder[] }> = [];
    const modals: ModalBuilder[] = [];
    await showContentEditModal({
      user: { id: "host-1" },
      reply: async (payload: typeof replies[number]) => { replies.push(payload); },
      showModal: async (modal: ModalBuilder) => { modals.push(modal); }
    } as unknown as Parameters<typeof showContentEditModal>[0], snapshot, options as Parameters<typeof showContentEditModal>[2]);
    if ("date" in options || "time" in options) {
      assert.equal(messageSummary(replies[0]), "Unscheduled parties cannot have a date or time. This edit cannot change the party mode.");
      assert.equal(modals.length, 0);
    } else {
      assert.equal(replies.length, 0);
      assert.equal(modals.length, 1);
    }
  }
});

test("unscheduled list ordering uses publication and actual start times", () => {
  const waiting = ["later", "first"].map((id, index) => ({ ...contentSnapshot("unscheduled").content, contentId: id, title: id, scheduledStartAt: null, createdAt: new Date(index === 0 ? "2026-09-10T02:00Z" : "2026-09-10T01:00Z") }));
  const active = ["started-later", "started-first"].map((id, index) => ({ ...contentSnapshot("active").content, contentId: id, title: id, scheduledStartAt: null, startedAt: new Date(index === 0 ? "2026-09-10T04:00Z" : "2026-09-10T03:00Z") }));
  const text = JSON.stringify(buildPartyListV2Messages([...waiting, ...active]));
  assert.ok(text.indexOf("[first]") < text.indexOf("[later]"));
  assert.ok(text.indexOf("[started-first]") < text.indexOf("[started-later]"));
});

for (const control of ["start", "cancel", "end", "edit"] as const) {
  test(`unscheduled ${control} remains host-only`, async () => {
    const snapshot = contentSnapshot("unscheduled");
    snapshot.content.scheduledStartAt = null;
    const replies: Array<{ embeds: EmbedBuilder[] }> = [];
    await handleContentButton({
      customId: `content:${control}:content-1`, inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", message: { id: "details-1" },
      user: { id: "non-host" }, reply: async (payload: typeof replies[number]) => { replies.push(payload); }
    } as unknown as Parameters<typeof handleContentButton>[0], {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot
    } as unknown as Parameters<typeof handleContentButton>[1], {} as never);
    assert.equal(messageSummary(replies[0]), "Only the party host can use that control.");
  });
}

for (const [approval, multisignup] of [undefined, "false", "true"].flatMap(approval =>
  [undefined, "false", "true"].map(multisignup => [approval, multisignup]))) {
  for (const mode of ["scheduled", "unscheduled"]) {
    for (const template of ["blank", "saved"]) {
      test(`party host ${mode} ${template} retains approval=${approval}, multisignup=${multisignup} through its form`, async () => {
        const modals: ModalBuilder[] = [];
        await handlePartyCommand({
          inGuild: () => true, guildId: "guild-1",
          options: {
            getSubcommandGroup: () => "host", getSubcommand: () => mode,
            getString: (name: string) => ({ date: "2099-08-10", time: "12", template, approval: approval ?? null, multisignup: multisignup ?? null })[name]
          },
          showModal: async (modal: ModalBuilder) => { modals.push(modal); }
        } as unknown as Parameters<typeof handlePartyCommand>[0], {
          getTemplate: async () => ({ contentTemplateId: "template-1", title: "Party", description: "", rolesText: "Tank" })
        } as never, {} as never);
        const parsed = parseContentModalId(modals[0].toJSON().custom_id);
        assert.equal(parsed?.approvalRequired ?? false, approval === "true");
        assert.equal(parsed?.multiSignupEnabled ?? false, multisignup === "true");
        assert.equal(parsed?.scheduledStartAt?.toISOString() ?? null, mode === "scheduled" ? "2099-08-10T12:00:00.000Z" : null);
        assert.equal(parsed?.templateId, template === "saved" ? "template-1" : undefined);
        assert.ok(modals[0].toJSON().custom_id.length <= 100);
      });
    }
  }
}

for (const route of ["role-select", "standby-button", "standby-command"] as const) {
  test(`${route} creates an approval request through the atomic gate`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.approvalRequired = true;
    const edits: Array<{ embeds: EmbedBuilder[] }> = [];
    const mutations: Array<{ roleSlotId: string | null; discordUserId: string; actorDiscordUserId?: string }> = [];
    const interaction: any = {
      inGuild: () => true, inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: "requester" },
      customId: route === "standby-button" ? "content:standby:content-1" : "content:slot:content-1:requester",
      message: { id: "control-1" },
      values: [route === "role-select" ? buildRoleSlotSelectValue(snapshot.slots[1]) : STANDBY_SIGNUP_VALUE],
      deferReply: async () => {}, editReply: async (p: typeof edits[number]) => { edits.push(p); }
    };
    const repository: any = {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot, getContentByThread: async () => snapshot,
      requestSignup: async (input: typeof mutations[number]) => {
        mutations.push(input);
        return { status: "requested", request: { requestId: "request-1" } };
      }
    };
    if (route.endsWith("select")) await handleContentRoleSelect(interaction, repository);
    else if (route === "standby-button") await handleContentButton(interaction, repository, {} as never);
    else await handleStandbyCommand(interaction, repository);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].roleSlotId, route === "role-select" ? "slot-2" : null);
    assert.equal(mutations[0].actorDiscordUserId, undefined);
    assert.equal(messageDescription(edits[0]),
      `Request sent for **${route === "role-select" ? "2. Healer" : "Standby"}**. Your place is confirmed when the host accepts.`);
    assert.equal(snapshot.signups.length, 2);
  });
}

for (const route of ["button", "command"]) {
  test(`Join ${route} explains the gate in its private selector`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.approvalRequired = true;
    const replies: any[] = [];
    const interaction: any = {
      inGuild: () => true, inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: "requester" },
      customId: "content:join:content-1", message: { id: "control-1" },
      reply: async (p: unknown) => { replies.push(p); }
    };
    const repository: any = { isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot, getContentByThread: async () => snapshot };
    if (route === "button") await handleContentButton(interaction, repository, {} as never);
    else await handleJoinCommand(interaction, repository);
    assert.match(messageDescription(replies[0]), /Host approval is required\. Requests do not reserve a place\./);
    assert.equal(replies[0].flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  });
}

for (const route of ["button", "command", "remove"]) {
  test(`${route} clears both confirmed signup and pending move atomically`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.approvalRequired = true;
    const edits: any[] = [];
    const calls: any[] = [];
    const interaction: any = {
      inGuild: () => true, inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: route === "remove" ? "host-1" : "requester" },
      customId: "content:leave:content-1", message: { id: "control-1" },
      options: { getSubcommandGroup: () => null, getSubcommand: () => "remove", getUser: () => ({ id: "requester" }) },
      deferReply: async () => {}, editReply: async (p: unknown) => { edits.push(p); }
    };
    const repository: any = {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot, getContentByThread: async () => snapshot,
      withdrawSignup: async (input: unknown) => { calls.push(input); return { status: "removed", removedSignup: true, removedRequest: true }; }
    };
    if (route === "button") await handleContentButton(interaction, repository, {} as never);
    else if (route === "command") await handleLeaveCommand(interaction, repository);
    else await handlePartyCommand(interaction, repository, {} as never);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actorDiscordUserId, route === "remove" ? "host-1" : undefined);
    assert.match(messageDescription(edits[0]), /signup and pending request were removed/);
    assert.doesNotMatch(messageDescription(edits[0]), /declined|not accepted/);
  });
}

test("host-add controls retain host authority even when assigning oneself", async () => {
  const snapshot = contentSnapshot();
  const replies: any[] = [];
  await openSignupSelect({ user: { id: "host-1" }, reply: async (p: unknown) => { replies.push(p); } } as never,
    { isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot } as never, snapshot, "host-1", true);
  const row = messageRows(replies[0])[0];
  const customId = row.components[0].custom_id;
  assert.match(customId, /:host$/);
  snapshot.content.hostDiscordUserId = "new-host";
  await handleContentRoleSelect({
    customId, values: ["slot-2"], inCachedGuild: () => true,
    guildId: "guild-1", channelId: "party-thread", user: { id: "host-1" },
    reply: async (p: unknown) => { replies.push(p); }
  } as never, { isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot } as never);
  assert.equal(messageSummary(replies[1]), "Only the party host can add another user.");
});

for (const route of ["join-button", "join-command", "role-select", "standby-button", "standby-command"]) {
  test(`expired ${route} rejects without changing a signup or request`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.scheduledStartAt = new Date("2000-01-01T00:00:00Z");
    const replies: any[] = [];
    const interaction: any = {
      inGuild: () => true, inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: "requester" },
      customId: route === "role-select" ? "content:slot:content-1:requester" : `content:${route.startsWith("join") ? "join" : "standby"}:content-1`,
      message: { id: "control-1" }, values: ["slot-2"],
      reply: async (p: unknown) => { replies.push(p); }
    };
    const repository: any = {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot, getContentByThread: async () => snapshot,
      requestSignup: async () => assert.fail("Expired entry must not reach mutation")
    };
    if (route === "role-select") await handleContentRoleSelect(interaction, repository);
    else if (route.endsWith("button")) await handleContentButton(interaction, repository, {} as never);
    else if (route === "join-command") await handleJoinCommand(interaction, repository);
    else await handleStandbyCommand(interaction, repository);
    assert.equal(messageSummary(replies[0]), "This content signup is no longer open.");
  });
}

for (const approvalRequired of [false, true]) {
  test(`role selector rejects a renamed slot with approval=${approvalRequired}`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.approvalRequired = approvalRequired;
    const selection = buildRoleSlotSelectRows(snapshot, "requester")[0].toJSON().components[0];
    const value = selection.options.find((option) => option.label === "2. Healer")!.value;
    snapshot.slots[1].label = "Tank";
    const replies: any[] = [];
    await handleContentRoleSelect({
      customId: selection.custom_id, values: [value], inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: "requester" },
      reply: async (p: unknown) => { replies.push(p); }
    } as never, {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot,
      requestSignup: async () => assert.fail("A stale displayed role must not become another role's request")
    } as never);
    assert.equal(messageSummary(replies[0]), "That role has changed. Choose a role again.");
  });
}

test("slash creation rejects an overlong gated role with a private validation error", async () => {
  const replies: any[] = [];
  await handleContentModalSubmit({
    customId: buildContentCreateModalId(undefined, null, true), inCachedGuild: () => true,
    guildId: "guild-1", user: { id: "host-1" },
    fields: { getTextInputValue: (field: string) => field === "roles" ? "a".repeat(1851) : "Party" },
    reply: async (p: unknown) => { replies.push(p); }
  } as never, {} as never, {} as never);
  assert.equal(messageDescription(replies[0]), "Keep each role to 1,850 characters or fewer when host approval is required.");
  assert.equal(replies[0].flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
});

for (const approvalRequired of [false, true]) {
  test(`gated role edit length validation applies only with approval=${approvalRequired}`, async () => {
    const snapshot = contentSnapshot();
    snapshot.content.approvalRequired = approvalRequired;
    const replies: any[] = [];
    let writes = 0;
    await handleContentModalSubmit({
      customId: "content-modal:edit:content-1", inCachedGuild: () => true,
      guildId: "guild-1", channelId: "party-thread", user: { id: "host-1" },
      fields: { getTextInputValue: (field: string) => field === "roles" ? "a".repeat(1851) : "Party" },
      reply: async (p: unknown) => { replies.push(p); },
      deferReply: async () => {}, editReply: async () => {}
    } as never, {
      isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot,
      updateContentDetails: async () => { writes++; return undefined; }
    } as never, {} as never);
    assert.equal(writes, approvalRequired ? 0 : 1);
    if (approvalRequired) assert.equal(messageDescription(replies[0]),
      "Keep each role to 1,850 characters or fewer when host approval is required.");
  });
}
