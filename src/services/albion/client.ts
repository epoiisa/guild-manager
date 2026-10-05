import type { Logger } from "../../logging/logger.js";
import { getAlbionGameInfoBaseUrl, type AlbionServer } from "./servers.js";
import type {
  AlbionAlliance,
  AlbionGuild,
  AlbionGuildMember,
  AlbionPlayer,
  AlbionSearchGuild,
  AlbionSearchPlayer,
  AlbionSearchResult
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 200;
const RATE_LIMIT_FALLBACK_MS = 30_000;

export interface AlbionClient {
  getAlliance(server: AlbionServer, id: string): Promise<AlbionAlliance>;
  getGuild(server: AlbionServer, id: string): Promise<AlbionGuild>;
  getGuildMembers(server: AlbionServer, id: string): Promise<AlbionGuildMember[]>;
  getPlayer(server: AlbionServer, id: string): Promise<AlbionPlayer>;
  search(server: AlbionServer, query: string): Promise<AlbionSearchResult>;
  searchCharacters(server: AlbionServer, query: string): Promise<AlbionSearchResult>;
}

export interface AlbionClientOptions {
  timeoutMs?: number;
  logger?: Logger;
  /** Test seams; production callers should use the platform defaults. */
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export type AlbionApiFailureKind = "timeout" | "network" | "rate_limited" | "server" | "client" | "invalid_response";

export class AlbionApiError extends Error {
  readonly name = "AlbionApiError";
  readonly retryAt?: number;
  readonly retryDeferred: boolean;

  constructor(
    message: string,
    readonly kind: AlbionApiFailureKind,
    readonly httpStatus?: number,
    options?: { cause?: unknown; retryAt?: number; retryDeferred?: boolean }
  ) {
    super(message, options);
    this.retryAt = options?.retryAt;
    this.retryDeferred = options?.retryDeferred ?? false;
  }
}

interface AlbionRequestDependencies {
  fetch: typeof globalThis.fetch;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  now: () => number;
  rateLimitedUntil: Map<AlbionServer, number>;
}

export function createAlbionClient(options: AlbionClientOptions = {}): AlbionClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger;
  const dependencies: AlbionRequestDependencies = {
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    random: options.random ?? Math.random,
    now: options.now ?? Date.now,
    rateLimitedUntil: new Map()
  };

  return {
    getAlliance: async (server, id) =>
      requestAndNormalize("getAlliance", server, `/alliances/${encodeURIComponent(id)}`, timeoutMs, logger, dependencies, normalizeAlliance),
    getGuild: async (server, id) =>
      requestAndNormalize("getGuild", server, `/guilds/${encodeURIComponent(id)}`, timeoutMs, logger, dependencies, normalizeGuild),
    getGuildMembers: async (server, id) =>
      requestAndNormalize("getGuildMembers", server, `/guilds/${encodeURIComponent(id)}/members`, timeoutMs, logger, dependencies, normalizeGuildMembers),
    getPlayer: async (server, id) =>
      requestAndNormalize("getPlayer", server, `/players/${encodeURIComponent(id)}`, timeoutMs, logger, dependencies, normalizePlayer),
    search: async (server, query) =>
      requestAndNormalize("search", server, `/search?q=${encodeURIComponent(query)}`, timeoutMs, logger, dependencies, normalizeSearchResult),
    searchCharacters: async (server, query) =>
      requestAndNormalize("searchCharacters", server, `/search?q=${encodeURIComponent(query)}`, timeoutMs, logger, dependencies, normalizeSearchResult)
  };
}

type AlbionRequestOperation = "getAlliance" | "getGuild" | "getGuildMembers" | "getPlayer" | "search" | "searchCharacters";

async function requestAndNormalize<T>(
  operation: AlbionRequestOperation,
  server: AlbionServer,
  path: string,
  timeoutMs: number,
  logger: Logger | undefined,
  dependencies: AlbionRequestDependencies,
  normalize: (value: unknown) => T
): Promise<T> {
  const startedAt = dependencies.now();
  const deadline = startedAt + timeoutMs;
  const separator = path.includes("?") ? "&" : "?";
  const cacheBuster = encodeURIComponent(`${dependencies.now()}-${dependencies.random()}`);
  const url = `${getAlbionGameInfoBaseUrl(server)}${path}${separator}_=${cacheBuster}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const retryAt = dependencies.rateLimitedUntil.get(server);
    if (retryAt !== undefined && dependencies.now() < retryAt) {
      logger?.debug("Albion Online API request deferred during rate limit cooldown", {
        operation,
        albionServer: server,
        retryAt
      });
      throw new AlbionApiError("Albion Online API requests are temporarily rate limited", "rate_limited", 429, {
        retryAt,
        retryDeferred: true
      });
    }
    let response: Response;
    let value: unknown;
    try {
      const remainingAttempts = MAX_ATTEMPTS - attempt + 1;
      const remainingMilliseconds = deadline - dependencies.now();
      const attemptDeadline = attempt === MAX_ATTEMPTS
        ? deadline
        : dependencies.now() + Math.max(1, Math.floor(remainingMilliseconds / remainingAttempts));
      ({ response, value } = await fetchJsonBeforeDeadline(url, attemptDeadline, dependencies));
    } catch (error) {
      const apiError = error instanceof AlbionApiError
        ? error
        : new AlbionApiError("Albion Online API request failed", "network", undefined, { cause: error });
      if (shouldRetry(apiError, attempt)) {
        logRequestFailure(logger, operation, server, startedAt, attempt, apiError, dependencies.now());
        if (await waitToRetry(undefined, attempt, deadline, dependencies)) continue;
        throw apiError;
      }
      logRequestFailure(logger, operation, server, startedAt, attempt, apiError, dependencies.now());
      throw apiError;
    }

    if (!response.ok) {
      const retryAt = response.status === 429
        ? recordRateLimit(response, server, dependencies)
        : undefined;
      const apiError = new AlbionApiError(
        `Albion Online API request failed: ${response.status} ${response.statusText}`,
        getHttpFailureKind(response.status),
        response.status,
        { retryAt }
      );
      if (shouldRetry(apiError, attempt)) {
        logRequestFailure(logger, operation, server, startedAt, attempt, apiError, dependencies.now());
        if (await waitToRetry(response, attempt, deadline, dependencies, retryAt)) continue;
        throw apiError;
      }
      logRequestFailure(logger, operation, server, startedAt, attempt, apiError, dependencies.now());
      throw apiError;
    }

    try {
      const normalized = normalize(value);
      logger?.debug("Albion Online API request completed", {
        operation,
        albionServer: server,
        durationMilliseconds: dependencies.now() - startedAt,
        httpStatus: response.status,
        attempt
      });
      return normalized;
    } catch (error) {
      const apiError = new AlbionApiError("Albion Online API returned an invalid response", "invalid_response", response.status, { cause: error });
      logRequestFailure(logger, operation, server, startedAt, attempt, apiError, dependencies.now());
      throw apiError;
    }
  }

  throw new AlbionApiError("Albion Online API request deadline elapsed", "timeout");
}

function logRequestFailure(
  logger: Logger | undefined,
  operation: AlbionRequestOperation,
  server: AlbionServer,
  startedAt: number,
  attempt: number,
  error: AlbionApiError,
  now: number
): void {
  const context = {
    operation,
    albionServer: server,
    durationMilliseconds: now - startedAt,
    attempt,
    failureKind: error.kind,
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus })
  };
  if (error.httpStatus === 404) {
    logger?.info("Albion Online API request failed", context);
  } else {
    logger?.warn("Albion Online API request failed", context);
  }
}

async function fetchJsonBeforeDeadline(
  url: string,
  deadline: number,
  dependencies: AlbionRequestDependencies
): Promise<{ response: Response; value?: unknown }> {
  const remaining = deadline - dependencies.now();
  if (remaining <= 0) {
    throw new AlbionApiError("Albion Online API request deadline elapsed", "timeout");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AlbionApiError("Albion Online API request timed out", "timeout"));
    }, remaining);
  });
  const request = (async () => {
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-cache", pragma: "no-cache" },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new AlbionApiError("Albion Online API request timed out", "timeout", undefined, { cause: error });
      }
      throw new AlbionApiError("Albion Online API request failed", "network", undefined, { cause: error });
    }
    if (!response.ok) return { response };
    try {
      return { response, value: await response.json() as unknown };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new AlbionApiError("Albion Online API request timed out", "timeout", undefined, { cause: error });
      }
      throw new AlbionApiError("Albion Online API returned an invalid response", "invalid_response", response.status, { cause: error });
    }
  })();
  try {
    return await Promise.race([request, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function getHttpFailureKind(status: number): AlbionApiFailureKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "client";
}

function shouldRetry(error: AlbionApiError, attempt: number): boolean {
  return attempt < MAX_ATTEMPTS && (error.kind === "timeout" || error.kind === "network" || error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus !== undefined && error.httpStatus >= 500));
}

function recordRateLimit(response: Response, server: AlbionServer, dependencies: AlbionRequestDependencies): number {
  const now = dependencies.now();
  const delay = parseRetryAfter(response.headers.get("retry-after"), now) ?? RATE_LIMIT_FALLBACK_MS;
  const retryAt = Math.max(dependencies.rateLimitedUntil.get(server) ?? 0, now + delay);
  dependencies.rateLimitedUntil.set(server, retryAt);
  return retryAt;
}

async function waitToRetry(response: Response | undefined, attempt: number, deadline: number, dependencies: AlbionRequestDependencies, rateLimitRetryAt?: number): Promise<boolean> {
  const remaining = deadline - dependencies.now();
  if (remaining <= 1) return false;
  const retryAfter = rateLimitRetryAt === undefined
    ? response ? parseRetryAfter(response.headers.get("retry-after"), dependencies.now()) : undefined
    : Math.max(0, rateLimitRetryAt - dependencies.now());
  const fallback = BACKOFF_BASE_MS * (2 ** (attempt - 1)) * (0.5 + dependencies.random());
  if (retryAfter !== undefined && retryAfter >= remaining) return false;
  const delay = retryAfter ?? Math.min(fallback, remaining - 1);
  if (delay < 0 || delay >= remaining) return false;
  await dependencies.sleep(delay);
  return dependencies.now() < deadline;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    const milliseconds = seconds * 1_000;
    return seconds >= 0 && Number.isFinite(milliseconds) ? Math.floor(milliseconds) : undefined;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function normalizeSearchResult(value: unknown): AlbionSearchResult {
  const record = toRecord(value);
  const guildValues = Array.isArray(record.guilds)
    ? record.guilds
    : Array.isArray(record.Guilds)
      ? record.Guilds
      : [];
  const playerValues = Array.isArray(record.players)
    ? record.players
    : Array.isArray(record.Players)
      ? record.Players
      : [];

  return {
    guilds: guildValues.map(normalizeSearchGuild).filter(isDefined),
    players: playerValues.map(normalizeSearchPlayer).filter(isDefined)
  };
}

function normalizeSearchGuild(value: unknown): AlbionSearchGuild | undefined {
  const record = toRecord(value);
  const id = getString(record, "Id", "id");
  const name = getString(record, "Name", "name");

  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    allianceId: getString(record, "AllianceId", "allianceId"),
    allianceName: getString(record, "AllianceName", "allianceName"),
    allianceTag: getString(record, "AllianceTag", "allianceTag")
  };
}

function normalizeSearchPlayer(value: unknown): AlbionSearchPlayer | undefined {
  const record = toRecord(value);
  const id = getString(record, "Id", "id");
  const name = getString(record, "Name", "name");

  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    guildId: getString(record, "GuildId", "guildId"),
    guildName: getString(record, "GuildName", "guildName"),
    allianceId: getString(record, "AllianceId", "allianceId"),
    allianceName: getString(record, "AllianceName", "allianceName"),
    allianceTag: getString(record, "AllianceTag", "allianceTag")
  };
}

function normalizePlayer(value: unknown): AlbionPlayer {
  const record = toRecord(value);
  const id = requireString(record, "Id", "id");
  const name = requireString(record, "Name", "name");

  return {
    id,
    name,
    guildId: getString(record, "GuildId", "guildId"),
    guildName: getString(record, "GuildName", "guildName"),
    allianceId: getString(record, "AllianceId", "allianceId"),
    allianceName: getString(record, "AllianceName", "allianceName"),
    allianceTag: getString(record, "AllianceTag", "allianceTag"),
    pvpFame: getNestedNumber(record, ["KillFame"], ["killFame"]),
    pveFame: getNestedNumber(record, ["LifetimeStatistics", "PvE", "Total"], ["lifetimeStatistics", "pve", "total"]),
    gatheringFame: getNestedNumber(
      record,
      ["LifetimeStatistics", "Gathering", "All", "Total"],
      ["lifetimeStatistics", "gathering", "all", "total"]
    ),
    craftingFame: getNestedNumber(
      record,
      ["LifetimeStatistics", "Crafting", "Total"],
      ["lifetimeStatistics", "crafting", "total"]
    )
  };
}

function normalizeGuild(value: unknown): AlbionGuild {
  const record = toRecord(value);
  const id = requireString(record, "Id", "id");
  const name = requireString(record, "Name", "name");

  return {
    id,
    name,
    founderName: getString(record, "FounderName", "founderName"),
    founded: getString(record, "Founded", "founded"),
    allianceId: getString(record, "AllianceId", "allianceId"),
    allianceName: getString(record, "AllianceName", "allianceName"),
    allianceTag: getString(record, "AllianceTag", "allianceTag"),
    memberCount: getNumber(record, "MemberCount") ?? getNumber(record, "memberCount")
  };
}

function normalizeGuildMembers(value: unknown): AlbionGuildMember[] {
  const record = toRecord(value);
  const memberValues = Array.isArray(value)
    ? value
    : firstArray(
      record.members,
      record.Members,
      record.players,
      record.Players,
      record.guildMembers,
      record.GuildMembers
    );

  return memberValues.map(normalizeGuildMember).filter(isDefined);
}

function normalizeGuildMember(value: unknown): AlbionGuildMember | undefined {
  const record = toRecord(value);
  const id = getString(record, "Id", "id", "PlayerId", "playerId", "CharacterId", "characterId");
  const name = getString(record, "Name", "name", "PlayerName", "playerName", "CharacterName", "characterName");

  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    guildId: getString(record, "GuildId", "guildId"),
    guildName: getString(record, "GuildName", "guildName"),
    allianceId: getString(record, "AllianceId", "allianceId"),
    allianceName: getString(record, "AllianceName", "allianceName"),
    allianceTag: getString(record, "AllianceTag", "allianceTag"),
    pvpFame: getNestedNumber(record, ["KillFame"], ["killFame"], ["LifetimeStatistics", "PvP", "Total"], ["lifetimeStatistics", "pvp", "total"]),
    pveFame: getNestedNumber(record, ["LifetimeStatistics", "PvE", "Total"], ["lifetimeStatistics", "pve", "total"], ["PvE", "Total"], ["pve", "total"]),
    gatheringFame: getNestedNumber(
      record,
      ["LifetimeStatistics", "Gathering", "All", "Total"],
      ["LifetimeStatistics", "Gathering", "Total"],
      ["lifetimeStatistics", "gathering", "all", "total"],
      ["lifetimeStatistics", "gathering", "total"],
      ["Gathering", "All", "Total"],
      ["Gathering", "Total"]
    ),
    refiningFame: getNestedNumber(
      record,
      ["LifetimeStatistics", "Crafting", "Total"],
      ["LifetimeStatistics", "Refining", "Total"],
      ["lifetimeStatistics", "crafting", "total"],
      ["lifetimeStatistics", "refining", "total"],
      ["Crafting", "Total"],
      ["Refining", "Total"]
    ),
    totalFame: getNestedNumber(record, ["LifetimeStatistics", "Total"], ["lifetimeStatistics", "total"], ["TotalFame"], ["totalFame"])
  };
}

function normalizeAlliance(value: unknown): AlbionAlliance {
  const record = toRecord(value);
  const id = requireString(record, "AllianceId", "allianceId", "Id", "id");
  const name = requireString(record, "AllianceName", "allianceName", "Name", "name");
  const guildValues = Array.isArray(record.Guilds)
    ? record.Guilds
    : Array.isArray(record.guilds)
      ? record.guilds
      : [];

  return {
    id,
    name,
    tag: getString(record, "AllianceTag", "allianceTag", "Tag", "tag"),
    guilds: guildValues.map((guildValue) => {
      const guildRecord = toRecord(guildValue);
      const guildId = getString(guildRecord, "Id", "id");
      const guildName = getString(guildRecord, "Name", "name");
      return guildId && guildName ? { id: guildId, name: guildName } : undefined;
    }).filter(isDefined)
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }

  return undefined;
}

function getNestedNumber(record: Record<string, unknown>, ...paths: string[][]): number | undefined {
  for (const path of paths) {
    let current: unknown = record;

    for (const key of path) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }

    const number = toNumber(current);
    if (number !== undefined) {
      return number;
    }
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }

  return undefined;
}

function requireString(record: Record<string, unknown>, ...keys: string[]): string {
  const value = getString(record, ...keys);

  if (!value) {
    throw new Error(`Albion API response is missing ${keys.join("/")}`);
  }

  return value;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
