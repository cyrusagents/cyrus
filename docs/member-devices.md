# Connect a personal device

With the companion Hosted member-devices release, workspace admins can enable personal devices in **Devices**. Each member can connect one personal machine alongside the workspace's shared machine.

1. In Hosted, open **Devices → Add your device** and generate a code.
2. Install the current CLI: `npm install -g cyrus-ai`.
3. Run `cyrus auth <code>` on the machine you want to connect. The code is valid for fifteen minutes and can be used once. Authentication starts Cyrus automatically.
4. Finish setup in Hosted to sync your device's configuration. Configure model providers and connect your personal GitHub, Linear or Slack account to route your events to this machine.

Authentication reports hostname, operating system, architecture, CPU, core count, memory and CLI version. Hosted displays these details on the device page. Credentials, team ID and device ID are saved in the owner-readable Cyrus `.env` file. A running edge worker sends a presence heartbeat on startup and every ten minutes; Hosted shows it offline after fifteen minutes without a heartbeat.

Use Hosted to rename the device, change its settings, or revoke access. Revocation frees your personal slot so you can connect another machine. Personal event routing does not fail over to the shared machine when your device is offline. Local standalone installations without Hosted team credentials do not send heartbeats.

Deploy the Hosted database migration and application before enabling this flow. Existing shared authentication remains compatible; older CLIs need an upgrade to report device metadata and presence.
