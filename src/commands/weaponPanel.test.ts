import { ChannelType, ComponentType, PermissionFlagsBits } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { SpecialisationOperationError } from "../db/specialisationRepository.js";
import { createEntryPanelContext } from "../services/entryPanels/access.js";
import { SPECIALISATION_CATALOGUE, catalogueByKey } from "../services/specialisations/catalogue.js";
import { messageDescription, messageSummary } from "../testSupport/messageAssertions.js";
import { buildWeaponEntryModal, buildWeaponPanel, createWeaponPanelInteractions } from "./weaponPanel.js";

const character = { discordGuildId: "guild", discordUserId: "owner", albionServer: "asia" as const, albionCharacterId: "character-1", characterName: "Example" };
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
function fixture() {
  let now = Date.now(), revision = "revision", configured = true, canonical = true, timeout = 0, visible = true, administrator = false;
  let characters = [character];
  let excluded = new Set<string>();
  let active: any[] = [], pending: any[] = [];
  const replies: any[] = [], modals: any[] = [], reserved: any[] = [], sent: any[] = [];
  const memberRoles = new Map<string, object>();
  const member = { user: { bot: false }, get communicationDisabledUntilTimestamp() { return timeout; }, roles: { cache: memberRoles }, permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.Administrator && administrator } };
  const review = { id: "review", attachments: new Map(), components: [{ type: ComponentType.Container, components: [{ type: ComponentType.MediaGallery, items: [
    { description: "Weapon specialisation proof", media: { id: "proof", url: "https://cdn.test/proof.png", content_type: "image/png" } }
  ] }] }], edit: async () => undefined, delete: async () => undefined };
  const channel = { id: "configured-channel", type: ChannelType.GuildText, permissionsFor: (who: unknown) => ({ has: () => who === member ? visible : true }), isSendable: () => true, isTextBased: () => true, isThread: () => false,
    messages: { fetch: async () => review }, send: async (payload: unknown) => { sent.push(payload); return review; } };
  const roles = new Map(["asia-role", "europe-role"].map(id => [id, { id, managed: false, mentionable: true }]));
  const guild = { id: "guild", channels: { fetch: async () => channel }, members: { me: {}, fetch: async () => member }, roles: { cache: roles, fetch: async (id: string) => roles.get(id) } };
  const entries = createEntryPanelContext({
    repository: { getChannel: async () => configured ? ({ discordChannelId: channel.id, configurationRevision: revision }) : undefined } as never,
    runExclusive: async (_guild: string, operation: () => Promise<any>) => operation(), refresh: async () => undefined,
    isGuildActive: async () => true, hasRegisteredCharacter: async () => true, isCurrentPanel: async () => canonical, captureFence: () => () => true
  });
  const reviewerRepository = { effectiveRoleIds: async () => ["asia-role", "europe-role"] };
  let receiptFailure = false;
  const repository = {
    listEligibleCharacters: async (_g: string, owner: string) => characters.filter(c => c.discordUserId === owner),
    getEligibleCharacter: async (_g: string, owner: string, server: string, id: string) => characters.find(c => c.discordUserId === owner && c.albionServer === server && c.albionCharacterId === id),
    exclusionKeys: async () => excluded,
    listSpecialisations: async () => active,
    listSpecialisationsForOwner: async () => active,
    listRequests: async (_g: string, filters: any) => pending.filter(p => !filters.albionServer || p.albionServer === filters.albionServer),
    reserveRequest: async (input: any) => {
      if (active.some(a => a.targetKey === input.target.key)) throw new SpecialisationOperationError("active_exists");
      reserved.push(input); return { ...input, specialisationRequestId: "request", characterName: "Example", targetKey: input.target.key, targetKind: input.kind, targetDisplayName: input.target.name, state: "pending" };
    },
    attachReviewMessage: async (_g: string, request: string, message: string) => ({ ...reserved.at(-1), specialisationRequestId: request, reviewMessageId: message }),
    deleteUnattachedPendingRequest: async () => undefined
  };
  const controller = createWeaponPanelInteractions({ entries, repository: repository as never, membershipRepository: { listRegisteredCharacters: async () => characters } as never, reviewerRepository: reviewerRepository as never, logger: { info() {}, warn() {}, error() {}, debug() {} }, now: () => now });
  function interaction(id: string, kind = "button", owner = "owner"): any {
    return {
      customId: id, guildId: "guild", guild, channelId: "origin-channel", message: { id: "panel" }, user: { id: owner, bot: false }, member,
      inCachedGuild: () => true, isChatInputCommand: () => false, isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal",
      replied: false, deferred: false,
      async reply(payload: unknown) { this.replied = true; replies.push(json(payload)); }, async followUp(payload: unknown) { replies.push(json(payload)); },
      async update(payload: unknown) { replies.push(json(payload)); }, async deferReply() { this.deferred = true; }, async deferUpdate() { this.deferred = true; }, async editReply(payload: unknown) { replies.push(json(payload)); if (receiptFailure) throw new Error("receipt expired"); },
      async showModal(modal: any) { modals.push(modal.toJSON()); },
      fields: { getUploadedFiles: () => new Map([["proof", { name: "proof.png", url: "https://cdn.test/proof.png", contentType: "image/png" }]]) }, values: []
    };
  }
  async function open(kind = "weapon") { await controller.handle(interaction(`entry-panel:specialisation:current:${kind}`)); return /weapon-entry:([\w-]+):/.exec(JSON.stringify(replies.at(-1)))?.[1]; }
  async function select(id: string, action: string, value: string) { const i = interaction(`weapon-entry:${id}:${action}`, "select"); i.values = [value]; await controller.handle(i); }
  async function form(kind = "weapon") { const id = (await open(kind))!; await select(id, "tree", "tree:axe"); if (kind === "weapon") await select(id, "weapon", "weapon:battleaxe"); await controller.handle(interaction(`weapon-entry:${id}:continue`)); return id; }
  return { controller, entries, repository, replies, modals, reserved, sent, interaction, open, select, form,
    setCharacters: (value: typeof characters) => { characters = value; }, setExcluded: (value: string[]) => { excluded = new Set(value); }, setActive: (value: any[]) => { active = value; }, setPending: (value: any[]) => { pending = value; },
    reviewer: () => { memberRoles.set("asia-role", {}); }, admin: () => { administrator = true; }, receiptFailure: () => { receiptFailure = true; },
    expire: () => { now += 15 * 60_000; }, move: () => { canonical = false; }, change: () => { revision = "changed"; }, clear: () => { configured = false; }, timeout: () => { timeout = Date.now() + 60_000; }, hide: () => { visible = false; }
  };
}

