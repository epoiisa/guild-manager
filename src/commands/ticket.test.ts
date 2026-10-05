import assert from "node:assert/strict";
import test from "node:test";
import { buildTicketChannelName, ticketCommand, ticketsCommand } from "./ticket.js";

test("ticket builders remain hidden and separate administrative and operational surfaces", () => {
  const command = ticketCommand.toJSON();
  assert.equal(command.name, "ticket");
  assert.equal(command.default_member_permissions, "0");
  assert.deepEqual(command.options?.map((option) => option.name), ["close", "reopen", "delete"]);
  const configuration = ticketsCommand.toJSON();
  assert.equal(configuration.name, "tickets");
  assert.equal(configuration.default_member_permissions, "0");
  assert.deepEqual(configuration.options?.map((option) => option.name), ["list", "show", "create", "button", "messages", "disable", "remove"]);
  const messages = configuration.options?.find((option) => option.name === "messages") as { options?: Array<{ name: string }> } | undefined;
  assert.deepEqual(messages?.options?.map((option) => option.name), ["set", "clear"]);
  for (const name of ["close", "reopen", "delete"]) {
    const option = command.options?.find((candidate) => candidate.name === name) as { options?: Array<{ type?: number; name?: string; description?: string; required?: boolean; autocomplete?: boolean }> } | undefined;
    assert.deepEqual(option?.options?.map((value) => ({ type: value.type, name: value.name, description: value.description, required: value.required, autocomplete: value.autocomplete })), [{ type: 3, name: "ticket", description: "Ticket target; omit in its ticket channel.", required: false, autocomplete: true }]);
  }
});

test("ticket channel names use the class and opener without a database ID", () => {
  assert.equal(buildTicketChannelName("General Help", "Luke Janicke"), "general-help-luke-janicke");
});
