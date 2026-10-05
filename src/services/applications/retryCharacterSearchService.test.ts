import assert from "node:assert/strict";
import test from "node:test";
import { retryApplicationCharacterSearch } from "./retryCharacterSearchService.js";

test("retry search service enforces open matching applicant-or-reviewer access before calling Albion Online or writing", async () => {
  const cases = [
    { name: "closed application", channelStatus: "closed" as const, expected: "Character Search Unavailable" },
    { name: "decided application", status: "accepted" as const, expected: "Character Search Unavailable" },
    { name: "wrong channel", channelId: "other", expected: "Wrong Channel" },
    { name: "outsider", userId: "outsider", expected: "Character Search Not Allowed" }
  ];

  for (const entry of cases) {
    const fixture = createFixture(entry);
    const result = await retryApplicationCharacterSearch(fixture.input);
    assert.equal(result.kind, "error", entry.name);
    assert.equal(result.kind === "error" && result.title, entry.expected, entry.name);
    assert.equal(fixture.calls.search, 0, entry.name);
  }
});

test("retry search reports no matches, caps results at 24, and records the attempt only after a successful Albion Online response", async () => {
  const none = createFixture({ players: [] });
  assert.deepEqual(await retryApplicationCharacterSearch(none.input), {
    kind: "no_matches", application: none.application, attempt: 2
  });

  const players = Array.from({ length: 30 }, (_, index) => ({ id: String(index), name: `Player ${index}` }));
  const matches = createFixture({ players });
  const result = await retryApplicationCharacterSearch(matches.input);
  assert.equal(result.kind, "matches");
  assert.equal(result.kind === "matches" && result.players.length, 24);
  assert.equal(matches.calls.begin, 1);
  assert.equal(matches.calls.search, 1);
  assert.deepEqual(matches.calls.events, ["search", "begin"]);
});

test("retry search reports an Albion Online outage without recording or clearing the application search", async () => {
  const fixture = createFixture({ searchError: new Error("unavailable") });

  const result = await retryApplicationCharacterSearch(fixture.input);
  assert.deepEqual(result, {
    kind: "error",
    title: "Character Search Unavailable",
    description: "Albion Online character search is temporarily unavailable. Try again."
  });
  assert.equal(fixture.calls.begin, 0);
  assert.equal(fixture.calls.search, 1);
});

test("retry search reports a compare-and-set loss after the successful Albion Online response", async () => {
  const fixture = createFixture({ begin: false });

  const result = await retryApplicationCharacterSearch(fixture.input);
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" && result.title, "Character Search Unavailable");
  assert.deepEqual(fixture.calls.events, ["search", "begin"]);
});

function createFixture(options: {
  status?: "open" | "accepted";
  channelStatus?: "open" | "closed";
  channelId?: string;
  userId?: string;
  begin?: boolean;
  players?: Array<{ id: string; name: string }>;
  searchError?: Error;
}) {
  const calls = { begin: 0, search: 0, events: [] as string[] };
  const application = { applicationClassId: "class", albionServer: "europe", reviewerRoleId: "reviewer" };
  const open = {
    applicationId: "application",
    applicationClassId: "class",
    applicantDiscordUserId: "applicant",
    ticketChannelId: "channel",
    status: options.status ?? "open",
    channelStatus: options.channelStatus ?? "open"
  };
  const repository = {
    getOpenApplication: async () => open,
    getApplicationClass: async () => application,
    beginApplicationCharacterSearch: async () => {
      calls.begin++;
      calls.events.push("begin");
      return options.begin === false ? undefined : { ...open, albionServer: "europe", characterSearchAttemptCount: 2 };
    }
  };
  return {
    application,
    calls,
    input: {
      guildId: "guild",
      channelId: options.channelId ?? "channel",
      applicationId: "application",
      characterName: "Applicant",
      actor: { userId: options.userId ?? "applicant", roleIds: new Set<string>() },
      applicationRepository: repository as never,
      albionClient: {
        searchCharacters: async () => {
          calls.search++;
          calls.events.push("search");
          if (options.searchError) throw options.searchError;
          return { players: options.players ?? [{ id: "one", name: "One" }] };
        }
      } as never
    }
  };
}
