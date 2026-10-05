import { type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalReactionEmojiKey,
  parseReactionEmojiInput
} from "../services/reactionRoles/emoji.js";
import {
  createReactionRemovalSuppressor,
  reactionSubscriptionAction
} from "../services/reactionRoles/subscriptions.js";
import { messageDescription, messageSummary } from "../testSupport/messageAssertions.js";
import {
  handleReactionAutocomplete,
  handleReactionCommand,
  reactionCommand
} from "./reaction.js";

test("reaction command exposes the approved emoji-only surface", () => {
  const json = reactionCommand.toJSON();
  assert.equal(json.default_member_permissions, "0");

  const leaves = (json.options ?? []).flatMap((group) => {
    if (!("options" in group) || !group.options) return [];
    return group.options.map((subcommand) => ({
      signature: `/reaction ${group.name} ${subcommand.name}`,
      options: "options" in subcommand
        ? (subcommand.options ?? []).map((option) => ({
          name: option.name,
          required: "required" in option ? option.required === true : false,
          autocomplete: "autocomplete" in option ? option.autocomplete === true : false
        }))
        : []
    }));
  });

  assert.deepEqual(leaves, [
    {
      signature: "/reaction roles add",
      options: [{ name: "role", required: true, autocomplete: false }]
    },
    {
      signature: "/reaction roles remove",
      options: [{ name: "role", required: true, autocomplete: true }]
    },
    { signature: "/reaction roles list", options: [] },
    {
      signature: "/reaction emoji add",
      options: [
        { name: "message", required: true, autocomplete: false },
        { name: "role", required: true, autocomplete: true },
        { name: "emoji", required: true, autocomplete: false }
      ]
    },
    {
      signature: "/reaction emoji remove",
      options: [{ name: "role", required: true, autocomplete: true }]
    }
  ]);
  assert.equal(JSON.stringify(json).includes("\"mode\""), false);
  assert.equal(JSON.stringify(json).includes("\"button\""), false);
  const roles = json.options?.find((option) => option.name === "roles");
  const remove = roles && "options" in roles
    ? roles.options?.find((option) => option.name === "remove")
    : undefined;
  assert.equal(remove?.description, "Remove a reaction role from tracked and cached members.");
});

test("reaction role configuration uses the concise success message", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
  }> = [];
  const interaction: any = {
    guildId: "guild-1",
    guild: {
      members: {
        me: {
          roles: {
            highest: {
              comparePositionTo: () => 1
            }
          }
        }
      }
    },
    user: { id: "user-1" },
    options: {
      getSubcommandGroup: () => "roles",
      getSubcommand: () => "add",
      getRole: () => ({
        id: "role-1",
        guild: { id: "guild-1" },
        managed: false
      })
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  };
  const repository = {
    addConfig: async () => undefined
  } as unknown as Parameters<typeof handleReactionCommand>[1];
  const membership = {
    listConfiguredRoleIdsForGuild: async () => []
  } as unknown as Parameters<typeof handleReactionCommand>[2];

  await handleReactionCommand(interaction, repository, membership);

  const embed = replies[0];
  assert.equal(messageSummary(embed), "<@&role-1> is configured as an opt-in reaction role for managed users.");
  assert.equal(
    messageDescription(embed),
    "<@&role-1> is configured as an opt-in reaction role for managed users."
  );
});

