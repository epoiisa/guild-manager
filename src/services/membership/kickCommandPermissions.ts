import { ApplicationCommandPermissionType, ApplicationCommandType, type ApplicationCommandPermissions, type Guild } from "discord.js";

// Current member-owned/self-service roots. Mixed configuration/reviewer roots and
// unknown future commands stay administrative until explicitly reviewed here.
const ORDINARY_COMMAND_ROOTS = new Set([
  "ping", "register", "unregister", "balance", "give", "join", "leave", "standby",
  "party", "giveaway", "giveaways", "regearme", "regears", "membership", "statement", "roles", "weapon", "weapons"
]);

export interface KickCommandPermissions {
  roleIds: string[];
  requiresManualRemoval: boolean;
}

/** Current command builders all use default_member_permissions=0. Only an
 * explicit command-level allow can bypass that baseline; app-wide grants alone
 * do not restore officer authority. Native Administrator roles are handled by
 * the caller's role cleanup.
 */
export async function inspectKickCommandPermissions(
  guild: Guild,
  userId: string,
  heldRoleIds: Iterable<string>
): Promise<KickCommandPermissions> {
  const applicationId = guild.client.application?.id;
  if (!applicationId) throw new Error("Application identity is unavailable for command permission inspection.");
  const [commands, permissions] = await Promise.all([
    guild.commands.fetch(),
    guild.commands.permissions.fetch({})
  ]);
  const inherited = permissions.get(applicationId) ?? [];
  const heldRoles = new Set(heldRoleIds);
  const roleIds = new Set<string>();
  let requiresManualRemoval = false;

  for (const command of commands.values()) {
    if (command.type === ApplicationCommandType.ChatInput && ORDINARY_COMMAND_ROOTS.has(command.name)) continue;
    // Since Discord's 2023 permissions update, only conflicting entries are
    // replaced. An empty command array has no overrides; app-wide entries remain.
    // https://support-apps.discord.com/hc/en-us/articles/26501842915607-Updates-to-Command-Permissions
    const overrides = new Map<string, ApplicationCommandPermissions>();
    for (const permission of permissions.get(command.id) ?? []) {
      overrides.set(`${permission.type}:${permission.id}`, permission);
    }
    const effective = new Map<string, ApplicationCommandPermissions>();
    for (const permission of [...inherited, ...overrides.values()]) {
      effective.set(`${permission.type}:${permission.id}`, permission);
    }
    const userPermission = effective.get(`${ApplicationCommandPermissionType.User}:${userId}`);
    if (userPermission?.permission === false) continue;
    if (overrides.get(`${ApplicationCommandPermissionType.User}:${userId}`)?.permission === true) requiresManualRemoval = true;
    // Empty/synced overrides and app-only everyone/member grants cannot bypass
    // default 0. Inherited user denies still apply unless explicitly overridden.
    for (const permission of overrides.values()) {
      if (permission.type !== ApplicationCommandPermissionType.Role || permission.permission !== true) continue;
      if (permission.id === guild.id) requiresManualRemoval = true;
      else if (heldRoles.has(permission.id)) roleIds.add(permission.id);
    }
  }
  return { roleIds: [...roleIds].sort(), requiresManualRemoval };
}
