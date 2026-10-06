---
title: Self-Hosting
permalink: /self-hosting/
---

# Self-Hosting

Run your own Guild Manager Discord application using the public source or a compiled release download. These instructions cover **0.1.0-alpha.1**.

You provide the Discord application, PostgreSQL database, and a computer or service that keeps the bot running. Downloads contain no credentials or live data. Public access to the maintainer's hosted instance is not currently offered.

## Setup sequence

1. Check the [requirements]({{ '/self-hosting/requirements/' | relative_url }}).
2. [Create and install your Discord application]({{ '/self-hosting/discord-setup/' | relative_url }}).
3. [Install a release and create its database]({{ '/self-hosting/installation/' | relative_url }}).
4. [Configure the environment]({{ '/self-hosting/environment/' | relative_url }}).
5. [Start the bot and activate your Discord server]({{ '/self-hosting/running/' | relative_url }}).

After startup, follow the [administrator quick start]({{ '/getting-started/administrator/' | relative_url }}) to configure the server's features and command access.

## Operating your instance

- [Updates and database backups]({{ '/self-hosting/updates-backups/' | relative_url }})
- [Troubleshooting]({{ '/self-hosting/troubleshooting/' | relative_url }})
- [Release notes and downloads](https://github.com/epoiisa/guild-manager/releases)

Guild Manager is an alpha project. Review and test each release in your own test Discord server before relying on it. Commands and database schemas may change between releases. The [MIT licence](https://github.com/epoiisa/guild-manager/blob/main/LICENSE) allows independent use and hosting subject to its notice requirements; third-party dependencies retain their own licences.
