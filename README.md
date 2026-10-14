# agent-memory-share-mcp

Local-first MCP service for searching coding-agent sessions and existing memory files.

## Development

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

The web interface runs at `http://127.0.0.1:5173` during development. The local API and MCP endpoint
run at `http://127.0.0.1:43110`.

## Checks

```bash
npm run typecheck
npm test
npm run build
```
