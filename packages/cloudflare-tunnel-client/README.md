# miko-cloudflare-tunnel-client

Cloudflare tunnel client for establishing tunnels to local services.

## Overview

This package provides a simplified client for establishing Cloudflare tunnels. It focuses solely on tunnel management - all HTTP request handling (webhooks, config updates) is done by `SharedApplicationServer`.

## Features

- **Cloudflare Tunnel**: Automatic tunnel setup using cloudflared binary
- **Event-Driven**: Emits events for tunnel lifecycle (connect, disconnect, ready, error)
- **Simple API**: Just provide token and port, client handles the rest

## Installation

```bash
npm install miko-cloudflare-tunnel-client
```

## Usage

```typescript
import { CloudflareTunnelClient } from 'miko-cloudflare-tunnel-client';

// Create tunnel client
const client = new CloudflareTunnelClient(
  'your-cloudflare-tunnel-token',
  3000, // local port to tunnel to
  (tunnelUrl) => {
    console.log('Tunnel ready:', tunnelUrl);
  }
);

// Listen for events
client.on('connect', () => {
  console.log('Tunnel connected');
});

client.on('disconnect', (reason) => {
  console.log('Tunnel disconnected:', reason);
});

client.on('error', (error) => {
  console.error('Tunnel error:', error);
});

// Start the tunnel
await client.startTunnel();

// Get tunnel URL
const tunnelUrl = client.getTunnelUrl();

// Check connection status
const isConnected = client.isConnected();

// Disconnect when done
client.disconnect();
```

## API

### Constructor

```typescript
new CloudflareTunnelClient(
  cloudflareToken: string,
  localPort: number,
  onReady?: (tunnelUrl: string) => void
)
```

### Methods

- `startTunnel()`: Start the Cloudflare tunnel (async)
- `getTunnelUrl()`: Get the tunnel URL (returns `string | null`)
- `isConnected()`: Check if tunnel is connected (returns `boolean`)
- `disconnect()`: Disconnect and cleanup

### Events

- `connect`: Emitted when tunnel connection is established
- `disconnect`: Emitted when tunnel disconnects (with reason string)
- `ready`: Emitted when tunnel URL is available (with tunnel URL string)
- `error`: Emitted on errors (with Error object)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## License

MIT
