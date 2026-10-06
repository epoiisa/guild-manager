---
title: Updates and Database Backups
permalink: /self-hosting/updates-backups/
---

# Updates and Database Backups

Back up PostgreSQL before every release update. Guild Manager applies schema migrations automatically at startup, so starting new code against an existing database can change its structure immediately.

## Update sequence

1. Read the new [release notes](https://github.com/epoiisa/guild-manager/releases) for command changes, schema changes, and migration requirements.
2. Prepare the new release in a separate directory. Follow [installation]({{ '/self-hosting/installation/' | relative_url }}) and install its dependencies.
3. Test it with a separate test application and database.
4. Stop your existing live process and prevent its service manager from automatically restarting it during the update.
5. Take a database backup and confirm that it can be restored. Retain the old release and its private configuration.
6. Supply the new release with your existing instance's private configuration. Start it against the existing database.
7. Check migration, Discord-login, and command-registration logs. Confirm `/ping`, `/status`, and the workflows you use in your server.
8. Update the service manager to use the new directory and verify unattended startup.

Do not run old and new versions concurrently. Do not assume that returning to an older release is safe after migrations have run.

## Database backup

Use your provider's backup tools or PostgreSQL's `pg_dump`. A custom-format dump can be restored with `pg_restore`. For a local database with working local authentication:

```sh
pg_dump --format=custom --file=guild-manager-backup.dump guild_manager
```

For a remote database, supply the host, database, username, and required secure connection settings through your normal PostgreSQL client configuration. Avoid putting passwords in shell commands. See the official [pg_dump reference](https://www.postgresql.org/docs/18/app-pgdump.html).

Backups contain community and character data. Store them privately, keep copies outside the running host, and choose a retention period appropriate for your community. Preserve the application credentials separately in your secret store: a database backup does not replace them.

## Verify recovery

Test a restore into a separate empty database, with no running bot attached:

```sh
createdb guild_manager_restore_test
pg_restore --exit-on-error --dbname=guild_manager_restore_test guild-manager-backup.dump
```

These examples assume your PostgreSQL role can create databases and restore the original schema and ownership. Adapt ownership and role handling to your environment using the official [pg_restore reference](https://www.postgresql.org/docs/18/app-pgrestore.html).

Use the corresponding release when validating the restored database, and use a separate test Discord application and server. A restored database may contain references to live Discord resources; do not let a recovery test operate on the live server.

If an update fails, stop the new process first. Recover using a compatible release and a verified backup. Restoring a backup loses database changes made since that backup; it also does not undo messages, roles, or channels already changed in Discord. Check both database state and Discord resources after recovery.
