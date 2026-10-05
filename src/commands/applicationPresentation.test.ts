import assert from "node:assert/strict";
import test from "node:test";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ContainerBuilder, EmbedBuilder, MessageFlags, TextDisplayBuilder, type Message } from "discord.js";
import { buildApplicationChannelName, buildApplicationV2Card, formatApplicationGroup } from "./application.js";
import { rerenderApplicationMessage } from "../services/applications/controlPresentation.js";
import { retireIntakeMessageControls, withoutApplicationControls } from "../services/applications/intakePresentation.js";

test("application channel names use the class and applicant without a database ID", () => {
  assert.equal(buildApplicationChannelName("Guild Application", "Luke Janicke"), "application-guild-application-luke-janicke");
});

test("application group fallback does not expose the stored database ID", () => {
  assert.equal(formatApplicationGroup(undefined, "42"), "Unavailable");
  assert.equal(formatApplicationGroup(undefined, undefined), "Not configured");
});

test("opening application card uses administrative mentions and notifies only its applicant and reviewers", () => {
  const card = buildApplicationV2Card(
    new EmbedBuilder().setColor(0x123456).setTitle("Application").addFields(
      { name: "Applicant", value: "Character • <@applicant>" },
      { name: "Reviewers", value: "<@&reviewer>" }
    ),
    [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("app:accept:1").setLabel("Accept").setStyle(ButtonStyle.Success))],
    { openingMentions: { applicantId: "applicant", reviewerRoleId: "reviewer" } }
  );
  assert.equal(card.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(card.allowedMentions, { parse: [], users: ["applicant"], roles: ["reviewer"], repliedUser: false });
  assert.equal(card.content, undefined);
  assert.equal(card.embeds, undefined);
  const json = (card.components![0] as { toJSON(): { components: Array<{ content?: string; components?: Array<{ custom_id?: string }> }> } }).toJSON();
  assert.equal(json.components[0]?.content, "# Application");
  assert.equal(json.components.some((component) => component.content?.includes("A new application has been opened.")), false);
  assert.equal(json.components[1]?.content, "**Applicant**\nCharacter • <@applicant>");
  assert.equal(json.components[2]?.content, "**Reviewers**\n<@&reviewer>");
  assert.equal(json.components.at(-1)?.components?.[0]?.custom_id, "app:accept:1");
});

import type { ApplicationClass, OpenApplication } from "../db/applicationRepository.js";
import { buildApplicationIntakeCard, buildApplicationCharacterSelectRow, buildApplicationAnswerMessages } from "../services/applications/rendering.js";

const appClass = { name: "Fallback", reviewerRoleId: "reviewer", albionServer: "europe", initialMessage: "Should be separate" } as ApplicationClass;
const intake = { applicationId: "id", applicantDiscordUserId: "applicant", submittedCharacterName: "Query", characterResolutionState: "unresolved", characterSearchAttemptCount: 2, targetMemberGroupName: "Target", targetMemberGroupType: "guild", modalAnswers: [{ question: "Question", answer: "Answer" }] } as OpenApplication;
const payloadJSON = (payload: unknown) => JSON.parse(JSON.stringify(payload));

