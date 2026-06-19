# Deployment

GitHub Actions deploys `main` to the Contabo host at `/var/www/assistant.hybridmodel.ai`.

The production service should run:

```bash
npm start
```

The server reads secrets from its environment or from `.env` through the package script. Keep the production `.env` on the server and out of git.

Required values:

```bash
GATEWAY_TOKEN=the-openclaw-gateway-token-or-password
GATEWAY_URL=wss://your-mac-gateway-url
GEMINI_API_KEY=...
CARTESIA_API_KEY=...
PORT=9787
```

`assistant.hybridmodel.ai` runs on Contabo, but OpenClaw runs on the always-on MacBook. Because the MacBook is usually behind NAT, the stable setup is:

1. Expose the MacBook OpenClaw gateway with a secure tunnel or private overlay network.
2. Put that public or private WebSocket URL in `GATEWAY_URL` on Contabo.
3. Keep `GATEWAY_TOKEN` matching the MacBook OpenClaw gateway password/token.
4. Restart the Contabo service after changing `.env`.

Recommended options for the MacBook connection:

- Cloudflare Tunnel: publish the MacBook gateway as `wss://...` without opening router ports.
- Tailscale or WireGuard: connect Contabo and the MacBook privately, then set `GATEWAY_URL=ws://<mac-private-ip>:18789`.
- SSH reverse tunnel: forward a Contabo-local port back to the MacBook gateway, then set `GATEWAY_URL=ws://127.0.0.1:<forwarded-port>`.

On the MacBook, OpenClaw may also need remote UI access enabled:

```json
{ "gateway": { "controlUi": { "allowInsecureAuth": true } } }
```

Restart the OpenClaw gateway after changing that setting.
