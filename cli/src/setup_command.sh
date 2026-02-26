## Detect OS and environment
detect_platform() {
  if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
    echo "wsl"
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "${WINDIR:-}" ]]; then
    echo "windows"
  else
    echo "linux"
  fi
}

PLATFORM=$(detect_platform)
echo "Detected platform: $PLATFORM"
echo ""

## Get the absolute path to mantis-mcp dist/index.js
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
INDEX_PATH="$PROJECT_DIR/dist/index.js"

if [[ ! -f "$INDEX_PATH" ]]; then
  echo "Error: dist/index.js not found at $INDEX_PATH"
  echo "Please run 'npm run build' first."
  exit 1
fi

## Collect API URL
API_URL="${args[--api-url]:-}"
if [[ -z "$API_URL" ]]; then
  echo "Enter your MantisBT REST API URL"
  echo "(e.g. https://debug.espero.it/mantis/api/rest)"
  read -rp "> " API_URL
  echo ""
fi

## Validate URL
if [[ ! "$API_URL" =~ ^https?:// ]]; then
  echo "Error: Invalid URL. Must start with http:// or https://"
  exit 1
fi

## Collect API Key
API_KEY="${args[--api-key]:-}"
if [[ -z "$API_KEY" ]]; then
  echo "Enter your MantisBT API token"
  echo "(from MantisBT → My Account → API Tokens)"
  read -rp "> " API_KEY
  echo ""
fi

if [[ -z "$API_KEY" ]]; then
  echo "Error: API token cannot be empty."
  exit 1
fi

## Test the connection
echo "Testing API connection..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $API_KEY" "$API_URL/projects" 2>/dev/null)
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "Connection successful!"
  echo ""
elif [[ "$HTTP_CODE" == "401" ]]; then
  echo "Warning: Got 401 Unauthorized. The token may be invalid or the server needs the Authorization header fix."
  echo "Continuing anyway..."
  echo ""
else
  echo "Warning: Got HTTP $HTTP_CODE. The URL may be incorrect."
  echo "Continuing anyway..."
  echo ""
fi

TARGET="${args[--target]}"

## Build the MCP server JSON snippet
build_mcp_json() {
  local cmd="$1"
  local args_json="$2"

  cat <<MCPEOF
{
  "mcpServers": {
    "mantis": {
      "command": "$cmd",
      "args": $args_json,
      "env": {
        "MANTIS_API_URL": "$API_URL",
        "MANTIS_API_KEY": "$API_KEY"
      }
    }
  }
}
MCPEOF
}

## Determine command and args based on platform
get_desktop_cmd() {
  if [[ "$PLATFORM" == "wsl" ]]; then
    echo "wsl"
  else
    echo "node"
  fi
}

get_desktop_args_json() {
  if [[ "$PLATFORM" == "wsl" ]]; then
    echo "[\"bash\", \"-c\", \"cd $PROJECT_DIR && node dist/index.js\"]"
  elif [[ "$PLATFORM" == "windows" ]]; then
    local win_path
    win_path=$(cygpath -w "$INDEX_PATH" 2>/dev/null || echo "$INDEX_PATH")
    win_path="${win_path//\\/\\\\}"
    echo "[\"$win_path\"]"
  else
    echo "[\"$INDEX_PATH\"]"
  fi
}

get_cli_cmd() {
  echo "node"
}

get_cli_args_json() {
  echo "[\"$INDEX_PATH\"]"
}

## Get Claude Desktop config path
get_desktop_config_path() {
  case "$PLATFORM" in
    wsl)
      # Windows path from WSL
      local win_appdata
      win_appdata=$(cmd.exe /C "echo %APPDATA%" 2>/dev/null | tr -d '\r')
      if [[ -n "$win_appdata" ]]; then
        local wsl_path
        wsl_path=$(wslpath "$win_appdata" 2>/dev/null)
        echo "$wsl_path/Claude/claude_desktop_config.json"
      else
        echo ""
      fi
      ;;
    macos)
      echo "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      ;;
    windows)
      echo "$APPDATA/Claude/claude_desktop_config.json"
      ;;
    linux)
      echo "$HOME/.config/claude/claude_desktop_config.json"
      ;;
  esac
}

## Merge MCP config into existing JSON file using node
merge_mcp_config() {
  local config_file="$1"
  local mcp_json="$2"

  if [[ ! -f "$config_file" ]]; then
    # Create directory if needed
    mkdir -p "$(dirname "$config_file")"
    echo "$mcp_json" > "$config_file"
    return
  fi

  # Use node to merge JSON (handles existing mcpServers)
  node -e "
    const fs = require('fs');
    const existing = JSON.parse(fs.readFileSync('$config_file', 'utf8'));
    const newConfig = JSON.parse(\`$mcp_json\`);
    existing.mcpServers = existing.mcpServers || {};
    Object.assign(existing.mcpServers, newConfig.mcpServers);
    fs.writeFileSync('$config_file', JSON.stringify(existing, null, 2) + '\n');
  " 2>/dev/null

  if [[ $? -ne 0 ]]; then
    echo "Warning: Could not merge into existing config. Writing new file."
    echo "$mcp_json" > "$config_file"
  fi
}

## Configure Claude Desktop
if [[ "$TARGET" == "desktop" ]] || [[ "$TARGET" == "both" ]]; then
  echo "=== Configuring Claude Desktop ==="

  DESKTOP_CONFIG_PATH=$(get_desktop_config_path)

  if [[ -z "$DESKTOP_CONFIG_PATH" ]]; then
    echo "Could not determine Claude Desktop config path for this platform."
    echo "Please manually add the MCP config to your claude_desktop_config.json"
  else
    MCP_JSON=$(build_mcp_json "$(get_desktop_cmd)" "$(get_desktop_args_json)")

    merge_mcp_config "$DESKTOP_CONFIG_PATH" "$MCP_JSON"
    echo "Written to: $DESKTOP_CONFIG_PATH"
    echo "Please restart Claude Desktop to apply changes."
  fi
  echo ""
fi

## Configure Claude Code (CLI)
if [[ "$TARGET" == "cli" ]] || [[ "$TARGET" == "both" ]]; then
  echo "=== Configuring Claude Code (CLI) ==="

  MCP_JSON_FILE="$PROJECT_DIR/.mcp.json"
  MCP_JSON=$(build_mcp_json "$(get_cli_cmd)" "$(get_cli_args_json)")

  echo "$MCP_JSON" > "$MCP_JSON_FILE"
  echo "Written to: $MCP_JSON_FILE"
  echo "Claude Code will prompt you to approve the MCP server on first use."
  echo ""
fi

## Create .env file
ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<ENVEOF
MANTIS_API_URL=$API_URL
MANTIS_API_KEY=$API_KEY
DB_PATH=./mantis-mcp.db
EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
SYNC_BATCH_SIZE=50
SYNC_ON_STARTUP=false
LOG_LEVEL=info
ENVEOF
  echo "Created .env file at: $ENV_FILE"
else
  echo ".env file already exists at: $ENV_FILE (not overwritten)"
fi

echo ""
echo "Setup complete! Next steps:"
echo "  1. Restart Claude Desktop (if configured)"
echo "  2. Ask Claude to 'sync the MantisBT index' to enable semantic search"
echo "  3. Then search with natural language queries!"
