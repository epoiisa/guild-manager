import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { managerCommand } from "../commands/manager.js";
import { channelCommand } from "../commands/channel.js";
import { activateCommand } from "../commands/activate.js";
import { accountCommand, creditCommand, debitCommand, giveCommand, statementCommand, transferCommand } from "../commands/account.js";
import { allianceCommand } from "../commands/alliance.js";
import { applicationCommand, applicationsCommand } from "../commands/application.js";
import { botCommand } from "../commands/bot.js";
import { characterCommand } from "../commands/character.js";
import { clearCommand } from "../commands/clear.js";
import { deactivateCommand } from "../commands/deactivate.js";
import { groupCommand } from "../commands/group.js";
import { giveawayCommand, giveawaysCommand } from "../commands/giveaway.js";
import { guildCommand } from "../commands/guild.js";
import { kickCommand } from "../commands/kick.js";
import { memberCommand } from "../commands/member.js";
import { messageCommand } from "../commands/message.js";
import { joinCommand, leaveCommand, partyCommand, standbyCommand } from "../commands/party.js";
import { pingCommand } from "../commands/ping.js";
import { registerCommand } from "../commands/register.js";
import { reactionCommand } from "../commands/reaction.js";
import { regearCommand, regearmeCommand, regearsCommand } from "../commands/regear.js";
import { resetCommand } from "../commands/reset.js";
import { positionCommand } from "../commands/position.js";
import { scheduleCommand } from "../commands/schedule.js";
import { balanceCommand, membershipCommand, rolesCommand } from "../commands/selfService.js";
import { templateCommand } from "../commands/template.js";
import { ticketCommand, ticketsCommand } from "../commands/ticket.js";
import { unregisterCommand } from "../commands/unregister.js";
import { auditCommand, updateCommand } from "../commands/update.js";
import { utcCommand } from "../commands/utc.js";
import { specialisationCommand, weaponCommand, weaponsCommand } from "../commands/weapon.js";
import { statusCommand } from "../commands/status.js";
import { tasksCommand } from "../commands/tasks.js";

export const activationGuildCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  activateCommand.toJSON()
];

export const activeGuildCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  managerCommand.toJSON(),
  channelCommand.toJSON(),
  accountCommand.toJSON(),
  allianceCommand.toJSON(),
  applicationCommand.toJSON(),
  applicationsCommand.toJSON(),
  auditCommand.toJSON(),
  balanceCommand.toJSON(),
  botCommand.toJSON(),
  characterCommand.toJSON(),
  clearCommand.toJSON(),
  creditCommand.toJSON(),
  debitCommand.toJSON(),
  deactivateCommand.toJSON(),
  groupCommand.toJSON(),
  giveawayCommand.toJSON(),
  giveawaysCommand.toJSON(),
  guildCommand.toJSON(),
  giveCommand.toJSON(),
  joinCommand.toJSON(),
  kickCommand.toJSON(),
  leaveCommand.toJSON(),
  memberCommand.toJSON(),
  membershipCommand.toJSON(),
  messageCommand.toJSON(),
  partyCommand.toJSON(),
  pingCommand.toJSON(),
  registerCommand.toJSON(),
  reactionCommand.toJSON(),
  regearCommand.toJSON(),
  regearmeCommand.toJSON(),
  regearsCommand.toJSON(),
  resetCommand.toJSON(),
  rolesCommand.toJSON(),
  positionCommand.toJSON(),
  scheduleCommand.toJSON(),
  statusCommand.toJSON(),
  tasksCommand.toJSON(),
  statementCommand.toJSON(),
  templateCommand.toJSON(),
  ticketCommand.toJSON(),
  ticketsCommand.toJSON(),
  unregisterCommand.toJSON(),
  transferCommand.toJSON(),
  updateCommand.toJSON(),
  utcCommand.toJSON(),
  weaponCommand.toJSON(),
  weaponsCommand.toJSON(),
  specialisationCommand.toJSON(),
  standbyCommand.toJSON()
];

export const guildCommands = activeGuildCommands;
