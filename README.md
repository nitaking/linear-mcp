# Legible Linear MCP

An MCP server that connects Claude Code to Linear with OAuth authentication and multi-workspace support.

## Quick Start

### 1. Install

```bash
git clone https://github.com/bleugreen/linear-mcp.git
cd linear-mcp

# npm
npm install && npm run build

# pnpm
pnpm install && pnpm build

# bun
bun install && bun run build
```

### 2. Authenticate

```bash
# Opens browser for OAuth login
lmcp auth login

# Or if not installed globally:
node dist/cli.js auth login
```

### 3. Configure Claude Code

Add via Claude Code CLI:

```bash
# bun (recommended)
claude mcp add linear-mcp -- bun run /path/to/linear-mcp/dist/mcp-server.js

# node
claude mcp add linear-mcp -- node /path/to/linear-mcp/dist/mcp-server.js
```

To specify scope:

```bash
# Project scope (saved to .claude/settings.json)
claude mcp add linear-mcp -s project -- bun run /path/to/linear-mcp/dist/mcp-server.js

# User scope (saved to ~/.claude/settings.json)
claude mcp add linear-mcp -s user -- bun run /path/to/linear-mcp/dist/mcp-server.js
```

#### Manual configuration

Add to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "linear-mcp": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/linear-mcp/dist/mcp-server.js"]
    }
  }
}
```

Restart Claude Code and you're ready to go!

## Authentication

### OAuth (Recommended)

OAuth provides a seamless authentication experience with automatic token refresh:

```bash
lmcp auth login      # Authenticate with Linear
lmcp auth status     # Check current auth status
lmcp auth list       # List connected workspaces
lmcp auth switch     # Switch active workspace
lmcp auth logout     # Remove a workspace
```

Credentials are stored securely in `~/.linear-mcp/credentials.json`.

### Multi-Workspace Support

Connect to multiple Linear workspaces and switch between them:

```bash
# Add first workspace
lmcp auth login

# Add another workspace (will show consent screen)
lmcp auth login

# Switch between them
lmcp auth switch my-company
lmcp auth switch side-project
```

### Environment Variable (Legacy)

You can also use an API key directly:

```bash
export LINEAR_API_KEY=lin_api_YOUR_KEY_HERE
```

Note: OAuth credentials take priority over the environment variable.

## CLI Reference

```
lmcp <command> [options]

Commands:
  auth login       Authenticate with Linear via OAuth
  auth logout      Remove a workspace's credentials
  auth list        List all connected workspaces
  auth switch      Switch active workspace
  auth status      Show current authentication status
  serve            Start the MCP server (default)
  help             Show help message

Environment Variables:
  LINEAR_API_KEY       Use API key instead of OAuth (fallback)
  LINEAR_WORKSPACE     Override active workspace for session
  LINEAR_CLIENT_ID     Use custom OAuth app client ID
  LINEAR_CLIENT_SECRET Use custom OAuth app client secret
```

## Features

### Core Capabilities
- **Full CRUD**: Issues, comments, projects, cycles, teams, users
- **Human-Readable IDs**: Use team keys (TEAM), issue identifiers (TEAM-123), project names, user emails
- **Smart Chunking**: Automatically splits large content across multiple comments
- **Markdown Export**: Get full issue content with all comments in clean markdown

### Reliability
- **Auto Token Refresh**: OAuth tokens refresh automatically before expiry
- **Rate Limiting**: Respects Linear's 1,500 req/hr limit with exponential backoff
- **Query Splitting**: Handles Linear's 10,000 complexity limit automatically

---

## Related Links

- [Linear API Documentation](https://developers.linear.app)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
- [Linear TypeScript SDK](https://github.com/linear/linear)

## Troubleshooting

### "Field membership argument userId required"
The server handles this automatically by using raw GraphQL queries for affected endpoints.

### "Query too complex"
The server automatically splits complex queries. If you still see this error, please file an issue.

### SSE Connection Drops
The server sends heartbeats every 15 seconds. Check your proxy/firewall timeout settings.

### Rate Limiting
The server implements exponential backoff. If you're hitting limits frequently, consider reducing request frequency or batch operations.
