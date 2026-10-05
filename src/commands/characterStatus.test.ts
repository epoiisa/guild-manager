import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterStatusResponse, characterStatusSections, handleCharacterStatusCommand, parseCharacterStatusSelection } from './characterStatus.js';
import { characterCommand, handleCharacterAutocomplete, handleCharacterCommand } from './character.js';
import type { CharacterStatusSnapshot } from '../db/characterStatusRepository.js';
const snapshot = (patch: Partial<CharacterStatusSnapshot> = {}): CharacterStatusSnapshot => ({ discordGuildId: 'guild', albionServer: 'asia', albionCharacterId: 'exact-id', characterName: 'SameName', registration: 'unregistered', activeMembership: false, financialSuspended: false, memberships: [], pendingRegears: 2, pendingSpecialisations: 3, ...patch });
const text = (s: CharacterStatusSnapshot) => characterStatusSections(s, new Date('2026-10-01')).join('\n');
test('hidden status registration and exact server identity', () => {
  assert.equal(characterCommand.toJSON().default_member_permissions, '0');
  assert.ok(characterCommand.toJSON().options?.some(o => o.name === 'status'));
  assert.deepEqual(parseCharacterStatusSelection('asia:exact-id'), { albionServer: 'asia', albionCharacterId: 'exact-id' });
  for (const value of ['all:id', 'asia:', 'Name', 'asia:id:extra', 'asia:with space']) assert.equal(parseCharacterStatusSelection(value), undefined);
});
test('lifecycle-only purged report has no invented expiry or owner and exact Pending counts', () => {
  const output = text(snapshot({ registration: 'purged', source: 'purge', formerOwner: 'former-owner', purgedAt: new Date('2026-09-01'), expiresAt: new Date('2026-09-04') }));
  assert.match(output, /## Registration\nNot registered\./);
  assert.match(output, /Registration purged <t:1788220800:F>\. Officer reconnection required\./);
  assert.doesNotMatch(output, /former-owner|former owner|deadline|1788480000/);
  assert.match(output, /No account\.\n2 pending re-gear requests\.\n3 pending weapon specialisation requests\./);
});
test('overdue unswept hold reports forfeiture while preserving exact stored bigint balance', () => {
  const output = text(snapshot({ registration: 'hold', expiresAt: new Date('2026-09-01'), account: { status: 'open', balance: 9007199254740993123n }, activeMembership: true,
    memberships: [{ groupId: '1', groupName: 'Retained', groupType: 'group', state: 'current', preserved: true, appointments: [] }] }));
  assert.match(output, /Registration hold expired <t:1788220800:F>\. Retained entitlements forfeited\./);
  assert.match(output, /Account open • Balance 9,007,199,254,740,993,123/);
  assert.match(output, /Current • Inactive • Forfeited/);
});
test('memberships retain independent departure boundaries and inactive appointment details', () => {
  const output = text(snapshot({ currentOwner: 'owner', registration: 'registered', account: { status: 'open', balance: 7n }, activeMembership: true,
    memberships: [{ groupId: '1', groupName: 'One', groupType: 'guild', state: 'departed', preserved: true, formerOwner: 'former-owner', detectedAt: '2026-09-29', expiresAt: '2026-10-02', appointments: [{ name: 'Leader', roleId: 'role', appointedAt: '2026-09-01' }] }, { groupId: '2', groupName: 'Two', groupType: 'alliance', state: 'departed', preserved: true, expiresAt: '2026-10-03', appointments: [] }] }));
  assert.match(output, /\*\*One\*\* • guild\nDeparted • Inactive • Preserved\nEligible for cleanup from <t:1790899200:F>\.\nLeader • <@&role> • Inactive/);
  assert.match(output, /\*\*Two\*\* • alliance\nDeparted • Inactive • Preserved\nEligible for cleanup from <t:1790985600:F>\./);
  assert.doesNotMatch(output, /former-owner|appointed|1788220800|:R>|Departure detected|Minimum cleanup boundary|Appointments: None/);
});
test('overflow keeps every record in complete attachment and suppresses notifications', () => {
  const s = snapshot({ memberships: Array.from({ length: 80 }, (_, i) => ({ groupId: String(i), groupName: `Group ${i}`, groupType: 'group', state: 'manual', preserved: true, appointments: [] })) });
  const response = buildCharacterStatusResponse(s); assert.equal(response.files.length, 1); assert.match((response.files[0]!.attachment as Buffer).toString(), /Group 79/); assert.deepEqual(response.allowedMentions, { parse: [], repliedUser: false });
});
test('malformed and stale selections safely only read', async () => {
  let reads = 0; const repository = { getCharacterStatus: async () => { reads++; return undefined; } };
  const interaction = (value: string) => ({ guildId: 'guild', options: { getString: () => value }, reply: async () => {}, deferReply: async () => {}, editReply: async () => {} });
  await handleCharacterStatusCommand(interaction('bad') as never, repository as never); assert.equal(reads, 0);
  await handleCharacterStatusCommand(interaction('asia:id') as never, repository as never); assert.equal(reads, 1);
});
test('router uses stored repository only; same-name autocomplete keeps server-qualified identity', async () => {
  let reads = 0; let choices: unknown;
  const repository = { getCharacterStatus: async () => { reads++; return snapshot(); }, listCharacterStatusChoices: async () => [{ characterName: 'SameName', albionServer: 'asia', albionCharacterId: 'id' }, { characterName: 'SameName', albionServer: 'europe', albionCharacterId: 'id' }] };
  const options = { getSubcommandGroup: () => null, getSubcommand: () => 'status', getString: () => 'asia:id', getFocused: () => ({ name: 'character', value: 'Same' }) };
  await handleCharacterCommand({ inGuild: () => true, guildId: 'guild', options, deferReply: async () => {}, editReply: async () => {} } as never, new Proxy({}, { get() { throw Error('No Albion Online API allowed'); } }) as never, repository as never); assert.equal(reads, 1);
  await handleCharacterAutocomplete({ commandName: 'character', guildId: 'guild', options, respond: async (c: unknown) => { choices = c; } } as never, repository as never);
  assert.deepEqual((choices as { value: string }[]).map(c => c.value), ['asia:id','europe:id']);
});

test('manual orphan keeps the account condition and disconnected membership without action eligibility prose', () => {
  const output = text(snapshot({ account: { status: 'open', balance: 42n }, memberships: [{ groupId: '1', groupName: 'Manual', groupType: 'group', state: 'manual', preserved: true, appointments: [] }] }));
  assert.match(output, /Not registered\./);
  assert.match(output, /\*\*Manual\*\* • group\nDisconnected • Inactive • Preserved/);
  assert.match(output, /Account open • Balance 42/);
  assert.doesNotMatch(output, /Manager balance mutations|Owner account transfers|Recovery Consequences|Registration alone|Fresh managed-roster|Losing the final entitlement/);
});

test('kick status distinguishes preserved records and pending cleanup from forfeiture', () => {
  const output = text(snapshot({ registration: 'kicked', source: 'kick', formerOwner: 'owner', kickCleanupPending: true, account: { status: 'open', balance: 123n } }));
  assert.match(output, /Not registered\.\nKicked\.\nKick cleanup pending; officer reconnection blocked\./);
  assert.match(output, /Account open • Balance 123/);
  assert.doesNotMatch(output, /<@owner>|Forfeited|forfeits|authority|Recovery Consequences/);
  assert.match(text(snapshot({ registration: 'kicked', kickCleanupPending: false })), /Kicked\.\nOfficer reconnection required\./);
});

test('compact registered report keeps separate position lines and exact zero request wording', () => {
  const output = text(snapshot({ currentOwner: 'owner', formerOwner: 'former-owner', registration: 'registered', account: { status: 'open', balance: 3500000n }, pendingRegears: 0, pendingSpecialisations: 0,
    memberships: [{ groupId: '1', groupName: 'Frostborn Exiles', groupType: 'guild', state: 'current', owner: 'owner', preserved: true,
      appointments: [{ name: 'Officer', roleId: 'officers', appointedAt: '2026-08-15' }, { name: 'Quartermaster', roleId: 'quartermasters', appointedAt: '2026-09-15' }] }] }));
  assert.match(output, /^# Character Status\nSameName • Asia • `exact-id`\n## Registration\nRegistered to <@owner>\./);
  assert.match(output, /\*\*Frostborn Exiles\*\* • guild\nActive\nOfficer • <@&officers>\nQuartermaster • <@&quartermasters>/);
  assert.match(output, /### Account and Requests\nAccount open • Balance 3,500,000\nNo pending re-gear requests\.\nNo pending weapon specialisation requests\.$/);
  assert.doesNotMatch(output, /former-owner|State:|Preserved|appointed|:R>|Manager balance mutations|Owner account transfers|Recovery Consequences/);
});

test('current membership alone never implies access and unregistered observations retain no entitlement', () => {
  const membership = { groupId: '1', groupName: 'One', groupType: 'group' as const, state: 'current' as const, owner: 'owner', preserved: true, appointments: [] };
  for (const patch of [{ currentOwner: undefined }, { currentOwner: 'other-owner' }, { financialSuspended: true }]) {
    assert.match(text(snapshot({ registration: 'registered', currentOwner: 'owner', memberships: [membership], ...patch })), /Current • Inactive • Preserved/);
  }
  assert.match(text(snapshot({ memberships: [{ ...membership, state: 'unregistered', owner: undefined, preserved: false }] })), /Unregistered • Inactive • Not preserved/);
});

test('account conditions and singular request counts do not duplicate registration or membership restrictions', () => {
  for (const status of ['open', 'frozen', 'closed'] as const) {
    const sections = characterStatusSections(snapshot({ account: { status, balance: 0n }, financialSuspended: true, pendingRegears: 1, pendingSpecialisations: 1 }));
    assert.equal(sections[3], `### Account and Requests\nAccount ${status} • Balance 0\n1 pending re-gear request.\n1 pending weapon specialisation request.`);
  }
});

test('registration hold deadline stays separate from membership cleanup eligibility', () => {
  const output = text(snapshot({ registration: 'hold', expiresAt: new Date('2026-10-04'), financialSuspended: true,
    memberships: [{ groupId: '1', groupName: 'One', groupType: 'guild', state: 'departed', preserved: true, expiresAt: '2026-10-02', appointments: [] }] }));
  assert.match(output, /Registration on hold until <t:1791072000:F>\.\nOfficer reconnection required\./);
  assert.match(output, /Departed • Inactive • Preserved\nEligible for cleanup from <t:1790899200:F>\./);
  assert.doesNotMatch(output, /:R>|expired|Forfeited/);
  assert.match(text(snapshot({ registration: 'abandoned' })), /Not registered\.\nRegistration abandoned\. Officer reconnection required\./);
});