test("weapon panel has the exact headings, ordered labels, styles, and silent mentions", () => {
  const panel = json(buildWeaponPanel("current"));
  const children = panel.components[0].components;
  assert.equal(children[0].content, "# Weapon Specialisation\n\nSubmit screenshot proof of a weapon at 100 or a weapon tree at 800, or view your confirmed specialisations.\n\n**Everyone**");
  assert.deepEqual(children[1].components.map((b: any) => [b.label, b.style]), [["Weapon 100", 1], ["Tree 800", 1], ["My Specialisations", 2]]);
  assert.equal(children[2].content, "**Managers**");
  assert.deepEqual(children[3].components.map((b: any) => [b.label, b.style]), [["Pending Requests", 2]]);
  assert.deepEqual(panel.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
});

test("weapon forms fix the selected character and target and require exactly one image", () => {
  for (const key of ["weapon:battleaxe", "tree:axe"]) {
    const modal = buildWeaponEntryModal("weapon-entry:draft:submit", character, catalogueByKey.get(key)!).toJSON();
    assert.equal(modal.title, key.startsWith("weapon") ? "Submit Weapon 100" : "Submit Tree 800");
    assert.equal(modal.components[0].type, ComponentType.TextDisplay);
    const label = modal.components[1] as any;
    assert.equal(label.label, "Proof Screenshot");
    assert.equal(label.description, "Upload one screenshot showing the selected specialisation.");
    assert.equal(label.component.type, ComponentType.FileUpload);
    assert.equal(label.component.min_values, 1); assert.equal(label.component.max_values, 1);
  }
});

test("a disabled 800 tree remains an available Weapon 100 family filter and targets require explicit selection", async () => {
  const f = fixture(); f.setExcluded(SPECIALISATION_CATALOGUE.filter(e => e.key !== "weapon:battleaxe").map(e => e.key));
  const id = (await f.open())!;
  const children = f.replies.at(-1).components[0].components;
  assert.equal(children[1].components[0].options[0].default, true);
  assert.equal(children[2].components[0].options[0].value, "tree:axe");
  assert.equal(children[2].components[0].options[0].default, false);
  assert.equal(children.at(-1).components[0].disabled, true);
  await f.select(id, "tree", "tree:axe");
  const weapons = f.replies.at(-1).components[0].components[3].components[0].options;
  assert.deepEqual(weapons.map((w: any) => [w.value, w.default]), [["weapon:battleaxe", false]]);
});

test("parent changes clear the weapon choice, while an active or Pending tree blocks its family", async () => {
  const f = fixture(); const id = (await f.open())!;
  await f.select(id, "tree", "tree:axe"); await f.select(id, "weapon", "weapon:battleaxe");
  await f.select(id, "tree", "tree:sword");
  assert.equal(f.replies.at(-1).components[0].components.at(-1).components[0].disabled, true);
  f.setActive([{ targetKind: "tree", targetKey: "tree:axe" }]);
  const other = (await f.open())!;
  const trees = f.replies.at(-1).components[0].components[2].components[0].options;
  assert.ok(!trees.some((t: any) => t.value === "tree:axe"));
  f.setActive([]); f.setPending([{ albionServer: "asia", targetKind: "tree", targetKey: "tree:axe" }]);
  await f.open();
  assert.ok(!f.replies.at(-1).components[0].components[2].components[0].options.some((t: any) => t.value === "tree:axe"));
});

test("Tree 800 excludes a Pending individual weapon's family and empty character or target states are exact", async () => {
  const f = fixture(); f.setPending([{ albionServer: "asia", targetKind: "weapon", targetKey: "weapon:battleaxe" }]);
  await f.open("tree");
  assert.ok(!f.replies.at(-1).components[0].components[2].components[0].options.some((t: any) => t.value === "tree:axe"));
  f.setExcluded(SPECIALISATION_CATALOGUE.map(e => e.key)); await f.open();
  assert.equal(f.replies.at(-1).content, "There are no available weapon specialisations to submit for this selection.");
  f.setCharacters([]); await f.open();
  assert.equal(f.replies.at(-1).content, "You need a registered Albion Online character with active member-group membership to submit proof.");
});

test("weapon submission survives ordinary panel movement, freezes its target, and consumes duplicate forms once", async () => {
  const f = fixture(); const id = await f.form();
  assert.equal(f.modals.length, 1);
  await f.select(id, "tree", "tree:sword"); assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  f.move();
  await Promise.all([f.controller.handle(f.interaction(f.modals[0].custom_id, "modal")), f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"))]);
  assert.equal(f.reserved.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.reserved[0].target.key, "weapon:battleaxe"); assert.equal(f.reserved[0].reviewChannelId, "configured-channel");
  assert.ok(f.replies.some(r => JSON.stringify(r).includes("Your weapon specialisation request has been submitted.")));
});

for (const scenario of ["expire", "change", "clear", "timeout", "hide"] as const) {
  test(`weapon form ${scenario} prevents submission after it opens`, async () => {
    const f = fixture(); await f.form(); f[scenario]();
    await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
    assert.equal(f.sent.length, 0); assert.equal(f.reserved.length, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), scenario === "timeout" ? /Action Unavailable/ : /Start Again/);
  });
}

test("weapon form rechecks catalogue exclusion, ownership, and confirmed records at submission", async () => {
  for (const change of ["catalogue", "owner", "record"]) {
    const f = fixture(); await f.form();
    if (change === "catalogue") f.setExcluded(["weapon:battleaxe"]);
    else if (change === "owner") f.setCharacters([]);
    else f.setActive([{ targetKey: "weapon:battleaxe", targetKind: "weapon" }]);
    await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
    assert.equal(f.reserved.length, 0); assert.equal(f.sent.length, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), change === "catalogue" ? /Choose an enabled target from autocomplete/ : change === "owner" ? /Choose one of your actively managed registered characters/ : /That character already has this active specialisation/);
  }
});

test("weapon receipt failure does not remove the completed proof request", async () => {
  const f = fixture(); await f.form(); f.receiptFailure();
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.equal(f.reserved.length, 1); assert.equal(f.sent.length, 1);
});

test("Pending Requests requires current reviewer authority and includes all Albion Online servers", async () => {
  const f = fixture();
  await f.controller.handle(f.interaction("entry-panel:specialisation:current:pending"));
  assert.equal(messageSummary(f.replies.at(-1)), "You need a weapon specialisation manager role or Discord Administrator permission to view this queue.");
  assert.equal(messageDescription(f.replies.at(-1)), "You need a weapon specialisation manager role or Discord Administrator permission to view this queue.");
  f.reviewer();
  f.setPending([
    { albionServer: "asia", characterName: "AsiaCharacter", targetDisplayName: "Battleaxe", reviewChannelId: "original-channel", reviewMessageId: "asia-review" },
    { albionServer: "europe", characterName: "EuropeCharacter", targetDisplayName: "Battleaxe", reviewChannelId: "other-channel", reviewMessageId: "europe-review" }
  ]);
  await f.controller.handle(f.interaction("entry-panel:specialisation:current:pending"));
  assert.match(JSON.stringify(f.replies.at(-1)), /AsiaCharacter/); assert.match(JSON.stringify(f.replies.at(-1)), /EuropeCharacter/);
  f.setPending([]); await f.controller.handle(f.interaction("entry-panel:specialisation:current:pending"));
  assert.equal(messageDescription(f.replies.at(-1)), "No pending weapon specialisation requests.");
});

test("personal specialisations remain private and available during timeout", async () => {
  const f = fixture(); f.timeout(); f.setCharacters([]);
  await f.controller.handle(f.interaction("entry-panel:specialisation:current:history"));
  assert.equal(messageDescription(f.replies.at(-1)), "You have no registered Albion Online characters.");
});

test("an overlapping Character change cannot replace the frozen character while Continue opens a form", async () => {
  const f = fixture();
  f.setCharacters([character, { ...character, albionCharacterId: "character-2", characterName: "Second" }]);
  const id = (await f.open())!;
  await f.select(id, "character", "asia:character-1"); await f.select(id, "tree", "tree:axe"); await f.select(id, "weapon", "weapon:battleaxe");
  const originalAccess = f.entries.checkAccess;
  let release!: () => void, reached!: () => void, checks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paused = new Promise<void>(resolve => { reached = resolve; });
  f.entries.checkAccess = async (i, feature, options) => {
    if ("customId" in i && i.customId.endsWith(":continue") && ++checks === 2) { reached(); await gate; }
    return originalAccess(i, feature, options);
  };
  const opening = f.controller.handle(f.interaction(`weapon-entry:${id}:continue`));
  await paused;
  await f.select(id, "character", "asia:character-2");
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  release(); await opening;
  assert.match(JSON.stringify(f.modals[0]), /Example/);
  assert.doesNotMatch(JSON.stringify(f.modals[0]), /Second/);
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.equal(f.reserved[0].albionCharacterId, "character-1");
});

test("weapon opens, selections and uploads acknowledge before slow access checks", async () => {
  const f = fixture(); const original = f.entries.checkAccess;
  f.entries.checkAccess = async (i, feature, options) => {
    if (!("customId" in i) || !i.customId.endsWith(":continue")) assert.equal(i.deferred, true);
    return original(i, feature, options);
  };
  await f.form(); await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.equal(f.reserved.length, 1);
});

test("a dismissed weapon form can reopen and only its replacement version can submit", async () => {
  const f = fixture(); const id = await f.form();
  await f.controller.handle(f.interaction(`weapon-entry:${id}:continue`));
  assert.equal(f.modals.length, 2);
  assert.notEqual(f.modals[0].custom_id, f.modals[1].custom_id);
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  assert.equal(f.sent.length, 0);
  await f.controller.handle(f.interaction(f.modals[1].custom_id, "modal"));
  assert.equal(f.reserved.length, 1);
});

test("a dismissed weapon form can be cancelled even after a timeout is imposed", async () => {
  const f = fixture(); const id = await f.form(); f.timeout();
  await f.controller.handle(f.interaction(`weapon-entry:${id}:cancel`));
  assert.match(JSON.stringify(f.replies.at(-1)), /Cancelled.*No changes were made/);
  await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
  assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  assert.equal(f.sent.length, 0);
});

for (const invalidation of ["stop", "reset", "expiry"] as const) {
  test(`weapon ${invalidation} during reservation removes the reservation without publishing proof`, async () => {
    const f = fixture(); await f.form();
    const reserve = f.repository.reserveRequest;
    let removed = 0;
    f.repository.reserveRequest = async input => {
      const request = await reserve(input);
      if (invalidation === "stop") f.controller.stop();
      else if (invalidation === "reset") f.controller.invalidateGuild("guild");
      else f.expire();
      return request;
    };
    f.repository.deleteUnattachedPendingRequest = async () => { removed++; };
    await f.controller.handle(f.interaction(f.modals[0].custom_id, "modal"));
    assert.equal(f.reserved.length, 1);
    assert.equal(removed, 1);
    assert.equal(f.sent.length, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), /Start Again/);
  });
}