test("reaction role autocomplete stays operation-specific", async () => {
  const configs = [
    {
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      createdByDiscordUserId: "user-1"
    },
    {
      reactionRoleConfigId: "config-2",
      discordGuildId: "guild-1",
      discordRoleId: "role-2",
      createdByDiscordUserId: "user-1"
    },
    {
      reactionRoleConfigId: "config-3",
      discordGuildId: "guild-1",
      discordRoleId: "role-3",
      createdByDiscordUserId: "user-1"
    }
  ];
  const placements = [
    {
      reactionRoleEmojiPlacementId: "placement-2",
      reactionRoleConfigId: "config-2",
      discordGuildId: "guild-1",
      discordRoleId: "role-2",
      channelId: "channel-2",
      messageId: "message-2",
      emojiKey: "unicode:✅",
      emojiDisplayValue: "✅",
      createdByDiscordUserId: "user-1"
    },
    {
      reactionRoleEmojiPlacementId: "placement-3",
      reactionRoleConfigId: "config-3",
      discordGuildId: "guild-1",
      discordRoleId: "role-3",
      channelId: "channel-3",
      messageId: "message-3",
      emojiKey: "unicode:🎉",
      emojiDisplayValue: "🎉",
      createdByDiscordUserId: "user-1"
    }
  ];
  const repository = {
    listConfigs: async () => configs,
    listPlacements: async () => placements
  } as unknown as Parameters<typeof handleReactionAutocomplete>[1];
  const roleNames = new Map([
    ["role-1", { name: "Raid Leaders" }],
    ["role-2", { name: "Raid Members" }],
    ["role-3", { name: "Gatherers" }]
  ]);

  async function choicesFor(group: string, subcommand: string) {
    let choices: Array<{ name: string; value: string }> = [];
    const interaction = {
      commandName: "reaction",
      guildId: "guild-1",
      guild: { roles: { cache: roleNames } },
      options: {
        getFocused: () => ({ name: "role", value: "RAID" }),
        getSubcommandGroup: () => group,
        getSubcommand: () => subcommand
      },
      respond: async (response: Array<{ name: string; value: string }>) => {
        choices = response;
      }
    } as unknown as AutocompleteInteraction;

    assert.equal(await handleReactionAutocomplete(interaction, repository), true);
    return choices;
  }

  assert.deepEqual(await choicesFor("emoji", "add"), [
    { name: "Raid Leaders", value: "config-1" }
  ]);
  assert.deepEqual(await choicesFor("emoji", "remove"), [
    { name: "Raid Members", value: "config-2" }
  ]);
  assert.deepEqual(await choicesFor("roles", "remove"), [
    { name: "Raid Leaders", value: "config-1" },
    { name: "Raid Members", value: "config-2" }
  ]);
});

test("reaction emoji removal uses the stored placement and cleans a deleted message", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
  }> = [];
  const removed: string[][] = [];
  const interaction: any = {
    deferred: false,
    guildId: "guild-1",
    guild: {
      channels: {
        fetch: async (channelId: string) => {
          assert.equal(channelId, "stored-channel");
          return {
            isTextBased: () => true,
            messages: {
              fetch: async (messageId: string) => {
                assert.equal(messageId, "stored-message");
                throw Object.assign(new Error("Unknown Message"), { code: 10008 });
              }
            }
          };
        }
      }
    },
    options: {
      getSubcommandGroup: () => "emoji",
      getSubcommand: () => "remove",
      getString: (name: string) => {
        assert.equal(name, "role");
        return "config-1";
      }
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  };
  const repository = {
    getConfig: async () => ({
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      createdByDiscordUserId: "user-1"
    }),
    getPlacementForConfig: async () => ({
      reactionRoleEmojiPlacementId: "placement-1",
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      channelId: "stored-channel",
      messageId: "stored-message",
      emojiKey: "unicode:✅",
      emojiDisplayValue: "✅",
      createdByDiscordUserId: "user-1"
    }),
    removePlacement: async (...args: string[]) => {
      removed.push(args);
    }
  } as unknown as Parameters<typeof handleReactionCommand>[1];

  await handleReactionCommand(interaction, repository, {} as never);

  assert.deepEqual(removed, [["guild-1", "stored-message", "config-1"]]);
  const embed = replies[0];
  assert.equal(messageSummary(embed), "✅ was detached from the deleted message. Existing subscriptions and role assignments were preserved.");
  assert.equal(
    messageDescription(embed),
    "✅ was detached from the deleted message. Existing subscriptions and role assignments were preserved."
  );
});

test("reaction emoji removal retains an inaccessible stored placement", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
  }> = [];
  let removed = false;
  const interaction: any = {
    deferred: false,
    guildId: "guild-1",
    guild: {
      channels: {
        fetch: async (channelId: string) => {
          assert.equal(channelId, "stored-channel");
          throw new Error("Missing Access");
        }
      }
    },
    options: {
      getSubcommandGroup: () => "emoji",
      getSubcommand: () => "remove",
      getString: (name: string) => {
        assert.equal(name, "role");
        return "config-1";
      }
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  };
  const repository = {
    getConfig: async () => ({
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      createdByDiscordUserId: "user-1"
    }),
    getPlacementForConfig: async () => ({
      reactionRoleEmojiPlacementId: "placement-1",
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      channelId: "stored-channel",
      messageId: "stored-message",
      emojiKey: "unicode:✅",
      emojiDisplayValue: "✅",
      createdByDiscordUserId: "user-1"
    }),
    removePlacement: async () => {
      removed = true;
    }
  } as unknown as Parameters<typeof handleReactionCommand>[1];

  await handleReactionCommand(interaction, repository, {} as never);

  assert.equal(removed, false);
  const embed = replies[0];
  assert.equal(messageSummary(embed), "Reaction Emoji Inaccessible: Guild Manager cannot access the configured message. Restore channel access before removing the placement.");
  assert.equal(
    messageDescription(embed),
    "Reaction Emoji Inaccessible: Guild Manager cannot access the configured message. Restore channel access before removing the placement."
  );
});

