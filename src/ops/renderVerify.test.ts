import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION } from "../db/schema.js";
import { activeGuildCommands } from "../discord/commands.js";
import {
  EXPECTED_ACTIVE_COMMAND_COUNT,
  MINIMUM_COMPATIBLE_SCHEMA_VERSION,
  assertCompatibleSchemaVersion
} from "./renderVerify.js";

test("Render verification command count matches the registered active surface", () => {
  assert.equal(EXPECTED_ACTIVE_COMMAND_COUNT, 50);
  assert.equal(activeGuildCommands.length, EXPECTED_ACTIVE_COMMAND_COUNT);
});

test("Render verification accepts every schema version on the supported migration path", () => {
  for (let schemaVersion = MINIMUM_COMPATIBLE_SCHEMA_VERSION; schemaVersion <= CURRENT_SCHEMA_VERSION; schemaVersion += 1) {
    assert.doesNotThrow(() => assertCompatibleSchemaVersion(schemaVersion));
  }
});

test("Render verification rejects older and future schema versions", () => {
  assert.throws(
    () => assertCompatibleSchemaVersion(MINIMUM_COMPATIBLE_SCHEMA_VERSION - 1),
    new Error(
      `Expected schema version ${MINIMUM_COMPATIBLE_SCHEMA_VERSION} through ${CURRENT_SCHEMA_VERSION}, found ${MINIMUM_COMPATIBLE_SCHEMA_VERSION - 1}`
    )
  );
  assert.throws(
    () => assertCompatibleSchemaVersion(CURRENT_SCHEMA_VERSION + 1),
    new Error(
      `Expected schema version ${MINIMUM_COMPATIBLE_SCHEMA_VERSION} through ${CURRENT_SCHEMA_VERSION}, found ${CURRENT_SCHEMA_VERSION + 1}`
    )
  );
});
