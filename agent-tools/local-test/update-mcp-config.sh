#!/usr/bin/env bash
# update-mcp-config.sh
#
# Writes the AWS Region, the AWS profile and the state machine names into the MCP
# client configuration (agent-tools/config/mcp-claude-desktop.json).
#
#   AWS_REGION         taken from $AWS_REGION, or else from the Region the AWS CLI resolves
#                      (AWS_DEFAULT_REGION or the profile), so it matches the Region your
#                      stacks are deployed in.
#   STATE_MACHINE_LIST built from $TRANSFER_SM_NAME and $BRIDGE_SM_NAME, the names of
#                      the two tool state machines (stack outputs of paymaster-agent-tools).
#   AWS_PROFILE        set to $MCP_AWS_PROFILE when given. ./deploy.sh uses it to point the
#                      MCP server at the least-privilege paymaster-mcp profile.
#
# deploy.sh runs this script for you. To run it by hand, from the repository root:
#   export TRANSFER_SM_NAME=...   # GaslessTransferToolStateMachineName stack output
#   export BRIDGE_SM_NAME=...     # CctpBridgeToolStateMachineName stack output
#   export MCP_AWS_PROFILE=paymaster-mcp   # optional
#   bash agent-tools/local-test/update-mcp-config.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../config/mcp-claude-desktop.json"

if [[ -z "${TRANSFER_SM_NAME:-}" ]]; then
  echo "ERROR: TRANSFER_SM_NAME is not set (GaslessTransferToolStateMachineName stack output)." >&2
  exit 1
fi
if [[ -z "${BRIDGE_SM_NAME:-}" ]]; then
  echo "ERROR: BRIDGE_SM_NAME is not set (CctpBridgeToolStateMachineName stack output)." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: $CONFIG_FILE not found." >&2
  exit 1
fi

# AWS_REGION first, then whatever the AWS CLI resolves (AWS_DEFAULT_REGION or the profile).
# `aws configure get region` is not used: it reads only ~/.aws/config, not the environment.
REGION="${AWS_REGION:-$(aws configure list 2>/dev/null | awk '$1=="region" && $3!="<not" {print $3}' || true)}"
if [[ -z "${REGION:-}" ]]; then
  echo "ERROR: Could not determine the Region." >&2
  echo "       Run 'aws configure set region <region>' or 'export AWS_REGION=<region>'." >&2
  exit 1
fi

STATE_MACHINE_LIST="${TRANSFER_SM_NAME}, ${BRIDGE_SM_NAME}"
echo "AWS_REGION:         $REGION"
echo "STATE_MACHINE_LIST:  $STATE_MACHINE_LIST"

# Rewrite the values in place. A temporary file keeps this portable between macOS and Linux.
TMP="$(mktemp)"
sed -e "s|\"AWS_REGION\": \"[^\"]*\"|\"AWS_REGION\": \"${REGION}\"|g" \
    -e "s|\"STATE_MACHINE_LIST\": \"[^\"]*\"|\"STATE_MACHINE_LIST\": \"${STATE_MACHINE_LIST}\"|g" \
    "$CONFIG_FILE" > "$TMP"

if [[ -n "${MCP_AWS_PROFILE:-}" ]]; then
  echo "AWS_PROFILE:         $MCP_AWS_PROFILE"
  sed -i.bak -e "s|\"AWS_PROFILE\": \"[^\"]*\"|\"AWS_PROFILE\": \"${MCP_AWS_PROFILE}\"|g" "$TMP" && rm -f "$TMP.bak"
fi

# Refuse to write a file that is no longer valid JSON.
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TMP" \
  || { rm -f "$TMP"; echo "ERROR: the generated configuration is not valid JSON." >&2; exit 1; }

cat "$TMP" > "$CONFIG_FILE"
rm -f "$TMP"

echo "Updated: $CONFIG_FILE"
echo
echo "To use it with Amazon Quick Desktop:"
echo "  Settings, then Capabilities, then MCP, then Add MCP, then Import"
echo "  Config file: $(cd "$(dirname "$CONFIG_FILE")" && pwd)/$(basename "$CONFIG_FILE")"
