import { ButtonStyle, Collection, ComponentType, MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { GiveawayRecord, GiveawayWinner } from "../db/giveawayRepository.js";
import type { EntryInteraction, EntryPanelContext } from "../services/entryPanels/types.js";
import { buildNextUtcDateChoices } from "../services/scheduling.js";
import { v2Title } from "../testSupport/messageAssertions.js";
import { buildGiveawayHostModal, buildGiveawayPanel, createGiveawayPanelInteractions, type GiveawayPanelDependencies } from "./giveawayPanel.js";

type JSONComponent = { type: number; custom_id?: string; label?: string; content?: string; placeholder?: string; style?: number; disabled?: boolean; components?: JSONComponent[]; options?: Array<{ label: string; value: string; default?: boolean }> };
type Payload = { content?: string; flags?: number; components?: Array<{ toJSON(): JSONComponent }>; embeds?: Array<{ toJSON(): { title?: string } }> };
function components(payload: Payload): JSONComponent[] {
  const all: JSONComponent[] = [];
  const visit = (c: JSONComponent) => { all.push(c); for (const child of c.components ?? []) visit(child); };
  for (const c of payload.components ?? []) visit(c.toJSON());
  return all;
}
function text(payload: Payload) { if (typeof payload.content === "string") return payload.content; return components(payload).map((c) => c.content ?? "").filter(Boolean).join("\n"); }
function control(payload: Payload, label: string) {
  const found = components(payload).find((c) => c.label === label || c.placeholder === label);
  assert.ok(found, `Missing ${label}: ${JSON.stringify(components(payload))}`);
  return found;
}
function record(overrides: Partial<GiveawayRecord> = {}): GiveawayRecord {
  return { giveawayId: "g1", discordGuildId: "guild", channelId: "channel", originalMessageId: "message", creatorDiscordUserId: "owner", title: "Founder Pack", description: "Win the prize.", drawAt: new Date(Date.now() + 48 * 3600_000), winnerCount: 1, state: "open", createdAt: new Date(), ...overrides };
}

function harness(initial: GiveawayRecord[] = []) {
  let now = Date.now();
  let registered = true;
  let timedOut = false;
  let configured = true;
  let selection = { discordChannelId: "channel", configurationRevision: "revision" };
  let generation = "current";
  let locked = false;
  const records = initial;
  const sent: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const reactions: string[] = [];
  let deleted = 0;
  let drawCalls = 0;
  let cancelCalls = 0;
  let rerollCalls = 0;
  let roleChecks = 0;
  let refreshCalls = 0;
  let missingMessage = false;
  let replacements: "" | undefined | { replacementDiscordUserId: string; notificationPublished: boolean } = { replacementDiscordUserId: "replacement", notificationPublished: true };
  let winners: GiveawayWinner[] = [];
  const member = { user: { id: "owner", bot: false }, displayName: "Owner", permissions: { has: () => true } };
  const channel = {
    id: "channel", permissionsFor: () => ({ has: () => true }),
    send: async (payload: Record<string, unknown>) => {
      sent.push(payload);
      return { id: `published-${sent.length}`, url: `https://discord.com/channels/guild/channel/published-${sent.length}`, react: async (emoji: string) => { reactions.push(emoji); }, delete: async () => { deleted++; } };
    }
  };
  const guild = { id: "guild", members: { me: member, cache: new Map(), fetch: async () => member }, roles: { fetch: async (id: string) => ({ id, mentionable: true }) } };
  const repository = {
    listOpen: async () => records.filter((g) => g.state === "open"),
    listHostHistory: async (_guild: string, owner: string) => records.filter((g) => g.creatorDiscordUserId === owner),
    getById: async (_guild: string, id: string) => records.find((g) => g.giveawayId === id),
    listWinners: async () => winners,
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      const g = record({ ...input, giveawayId: `new-${created.length}` } as Partial<GiveawayRecord>);
      records.push(g);
      return g;
    }
  } as unknown as GiveawayPanelDependencies["repository"];
  async function deny(i: EntryInteraction, reason: string) {
    const payload = { components: [], content: reason } as never;
    if (i.replied || i.deferred) await i.editReply(payload); else await i.reply(payload);
  }
  const entries = {
    checkAccess: async (i: EntryInteraction, _feature: string, options: { mutation?: boolean; expected?: typeof selection; generation?: string } = {}) => {
      if (!configured || (options.expected && (options.expected.configurationRevision !== selection.configurationRevision || options.expected.discordChannelId !== selection.discordChannelId)) || (options.generation && options.generation !== generation)) { await deny(i, "Start Again"); return undefined; }
      if (!registered) { await deny(i, "Registration Required"); return undefined; }
      if (options.mutation && timedOut) { await deny(i, "Timed Out"); return undefined; }
      return { ...selection, channel, member };
    },
    requireRole: async () => { roleChecks++; assert.fail("Giveaway controls must not require a configured hosting role"); },
    runExclusive: async (_guild: string, operation: () => Promise<unknown>) => { assert.equal(locked, false); locked = true; try { return await operation(); } finally { locked = false; } },
    refresh: async () => { assert.equal(locked, false, "Refresh must happen after releasing the configuration lock"); refreshCalls++; }
  } as unknown as EntryPanelContext;
  const service = {
    draw: async (_guild: unknown, g: GiveawayRecord) => { drawCalls++; if (missingMessage) { g.state = "cancelled"; return "message_missing"; } g.state = "drawn"; g.drawnAt = new Date(now); return "drawn"; },
    cancel: async (_guild: unknown, g: GiveawayRecord) => { cancelCalls++; g.state = "cancelled"; g.cancelledAt = new Date(now); return "cancelled"; },
    reroll: async () => { rerollCalls++; return replacements; }
  } as unknown as GiveawayPanelDependencies["service"];
  const panel = createGiveawayPanelInteractions({ repository, entries, logger: { info() {}, warn() {}, error() {} } as never, now: () => now, service });
  function interaction(kind: "button" | "select" | "role" | "modal", id: string, values: string[] = [], options: { owner?: string; fields?: Record<string, string>; files?: Array<Record<string, string>>; failReceipt?: boolean } = {}) {
    const payloads: Array<Payload & { content?: string }> = [];
    const modals: Array<{ toJSON(): ReturnType<typeof JSON.parse>; data: { custom_id?: string } }> = [];
    const i = {
      customId: id, channelId: "channel", guildId: "guild", guild, user: { id: options.owner ?? "owner", bot: false }, message: { id: "public-message" }, values,
      client: { users: { cache: new Map() } }, deferred: false, replied: false,
      isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isRoleSelectMenu: () => kind === "role", isModalSubmit: () => kind === "modal", inCachedGuild: () => true,
      fields: { getTextInputValue: (name: string) => options.fields?.[name] ?? ({ title: "New Prize", description: "A good prize.", time: "24:00" } as Record<string, string>)[name], getUploadedFiles: () => new Collection((options.files ?? []).map((f, index) => [String(index), f])) },
      deferReply: async ({ flags }: { flags: number }) => { assert.equal(flags, MessageFlags.Ephemeral); i.deferred = true; },
      deferUpdate: async () => { i.deferred = true; },
      reply: async (payload: Payload) => { i.replied = true; payloads.push(payload); },
      editReply: async (payload: Payload) => { if (options.failReceipt && v2Title(payload) === "Giveaway Created") throw new Error("Receipt lost"); payloads.push(payload); },
      showModal: async (modal: typeof modals[number]) => { i.replied = true; modals.push(modal); }
    };
    return { i: i as unknown as EntryInteraction, payloads, modals, last: () => { assert.ok(payloads.length); return payloads.at(-1)!; } };
  }
  async function act(kind: Parameters<typeof interaction>[0], id: string, values: string[] = [], options: Parameters<typeof interaction>[3] = {}) {
    const result = interaction(kind, id, values, options);
    assert.equal(await panel.handle(result.i), true);
    return result;
  }
  async function open(kind: "host" | "mine" | "all") { return act("button", `entry-panel:giveaways:${generation}:${kind}`); }
  async function hostForm() {
    const start = await open("host");
    const date = await act("select", control(start.last(), "Draw Date (UTC)").custom_id!, [buildNextUtcDateChoices(new Date(now))[1].value]);
    const form = await act("button", control(date.last(), "Continue").custom_id!);
    return { modalId: form.modals[0].data.custom_id!, start, date, form };
  }
  return { panel, act, open, hostForm, interaction, records, sent, created, reactions,
    counts: () => ({ deleted, drawCalls, cancelCalls, rerollCalls, roleChecks, refreshCalls }),
    advance: (ms: number) => { now += ms; }, setRegistered: (v: boolean) => { registered = v; }, setTimeout: (v: boolean) => { timedOut = v; },
    move: () => { generation = "moved"; }, reconfigure: () => { selection = { ...selection, configurationRevision: "reconfigured" }; }, clear: () => { configured = false; },
    setWinners: (ids: string[]) => { winners = ids.map((id, index) => ({ giveawayWinnerId: `winner-${index}`, giveawayId: "g1", discordUserId: id, winnerPosition: index + 1, status: "current", selectedAt: new Date(now) })); },
    setReplacement: (value: typeof replacements) => { replacements = value; },
    setMissingMessage: () => { missingMessage = true; }
  };
}