test("unified selection card has exact target heading, selection prompt, controls and suppressed mentions", () => {
  const payload = buildApplicationIntakeCard(appClass, intake, undefined, { players: [{ id: "player", name: "Resolved" }] });
  const card = payloadJSON(payload).components[0];
  assert.deepEqual(card.components.slice(0, 3).map((item: any) => item.content), [
    "# Target Application",
    "<@applicant>, please select your character from the dropdown menu below.",
    "*The applicant can withdraw this application. Reviewers can close it.*",
  ]);
  assert.equal(card.components[3].components[0].placeholder, "Choose your character");
  assert.equal(card.components[3].components[0].custom_id, "app:character:id:2");
  assert.deepEqual(card.components[4].components.map((item: any) => item.label), ["Retry Character Search", "Close", "Withdraw"]);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("selected summary uses full resolved identity and approved field and button order", () => {
  const payload = buildApplicationIntakeCard(appClass, { ...intake, characterResolutionState: "selected", selectedAlbionCharacterId: "player", selectedCharacterName: "Exact Name" });
  const components = payloadJSON(payload).components[0].components;
  assert.deepEqual(components.slice(0, 6).map((item: any) => item.content), [
    "# Target Application", "**Applicant**\n<@applicant>", "**Character**\nExact Name • Europe • `player` • [AlbionDB](https://europe.albiondb.net/player/Exact%20Name) • [Killboard1](https://killboard-1.com/eu/player/Exact%20Name)", "**Guild**\nTarget • guild • Europe", "**Reviewers**\n<@&reviewer>",
    "*The applicant can withdraw this application. Reviewers can close, accept, or reject it.*",
  ]);
  assert.deepEqual(components[6].components.map((item: any) => item.label), ["Retry Character Search", "Withdraw", "Close", "Accept", "Reject"]);
  assert.equal(JSON.stringify(components).includes("Should be separate"), false);
  assert.equal(JSON.stringify(components).includes("Query"), false);

  for (const [guildName, allianceName, allianceTag, expected] of [
    ["Dreamweavers", "GUCHI", undefined, "AAZUM • Dreamweavers • GUCHI • Asia • `Q3a5Oq2qQi6ujmL3HqYiWA`"],
    ["Dreamweavers", undefined, undefined, "AAZUM • Dreamweavers • Asia • `Q3a5Oq2qQi6ujmL3HqYiWA`"],
    [undefined, "GUCHI", undefined, "AAZUM • GUCHI • Asia • `Q3a5Oq2qQi6ujmL3HqYiWA`"],
    [" ", "", undefined, "AAZUM • Asia • `Q3a5Oq2qQi6ujmL3HqYiWA`"],
    ["Dreamweavers", "Alliance", "TAG", "AAZUM • Dreamweavers • Alliance [TAG] • Asia • `Q3a5Oq2qQi6ujmL3HqYiWA`"],
    [undefined, undefined, "TAG", "AAZUM • [TAG] • Asia • `Q3a5Oq2qQi6ujmL3HqYiWA`"],
  ]) {
    const summary = buildApplicationIntakeCard({ ...appClass, albionServer: "asia" }, {
      ...intake,
      targetMemberGroupName: "Registered",
      targetMemberGroupType: "group",
      characterResolutionState: "selected",
      selectedAlbionCharacterId: "Q3a5Oq2qQi6ujmL3HqYiWA",
      selectedCharacterName: "AAZUM",
      selectedCharacterGuildName: guildName,
      selectedCharacterAllianceName: allianceName,
      selectedCharacterAllianceTag: allianceTag,
    });
    const fields = payloadJSON(summary).components[0].components;
    assert.equal(fields[2].content, `**Character**\n${expected} • [AlbionDB](https://east.albiondb.net/player/AAZUM) • [Killboard1](https://killboard-1.com/as/player/AAZUM)`);
    assert.equal(fields[3].content, "**Group**\nRegistered • group • Asia");
  }
});

test("selected state without an exact resolved identity cannot expose decision buttons", () => {
  const components = payloadJSON(buildApplicationIntakeCard(appClass, { ...intake, characterResolutionState: "selected", selectedAlbionCharacterId: "player" })).components[0].components;
  assert.deepEqual(components.at(-1).components.map((item: any) => item.label), ["Retry Character Search", "Close", "Withdraw"]);
});

test("candidate menus reserve the final option and preserve distinguishing identity descriptions", () => {
  const players = Array.from({ length: 30 }, (_, index) => ({ id: `id-${index}`, name: "Same", guildName: "Guild".repeat(20), allianceName: "Alliance".repeat(20) }));
  const row = buildApplicationCharacterSelectRow("europe", "id", players).toJSON();
  const options = (row.components[0] as any).options;
  assert.equal(options.length, 25);
  assert.equal(options[24].label, "My character is not shown here");
  assert.ok(options[23].description.endsWith("Europe • id-23"));
  assert.ok(options.every((item: any) => !item.description || item.description.length <= 100));
});

test("answer messages preserve full long answers without exceeding combined Text Display budget", () => {
  const answers = [{ question: "Large", answer: "😀".repeat(5000) }, { question: "Empty", answer: "" }, { question: "Last", answer: "tail" }];
  const messages = buildApplicationAnswerMessages(answers).map(payloadJSON);
  const texts: string[] = [];
  for (const message of messages) {
    const content = message.components[0].components.map((item: any) => item.content as string);
    assert.ok(content.reduce((sum: number, part: string) => sum + part.length, 0) <= 4000);
    texts.push(...content.slice(1));
  }
  assert.equal(texts.join(""), "**Large**\n" + "😀".repeat(5000) + "**Last**\ntail");
});

test("application edits cannot opt into fresh mention notifications", () => {
  const payload = buildApplicationV2Card(new EmbedBuilder().setTitle("Application"), [], { edit: true, openingMentions: { applicantId: "applicant", reviewerRoleId: "reviewer" } });
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("initial searching card notifies only its applicant", () => {
  const payload = buildApplicationIntakeCard(appClass, intake, undefined, { searching: true, openingApplicantId: "applicant" });
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false, users: ["applicant"] });
});

test("current conflicting ownership removes decision controls despite retained selected state", () => {
  const payload = buildApplicationIntakeCard(appClass, { ...intake, characterResolutionState: "selected", selectedAlbionCharacterId: "player", selectedCharacterName: "Exact Name", selectedCharacterOwnerDiscordUserId: "different-user" });
  assert.deepEqual(payloadJSON(payload).components[0].components.at(-1).components.map((button: any) => button.label), ["Retry Character Search", "Close", "Withdraw"]);
});

test("retiring current and legacy application cards removes control guidance and preserves history", async () => {
  const guidance = [
    "The applicant can withdraw this application. Reviewers can close it.",
    "The applicant can withdraw this application. Reviewers can close, accept, or reject it.",
    "Reviewers can accept or reject this application. The applicant can withdraw it.",
    "The applicant or reviewers can retry the search and select or change the character.",
    "Reviewers can verify membership or cancel this application.",
    "The applicant or reviewers can close this channel.",
    "The applicant or reviewers can reopen this channel. Reviewers can delete it.",
    "Reviewers only.",
  ];
  const controls = [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("app:close:id").setLabel("Close").setStyle(ButtonStyle.Secondary),
  )];
  for (const footer of guidance) {
    const embed = new EmbedBuilder().setTitle("Application history").setColor(0x123456)
      .setDescription("Keep **configured instructions** and decision attribution.")
      .addFields({ name: "Applicant", value: "<@applicant>" }).setFooter({ text: footer });
    const activeCard = buildApplicationV2Card(embed, controls);
    assert.ok(JSON.stringify(payloadJSON(activeCard)).includes(`*${footer}*`));
    for (const legacy of [false, true]) {
      for (const retire of [retireIntakeMessageControls, (message: Message) => rerenderApplicationMessage(message, undefined, [])]) {
        let edited: unknown;
        const message = {
          content: "", embeds: legacy ? [embed] : [],
          components: payloadJSON(legacy ? controls : activeCard.components),
          edit: async (payload: unknown) => { edited = payload; },
        } as unknown as Message;
        await retire(message);
        const json = payloadJSON(edited);
        const serialized = JSON.stringify(json);
        assert.equal(serialized.includes(footer), false, footer);
        assert.equal(serialized.includes("app:close:id"), false);
        assert.ok(serialized.includes("Keep **configured instructions** and decision attribution."));
        assert.ok(serialized.includes("Application history"));
        assert.ok(serialized.includes("<@applicant>"));
        assert.deepEqual(json.allowedMentions, { parse: [], repliedUser: false });
        if (!legacy) assert.equal(json.components[0].accent_color, 0x123456);
        assert.equal(embed.toJSON().footer?.text, footer, "retirement must not mutate the source embed");
      }
    }
  }
});

test("buttonless application updates omit control guidance while retaining informational footers", () => {
  const waiting = new EmbedBuilder().setTitle("Waiting For In-Game Membership")
    .setFooter({ text: "Reviewers can verify membership or cancel this application." });
  assert.deepEqual(payloadJSON(buildApplicationV2Card(waiting)).components[0].components,
    [{ type: ComponentType.TextDisplay, content: "# Waiting For In-Game Membership" }]);
  const informational = new EmbedBuilder().setTitle("Application history").setFooter({ text: "Recorded on 8 September." });
  assert.equal(payloadJSON(buildApplicationV2Card(informational)).components[0].components.at(-1).content, "*Recorded on 8 September.*");
});

test("retired legacy snapshots omit guidance without deleting configured text or unrelated footers", () => {
  const text = "*The applicant or reviewers can close this channel.*";
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent("# Application"),
    new TextDisplayBuilder().setContent(text),
    new TextDisplayBuilder().setContent("**Answer**\nRetain every answer."),
    new TextDisplayBuilder().setContent(text),
  ).addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("app:close:id").setLabel("Close").setStyle(ButtonStyle.Secondary),
  ));
  const instructions = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  const retired = payloadJSON(withoutApplicationControls({ components: payloadJSON([container, instructions]), embeds: [] } as unknown as Message));
  assert.deepEqual(retired.components[0].components.map((item: { content: string }) => item.content),
    ["# Application", text, "**Answer**\nRetain every answer."]);
  assert.equal(retired.components[1].components[0].content, text);
  const legacy = withoutApplicationControls({
    content: "Keep this message text.", components: [],
    embeds: [new EmbedBuilder().setTitle("Application").setDescription("Keep configured instructions.")
      .setFooter({ text: "Reviewers can accept or reject this application. The applicant can withdraw it." }),
    new EmbedBuilder().setTitle("Historical metadata").setFooter({ text: "Recorded on 8 September." })],
  } as unknown as Message);
  const json = payloadJSON(legacy);
  assert.equal(json.content, "Keep this message text.");
  assert.equal(json.embeds[0].description, "Keep configured instructions.");
  assert.equal(json.embeds[0].footer, undefined);
  assert.equal(json.embeds[1].footer.text, "Recorded on 8 September.");
});
