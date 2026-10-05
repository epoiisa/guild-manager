import { AttachmentBuilder, ContainerBuilder, FileBuilder, MessageFlags, TextDisplayBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CharacterStatusSnapshot, createCharacterStatusRepository } from '../db/characterStatusRepository.js';
import { getAlbionServerLabel, isAlbionServer } from '../services/albion/servers.js';
import { editFeedback, feedbackReply } from '../discord/feedbackMessages.js';
import { REPORT_COLOR } from './configurationHelpers.js';

export function parseCharacterStatusSelection(value: string) {
  const parts = value.split(':');
  return parts.length === 2 && isAlbionServer(parts[0]!) && /^[A-Za-z0-9_-]+$/.test(parts[1]!)
    ? { albionServer: parts[0], albionCharacterId: parts[1]! } : undefined;
}
export async function handleCharacterStatusCommand(interaction: ChatInputCommandInteraction, repository: ReturnType<typeof createCharacterStatusRepository>): Promise<void> {
  if (!interaction.guildId) return;
  const selected = parseCharacterStatusSelection(interaction.options.getString('character', true));
  if (!selected) {
    await interaction.reply(feedbackReply({ text: 'Select an exact stored Albion Online character from autocomplete.', flags: MessageFlags.Ephemeral }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const snapshot = await repository.getCharacterStatus(interaction.guildId, selected.albionServer, selected.albionCharacterId);
  if (!snapshot) {
    await editFeedback(interaction, { text: 'This Albion Online character has no stored state in this Discord server. Select a current autocomplete result.' });
    return;
  }
  await interaction.editReply(buildCharacterStatusResponse(snapshot));
}

export function characterStatusSections(s: CharacterStatusSnapshot, now = new Date()): string[] {
  const overdue = s.registration === 'hold' && !!s.expiresAt && s.expiresAt <= now;
  const terminal = s.registration === 'purged' || s.registration === 'abandoned' || overdue;
  const kicked = s.registration === 'kicked';
  const registration = [
    '## Registration',
    s.currentOwner ? `Registered to <@${s.currentOwner}>.` : 'Not registered.',
    ...(s.registration === 'hold' ? [
      overdue
        ? `Registration hold expired ${timestamp(s.expiresAt!)}. Retained entitlements forfeited.`
        : s.expiresAt ? `Registration on hold until ${timestamp(s.expiresAt)}.` : 'Registration on hold; deadline unavailable.',
      'Officer reconnection required.'
    ] : []),
    ...(s.registration === 'abandoned' ? ['Registration abandoned. Officer reconnection required.'] : []),
    ...(s.registration === 'purged' ? [`Registration purged${s.purgedAt ? ` ${timestamp(s.purgedAt)}` : ''}. Officer reconnection required.`] : []),
    ...(kicked ? [
      `Kicked${s.detectedAt ? ` ${timestamp(s.detectedAt)}` : ''}.`,
      s.kickCleanupPending ? 'Kick cleanup pending; officer reconnection blocked.' : 'Officer reconnection required.'
    ] : [])
  ].join('\n');
  const membershipStates = { current: 'Current', manual: 'Disconnected', unregistered: 'Unregistered', departed: 'Departed' };
  const membershipLines = s.memberships.map(p => {
    const active = !terminal && !s.financialSuspended && !!s.currentOwner && p.owner === s.currentOwner && p.state === 'current' && p.preserved;
    return [
      `**${escape(p.groupName)}** • ${p.groupType}`,
      active ? 'Active' : `${membershipStates[p.state]} • Inactive • ${terminal ? 'Forfeited' : p.preserved ? 'Preserved' : 'Not preserved'}`,
      ...(p.state === 'departed' ? [p.expiresAt ? `Eligible for cleanup from ${timestamp(p.expiresAt)}.` : 'Cleanup eligibility date unavailable.'] : []),
      ...p.appointments.map(a => `${escape(a.name)} • <@&${a.roleId}>${active ? '' : ' • Inactive'}`)
    ].join('\n');
  });
  return [
    `# Character Status\n${escape(s.characterName)} • ${getAlbionServerLabel(s.albionServer)} • \`${s.albionCharacterId}\``,
    registration,
    `## Memberships (${s.memberships.length})\n${membershipLines.length ? membershipLines.join('\n\n') : 'None'}`,
    [
      '### Account and Requests',
      s.account ? `Account ${s.account.status} • Balance ${s.account.balance.toLocaleString('en-US')}` : 'No account.',
      pendingRequests(s.pendingRegears, 're-gear'),
      pendingRequests(s.pendingSpecialisations, 'weapon specialisation')
    ].join('\n')
  ];
}
export function buildCharacterStatusResponse(snapshot: CharacterStatusSnapshot, now = new Date()) {
  const sections = characterStatusSections(snapshot, now);
  const overflow = sections.reduce((sum, section) => sum + section.length, 0) > 4_000;
  const container = new ContainerBuilder().setAccentColor(REPORT_COLOR);
  const files: AttachmentBuilder[] = [];
  if (overflow) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('# Character Status\nThe complete stored-state report is attached as character-status.md.'));
    files.push(new AttachmentBuilder(Buffer.from(sections.join('\n\n'), 'utf8'), { name: 'character-status.md' }));
    container.addFileComponents(new FileBuilder().setURL('attachment://character-status.md'));
  } else container.addTextDisplayComponents(...sections.map(section => new TextDisplayBuilder().setContent(section)));
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] as never[], repliedUser: false }, files };
}
function timestamp(value: Date | string) { const seconds = Math.floor(new Date(value).getTime() / 1_000); return Number.isFinite(seconds) ? `<t:${seconds}:F>` : 'Unknown'; }
function pendingRequests(count: number, kind: string) { return count ? `${count} pending ${kind} request${count === 1 ? '' : 's'}.` : `No pending ${kind} requests.`; }
function escape(value: string) { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/@/g, '@\u200b').replace(/[\\`*_{}\[\]()#+.!|~\-]/g, '\\$&'); }
