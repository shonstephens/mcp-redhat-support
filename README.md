# mcp-redhat-cases

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Support Case Management API. Lets AI assistants list, read, comment on, and manage Red Hat support cases.

## Tools

| Tool | Description |
|------|-------------|
| `listCases` | List support cases with filtering by status, severity, and search string |
| `getCase` | Get full details of a specific case |
| `getCaseComments` | Get all comments on a case |
| `addCaseComment` | Add a comment to a case |
| `getCaseAttachments` | List attachments on a case |
| `downloadAttachment` | Download a case attachment to a local file |
| `uploadAttachment` | Upload a local file as an attachment to a case |

## Prerequisites

- Node.js 18+
- A Red Hat offline API token ([generate one here](https://access.redhat.com/management/api))

## Usage with Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "redhat-cases": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-cases"],
      "env": {
        "REDHAT_TOKEN": "${REDHAT_TOKEN}"
      }
    }
  }
}
```

Set your token in your shell profile:

```bash
export REDHAT_TOKEN="your-offline-token-here"
```

## Authentication

The server exchanges your Red Hat offline API token for a short-lived bearer token via Red Hat SSO. Tokens are cached and refreshed automatically.

## License

MIT
