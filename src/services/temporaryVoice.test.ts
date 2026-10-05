import { createUnblockedMemberActionGuard } from "../testSupport/memberActionGuard.js";
import { createMemberActionGuard } from "../runtime/memberActionGuard.js";

test("blocked members cannot create or regain temporary voice ownership", async () => {
  const service = createTemporaryVoiceService({
    getConfig: async () => ({ baseChannelId: "base" }),
    getChannelByOwner: async () => assert.fail("blocked voice joins must not reuse or create a room")
  } as never, silentLogger, createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => true }));
  const guild = { id: "guild" };
  await service.handleVoiceStateUpdate({ guild, channelId: null } as never,
    { guild, channelId: "base", id: "blocked", member: { id: "blocked", user: { bot: false } } } as never);
});
import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
  type VoiceState
} from "discord.js";
import type { Logger } from "../logging/logger.js";
import type { TemporaryVoiceChannelRecord, TemporaryVoiceConfig } from "../db/temporaryVoiceRepository.js";
import {
  TEMPORARY_VOICE_OWNER_PERMISSIONS,
  buildTemporaryVoiceChannelName,
  createTemporaryVoiceService
} from "./temporaryVoice.js";

test("temporary voice names use only the server display name within the existing length limit", () => {
  assert.equal(buildTemporaryVoiceChannelName("Luke"), "Luke");
  assert.equal(buildTemporaryVoiceChannelName("🎙️ Luke"), "🎙️ Luke");
  assert.equal(buildTemporaryVoiceChannelName("L".repeat(101)), "L".repeat(100));
});

test("temporary voice owners receive the approved native channel permissions", () => {
  assert.deepEqual(TEMPORARY_VOICE_OWNER_PERMISSIONS, [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers,
    PermissionFlagsBits.PrioritySpeaker,
    PermissionFlagsBits.SetVoiceChannelStatus,
    PermissionFlagsBits.ManageMessages
  ]);
});

test("joining the base channel creates, tracks, and moves into an inherited owner channel", async () => {
  let config: TemporaryVoiceConfig | undefined = {
    discordGuildId: "guild-1",
    baseChannelId: "base-1"
  };
  const records = new Map<string, TemporaryVoiceChannelRecord>();
  let createOptions: Record<string, unknown> | undefined;
  let movedTo: string | undefined;
  let deleted = false;
  const botMember = { id: "bot-1" };
  const baseChannel = {
    id: "base-1",
    type: ChannelType.GuildVoice,
    parentId: "category-1",
    bitrate: 64_000,
    userLimit: 0,
    rtcRegion: null,
    videoQualityMode: 1,
    rawPosition: 4,
    permissionOverwrites: {
      cache: new Map([
        ["role-1", {
          id: "role-1",
          type: OverwriteType.Role,
          allow: { bitfield: PermissionFlagsBits.ViewChannel },
          deny: { bitfield: 0n }
        }]
      ])
    },
    permissionsFor: () => ({ has: () => true })
  };
  const temporaryChannel = {
    id: "temp-1",
    type: ChannelType.GuildVoice,
    name: "Luke",
    members: new Map(),
    delete: async () => { deleted = true; }
  };
  const channels = new Map<string, unknown>([
    ["base-1", baseChannel],
    ["temp-1", temporaryChannel]
  ]);
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    members: { me: botMember },
    channels: {
      fetch: async (id: string) => channels.get(id) ?? null,
      create: async (options: Record<string, unknown>) => {
        createOptions = options;
        return temporaryChannel;
      }
    }
  } as unknown as Guild;
  const memberVoice = {
    channelId: "base-1",
    setChannel: async (channel: { id: string }) => {
      movedTo = channel.id;
      memberVoice.channelId = channel.id;
    }
  };
  const member = {
    id: "owner-1",
    displayName: "Luke",
    user: { bot: false, tag: "luke" },
    voice: memberVoice
  };
  const repository = createFakeRepository(
    () => config,
    (next) => { config = next; },
    records
  );
  const service = createTemporaryVoiceService(repository, silentLogger, createUnblockedMemberActionGuard());

  await service.handleVoiceStateUpdate(
    { guild, channelId: null } as VoiceState,
    { guild, channelId: "base-1", member, id: "owner-1" } as unknown as VoiceState
  );

  assert.equal(createOptions?.name, "Luke");
  assert.equal(createOptions?.parent, "category-1");
  assert.equal(createOptions?.position, 5);
  const overwrites = createOptions?.permissionOverwrites as Array<{
    id: string;
    type: OverwriteType;
    allow: bigint;
    deny?: bigint;
  }>;
  assert.equal(overwrites[0].id, "role-1");
  const ownerOverwrite = overwrites.find((overwrite) => overwrite.id === "owner-1");
  assert.equal(ownerOverwrite?.type, OverwriteType.Member);
  const expectedOwnerPermissions = TEMPORARY_VOICE_OWNER_PERMISSIONS.reduce((all, permission) => all | permission, 0n);
  assert.equal(ownerOverwrite?.allow, expectedOwnerPermissions);
  assert.equal(records.get("temp-1")?.ownerDiscordUserId, "owner-1");
  assert.equal(movedTo, "temp-1");

  await service.clearConfig(guild.id);
  assert.equal(config, undefined);
  assert.equal(records.size, 1);
  assert.equal(deleted, false);

  await service.handleVoiceStateUpdate(
    { guild, channelId: "temp-1" } as VoiceState,
    { guild, channelId: null, member, id: "owner-1" } as unknown as VoiceState
  );
  assert.equal(deleted, true);
  assert.equal(records.size, 0);
});

