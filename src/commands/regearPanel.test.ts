import { ChannelType, ComponentType } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { RegearContent } from "../db/regearRepository.js";
import { createEntryPanelContext } from "../services/entryPanels/access.js";
import { buildRegearPanel, createRegearPanelInteractions } from "./regearPanel.js";

const content: RegearContent = {
  regearContentId: "content-1", discordGuildId: "guild", albionServer: "asia", name: "Reset Day",
  contentDate: "2026-09-10", contentAt: new Date("2026-09-10T10:00:00Z"), state: "open",
  channelId: "historical-channel", createdByDiscordUserId: "reviewer", createdAt: new Date(), updatedAt: new Date()
};
const character = { albionServer: "asia" as const, albionCharacterId: "character-1", characterName: "Example", discordUserId: "owner" };
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
function fixture() {
  let now = Date.now(), revision = "revision", configured = true, canonical = true, timeout = 0, visible = true;
  let contents: RegearContent[] = [content];
  let characters = [character];
  const replies: any[] = [], modals: any[] = [], claims: any[] = [], sent: any[] = [];
  const member = { user: { bot: false }, get communicationDisabledUntilTimestamp() { return timeout; }, roles: { cache: new Map() }, permissions: { has: () => false } };
  const review = { id: "review", attachments: new Map(), components: [{ type: ComponentType.Container, components: [{ type: ComponentType.MediaGallery, items: [
    { description: "Screenshot/Evidence 1", media: { id: "e1", url: "https://cdn.test/one.png", content_type: "image/png" } },
    { description: "Screenshot/Evidence 2", media: { id: "e2", url: "https://cdn.test/two.png", content_type: "image/png" } }
  ] }] }], edit: async () => undefined, delete: async () => undefined };
  const channel = { id: "configured-channel", type: ChannelType.GuildText, permissionsFor: (who: unknown) => ({ has: () => who === member ? visible : true }), isSendable: () => true, send: async (payload: unknown) => { sent.push(payload); return review; } };
  const guild = { id: "guild", channels: { fetch: async () => channel }, members: { me: {}, fetch: async () => member } };
  const entries = createEntryPanelContext({
    repository: { getChannel: async () => configured ? ({ discordChannelId: channel.id, configurationRevision: revision }) : undefined } as never,
    runExclusive: async (_guild: string, operation: () => Promise<any>) => operation(), refresh: async () => undefined,
    isGuildActive: async () => true, hasRegisteredCharacter: async () => true, isCurrentPanel: async () => canonical, captureFence: () => () => true
  });
  const repository = {
    listEligibleCharactersForUser: async (_g: string, owner: string, server?: string) => characters.filter(c => c.discordUserId === owner && (!server || c.albionServer === server)),
    listContents: async (_g: string, server?: string, state?: string) => contents.filter(c => (!server || c.albionServer === server) && (!state || c.state === state)),
    getContent: async (_g: string, id: string) => contents.find(c => c.regearContentId === id),
    listReviewerRoleIds: async () => [],
    createPendingClaim: async (input: any) => { claims.push(input); return { ...input, currentOwnerDiscordUserId: "owner", characterName: character.characterName, contentName: content.name, contentDate: content.contentDate, contentAt: content.contentAt }; },
    listClaimsForOwner: async () => []
  };
  const controller = createRegearPanelInteractions({ entries, repository: repository as never, now: () => now });
  function interaction(id: string, kind = "button", owner = "owner"): any {
    return {
      customId: id, commandName: kind === "command" ? "regearme" : undefined, guildId: "guild", guild, channelId: "origin-channel", message: { id: "panel" }, user: { id: owner, bot: false },
      inCachedGuild: () => true, isChatInputCommand: () => kind === "command", isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal",
      replied: false, deferred: false,
      async reply(payload: unknown) { this.replied = true; replies.push(json(payload)); }, async followUp(payload: unknown) { replies.push(json(payload)); },
      async update(payload: unknown) { replies.push(json(payload)); }, async deferReply() { this.deferred = true; }, async deferUpdate() { this.deferred = true; }, async editReply(payload: unknown) { replies.push(json(payload)); },
      async showModal(modal: any) { modals.push(modal.toJSON()); },
      fields: { getTextInputValue: () => "1250000", getUploadedFiles: (id: string) => new Map([[id, { url: `https://cdn.test/${id}.png`, contentType: "image/png" }]]) }, values: []
    };
  }
  async function open(command = false) { await controller.handle(interaction("entry-panel:regears:current:submit", command ? "command" : "button")); return /regear-entry:([\w-]+):/.exec(JSON.stringify(replies.at(-1)))?.[1]; }
  return { controller, entries, repository, replies, modals, claims, sent, interaction, open,
    setContents: (value: RegearContent[]) => { contents = value; }, setCharacters: (value: typeof characters) => { characters = value; },
    expire: () => { now += 15 * 60_000; }, move: () => { canonical = false; }, change: () => { revision = "changed"; }, clear: () => { configured = false; },
    timeout: () => { timeout = Date.now() + 60_000; }, hide: () => { visible = false; }
  };
}