test("reaction emoji changes revalidate configuration inside the shared lock", async () => {
  const events: string[] = [];
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string } }> }> = [];
  let configLookups = 0;
  let placementLookups = 0;
  const config = {
    reactionRoleConfigId: "config-1",
    discordGuildId: "guild-1",
    discordRoleId: "role-1",
    createdByDiscordUserId: "user-1"
  };
  const interaction: any = {
    deferred: false,
    guildId: "guild-1",
    options: {
      getSubcommandGroup: () => "emoji",
      getSubcommand: () => "remove",
      getString: () => "config-1"
    },
    deferReply: async () => { interaction.deferred = true; events.push("defer"); },
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); }
  };
  const repository = {
    getConfig: async () => { configLookups += 1; return configLookups === 1 ? config : undefined; },
    getPlacementForConfig: async () => { placementLookups += 1; return undefined; }
  };

  await handleReactionCommand(interaction, repository as never, {} as never, undefined, {
    enqueue: async (key, operation) => {
      assert.equal(key, "guild-1:reaction-role-config:config-1");
      events.push("config-lock");
      await operation();
    }
  });

  assert.deepEqual(events, ["defer", "config-lock"]);
  assert.equal(configLookups, 2);
  assert.equal(placementLookups, 0);
  assert.equal(messageSummary(replies[0]), "Reaction Role Not Found: The reaction role was removed before its emoji placement could be changed.");
});

test("reaction role removal acknowledges before lookup and locks targeted cleanup against reaction changes", async () => {
  const calls: string[] = [];
  const removed: string[] = [];
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
  }> = [];
  const role = {
    id: "role-1",
    members: new Map([["cached-holder", {}]])
  };
  const interaction = {
    guildId: "guild-1",
    guild: {
      roles: { fetch: async () => role },
      members: {
        fetch: async (input: { user: string }) => {
          assert.ok(input?.user, "role removal must fetch one targeted member at a time");
          calls.push(`member:${input.user}`);
          if (input.user === "departed") {
            throw Object.assign(new Error("Unknown Member"), { code: 10007 });
          }
          return {
            roles: {
              cache: { has: () => true },
              remove: async () => { removed.push(input.user); }
            }
          };
        }
      }
    },
    options: {
      getSubcommandGroup: () => "roles",
      getSubcommand: () => "remove",
      getString: () => "config-1"
    },
    deferReply: async () => { calls.push("defer"); },
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getConfig: async () => {
      assert.equal(calls[0], "defer");
      return {
        reactionRoleConfigId: "config-1",
        discordGuildId: "guild-1",
        discordRoleId: "role-1",
        createdByDiscordUserId: "user-1"
      };
    },
    listSubscriberDiscordUserIds: async () => ["subscriber", "cached-holder", "departed"],
    getPlacementForConfig: async () => undefined,
    removeConfig: async () => { calls.push("remove-config"); }
  } as unknown as Parameters<typeof handleReactionCommand>[1];

  await handleReactionCommand(interaction, repository, {} as never, undefined, {
    enqueue: async (key, operation) => {
      assert.equal(key, "guild-1:reaction-role-config:config-1");
      calls.push("config-lock");
      await operation();
    }
  });

  assert.deepEqual(calls, [
    "defer",
    "config-lock",
    "member:subscriber",
    "member:cached-holder",
    "member:departed",
    "remove-config"
  ]);
  assert.deepEqual(removed, ["subscriber", "cached-holder"]);
  assert.equal(messageSummary(replies[0]), "<@&role-1>, its subscriptions, and emoji placement were removed.");
});

test("reaction role removal reports a missing configuration after acknowledgement", async () => {
  const calls: string[] = [];
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
  }> = [];
  const interaction = {
    guildId: "guild-1",
    guild: {
      roles: { fetch: async () => { calls.push("role"); return undefined; } }
    },
    options: {
      getSubcommandGroup: () => "roles",
      getSubcommand: () => "remove",
      getString: () => "config-1"
    },
    deferReply: async () => { calls.push("defer"); },
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getConfig: async () => {
      assert.deepEqual(calls, ["defer"]);
      return undefined;
    }
  } as unknown as Parameters<typeof handleReactionCommand>[1];

  await handleReactionCommand(interaction, repository, {} as never);

  assert.deepEqual(calls, ["defer"]);
  assert.equal(messageSummary(replies[0]), "Reaction Role Not Found: Choose a configured reaction role from autocomplete.");
});

