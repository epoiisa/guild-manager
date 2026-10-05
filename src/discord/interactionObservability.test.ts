import assert from "node:assert/strict";
import test from "node:test";
import {
  interactionAcknowledgementContext,
  interactionFailureResponseMethod,
  logHandledChatInputCommand,
  logSlowUnacknowledgedInteraction,
  normalizedChatInputCommandRoute,
  sanitizedRateLimitContext
} from "./interactionObservability.js";

function interaction(commandName: string, subcommandGroup: string | null, subcommand: string | null) {
  return {
    commandName,
    guildId: "guild-1",
    options: {
      getSubcommandGroup: () => subcommandGroup,
      getSubcommand: () => subcommand
    }
  };
}

test("normalizes chat-input command routes without option values", () => {
  assert.equal(normalizedChatInputCommandRoute(interaction("ping", null, null)), "ping");
  assert.equal(normalizedChatInputCommandRoute(interaction("tickets", null, "show")), "tickets show");
  assert.equal(normalizedChatInputCommandRoute(interaction("reaction", "giveaway", "create")), "reaction giveaway create");
});

test("logs one terminal chat-input command event with duration and outcome", () => {
  const entries: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = {
    debug: () => undefined,
    info: (message: string, context?: Record<string, unknown>) => entries.push({ message, context }),
    warn: () => undefined,
    error: () => undefined
  };

  logHandledChatInputCommand(logger, interaction("reaction", "giveaway", "create"), 1_000, "unhandled_error", 1_042);

  assert.deepEqual(entries, [{
    message: "chat input command handled",
    context: {
      commandRoute: "reaction giveaway create",
      guildId: "guild-1",
      durationMilliseconds: 42,
      outcome: "unhandled_error"
    }
  }]);
});

test("reports interaction age and acknowledgement state without interaction content", () => {
  assert.deepEqual(interactionAcknowledgementContext({
    createdTimestamp: 1_000,
    deferred: true,
    replied: false
  }, 1_042), {
    interactionAgeMilliseconds: 42,
    interactionAcknowledged: true,
    interactionDeferred: true,
    interactionReplied: false,
    interactionResponded: false
  });
});

test("warns only when an interaction is nearing its acknowledgement deadline unacknowledged", () => {
  const entries: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, context?: Record<string, unknown>) => entries.push({ message, context }),
    error: () => undefined
  };

  logSlowUnacknowledgedInteraction(logger, { guildId: "guild-1", createdTimestamp: 1_000 }, 3_500);
  logSlowUnacknowledgedInteraction(logger, { guildId: "guild-1", createdTimestamp: 1_000, replied: true }, 3_500);

  assert.deepEqual(entries, [{
    message: "interaction is approaching its acknowledgement deadline",
    context: {
      guildId: "guild-1",
      interactionAgeMilliseconds: 2_500,
      interactionAcknowledged: false,
      interactionDeferred: false,
      interactionReplied: false,
      interactionResponded: false
    }
  }]);
});

test("keeps a generalized REST route while removing webhook tokens, URLs, and request data", () => {
  const context = sanitizedRateLimitContext({
    global: false,
    hash: "bucket-hash",
    limit: 5,
    majorParameter: "guild-1",
    method: "POST",
    retryAfter: 1_000,
    route: "/webhooks/application-id/secret-token/messages",
    scope: "shared",
    sublimitTimeout: 0,
    timeToReset: 1_000,
    url: "https://discord.com/api/webhooks/application-id/secret-token"
  });

  assert.deepEqual(context, {
    global: false,
    bucketHash: "bucket-hash",
    limit: 5,
    method: "POST",
    route: "/webhooks/:id/:token/messages",
    retryAfterMilliseconds: 1_000,
    scope: "shared",
    sublimitTimeoutMilliseconds: 0,
    timeToResetMilliseconds: 1_000
  });
  assert.equal(JSON.stringify(context).includes("secret-token"), false);
});

test("treats autocomplete respond as acknowledgement", () => {
  assert.equal(interactionAcknowledgementContext({
    createdTimestamp: 1_000,
    responded: true
  }, 1_100).interactionAcknowledged, true);
});

test("edits a deferred reply fallback but follows up a deferred component update", () => {
  assert.equal(interactionFailureResponseMethod({ deferred: false, replied: false }), "reply");
  assert.equal(interactionFailureResponseMethod({ deferred: true, replied: false, ephemeral: true }), "edit_reply");
  assert.equal(interactionFailureResponseMethod({ deferred: true, replied: false, ephemeral: false }), "edit_reply");
  assert.equal(interactionFailureResponseMethod({ deferred: true, replied: false, ephemeral: null }), "follow_up");
  assert.equal(interactionFailureResponseMethod({ deferred: false, replied: true, ephemeral: true }), "follow_up");
});

test("content component telemetry omits private draft and generation identifiers", async () => {
  const { normalizedContentComponentRoute } = await import("./interactionObservability.js");
  assert.equal(normalizedContentComponentRoute("content-panel:secret-generation:scheduled"), "content-panel");
  assert.equal(normalizedContentComponentRoute("content-host:secret-draft:form:1"), "content-host");
  assert.equal(normalizedContentComponentRoute("content:other"), undefined);
});
