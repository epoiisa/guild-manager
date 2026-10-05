import assert from "node:assert/strict";
import test from "node:test";
import { provisionContent } from "./hosting.js";
function fixture(fail: "pin" | "cleanup" | "fence" | "host-controls" | undefined) {
  const calls: string[] = [];
  let validations = 0;
  const sends: unknown[] = [];
  const snapshot: any = {
    content: {
      contentId: "party",
      state: "unscheduled",
      hostDiscordUserId: "host",
      title: "Party",
      description: "",
      scheduledStartAt: null,
    },
    slots: [{ contentRoleSlotId: "slot", label: "Tank" }],
    signups: [],
  };
  const thread = {
    id: "thread",
    send: async (payload: unknown) => {
      sends.push(payload);
      const roles = JSON.stringify(payload).includes("# Roles");
      if (!roles && fail === "host-controls") throw Error("send denied");
      return {
        id: roles ? "roles" : "details",
        pin: async () => {
          if (fail === "pin" || fail === "cleanup") throw Error("pin denied");
        },
      };
    },
    delete: async () => {
      calls.push("thread");
      if (fail === "cleanup") throw Error("network");
    },
  };
  const options = {
    repository: {
      createContent: async () => snapshot,
      setContentMessageIds: async () => {
        calls.push("saved");
      },
      deleteContent: async () => {
        calls.push("record");
      },
    },
    logger: { info() {} },
    parentChannel: {
      id: "channel",
      send: async () => ({
        id: "post",
        createdAt: new Date(),
        startThread: async () => thread,
        delete: async () => {
          calls.push("post");
        },
      }),
    },
    guildId: "guild",
    hostUserId: "host",
    title: "Party",
    description: "",
    roleLabels: ["Tank"],
    scheduledStartAt: null,
    validate: async () => {
      validations++;
      if (fail === "fence" && validations === 4) throw Error("reset");
    },
  } as unknown as Parameters<typeof provisionContent>[0];
  return { options, calls, sends };
}
test("incomplete provisioning cleans record, thread and announcement", async () => {
  const f = fixture("pin");
  await assert.rejects(provisionContent(f.options), /pin denied/);
  assert.deepEqual(f.calls, ["record", "thread", "post"]);
});
test("uncertain rollback is explicit and cannot be mistaken for safe retry", async () => {
  const f = fixture("cleanup");
  await assert.rejects(provisionContent(f.options), /cleanup is uncertain/);
  assert.deepEqual(f.calls, ["record", "thread", "post"]);
});
test("reset fence after save rolls back an invalidated in-flight publication", async () => {
  const f = fixture("fence");
  await assert.rejects(provisionContent(f.options), /reset/);
  assert.deepEqual(f.calls, ["saved", "record", "thread", "post"]);
});
test("successful provisioning returns the announcement link without a confirmation side effect", async () => {
  const f = fixture(undefined);
  const result = await provisionContent(f.options);
  assert.equal(
    result.announcementUrl,
    "https://discord.com/channels/guild/channel/post",
  );
  assert.deepEqual(f.calls, ["saved"]);
  assert.equal(f.sends.length, 2);
  assert.match(JSON.stringify(f.sends[0]), /content:edit:party/);
  assert.doesNotMatch(JSON.stringify(f.sends[0]), /content:(join|standby|leave):party/);
  assert.match(JSON.stringify(f.sends[1]), /# Roles/);
  assert.match(JSON.stringify(f.sends[1]), /content:join:party.*content:standby:party.*content:leave:party/);
  assert.doesNotMatch(JSON.stringify(f.sends[1]), /content:edit:/);
});

test("failed host-control publication rolls back incomplete provisioning", async () => {
  const f = fixture("host-controls");
  await assert.rejects(provisionContent(f.options), /send denied/);
  assert.deepEqual(f.calls, ["record", "thread", "post"]);
});

for (const approvalRequired of [undefined, false, true]) {
  test(`provisioning persists approval=${approvalRequired} with default off`, async () => {
    const f = fixture(undefined);
    const original = f.options.repository.createContent;
    let saved: boolean | undefined;
    f.options.repository.createContent = async (input) => {
      saved = input.approvalRequired;
      return original(input);
    };
    await provisionContent({ ...f.options, approvalRequired });
    assert.equal(saved, approvalRequired ?? false);
  });
}

for (const [approvalRequired, length, rejected] of [[true, 1851, true], [true, 1850, false], [false, 1851, false]] as const) {
  test(`provisioning approval=${approvalRequired} role length ${length} ${rejected ? "rejects before publication" : "is allowed"}`, async () => {
    const f = fixture(undefined);
    let published = 0;
    const send = f.options.parentChannel.send;
    f.options.parentChannel.send = async (...args) => {
      published++;
      return send(...args);
    };
    const operation = provisionContent({ ...f.options, approvalRequired, roleLabels: ["a".repeat(length)] });
    if (rejected) {
      await assert.rejects(operation, { message: "Keep each role to 1,850 characters or fewer when host approval is required." });
      assert.equal(published, 0);
      assert.deepEqual(f.calls, []);
    } else {
      await operation;
      assert.equal(published, 1);
    }
  });
}
