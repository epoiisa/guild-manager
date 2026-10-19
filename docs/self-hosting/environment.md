---
title: Environment Configuration
permalink: /self-hosting/environment/
---

# Environment Configuration

Guild Manager reads environment variables at startup. For a local standalone installation, place `.env` in the package directory and start the process from that directory. A hosting service can supply the same variables directly through its secret and environment settings.

| Variable | Required | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Your Discord application's bot token. |
| `DISCORD_CLIENT_ID` | Yes | The Application ID belonging to the same application as the token. |
| `DATABASE_URL` | Yes | PostgreSQL connection string for your dedicated database. |
| `BOT_INSTANCE_NAME` | No | Instance label used in logs and `/ping`; defaults to `Guild Manager`. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`; defaults to `info`. |

The supplied `.env.example` contains:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DATABASE_URL=postgresql://localhost:5432/guild_manager
BOT_INSTANCE_NAME=Guild Manager
LOG_LEVEL=info
```

Fill the empty values with your credentials. The database example works only when your local PostgreSQL authentication accepts that connection. For hosted databases, use the connection settings and certificate requirements supplied by the provider.

Required values are trimmed and must be nonempty. An unsupported `LOG_LEVEL` prevents startup. Configuration changes take effect after restarting the process.

## Server configuration

Do not add a Discord server ID to the environment file. The bot discovers Discord servers where it is installed and stores their individual configuration in PostgreSQL. Albion Online server selection, member groups, channels, and manager roles are configured through Discord commands after activation.

`BOT_INSTANCE_NAME` labels the instance; it does not choose a separate database or environment. Isolation comes from the Discord application and database you supply.

## Protect credentials

Keep `.env`, database connection strings, and bot tokens out of Git, screenshots, support messages, and public logs. Use a private secret store or the hosting service's secret settings for managed deployments. If a bot token is exposed, reset it in the Developer Portal and update the instance before restarting.

Continue with [running the bot]({{ '/self-hosting/running/' | relative_url }}).

## Private signup-image storage (upcoming)

**Upcoming in public source releases; absent from 0.1.0-alpha.1. Production availability has not been verified for template images.**

Create your own private Cloudflare R2 Standard bucket and bucket-scoped Object Read & Write credentials. Use separate buckets/credentials for testing and live use. Keep public access, custom domains and object-age deletion rules off. Supply credentials through your secret store; never use another operator's storage.

| Variable | Meaning |
|---|---|
| `IMAGE_STORAGE_ENABLED` | `true` enables configured storage; defaults to disabled. |
| `IMAGE_STORAGE_SCOPE` | Required when enabled: `local` (256 MiB total) or `production` (4 GiB total). |
| `R2_ACCOUNT_ID`, `R2_BUCKET` | Exact reviewed account and private bucket. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Separate scoped credentials for this bucket. |
| `IMAGE_SERVER_LIMIT_BYTES` | Optional positive-byte override; default 536870912 (512 MiB). |
| `IMAGE_GLOBAL_LIMIT_BYTES` | Optional total-byte override after capacity/cost review. |
| `IMAGE_COLLECTION_ENABLED` | Defaults to `true`; set `false` for recovery until state is reconciled. |
| `IMAGE_NORMALIZATION_ENABLED` | Defaults to `false`; enable bounded adoption after existing-image inventory/review. |

The 15 MiB/image limit remains fixed. Animated PNG is rejected; static PNG and bounded GIF/WebP animation are supported. Provisional decode bounds are 20 million pixels per frame, 50 million overall and 1,000 frames; validate representative graphics and peak memory before enabling a live installation. Application limits do not cap the Cloudflare account bill.