test("public giveaway panel has exact empty and populated wording, order, styles, and silent mentions", () => {
  const empty = buildGiveawayPanel([], "one");
  assert.equal(text(empty.payload), "# Giveaways\n\nNo giveaways are open for entries.");
  assert.deepEqual(components(empty.payload).filter((c) => c.type === ComponentType.Button).map(({ label, style }) => ({ label, style })), [{ label: "Host Giveaway", style: ButtonStyle.Primary }, { label: "My Giveaways", style: ButtonStyle.Secondary }]);
  assert.deepEqual(empty.payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  const first = record({ title: "First", drawAt: new Date("2099-01-01T00:00:00Z") });
  const later = record({ giveawayId: "g2", title: "Later", winnerCount: 3, drawAt: new Date("2099-01-02T00:00:00Z") });
  const populated = buildGiveawayPanel([later, record({ state: "cancelled" }), first], "one");
  assert.equal(text(populated.payload), `# Giveaways\n\nOpen a giveaway below and react with 🎁 to enter.\n\n**Open Giveaways (2)**\n- [First](https://discord.com/channels/guild/channel/message) • draws <t:4070908800:R> • 1 winner • <@owner>\n- [Later](https://discord.com/channels/guild/channel/message) • draws <t:4070995200:R> • 3 winners • <@owner>`);
  assert.equal(populated.payload.flags, MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications);
});

test("public overflow uses whole rows and exact count; private pages retain every configured-channel giveaway", async () => {
  const records = Array.from({ length: 70 }, (_, index) => record({ giveawayId: `id-${index}`, title: `Prize ${index} ${"x".repeat(80)}` }));
  const publicPanel = buildGiveawayPanel(records, "one");
  assert.ok(publicPanel.overflow > 0);
  assert.match(text(publicPanel.payload), new RegExp(`… and ${publicPanel.overflow} more\\.$`));
  assert.equal(text(publicPanel.payload).split("\n").filter((line) => line.startsWith("- ")).length + publicPanel.overflow, records.length);
  assert.ok(text(publicPanel.payload).length <= 3800);
  assert.ok(control(publicPanel.payload, "View All Giveaways"));
  const h = harness([...records, record({ giveawayId: "other", title: "Wrong Channel", channelId: "old-channel" })]);
  let page = await h.open("all");
  const seen: string[] = [];
  for (;;) {
    seen.push(...text(page.last()).split("\n").filter((line) => line.startsWith("- ")));
    assert.match(text(page.last()), /Page \d+ of \d+/);
    const next = control(page.last(), "Next");
    if (next.disabled) break;
    page = await h.act("button", next.custom_id!);
  }
  assert.equal(seen.length, 70);
  assert.equal(new Set(seen).size, 70);
  assert.ok(seen.every((line) => !line.includes("Wrong Channel")));
  assert.equal(h.counts().refreshCalls, 0);
});

test("hosting modal has fixed context, exact labels/help, required limits, and one optional image", () => {
  const modal = buildGiveawayHostModal("giveaway-panel:test:submit:1", { date: "2099-01-01", winnerCount: 3, notificationRoleId: "role" }).toJSON();
  assert.equal(modal.title, "Create Giveaway");
  assert.equal(modal.components.length, 5);
  const [context, ...labels] = modal.components as Array<{ type: number; content?: string; label?: string; description?: string; component?: { type: number; max_length?: number; max_values?: number; required?: boolean } }>;
  assert.match(context.content!, /2099-01-01[\s\S]*3[\s\S]*<@&role>/);
  assert.deepEqual(labels.map(({ label, description }) => ({ label, description })), [
    { label: "Title", description: "Name the giveaway." },
    { label: "Description", description: "Describe the prize and any participation instructions." },
    { label: "Draw Time (UTC)", description: "Enter H, HH, H:MM, or HH:MM in UTC. 24:00 means the end of the selected date." },
    { label: "Image", description: "Optionally upload one giveaway image." }
  ]);
  assert.equal(labels[0].component?.max_length, 100);
  assert.equal(labels[1].component?.max_length, 4000);
  assert.equal(labels[3].component?.max_values, 1);
  assert.equal(labels[3].component?.required, false);
});

test("host setup defaults to one winner, supports clearing a role, and publishes once through a frozen replacement modal", async () => {
  const h = harness();
  const start = await h.open("host");
  assert.equal(text(start.last()), "# Host Giveaway\n\nChoose the draw date, number of winners, and optional notification role.");
  assert.equal(control(start.last(), "Winners").options?.find((o) => o.default)?.value, "1");
  assert.equal(control(start.last(), "Draw Date (UTC)").options?.length, 7);
  assert.equal(control(start.last(), "Continue").disabled, true);
  let setup = await h.act("select", control(start.last(), "Draw Date (UTC)").custom_id!, [buildNextUtcDateChoices()[1].value]);
  setup = await h.act("select", control(setup.last(), "Winners").custom_id!, ["3"]);
  setup = await h.act("role", control(setup.last(), "Notification Role").custom_id!, ["role"]);
  setup = await h.act("role", control(setup.last(), "Notification Role").custom_id!, []);
  const one = await h.act("button", control(setup.last(), "Continue").custom_id!);
  const replacement = await h.act("button", control(setup.last(), "Continue").custom_id!);
  const old = await h.act("modal", one.modals[0].data.custom_id!);
  assert.match(text(old.last()), /^(?:# )?Start Again/);
  const changed = await h.act("select", control(setup.last(), "Winners").custom_id!, ["5"]);
  assert.match(text(changed.last()), /^(?:# )?Start Again/);
  h.move();
  const first = h.interaction("modal", replacement.modals[0].data.custom_id!, [], { files: [{ name: "prize.png", url: "https://example.invalid/prize.png", contentType: "image/png" }] });
  const duplicate = h.interaction("modal", replacement.modals[0].data.custom_id!);
  await Promise.all([h.panel.handle(first.i), h.panel.handle(duplicate.i)]);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].winnerCount, 3);
  assert.equal(h.created[0].notificationRoleId, undefined);
  assert.equal(h.created[0].channelId, "channel");
  assert.deepEqual(h.reactions, ["🎁"]);
  assert.equal(v2Title(first.last()), "Giveaway Created");
  assert.match(text(duplicate.last()), /^(?:# )?Start Again/);
  assert.equal(h.counts().refreshCalls, 1);
});

test("failed private receipt preserves a published, saved giveaway and cannot be resubmitted", async () => {
  const h = harness();
  const { modalId } = await h.hostForm();
  await assert.rejects(h.act("modal", modalId, [], { failReceipt: true }), /Receipt lost/);
  assert.equal(h.created.length, 1);
  assert.equal(h.counts().deleted, 0);
  const retry = await h.act("modal", modalId);
  assert.match(text(retry.last()), /^(?:# )?Start Again/);
  assert.equal(h.sent.length, 1);
});

for (const event of ["expiry", "channel", "clear", "registration", "timeout", "restart", "reset"] as const) {
  test(`host draft cannot publish after ${event}`, async () => {
    const h = harness();
    const { modalId } = await h.hostForm();
    if (event === "expiry") h.advance(15 * 60_000);
    if (event === "channel") h.reconfigure();
    if (event === "clear") h.clear();
    if (event === "registration") h.setRegistered(false);
    if (event === "timeout") h.setTimeout(true);
    if (event === "restart") { h.panel.stop(); h.panel.start(); }
    if (event === "reset") h.panel.invalidateGuild("guild");
    await h.act("modal", modalId);
    assert.equal(h.created.length, 0);
    assert.equal(h.sent.length, 0);
  });
}

test("private controls belong to their owner and an incorrect owner cannot consume the host form", async () => {
  const h = harness();
  const { modalId } = await h.hostForm();
  const hostile = await h.act("modal", modalId, [], { owner: "other-user" });
  assert.match(text(hostile.last()), /^(?:# )?Start Again/);
  await h.act("modal", modalId);
  assert.equal(h.created.length, 1);
});

test("My Giveaways remains private and complete across channels without configured hosting roles", async () => {
  const records = Array.from({ length: 27 }, (_, index) => record({ giveawayId: `g-${index}`, title: `Title ${index}`, channelId: index === 26 ? "old-channel" : "channel", state: index > 23 ? "cancelled" : "open", cancelledAt: new Date() }));
  const h = harness([...records, record({ creatorDiscordUserId: "someone-else" })]);
  h.setTimeout(true);
  const first = await h.open("mine");
  assert.match(text(first.last()), /Page 1 of 2/);
  assert.equal(control(first.last(), "Giveaway").options?.length, 25);
  const next = await h.act("button", control(first.last(), "Next").custom_id!);
  assert.match(text(next.last()), /Page 2 of 2/);
  assert.equal(control(next.last(), "Giveaway").options?.length, 2);
  assert.match(control(next.last(), "Giveaway").options![1].label, /^Title 26 • Cancelled • \d{4}-\d{2}-\d{2}$/);
  const detail = await h.act("select", control(next.last(), "Giveaway").custom_id!, ["g-26"]);
  assert.match(text(detail.last()), /old-channel/);
  assert.match(text(detail.last()), /\*\*Cancelled\*\*[\s\S]*No winners were drawn\./);
  assert.deepEqual(components(detail.last()).filter((c) => c.type === ComponentType.Button).map((c) => c.label), ["Open Giveaway", "Back"]);
  assert.equal(h.counts().roleChecks, 0);
});

test("My Giveaways never allows another host's item even when it is selected manually", async () => {
  const h = harness([record(), record({ giveawayId: "other", creatorDiscordUserId: "someone-else" })]);
  const first = await h.open("mine");
  const hostile = await h.act("select", control(first.last(), "Giveaway").custom_id!, ["other"]);
  assert.match(text(hostile.last()), /^(?:# )?Start Again/);
  assert.equal(h.counts().drawCalls + h.counts().cancelCalls + h.counts().rerollCalls, 0);
});

test("private draw and cancel confirmations use exact wording and a retained host can draw only once", async () => {
  const h = harness([record()]);
  const start = await h.open("mine");
  let detail = await h.act("select", control(start.last(), "Giveaway").custom_id!, ["g1"]);
  assert.deepEqual(components(detail.last()).filter((c) => c.type === ComponentType.Button).map((c) => c.label), ["Open Giveaway", "Draw Now", "Cancel Giveaway", "Back"]);
  const cancel = await h.act("button", control(detail.last(), "Cancel Giveaway").custom_id!);
  assert.equal(text(cancel.last()), "# Cancel Giveaway\n\nCancel “Founder Pack”? No winners will be drawn.");
  detail = await h.act("button", control(cancel.last(), "Keep Giveaway").custom_id!);
  const draw = await h.act("button", control(detail.last(), "Draw Now").custom_id!);
  assert.equal(text(draw.last()), "# Draw Giveaway\n\nDraw “Founder Pack” now? This closes entries and selects the winners.");
  const drawn = await h.act("button", control(draw.last(), "Draw Now").custom_id!);
  await h.act("button", control(draw.last(), "Draw Now").custom_id!);
  assert.equal(h.counts().drawCalls, 1);
  assert.equal(h.counts().cancelCalls, 0);
  assert.match(text(drawn.last()), /\*\*Status\*\*\nDrawn/);
  assert.match(text(drawn.last()), /No eligible winners\./);
  assert.deepEqual(components(drawn.last()).filter((c) => c.type === ComponentType.Button).map((c) => c.label), ["Open Giveaway", "Reroll Winner", "Back"]);
});

test("scheduled closure invalidates a pending private early-draw confirmation", async () => {
  const g = record();
  const h = harness([g]);
  const start = await h.open("mine");
  const detail = await h.act("select", control(start.last(), "Giveaway").custom_id!, ["g1"]);
  const confirmation = await h.act("button", control(detail.last(), "Draw Now").custom_id!);
  g.state = "drawn";
  g.drawnAt = new Date();
  await h.act("button", control(confirmation.last(), "Draw Now").custom_id!);
  assert.equal(h.counts().drawCalls, 0);
});

test("a missing announcement reports the failed draw and refreshes the cancelled row", async () => {
  const h = harness([record()]);
  const list = await h.open("mine");
  const detail = await h.act("select", control(list.last(), "Giveaway").custom_id!, ["g1"]);
  const confirmation = await h.act("button", control(detail.last(), "Draw Now").custom_id!);
  h.setMissingMessage();
  const result = await h.act("button", control(confirmation.last(), "Draw Now").custom_id!);
  assert.equal(text(result.last()), "# Giveaway Not Drawn\n\nThe giveaway message is missing or the giveaway was already closed.");
  assert.equal(h.counts().refreshCalls, 1);
  assert.equal(h.records[0].state, "cancelled");
});

test("a stale confirmation for one giveaway cannot confirm a newer selection", async () => {
  const first = record();
  const second = record({ giveawayId: "g2", title: "Second Prize" });
  const h = harness([first, second]);
  const list = await h.open("mine");
  const firstDetail = await h.act("select", control(list.last(), "Giveaway").custom_id!, ["g1"]);
  const firstConfirmation = await h.act("button", control(firstDetail.last(), "Draw Now").custom_id!);
  const kept = await h.act("button", control(firstConfirmation.last(), "Keep Giveaway").custom_id!);
  const back = await h.act("button", control(kept.last(), "Back").custom_id!);
  const secondDetail = await h.act("select", control(back.last(), "Giveaway").custom_id!, ["g2"]);
  const secondConfirmation = await h.act("button", control(secondDetail.last(), "Draw Now").custom_id!);
  const stale = await h.act("button", control(firstConfirmation.last(), "Draw Now").custom_id!);
  assert.match(text(stale.last()), /^(?:# )?Start Again/);
  assert.equal(h.counts().drawCalls, 0);
  await h.act("button", control(secondConfirmation.last(), "Draw Now").custom_id!);
  assert.equal(h.counts().drawCalls, 1);
  assert.equal(first.state, "open");
  assert.equal(second.state, "drawn");
});

test("cancelling an open giveaway requires the confirmation and preserves its original location", async () => {
  const g = record({ channelId: "original-channel" });
  const h = harness([g]);
  const list = await h.open("mine");
  const detail = await h.act("select", control(list.last(), "Giveaway").custom_id!, ["g1"]);
  const confirmation = await h.act("button", control(detail.last(), "Cancel Giveaway").custom_id!);
  assert.equal(h.counts().cancelCalls, 0);
  const cancelled = await h.act("button", control(confirmation.last(), "Cancel Giveaway").custom_id!);
  assert.equal(h.counts().cancelCalls, 1);
  assert.equal(g.channelId, "original-channel");
  assert.equal(g.state, "cancelled");
  assert.match(text(cancelled.last()), /No winners were drawn\./);
  assert.deepEqual(components(cancelled.last()).filter((c) => c.type === ComponentType.Button).map((c) => c.label), ["Open Giveaway", "Back"]);
});

test("reroll selection has no side effect; confirmation keeps exact no-replacement response", async () => {
  const h = harness([record({ state: "drawn", drawnAt: new Date() })]);
  h.setWinners(["winner-one", "winner-two"]);
  h.setReplacement("");
  const start = await h.open("mine");
  const detail = await h.act("select", control(start.last(), "Giveaway").custom_id!, ["g1"]);
  assert.match(text(detail.last()), /<@winner-one> <@winner-two>/);
  const setup = await h.act("button", control(detail.last(), "Reroll Winner").custom_id!);
  assert.equal(text(setup.last()), "# Reroll Winner\n\nSelect the winner to replace.");
  assert.equal(control(setup.last(), "Reroll Winner").disabled, true);
  const selected = await h.act("select", control(setup.last(), "Winner").custom_id!, ["winner-two"]);
  assert.equal(h.counts().rerollCalls, 0);
  const result = await h.act("button", control(selected.last(), "Reroll Winner").custom_id!);
  assert.equal(h.counts().rerollCalls, 1);
  assert.equal(text(result.last()), "# No Replacement Available\n\nNo eligible participant remains who has not already won.");
});
