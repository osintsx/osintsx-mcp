# osintsx-mcp

An [MCP](https://modelcontextprotocol.io) server for the [OSINT.SX](https://osint.sx) API.

It lets an AI assistant such as Claude, Cursor or VS Code run OSINT.SX searches for you. It can check an email, phone number, username or name against every source at once, or use one of the single-platform tools.

It runs on your own API key. Each search costs what it costs on the site: 1 credit. A search that finds nothing because most sources failed gives the credit back. Tool searches cost nothing when they find nothing.

## Setup

1. Make an API key at https://osint.sx/keys.
2. Add the server to your MCP client with that key.

Claude Desktop, Cursor and most clients (`claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "osintsx": {
      "command": "npx",
      "args": ["-y", "osintsx-mcp"],
      "env": { "OSINTSX_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add osintsx --env OSINTSX_API_KEY=YOUR_API_KEY -- npx -y osintsx-mcp
```

Node.js 20.3 or newer is required.

## Tools

| Tool | What it does |
|---|---|
| `search` | Checks an email, phone number (+E.164), username or full name against every source, and returns each site where it's registered with the details that site shows. |
| `google_account_lookup` | Finds Google accounts and Gaia IDs by email, name or domain, or looks one up by Gaia ID. |
| `microsoft_account_lookup` | Finds Microsoft accounts by email, name or domain, or looks one up by CID. |
| `epic_games_lookup` | Finds Epic Games accounts by display name, account ID, or the username on a linked platform. |
| `twitter_history` | Looks up an X profile's archived history: earlier usernames, names, bios, locations and pictures. |
| `steam_history` | Looks up a Steam profile's archived history: earlier names, custom URLs and avatars, and other accounts that held the same custom URL. |
| `instagram_share_trace` | Finds the account that shared an Instagram link copied from the app. |
| `tiktok_share_trace` | Finds the account that shared a TikTok short link copied from the app. |

A call waits up to 50 seconds by default, then returns whatever has come in, and the result says it was cut short. For `search`, the sources that hadn't answered are cancelled. A single-platform tool keeps running on OSINT.SX after the cut-off, so its credit may still be used. 50 seconds keeps the call under the 60-second timeout many MCP clients use, and in testing almost every source answered within that time.

If your client allows longer calls, set `max_wait_seconds` (up to 600). Clients that support progress notifications show progress while a search runs.

By default, `search` leaves out sources that may notify the person. Set `include_alerting_sources` to include them.

Replies are kept under about 48 KB, so they fit what MCP clients accept. If there are more results than that, the reply says how many were left out. The Google, Microsoft, Epic and share-trace tools return each result's main fields; set `include_raw` to get everything the source sent.

## Settings

| Variable | |
|---|---|
| `OSINTSX_API_KEY` | Required. Your API key. |
| `OSINTSX_API_URL` | Optional. Defaults to `https://api.osint.sx`. |

## Use responsibly

Only search for people and accounts you have a lawful reason to look into. See the [terms](https://osint.sx/terms).

API reference: https://osint.sx/api
