import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { deleteApplicationChannel } from "./deleteService.js";

test("deletion service authorizes reviewer role and requires a closed application", async () => {
  const denied = fixture({ roles: ["administrator"] });
  assert.equal((await deleteApplicationChannel(denied.input)).kind, "error");
  assert.deepEqual(denied.events, []);

  const open = fixture({ status: "open" });
  const result = await deleteApplicationChannel(open.input);
  assert.deepEqual(result, { kind: "error", title: "Close Channel First", description: "This application channel must be closed before it can be deleted." });
  assert.deepEqual(open.events, []);
});

test("deletion service deletes Discord first, preserves closed state on failure, and handles listener races", async () => {
  const failed = fixture({ deleteError: new Error("Missing Permissions") });
  await assert.rejects(() => deleteApplicationChannel(failed.input), /Missing Permissions/);
  assert.deepEqual(failed.events, ["delete"]);

  const raced = fixture({ markReturnsUndefined: true });
  assert.deepEqual(await deleteApplicationChannel(raced.input), { kind: "deleted", channelName: "application-ticket" });
  assert.deepEqual(raced.events, ["delete", "mark", "reload"]);
});

function fixture(options: { roles?: string[]; status?: "open" | "closed"; deleteError?: Error; markReturnsUndefined?: boolean }) {
  const events: string[] = [];
  const open = {
    applicationId: "application", applicationClassId: "class", discordGuildId: "guild", applicantDiscordUserId: "applicant",
    ticketChannelId: "channel", status: options.status ?? "closed", channelStatus: options.status ?? "closed"
  };
  const channel = {
    id: "channel", name: "application-ticket", type: ChannelType.GuildText,
    delete: async () => { events.push("delete"); if (options.deleteError) throw options.deleteError; }
  };
  const repository = {
    getOpenApplication: async () => { if (events.includes("mark")) events.push("reload"); return events.includes("mark") ? { ...open, channelStatus: "deleted" } : open; },
    getApplicationClass: async () => ({ reviewerRoleId: "reviewer" }),
    markApplicationDeleted: async () => { events.push("mark"); return options.markReturnsUndefined ? undefined : { ...open, channelStatus: "deleted" }; }
  };
  return {
    events,
    input: {
      guild: { channels: { cache: new Map([["channel", channel]]), fetch: async () => channel } } as never,
      guildId: "guild", applicationId: "application", actor: { userId: "reviewer", roleIds: new Set(options.roles ?? ["reviewer"]) },
      applicationRepository: repository as never, channel: channel as never
    }
  };
}