test("reaction role removal cleans obsolete configuration when the Discord role is missing", async () => {
  let removedConfig = false;
  let subscriptionLookup = false;
  const interaction = {
    guildId: "guild-1",
    guild: {
      roles: {
        fetch: async () => { throw Object.assign(new Error("Unknown Role"), { code: 10011 }); }
      }
    },
    options: {
      getSubcommandGroup: () => "roles",
      getSubcommand: () => "remove",
      getString: () => "config-1"
    },
    deferReply: async () => undefined,
    editReply: async () => undefined
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getConfig: async () => ({
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      createdByDiscordUserId: "user-1"
    }),
    listSubscriberDiscordUserIds: async () => {
      subscriptionLookup = true;
      return [];
    },
    getPlacementForConfig: async () => undefined,
    removeConfig: async () => { removedConfig = true; }
  } as unknown as Parameters<typeof handleReactionCommand>[1];

  await handleReactionCommand(interaction, repository, {} as never);

  assert.equal(subscriptionLookup, false);
  assert.equal(removedConfig, true);
});

test("reaction role removal retains configuration when a targeted role removal fails", async () => {
  let removedConfig = false;
  let placementLookup = false;
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
  }> = [];
  const interaction = {
    guildId: "guild-1",
    guild: {
      roles: { fetch: async () => ({ id: "role-1", members: new Map() }) },
      members: {
        fetch: async () => ({
          roles: {
            cache: { has: () => true },
            remove: async () => { throw new Error("Missing permissions"); }
          }
        })
      }
    },
    options: {
      getSubcommandGroup: () => "roles",
      getSubcommand: () => "remove",
      getString: () => "config-1"
    },
    deferReply: async () => undefined,
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getConfig: async () => ({
      reactionRoleConfigId: "config-1",
      discordGuildId: "guild-1",
      discordRoleId: "role-1",
      createdByDiscordUserId: "user-1"
    }),
    listSubscriberDiscordUserIds: async () => ["subscriber"],
    getPlacementForConfig: async () => {
      placementLookup = true;
      return undefined;
    },
    removeConfig: async () => { removedConfig = true; }
  } as unknown as Parameters<typeof handleReactionCommand>[1];

  await handleReactionCommand(interaction, repository, {} as never);

  assert.equal(removedConfig, false);
  assert.equal(placementLookup, false);
  assert.equal(messageSummary(replies[0]), "Reaction Role Removal Incomplete");
});

test("reaction events preserve dormant subscriptions", () => {
  assert.equal(reactionSubscriptionAction(true, true), "subscribe");
  assert.equal(reactionSubscriptionAction(false, true), "unsubscribe");
  assert.equal(reactionSubscriptionAction(true, false), "preserve_dormant");
  assert.equal(reactionSubscriptionAction(false, false), "preserve_dormant");
});

test("bot-initiated reaction removals suppress exactly one matching remove event", () => {
  const suppressor = createReactionRemovalSuppressor();
  suppressor.mark("guild:message:emoji:user");
  assert.equal(suppressor.consume("guild:message:emoji:user"), true);
  assert.equal(suppressor.consume("guild:message:emoji:user"), false);

  suppressor.mark("cancelled");
  suppressor.cancel("cancelled");
  assert.equal(suppressor.consume("cancelled"), false);
});

test("reaction emoji parsing canonicalizes Unicode and custom emoji identities", () => {
  assert.deepEqual(parseReactionEmojiInput(" ✅ "), {
    emojiKey: "unicode:✅",
    displayValue: "✅"
  });
  assert.deepEqual(parseReactionEmojiInput("<a:party_blob:1234567890>"), {
    emojiKey: "custom:1234567890",
    displayValue: "<a:party_blob:1234567890>",
    customEmojiId: "1234567890"
  });
  assert.equal(parseReactionEmojiInput("✅ 🎉"), undefined);
  assert.equal(parseReactionEmojiInput("not-an-emoji"), undefined);
});

test("reaction event emoji identities match stored placement keys", () => {
  assert.equal(
    canonicalReactionEmojiKey({ id: "1234567890", name: "renamed" } as any),
    "custom:1234567890"
  );
  assert.equal(
    canonicalReactionEmojiKey({ id: null, name: "✅" } as any),
    "unicode:✅"
  );
});
