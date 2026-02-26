# mantis-mcp

MCP (Model Context Protocol) server for [MantisBT](https://mantisbt.org/) with CRUD operations and **semantic search** (RAG) over issues and notes.

Enables natural language queries like *"have I ever discussed X with client Y?"* across a large MantisBT database (10,000+ issues).

## Features

- **8 CRUD tools** — list/get/create/update issues, add notes, list projects and users
- **3 semantic search tools** — natural language search across all issues and notes, with incremental sync
- **Local embeddings** — runs entirely offline using Transformers.js (no external API calls for search)
- **Multilingual** — uses `paraphrase-multilingual-MiniLM-L12-v2` model (IT/EN/DE/FR/ES/...)
- **Incremental sync** — only processes new/updated/deleted issues after the initial sync

## Quick Start

### 1. Install

```bash
git clone git@github.com:f-liva/mantis-mcp.git
cd mantis-mcp
npm install
npm run build
```

### 2. Setup (automated)

Run the interactive setup script — it detects your platform (WSL, Windows, macOS, Linux), asks for your MantisBT credentials, tests the connection, and configures everything automatically:

```bash
./setup.sh setup
```

This will:
- Prompt for your MantisBT API URL and token
- Test the API connection
- Configure **Claude Desktop** (`claude_desktop_config.json`)
- Configure **Claude Code** (`.mcp.json`)
- Create the `.env` file

You can also pass parameters directly:

```bash
./setup.sh setup -u "https://mantis.example.com/api/rest" -k "your-api-token"
```

Or configure only one target:

```bash
./setup.sh setup -t desktop   # only Claude Desktop
./setup.sh setup -t cli       # only Claude Code
./setup.sh setup -t both      # both (default)
```

### 3. Manual Configuration (alternative)

If you prefer to configure manually:

#### Claude Desktop

Edit your `claude_desktop_config.json`:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

**Windows (without WSL):**
```json
{
  "mcpServers": {
    "mantis": {
      "command": "node",
      "args": ["C:\\Users\\YOURUSERNAME\\mantis-mcp\\dist\\index.js"],
      "env": {
        "MANTIS_API_URL": "https://mantis.example.com/api/rest",
        "MANTIS_API_KEY": "your-api-token"
      }
    }
  }
}
```

**Windows with WSL:**
```json
{
  "mcpServers": {
    "mantis": {
      "command": "wsl",
      "args": ["bash", "-c", "cd /home/YOURUSERNAME/mantis-mcp && node dist/index.js"],
      "env": {
        "MANTIS_API_URL": "https://mantis.example.com/api/rest",
        "MANTIS_API_KEY": "your-api-token"
      }
    }
  }
}
```

**macOS / Linux:**
```json
{
  "mcpServers": {
    "mantis": {
      "command": "node",
      "args": ["/absolute/path/to/mantis-mcp/dist/index.js"],
      "env": {
        "MANTIS_API_URL": "https://mantis.example.com/api/rest",
        "MANTIS_API_KEY": "your-api-token"
      }
    }
  }
}
```

#### Claude Code (CLI)

Create a `.mcp.json` in any project directory:

```json
{
  "mcpServers": {
    "mantis": {
      "command": "node",
      "args": ["/absolute/path/to/mantis-mcp/dist/index.js"],
      "env": {
        "MANTIS_API_URL": "https://mantis.example.com/api/rest",
        "MANTIS_API_KEY": "your-api-token"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MANTIS_API_URL` | Yes | — | MantisBT REST API base URL |
| `MANTIS_API_KEY` | Yes | — | API token (from MantisBT → My Account → API Tokens) |
| `DB_PATH` | No | `./mantis-mcp.db` | SQLite database file path |
| `EMBEDDING_MODEL` | No | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Hugging Face model for embeddings |
| `SYNC_BATCH_SIZE` | No | `50` | Issues fetched per batch during sync |
| `SYNC_ON_STARTUP` | No | `false` | Auto-sync when server starts |
| `LOG_LEVEL` | No | `info` | `error` / `warn` / `info` / `debug` |

## Tools Reference

### CRUD Tools (8)

| Tool | Description | Key Parameters |
|---|---|---|
| `get_issues` | List issues with filters | `page`, `page_size`, `project_id`, `filter_id` |
| `get_issue_by_id` | Get full issue details | `id` |
| `create_issue` | Create a new issue | `summary`, `description`, `project_id`, `category`, `priority` |
| `update_issue` | Update an existing issue | `id`, `summary`, `description`, `status`, `handler` |
| `add_issue_note` | Add a note/comment | `issue_id`, `text`, `view_state` |
| `get_projects` | List all projects | — |
| `get_user` | Look up user by username | `username` |
| `get_users_by_project_id` | List project members | `project_id` |

### Semantic Search Tools (3)

| Tool | Description | Key Parameters |
|---|---|---|
| `search` | Natural language search across indexed issues/notes | `query`, `limit` |
| `sync_index` | Sync MantisBT data into vector index | `project_id` (optional) |
| `sync_status` | Check index status and counts | — |

### Search Workflow

1. **First time**: Call `sync_index` to populate the vector database (may take several minutes for large databases)
2. **Search**: Use `search` with natural language queries — results include similarity scores
3. **Keep updated**: Call `sync_index` periodically — it performs incremental sync (only changed issues)

## Architecture

```
Claude Desktop / Claude Code
        │
        │ stdio (JSON-RPC)
        ▼
    mantis-mcp server
        │
        ├── CRUD tools ──────► MantisBT REST API
        │
        └── Search tools
              ├── sync ──────► MantisBT REST API → Embeddings → SQLite + sqlite-vec
              └── search ────► Embeddings → sqlite-vec KNN → Ranked results
```

- **Embeddings**: Generated locally with Transformers.js (~80MB model downloaded on first use)
- **Vector storage**: SQLite with sqlite-vec extension for fast cosine similarity search
- **Sync**: Compares `updated_at` timestamps to detect changes, then re-embeds only modified issues

## License

MIT