test("re-gear public panel sorts complete rows, omits absent times, disables empty intake, and never mentions", () => {
  const result = json(buildRegearPanel([content, { ...content, regearContentId: "later", name: "@everyone **Later**", contentAt: new Date("2026-09-10T12:30Z") }, { ...content, regearContentId: "earlier", name: "Earlier", contentAt: undefined }], "current"));
  const text = result.components[0].components[0].content;
  assert.ok(text.indexOf("Later") < text.indexOf("Reset Day"));
  assert.match(text, /10 September 2026 • 12:30 UTC/);
  assert.ok(text.endsWith("- Earlier • Asia • 10 September 2026"));
  assert.ok(!text.includes("@everyone"));
  assert.deepEqual(result.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  const buttons = json(buildRegearPanel([], "current")).components[0].components.at(-1).components;
  assert.deepEqual(buttons.map((b: any) => [b.label, b.disabled]), [["REGEAR ME", true], ["My Re-gears", undefined]]);
});

test("re-gear public overflow exposes a complete private paged list without changing its panel", async () => {
  const f = fixture();
  const contents = Array.from({ length: 75 }, (_, i) => ({ ...content, regearContentId: `c${i}`, name: `${String(i).padStart(2, "0")} ${"Long name ".repeat(9)}` }));
  f.setContents(contents);
  const result = json(buildRegearPanel(contents, "current"));
  assert.match(result.components[0].components[0].content, /… and \d+ more\.$/);
  assert.equal(result.components[0].components.at(-1).components.at(-1).label, "View All Content");
  await f.controller.handle(f.interaction("entry-panel:regears:current:list"));
  const id = /regear-entry:([\w-]+):/.exec(JSON.stringify(f.replies.at(-1)))![1];
  const rows = new Set<string>();
  for (let page = 0; page < 8; page++) {
    const text = f.replies.at(-1).components[0].components[0].content;
    assert.ok(text.includes(`Page ${page + 1} of 8`));
    for (const line of text.split("\n")) if (line.startsWith("- ")) rows.add(line);
    if (page < 7) await f.controller.handle(f.interaction(`regear-entry:${id}:next`));
  }
  assert.equal(rows.size, 75);
});

test("/regearme preselects sole visible options and opens a fixed form, then submits once to the configured channel", async () => {
  const f = fixture(); const id = await f.open(true);
  const rows = f.replies.at(-1).components[0].components;
  assert.deepEqual(rows.slice(1, 3).map((r: any) => [r.components[0].placeholder, r.components[0].options[0].default]), [["Content", true], ["Character", true]]);
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  assert.equal(f.modals.length, 1);
  f.move(); // Ordinary movement changes panel identity, never configuration revision.
  await Promise.all([f.controller.handle(f.interaction(f.modals[0].custom_id, "modal")), f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"))]);
  assert.equal(f.claims.length, 1);
  assert.equal(f.claims[0].reviewChannelId, "configured-channel");
  assert.equal(f.sent.length, 1);
  assert.ok(f.replies.some(r => JSON.stringify(r).includes("Your re-gear request has been submitted.")));
});

for (const scenario of ["expire", "change", "clear", "timeout", "hide"] as const) {
  test(`re-gear form ${scenario} prevents submission after it opens`, async () => {
    const f = fixture(); const id = await f.open();
    await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
    f[scenario]();
    await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
    assert.equal(f.sent.length, 0); assert.equal(f.claims.length, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), scenario === "timeout" ? /Action Unavailable/ : /Start Again/);
  });
}

test("re-gear content closure and changed character ownership are rechecked at form submission", async () => {
  for (const change of ["content", "owner"]) {
    const f = fixture(); const id = await f.open();
    await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
    if (change === "content") f.setContents([{ ...content, state: "closed" }]); else f.setCharacters([]);
    await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
    assert.equal(f.claims.length, 0); assert.equal(f.sent.length, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), change === "content" ? /That content is no longer open for re-gear requests. Choose another content item./ : /The selected character must still be registered to you/);
  }
});

test("re-gear setup cannot be used by another member and selections freeze once the form opens", async () => {
  const f = fixture(); const id = await f.open();
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`, "button", "other"));
  assert.equal(f.modals.length, 0);
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  const late = f.interaction(`regear-entry:${id}:character`, "select"); late.values = ["other"];
  await f.controller.handle(late);
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.equal(f.claims[0].albionCharacterId, "character-1");
});

test("timed-out members can still read private history and cancelled setup cannot be resumed", async () => {
  const f = fixture(); const id = await f.open();
  await f.controller.handle(f.interaction(`regear-entry:${id}:cancel`));
  assert.match(JSON.stringify(f.replies.at(-1)), /No changes were made./);
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  f.timeout();
  await f.controller.handle(f.interaction("entry-panel:regears:current:history"));
  assert.match(JSON.stringify(f.replies.at(-1)), /No Pending or Accepted re-gear requests/);
});

test("re-gear setup selects the Albion Online server first and then shows only its eligible content and characters", async () => {
  const f = fixture();
  f.setContents([content, { ...content, albionServer: "europe", regearContentId: "europe-content", name: "Europe Content" }]);
  f.setCharacters([character, { ...character, albionServer: "europe", albionCharacterId: "europe-character", characterName: "Europe Example" }] as never);
  const id = (await f.open())!;
  const rows = f.replies.at(-1).components[0].components;
  assert.equal(rows[0].content, "# Choose Re-gear Server\n\nChoose the Albion Online server for this request.");
  assert.equal(rows[1].components[0].placeholder, "Albion Online Server");
  assert.deepEqual(rows[1].components[0].options.map((o: any) => o.value), ["asia", "europe"]);
  const selection = f.interaction(`regear-entry:${id}:server`, "select"); selection.values = ["europe"];
  await f.controller.handle(selection);
  const scoped = f.replies.at(-1).components[0].components;
  assert.deepEqual(scoped.slice(1, 3).map((r: any) => r.components[0].options.map((o: any) => o.value)), [["europe-content"], ["europe-character"]]);
  assert.ok(scoped.slice(1, 3).every((r: any) => r.components[0].options[0].default));
});

test("re-gear entry reports an unset channel and has the exact no-eligible-content state", async () => {
  const f = fixture(); f.setCharacters([]); await f.open();
  assert.equal(f.replies.at(-1).content, "No re-gear content available. You need a registered Albion Online character with active member-group membership on an Albion Online server that has open re-gear content.");
  f.clear(); await f.open(true);
  assert.equal(f.replies.at(-1).content, "Re-gears Channel Not Configured: Ask a Discord Administrator to configure this feature’s channel.");
});

test("an overlapping server selection cannot change the frozen re-gear form", async () => {
  const f = fixture();
  f.setContents([content, { ...content, albionServer: "europe", regearContentId: "europe-content" }]);
  f.setCharacters([character, { ...character, albionServer: "europe", albionCharacterId: "europe-character" }] as never);
  const id = (await f.open())!;
  const asia = f.interaction(`regear-entry:${id}:server`, "select"); asia.values = ["asia"]; await f.controller.handle(asia);
  const original = f.entries.checkAccess;
  let release!: () => void, reached!: () => void, checks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paused = new Promise<void>(resolve => { reached = resolve; });
  f.entries.checkAccess = async (i, feature, options) => {
    if ("customId" in i && i.customId.endsWith(":continue") && ++checks === 2) { reached(); await gate; }
    return original(i, feature, options);
  };
  const opening = f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  await paused;
  const europe = f.interaction(`regear-entry:${id}:server`, "select"); europe.values = ["europe"]; await f.controller.handle(europe);
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  release(); await opening;
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.equal(f.claims[0].albionServer, "asia");
  assert.equal(f.claims[0].albionCharacterId, "character-1");
});

test("re-gear opens, selections and uploads acknowledge before slow access checks", async () => {
  const f = fixture(); const original = f.entries.checkAccess;
  f.entries.checkAccess = async (i, feature, options) => {
    if (!("customId" in i) || !i.customId.endsWith(":continue")) assert.equal(i.deferred, true);
    return original(i, feature, options);
  };
  const id = await f.open(true); await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.equal(f.claims.length, 1);
});

test("a dismissed re-gear form can reopen and only its replacement version can submit", async () => {
  const f = fixture(); const id = await f.open();
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  assert.equal(f.modals.length, 2);
  assert.notEqual(f.modals[0].custom_id, f.modals[1].custom_id);
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  assert.equal(f.sent.length, 0);
  await f.controller.handle(f.interaction(f.modals[1].custom_id, "modal"));
  assert.equal(f.claims.length, 1);
});

test("a dismissed re-gear form can be cancelled even after a timeout is imposed", async () => {
  const f = fixture(); const id = await f.open();
  await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
  f.timeout();
  await f.controller.handle(f.interaction(`regear-entry:${id}:cancel`));
  assert.match(JSON.stringify(f.replies.at(-1)), /Cancelled.*No changes were made/);
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  assert.equal(f.sent.length, 0);
});

for (const invalidation of ["stop", "reset", "expiry"] as const) {
  test(`re-gear ${invalidation} during reviewer lookup prevents publishing evidence`, async () => {
    const f = fixture(); const id = await f.open();
    await f.controller.handle(f.interaction(`regear-entry:${id}:continue`));
    f.repository.listReviewerRoleIds = async () => {
      if (invalidation === "stop") f.controller.stop();
      else if (invalidation === "reset") f.controller.invalidateGuild("guild");
      else f.expire();
      return [];
    };
    await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
    assert.equal(f.sent.length, 0);
    assert.equal(f.claims.length, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  });
}
