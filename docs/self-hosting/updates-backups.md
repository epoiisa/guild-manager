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

## Paired image backups (upcoming)

**Deployed to Production (20 October 2026); automated checks verified. Manual Discord acceptance and memory checks during image decoding in the running bot remain pending. Upcoming in public source releases; absent from 0.1.0-alpha.1.**

Once templates reference R2 images, a database-only export is incomplete. This pair covers template assets and their lifecycle state; ordinary Discord party attachments are excluded. `node dist/ops/images.js backup /absolute/protected/new-directory` creates a consistent custom database archive, image manifest and independent hash-verified media copies. Configure operator database/R2 access and PostgreSQL 18 tools (`POSTGRES_BIN` if needed). The destination must be outside the project and Git repositories, protected from runtime deletion. `node dist/ops/images.js verify /absolute/protected/directory` verifies the pair.

Backups are complete only with `manifest.json` and all verified files. Interrupted copying retains a durable hold; inspect `inventory` and the backup's `incomplete.json` before explicitly cancelling an abandoned hold with `cancel-backup-hold <UUID>`. Pending or interrupted manifests remain verification journals. A remaining `incomplete.json` means completion is unresolved even if `manifest.json` exists. `node dist/ops/images.js recover-backup /absolute/protected/directory` rechecks the matching database checkpoint and independent files; cancelled runs and missing copies cannot be promoted. Retain media copies for the lifetime of their complete manifests. Separate operator credentials and protected storage are essential; R2 durability is not an accidental-deletion backup.

Ordinary unreferenced media remains for eight days; never-referenced resolved uploads remain for 24 hours. Templates, transient template leases and backup holds retain required objects; party records do not retain R2 objects. Reset/deactivation bypass ordinary grace and do not erase independent backups or Discord copies. Do not configure an R2 age rule that can delete referenced images.

For recovery, stop bot writes, set `IMAGE_COLLECTION_ENABLED=false`, restore the reviewed database and reconcile newer purge decisions, generations, unresolved uploads and objects. After explicit reconciliation, `IMAGE_RESTORE_PURGE_RECONCILED=true` permits `node dist/ops/images.js restore-media /absolute/protected/directory`; it acquires the runtime lock, matches database identities and uses verified create-only writes. It does not restore the database or erase tombstones. Test rendering with isolated Discord credentials before resuming collection. R2 recovery restores template images only, not independent Discord party attachments. Older code cannot safely preserve the corrected schema-55 template lifecycle; use a compatible revision.

No historical-party image inventory, automatic migration, normalization or archive cleanup is required. Explicit template capture alone copies a selected current canonical party image into template storage. A database PITR point still needs every template image it references; deliberate purge or bucket loss can make it incomplete.
