# @suverselabs/mcp-server

An [MCP](https://modelcontextprotocol.io) server that gives Claude Desktop (or any
MCP client) **15 tools** for SuVerse's pay-per-call US-government and freight APIs.
Calls are paid automatically, per request, in **USDC on Base** via the
[x402](https://x402.org) protocol — you fund a wallet once and Claude pays as it
works. Your private key never leaves your machine.

> ✅ **Published on npm:** https://www.npmjs.com/package/@suverselabs/mcp-server

## Quick Start

Install via npx (no local build needed):

```bash
npx -y @suverselabs/mcp-server
```

### Claude Desktop Setup

Add to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "suverse": {
      "command": "npx",
      "args": ["-y", "@suverselabs/mcp-server"],
      "env": {
        "SUVERSE_BASE_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

The private key controls a Base wallet that pays for tool calls in USDC. Fund it with ~$5-10 USDC on Base. You don't need ETH for gas — Base settlements are gas-sponsored. Check your balance anytime with the free `suverse_balance` tool.

Restart Claude Desktop. The 15 SuVerse tools will appear in Claude's tool list.

## What is SuVerse?

[SuVerse](https://api.suverse.io) is an x402 gateway over 128 US-government data
services (SEC, NPS, FBI, CMS, …) plus a freight document/routing suite. Each call
costs a few tenths of a cent up to $0.50; there are no accounts or API keys — you
pay per call in USDC.

## Why MCP?

Without this server you'd hand-roll x402 payments to call SuVerse. With it, the
endpoints appear as native Claude tools: ask in plain language and Claude calls
them, paying transparently from your funded Base wallet.

## Tools

### Paid (per-call USDC on Base)

| Tool | Price | Purpose |
|---|---|---|
| `freight_parse_ratecon` | $0.10 | Rate confirmation → JSON |
| `freight_parse_bol_pod` | $0.15 | Bill of Lading / POD → JSON |
| `freight_parse_fuel_receipt` | $0.05 | Fuel receipt → JSON (IFTA) |
| `freight_parse_w9` | $0.07 | IRS W-9 → JSON |
| `freight_parse_insurance_cert` | $0.08 | ACORD 25 COI → JSON |
| `freight_parse_permit` | $0.25 | Oversize/overweight permit → JSON |
| `freight_truck_route` | $0.50 | Truck-legal routing + tolls + POIs |
| `freight_calculate_tolls` | $0.10 | Toll estimate for a polyline |
| `freight_trip_telematics` | $0.01 | GPS trip analytics |
| `gov_query` | $0.005 | Any of 128 gov services by id |
| `gov_cms_open_payments` | $0.01 | CMS Open Payments by NPI |
| `gov_fbi_crime_data` | $0.01 | FBI crime stats by state/year |

### Free (no payment)

| Tool | Purpose |
|---|---|
| `gov_list_services` | Discover the 128 `gov_query` service ids + params |
| `suverse_estimate_cost` | Price one or many calls before running them |
| `suverse_balance` | On-chain USDC balance + calls remaining per tool |
| `suverse_search_endpoints` | Search every x402 endpoint SuVerse knows about (own + CDP Bazaar mirror) |

### Aggregated verdicts (x402, custody-free — the server never pays)

| Tool | Price | Question it answers |
|---|---|---|
| `suverse_market_pulse` | $0.10 | What regime is the crypto market in right now? |
| `suverse_wallet_reputation` | $0.03 | Can this Solana wallet's trading be trusted or copied? |
| `suverse_token_check` | $0.05 | Is this Solana token sane to enter right now? |

These three work differently from the paid tools above: **this server does not
pay for them and holds no keys for them.** Called without payment they return a
structured `payment_required` result — what the endpoint answers, the price, and
the verbatim x402 challenge (`accepts` on Base, Solana, and Cosmos Noble, all
USDC). Your agent (or its runtime) decides whether to pay: sign one of the
accepts with any x402 buyer client (e.g. `@suverselabs/x402-client`) and call
the tool again with `payment_signature` set to the base64 header value — it is
forwarded as `PAYMENT-SIGNATURE` / `X-PAYMENT` and the full paid verdict
(`{verdict, signals, data_quality, raw}`) comes back. Wallet and mint arguments
are validated as base58 client-side before any network call.

## Usage examples

- *"Parse the rate con at `~/Downloads/load_4471.pdf`."* → `freight_parse_ratecon` (`file_path`)
- *"What gov services can you call?"* → `gov_list_services`
- *"How much would parsing 10 BOLs cost?"* → `suverse_estimate_cost`
- *"What's my SuVerse balance?"* → `suverse_balance`
- *"Get Apple's SEC company info."* → `gov_query` (`service: "sec.company_info"`)

### `file_path` inputs

Document tools accept a local `file_path` — the server reads the file, **verifies
it's really a PDF/image via magic bytes**, and base64-encodes it. No need to paste
base64 into the chat.

## Cost transparency & safety

- Every paid tool's description states its price; `suverse_estimate_cost` prices
  ahead of time.
- **Hard cap:** a single call never settles for more than
  `SUVERSE_MAX_PAYMENT_USDC` (default **$0.60**) **and** never more than the tool's
  published price — whichever is lower.
- **Client-side idempotency:** an identical repeat within a short window returns the
  cached response instead of paying twice (complements SuVerse's server-side
  idempotency).

## Security

- `SUVERSE_BASE_PRIVATE_KEY` is read from the environment, used only to sign EIP-3009
  USDC authorizations locally, and **never logged or transmitted** anywhere except
  as a signed payment header to SuVerse.
- All diagnostics go to **stderr** (stdout is the MCP protocol channel).
- `file_path` reads are restricted to your home directory (override with
  `SUVERSE_ALLOW_PATHS_OUTSIDE_HOME=true`), reject sensitive locations
  (`.ssh`, `.aws`, `credentials`, key files, …), and are content-type verified.

### Data sent off your machine

The document-parsing tools work by **uploading the file's contents** (base64-encoded,
or whatever you pass via `pdf_base64` / `image_base64` / `text`) to `api.suverse.io`,
where they're parsed. So while your private key never leaves your machine, **the
documents you ask Claude to parse do.** Only pass files you're comfortable sending to
SuVerse for processing. The `file_path` guards above (home-directory restriction,
sensitive-location denylist, magic-byte type check) limit *which* files can be read,
but any file you do parse is transmitted. The free tools (`gov_list_services`,
`suverse_estimate_cost`, `suverse_balance`) and the on-chain balance read send no
file data.

## Configuration reference

| Env var | Default | Notes |
|---|---|---|
| `SUVERSE_BASE_PRIVATE_KEY` | — | **Required.** 0x Base private key. |
| `SUVERSE_API_BASE` | `https://api.suverse.io` | |
| `SUVERSE_MAX_PAYMENT_USDC` | `0.60` | Hard per-call ceiling. |
| `SUVERSE_BASE_RPC_URL` | viem default | For `suverse_balance` reads. |
| `SUVERSE_ALLOW_PATHS_OUTSIDE_HOME` | `false` | Allow `file_path` outside `$HOME`. |
| `SUVERSE_IDEMPOTENCY_TTL_MS` | `120000` | Client idempotency window. |

## Development

For contributors / running from source. End users should use the `npx` [Quick Start](#quick-start) above instead.

```bash
git clone https://github.com/sudzikcoin/suverse-mcp && cd suverse-mcp
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (mocked HTTP)
npm run build       # tsup → dist/index.js
npm run dev         # run from source (tsx)
```

To run a local build in Claude Desktop, point `command`/`args` at the built file instead of `npx`:

```json
{
  "mcpServers": {
    "suverse": {
      "command": "node",
      "args": ["/absolute/path/to/suverse-mcp/dist/index.js"],
      "env": { "SUVERSE_BASE_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE" }
    }
  }
}
```

## License

MIT
