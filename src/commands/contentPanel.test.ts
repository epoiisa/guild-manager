import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { UTC_TIME_OPTION_DESCRIPTION } from "../services/scheduling.js";
import { INFO_COLOR } from "./configurationHelpers.js";
import { buildContentModal } from "./content.js";
import {
  createContentPanelInteractions,
  type ContentPanelInteractionDependencies,
} from "./contentPanel.js";
function fixture() {
  let now = Date.now(),
    revision = "revision",
    visible = true,
    timeout = 0,
    canonical = true,
    created = 0,
    deleted = 0;
  const outputs: any[] = [];
  let templateDeleted = false;
  const acknowledgments: string[] = [];
  const entries: any[] = [];
  const modals: any[] = [];
  const creations: Array<{ approvalRequired?: boolean; multiSignupEnabled?: boolean; title: string; scheduledStartAt: Date | null }> = [];
  const snapshot: any = {
    content: {
      contentId: "party",
      state: "unscheduled",
      hostDiscordUserId: "owner",
      title: "Party",
      description: "",
      scheduledStartAt: null,
    },
    slots: [{ contentRoleSlotId: "slot", label: "Tank", position: 0 }],
    signups: [],
  };
  const thread = {
    id: "thread",
    send: async () => ({ id: "roles", pin: async () => {} }),
    delete: async () => {
      deleted++;
    },
  };
  const channel = {
    id: "channel",
    type: ChannelType.GuildText,
    permissionsFor: () => ({
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel && visible,
    }),
    send: async () => ({
      id: "post",
      createdAt: new Date(),
      startThread: async () => thread,
      edit: async () => undefined,
      delete: async () => {
        deleted++;
      },
    }),
  };
  const repository = {
    getContentChannel: async () => ({
      discordChannelId: "channel",
      configurationRevision: revision,
    }),
    listTemplates: async () =>
      Array.from({ length: 50 }, (_, n) => ({
        contentTemplateId: `t${n}`,
        name: `Template ${n}`,
      })),
    getTemplate: async (_g: string, id: string) =>
      templateDeleted || id === "deleted"
        ? undefined
        : { title: "Template", description: "Details", rolesText: "Tank" },
    createContent: async (input: typeof creations[number]) => {
      creations.push(input);
      created++;
      Object.assign(snapshot.content, input);
      return snapshot;
    },
    setContentMessageIds: async () => {},
    deleteContent: async () => {
      deleted++;
    },
  };
  const deps = {
    repository,
    listPanelContent: async () => entries,
    logger: { info() {}, error() {} },
    panel: {
      runExclusive: async (_g: string, f: () => Promise<unknown>) => f(),
      isCurrentPanel: async () => canonical,
    },
    now: () => now,
  } as unknown as ContentPanelInteractionDependencies;
  const service = createContentPanelInteractions(deps);
  function interaction(customId: string, user = "owner"): any {
    return {
      customId,
      guildId: "guild",
      channelId: "channel",
      message: { id: "panel" },
      user: { id: user, bot: false },
      inCachedGuild: () => true,
      guild: {
        members: {
          fetch: async () => ({
            user: { bot: false },
            communicationDisabledUntilTimestamp: timeout,
          }),
        },
        channels: { fetch: async () => channel },
      },
      deferred: false,
      replied: false,
      async deferReply(options: unknown) {
        assert.deepEqual(options, { flags: MessageFlags.Ephemeral });
        acknowledgments.push("reply");
        this.deferred = true;
      },
      async deferUpdate() {
        acknowledgments.push("update");
        this.deferred = true;
      },
      async reply(p: any) {
        outputs.push(p);
        this.replied = true;
      },
      async editReply(p: any) {
        outputs.push(p);
      },
      async update(p: any) {
        outputs.push(p);
      },
      async showModal(m: any) {
        modals.push(m.toJSON());
      },
      fields: {
        getTextInputValue: (id: string) =>
          ({
            title: "Party",
            description: "Details",
            roles: "Tank",
            time: "24",
          })[id],
        getUploadedFiles: () => new Map(),
      },
    };
  }
  function ids() {
    return JSON.stringify(outputs.at(-1), (_k, v) =>
      v?.toJSON ? v.toJSON() : v,
    ).match(/content-host:[a-z0-9-]+:[a-z]+/g)!;
  }
  async function open(scheduled = false) {
    await service.handleButton(
      interaction(
        `content-panel:current:${scheduled ? "scheduled" : "unscheduled"}`,
      ),
    );
    return ids()[0].split(":")[1];
  }
  async function date(id: string) {
    const i = interaction(`content-host:${id}:date`);
    i.values = [new Date(now).toISOString().slice(0, 10)];
    await service.handleSelect(i);
  }
  return {
    date,
    creations,
    repository,
    panel: deps.panel,
    acknowledgments,
    entries,
    deleteTemplate: () => {
      templateDeleted = true;
    },
    service,
    interaction,
    outputs,
    modals,
    ids,
    open,
    created: () => created,
    deleted: () => deleted,
    setRevision: () => {
      revision = "changed";
    },
    hide: () => {
      visible = false;
    },
    timeout: () => {
      timeout = now + 1000;
    },
    repost: () => {
      canonical = false;
    },
    expire: () => {
      now += 900001;
    },
  };
}
test("modal graphic inclusion is explicit and scheduled modal has five components", () => {
  assert.equal(
    buildContentModal("Host", "arbitrary", "", "", "", {
      graphic: true,
      time: "",
    }).toJSON().components.length,
    5,
  );
  assert.equal(
    buildContentModal("Edit", "content-modal:create:x", "", "", "").toJSON()
      .components.length,
    3,
  );
});
test("visible members can host without history/send/managed or slash permissions; all templates are paged", async () => {
  const f = fixture();
  const id = await f.open();
  assert.ok(id);
  assert.match(JSON.stringify(f.outputs.at(-1)), /Template 23/);
  assert.doesNotMatch(JSON.stringify(f.outputs.at(-1)), /Template 24/);
  await f.service.handleButton(f.interaction(`content-host:${id}:next`));
  assert.match(JSON.stringify(f.outputs.at(-1)), /Template 47/);
  await f.service.handleButton(f.interaction(`content-host:${id}:next`));
  assert.match(JSON.stringify(f.outputs.at(-1)), /Template 49/);
  assert.deepEqual(f.outputs[0].allowedMentions, {
    parse: [],
    users: [],
    roles: [],
    repliedUser: false,
  });
});
test("wrong owners, expired drafts, config changes, loss of access and timeout reject", async () => {
  for (const mode of ["owner", "expiry", "revision", "access", "timeout"]) {
    const f = fixture();
    const id = await f.open();
    if (mode === "expiry") f.expire();
    if (mode === "revision") f.setRevision();
    if (mode === "access") f.hide();
    if (mode === "timeout") f.timeout();
    await f.service.handleButton(
      f.interaction(
        `content-host:${id}:continue`,
        mode === "owner" ? "other" : "owner",
      ),
    );
    if (mode === "owner" || mode === "expiry")
      assert.equal(f.modals.length, 0, mode);
    else {
      await f.service.handleModal(f.interaction(f.modals[0].custom_id));
      assert.equal(f.created(), 0, mode);
    }
  }
});
test("repost preserves draft; stale modal and duplicate submit cannot create twice; confirmation failure preserves result", async () => {
  const f = fixture();
  const id = await f.open();
  f.repost();
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  await f.service.handleModal(f.interaction(f.modals[0].custom_id));
  assert.equal(f.created(), 0);
  const submission = f.interaction(f.modals[1].custom_id);
  submission.editReply = async () => {
    throw Error("expired confirmation");
  };
  await assert.rejects(
    f.service.handleModal(submission),
    /expired confirmation/,
  );
  assert.equal(f.created(), 1);
  assert.equal(f.deleted(), 0);
  await f.service.handleModal(f.interaction(f.modals[1].custom_id));
  assert.equal(f.created(), 1);
  const confirmation = {
    content: "Created [Party](https://discord.com/channels/guild/channel/post), unscheduled.",
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
  };
  assert.deepEqual(f.outputs.at(-1), confirmation);
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  assert.deepEqual(f.outputs.at(-1), { ...confirmation, flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds });
  assert.equal(f.created(), 1);
});
test("invalid input retains editable values and retry explicitly requires reattaching graphic", async () => {
  const f = fixture();
  const id = await f.open(true);
  await f.date(id);
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  const i = f.interaction(f.modals[0].custom_id);
  i.fields.getTextInputValue = (key: string) =>
    ({ title: "Retained", description: "Text", roles: "Tank", time: "bad" })[
      key
    ];
  await f.service.handleModal(i);
  assert.match(JSON.stringify(f.outputs.at(-1)), /Reattach/);
  await f.service.handleButton(f.interaction(`content-host:${id}:retry`));
  assert.match(JSON.stringify(f.modals.at(-1)), /Retained/);
  assert.equal(f.modals.at(-1).components.length, 5);
});
test("reset and stop invalidate open forms", async () => {
  for (const stop of [false, true]) {
    const f = fixture();
    const id = await f.open();
    await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
    if (stop) f.service.stop();
    else f.service.invalidateGuild("guild");
    await f.service.handleModal(f.interaction(f.modals[0].custom_id));
    assert.equal(f.created(), 0);
  }
});
test("scheduled UTC 24 submission succeeds and repeated concurrent submissions create once", async () => {
  const f = fixture();
  const id = await f.open(true);
  await f.date(id);
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  const modal = f.modals[0].custom_id;
  await Promise.all([
    f.service.handleModal(f.interaction(modal)),
    f.service.handleModal(f.interaction(modal)),
  ]);
  assert.equal(f.created(), 1);
  const timestamp = f.creations[0].scheduledStartAt!.getTime() / 1000;
  const confirmation = {
    content: `Created [Party](https://discord.com/channels/guild/channel/post), scheduled for <t:${timestamp}:F> (<t:${timestamp}:R>).`,
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
  };
  assert.deepEqual(f.outputs.at(-1), confirmation);
  await f.service.handleModal(f.interaction(modal));
  assert.deepEqual(f.outputs.at(-1), confirmation);
  assert.equal(f.created(), 1);
});
test("cancellation and cross-guild reuse reject while stale public entry creates no draft", async () => {
  const f = fixture();
  const id = await f.open();
  const cross = f.interaction(`content-host:${id}:continue`);
  cross.guildId = "other";
  await f.service.handleButton(cross);
  assert.equal(f.modals.length, 0);
  await f.service.handleButton(f.interaction(`content-host:${id}:cancel`));
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  assert.equal(f.modals.length, 0);
  f.repost();
  await f.service.handleButton(f.interaction("content-panel:old:unscheduled"));
  assert.match(
    JSON.stringify(f.outputs.at(-1)),
    /Use the latest Content message/,
  );
});
test("reconnect permits new drafts but never revives drafts cleared on disconnect", async () => {
  const f = fixture();
  const id = await f.open();
  f.service.stop();
  f.service.start();
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  assert.equal(f.modals.length, 0);
  const next = await f.open();
  await f.service.handleButton(f.interaction(`content-host:${next}:continue`));
  assert.equal(f.modals.length, 1);
});
test("scheduled setup requires an explicit date and shows UTC time guidance in the modal", async () => {
  const f = fixture();
  const id = await f.open(true);
  const payload = JSON.parse(JSON.stringify(f.outputs.at(-1)));
  assert.equal(payload.components[0].accent_color, INFO_COLOR);
  const rows = payload.components[0].components;
  const selector = rows
    .flatMap((r: any) => r.components ?? [])
    .find((c: any) => c.custom_id?.endsWith(":date"));
  assert.equal(selector.placeholder, "Date (UTC)");
  assert.ok(selector.options.every((o: any) => !o.default));
  assert.equal(
    rows
      .flatMap((r: any) => r.components ?? [])
      .find((c: any) => c.label === "Continue").disabled,
    true,
  );
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  assert.equal(f.modals.length, 0);
  await f.date(id);
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  assert.equal(
    f.modals[0].components[1].description,
    UTC_TIME_OPTION_DESCRIPTION,
  );
});
test("Continue opens its prepared modal without waiting for any repository or REST authorization", async () => {
  const f = fixture();
  const id = await f.open();
  f.repository.getContentChannel = async () => {
    throw Error("must not read before modal ACK");
  };
  const i = f.interaction(`content-host:${id}:continue`);
  i.guild.members.fetch = async () => {
    throw Error("must not fetch");
  };
  await f.service.handleButton(i);
  assert.equal(f.modals.length, 1);
  assert.equal(i.deferred, false);
});
test("deleting the chosen template after opening the modal prevents publication and retains retry text", async () => {
  const f = fixture();
  const id = await f.open();
  const select = f.interaction(`content-host:${id}:template`);
  select.values = ["t1"];
  await f.service.handleSelect(select);
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  f.deleteTemplate();
  await f.service.handleModal(f.interaction(f.modals[0].custom_id));
  assert.equal(f.created(), 0);
  assert.match(JSON.stringify(f.outputs.at(-1)), /template was deleted/);
  await f.service.handleButton(f.interaction(`content-host:${id}:retry`));
  await f.service.handleModal(f.interaction(f.modals[1].custom_id));
  assert.equal(f.created(), 1);
  assert.equal(f.outputs.at(-1).content, "Created [Party](https://discord.com/channels/guild/channel/post), unscheduled.");
});
test("wrong-channel and malformed private actions never open forms or create content", async () => {
  const f = fixture();
  const id = await f.open();
  for (const suffix of ["unknown", "continue:extra", "submit:1:extra"]) {
    await f.service.handleButton(f.interaction(`content-host:${id}:${suffix}`));
  }
  const i = f.interaction(`content-host:${id}:continue`);
  i.channelId = "other";
  await f.service.handleButton(i);
  assert.equal(f.modals.length, 0);
  assert.equal(f.created(), 0);
});
test("private list navigation edits one owner-bound message and survives public repost", async () => {
  const f = fixture();
  for (let n = 0; n < 60; n++)
    f.entries.push({
      content: {
        contentId: `p${n}`,
        discordGuildId: "guild",
        threadChannelId: "thread",
        title: "Party " + "x".repeat(80),
        hostDiscordUserId: "owner",
        state: "unscheduled",
        postedAt: new Date(),
        createdAt: new Date(),
        startedAt: null,
        scheduledStartAt: null,
      },
      filledRoles: 0,
      totalRoles: 1,
    });
  await f.service.handleButton(f.interaction("content-panel:current:list"));
  const id = JSON.stringify(f.outputs.at(-1)).match(
    /content-panel:[a-z0-9-]+:page:1/,
  )![0];
  f.repost();
  await f.service.handleButton(f.interaction(id));
  assert.equal(f.acknowledgments.at(-1), "update");
  assert.match(JSON.stringify(f.outputs.at(-1)), /Content • 2\//);
  const wrong = f.interaction(id, "other");
  await f.service.handleButton(wrong);
  assert.match(
    JSON.stringify(f.outputs.at(-1)),
    /expired or is no longer available/,
  );
});
test("a delayed template selection cannot change the meaning of an already-open form", async () => {
  const f = fixture();
  const id = await f.open();
  let release!: (value: any) => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  f.repository.getTemplate = async () => {
    entered();
    return await new Promise<any>((r) => {
      release = r;
    });
  };
  const select = f.interaction(`content-host:${id}:template`);
  select.values = ["t1"];
  const selecting = f.service.handleSelect(select);
  await ready;
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  release({ title: "Changed", description: "Changed", rolesText: "Healer" });
  await selecting;
  f.repository.getTemplate = async () => {
    throw Error("Blank modal must not become selected template");
  };
  await f.service.handleModal(f.interaction(f.modals[0].custom_id));
  assert.equal(f.created(), 1);
});

test("public entry paused at canonical lookup cannot recreate a draft across invalidation", async () => {
  for (const disconnect of [false, true]) {
    const f = fixture();
    let release!: (current: boolean) => void;
    let reached!: () => void;
    const pending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.panel.isCurrentPanel = async () => {
      reached();
      return await new Promise<boolean>((resolve) => {
        release = resolve;
      });
    };
    const entering = f.service.handleButton(
      f.interaction("content-panel:current:unscheduled"),
    );
    await pending;
    if (disconnect) {
      f.service.stop();
      f.service.start();
    } else f.service.invalidateGuild("guild");
    release(true);
    await entering;
    assert.doesNotMatch(JSON.stringify(f.outputs.at(-1)), /content-host:/);
    assert.match(JSON.stringify(f.outputs.at(-1)), /latest Content message/);
  }
});

test("invalidation during final authorization prevents successful acceptance and rolls back publication", async () => {
  const f = fixture();
  const id = await f.open();
  await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
  const submit = f.interaction(f.modals[0].custom_id);
  const fetch = submit.guild.members.fetch;
  let count = 0;
  let release!: () => void;
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  submit.guild.members.fetch = async () => {
    count++;
    if (count === 5) {
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return await fetch();
  };
  const publishing = f.service.handleModal(submit);
  await pending;
  f.service.invalidateGuild("guild");
  release();
  await publishing;
  assert.equal(f.created(), 1);
  assert.equal(f.deleted(), 3);
  assert.equal(f.outputs.at(-1).content, "Creation failed. Ask an administrator to inspect the channel before hosting again.");
});

for (const scheduled of [false, true]) {
  for (const template of ["blank", "t1"]) {
    for (const [approval, multiSignup] of [[false, false], [false, true], [true, false], [true, true]]) {
      test(`hosting ${scheduled ? "scheduled" : "unscheduled"} ${template} snapshots approval=${approval}, multiSignup=${multiSignup} through Retry`, async () => {
        const f = fixture();
        const id = await f.open(scheduled);
        const initial = JSON.stringify(f.outputs.at(-1));
        assert.match(initial, /Host approval/);
        assert.ok(initial.indexOf('"label":"Host approval not required"') < initial.indexOf('"label":"Host approval required"'));
        assert.ok(initial.indexOf('"placeholder":"Host approval"') < initial.indexOf('"placeholder":"Multi-signup"'));
        const count = (nodes: any[]): number => nodes.reduce((n, node) => n + 1 + count(node.components ?? []), 0);
        assert.ok(count(JSON.parse(initial).components) <= 40);
        if (scheduled) await f.date(id);
        const select = f.interaction(`content-host:${id}:template`);
        select.values = [template];
        await f.service.handleSelect(select);
        const approvalSelect = f.interaction(`content-host:${id}:approval`);
        approvalSelect.values = [String(approval)];
        await f.service.handleSelect(approvalSelect);
        const multiSelect = f.interaction(`content-host:${id}:multisignup`);
        multiSelect.values = [String(multiSignup)];
        await f.service.handleSelect(multiSelect);
        await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
        // An older setup cannot change the submitted form's choice.
        approvalSelect.values = [String(!approval)];
        await f.service.handleSelect(approvalSelect);
        multiSelect.values = [String(!multiSignup)];
        await f.service.handleSelect(multiSelect);
        const invalid = f.interaction(f.modals.at(-1).custom_id);
        invalid.fields.getTextInputValue = (key: string) => key === "title" ? "" : "Tank";
        await f.service.handleModal(invalid);
        assert.equal(f.created(), 0);
        await f.service.handleButton(f.interaction(`content-host:${id}:retry`));
        await f.service.handleModal(f.interaction(f.modals.at(-1).custom_id));
        assert.equal(f.created(), 1);
        assert.equal(f.creations[0].approvalRequired, approval);
        assert.equal(f.creations[0].multiSignupEnabled, multiSignup);
        const second = await f.open(scheduled);
        const next = JSON.stringify(f.outputs.at(-1));
        assert.notEqual(second, id);
        assert.match(next, /"label":"Host approval not required"[^}]*"default":true/);
        assert.match(next, /"label":"Multi-signup off"[^}]*"default":true/);
      });
    }
  }
}

for (const approvalRequired of [false, true]) {
  test(`panel role length validation with approval=${approvalRequired} retains Retry`, async () => {
    const f = fixture();
    const id = await f.open();
    const select = f.interaction(`content-host:${id}:approval`);
    select.values = [String(approvalRequired)];
    await f.service.handleSelect(select);
    await f.service.handleButton(f.interaction(`content-host:${id}:continue`));
    const submission = f.interaction(f.modals.at(-1).custom_id);
    const read = submission.fields.getTextInputValue;
    submission.fields.getTextInputValue = (field: string) => field === "roles" ? "a".repeat(1851) : read(field);
    await f.service.handleModal(submission);
    assert.equal(f.created(), approvalRequired ? 0 : 1);
    if (approvalRequired) {
      assert.match(JSON.stringify(f.outputs.at(-1)), /Keep each role to 1,850 characters or fewer when host approval is required\./);
      await f.service.handleButton(f.interaction(`content-host:${id}:retry`));
      await f.service.handleModal(f.interaction(f.modals.at(-1).custom_id));
      assert.equal(f.created(), 1);
      assert.equal(f.creations[0].approvalRequired, true);
    }
  });
}