test("rejoining the base channel reuses the owner's tracked channel", async () => {
  const config: TemporaryVoiceConfig = {
    discordGuildId: "guild-1",
    baseChannelId: "base-1"
  };
  const records = new Map<string, TemporaryVoiceChannelRecord>([["temp-1", {
    discordGuildId: "guild-1",
    discordChannelId: "temp-1",
    ownerDiscordUserId: "owner-1",
    baseChannelId: "base-1"
  }]]);
  let created = false;
  let movedTo: string | undefined;
  const temporaryChannel = { id: "temp-1", name: "🎙️┃Luke", type: ChannelType.GuildVoice, members: new Map() };
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    members: { me: { id: "bot-1" } },
    channels: {
      fetch: async (id: string) => id === "temp-1" ? temporaryChannel : null,
      create: async () => { created = true; return temporaryChannel; }
    }
  } as unknown as Guild;
  const memberVoice = {
    channelId: "base-1",
    setChannel: async (channel: { id: string }) => { movedTo = channel.id; }
  };
  const member = {
    id: "owner-1",
    displayName: "Luke",
    user: { bot: false, tag: "luke" },
    voice: memberVoice
  };
  const service = createTemporaryVoiceService(
    createFakeRepository(() => config, () => undefined, records),
    silentLogger, createUnblockedMemberActionGuard()
  );

  await service.handleVoiceStateUpdate(
    { guild, channelId: null } as VoiceState,
    { guild, channelId: "base-1", member, id: "owner-1" } as unknown as VoiceState
  );

  assert.equal(created, false);
  assert.equal(movedTo, "temp-1");
  assert.equal(temporaryChannel.name, "🎙️┃Luke");
});

function createFakeRepository(
  getConfig: () => TemporaryVoiceConfig | undefined,
  setConfig: (config: TemporaryVoiceConfig | undefined) => void,
  records: Map<string, TemporaryVoiceChannelRecord>
) {
  return {
    getConfig: async () => getConfig(),
    setBaseChannel: async (guildId: string, channelId: string) => setConfig({
      discordGuildId: guildId,
      baseChannelId: channelId
    }),
    clearConfig: async () => { const existed = Boolean(getConfig()); setConfig(undefined); return existed; },
    getChannelByOwner: async (_guildId: string, ownerId: string) =>
      [...records.values()].find((record) => record.ownerDiscordUserId === ownerId),
    getChannel: async (_guildId: string, channelId: string) => records.get(channelId),
    listChannels: async () => [...records.values()],
    addChannel: async (record: TemporaryVoiceChannelRecord) => { records.set(record.discordChannelId, record); },
    removeChannel: async (_guildId: string, channelId: string) => records.delete(channelId)
  } as unknown as Parameters<typeof createTemporaryVoiceService>[0];
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as Logger;
