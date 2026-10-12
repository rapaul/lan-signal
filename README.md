# lan-signal

Reusable WebRTC signaling for browser games played on a local network. A game lists itself to players **on the same network** (same public IP), friends join it (optionally with a passphrase), and the browsers connect to each other over the LAN. Game traffic never touches the server: it only passes the few setup messages.

Used by [Ace of Spades](../ace-of-spades). Any other game can share the same deployment: rooms are namespaced by an app id.

## What's here

| Path | What |
|---|---|
| `client/index.ts` | Browser client (no dependencies): `SignalClient.connect`, `list`, `host`, `join`. Returns connected `RTCPeerConnection`s. |
| `core/relay.ts` | The relay logic, independent of where it runs. |
| `server/lambda.ts` | AWS Lambda handler (API Gateway WebSocket API + DynamoDB). |
| `server/local.ts` | Local Node server with the same relay (development, e2e tests, or a box on your LAN). |
| `infra/app.ts` | AWS CDK stack: WebSocket API, one Lambda, one DynamoDB table. |
| `test/` | Vitest: relay rules, client crypto and address checks, the local server end to end. |

## Using it in a game

```ts
import { SignalClient } from 'lan-signal/client';

const sig = await SignalClient.connect('wss://…/live', { app: 'my-game' });

// Host:
const room = await sig.host({ name: "Ann's game", passphrase: 'optional', meta: { map: 'kauai' }, setup: (pc) => makeChannels(pc) });
room.onPeer = (pc, peerId) => { /* connected over the LAN */ };
room.update({ map: 'kauai', players: 3 });          // keep the listing current

// Join:
const rooms = await sig.list();                      // games on this network
const pc = await sig.join(rooms[0].id, { passphrase: 'optional', setup: (pc) => makeChannels(pc) });
```

Create negotiated data channels in `setup` (it runs before negotiation). Joining a locked room without the right passphrase fails with `SignalError('Wrong passphrase.')`.

## Guarantees

- **Same network only**: the relay groups connections by app and source IP. Listing, joining and relaying only happen within a group.
- **LAN only** (default): no STUN or TURN servers, only host ICE candidates are sent, and a connection whose selected candidate pair isn't between two local addresses (private IPv4, link-local, unique-local IPv6 or mDNS) is closed. Pass `allowInternet: true` and your own `iceServers` to lift this.
- **Passphrase**: every setup payload is AES-GCM encrypted with a PBKDF2 key from the passphrase (salted with app and room). The relay can't read it; a joiner with the wrong passphrase is refused.
- **Origins**: the AWS relay only accepts WebSocket connections from listed origins.

Browsers hide LAN IPs behind random `.local` names that the other machine must resolve by multicast. Where a network blocks that, the page can call `getUserMedia({ audio: true })` once (and stop the stream): with media permission, Chrome and Firefox publish the real LAN IP. Ace of Spades offers this as *Share LAN address*.

## Develop

```sh
npm install
npm test            # vitest
npm run dev         # local relay on ws://localhost:8787 (any origin)
```

## Deploy to AWS

Needs an AWS account and credentials (e.g. `aws configure`, or `AWS_PROFILE`).

```sh
npx cdk bootstrap                                                  # once per account and region
ALLOWED_ORIGINS=https://example.com,localhost npx cdk deploy     # comma-separated origins; 'localhost' allows local dev
```

It prints `LanSignal.SignalUrl` (`wss://….execute-api.<region>.amazonaws.com/live`). Give that to the game; for Ace of Spades, build with `VITE_SIGNAL_URL=<that url> npm run build`. Add more games by adding their origins and redeploying; each uses its own app id.

Cost: API Gateway WebSocket, Lambda and DynamoDB are all pay-per-request, and a player sends a handful of messages per session. Hobby use should stay within free tiers or cost cents a month. The stage is throttled (50 req/s, burst 100) as a guard; consider an AWS Budgets alert too. `npx cdk destroy` removes everything.
