#!/usr/bin/env bash
# deploy.sh — one-command deployment for gasless USDC transfers on AWS
#
# Deploys three CloudFormation stacks with AWS SAM and wires them together:
#
#   1. gasless-workflow  A Step Functions workflow that runs any contract call
#                        as an ERC-4337 UserOperation, with gas paid in USDC
#                        through Circle Paymaster.
#   2. cctp-bridge       A Step Functions workflow that moves USDC across chains
#                        with Circle CCTP, reusing (1) twice.
#   3. agent-tools       Two Step Functions state machines, described by
#                        EventBridge schemas, that expose (1) and (2) to an AI
#                        agent over MCP.
#
# Every phase is idempotent: after a failure or a change, simply run it again.
#
# Usage:
#   ./deploy.sh              Run every phase in order (recommended)
#   ./deploy.sh keys         Generate wallet keys and write .env
#   ./deploy.sh fund         Check balances and print faucet instructions
#   ./deploy.sh stacks       Store secrets, then build and deploy all 3 stacks
#   ./deploy.sh harden       Create the least-privilege IAM user for the MCP server
#   ./deploy.sh mcp          Build the MCP client configuration
#   ./deploy.sh status       Show what is currently deployed
#   ./deploy.sh destroy      Delete every AWS resource this script created
#   ./deploy.sh destroy --purge-keys
#                            Also delete the local .env files that hold the wallet keys
#
# Two steps cannot be automated, and the script pauses for them:
#   - Funding the wallets from the Circle faucet, which needs a browser
#   - Installing the MCP config into your desktop agent, which runs on a laptop

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"

GASLESS_DIR="$ROOT_DIR/gasless-workflow"
BRIDGE_DIR="$ROOT_DIR/cctp-bridge"
AGENT_DIR="$ROOT_DIR/agent-tools"

GASLESS_STACK="gasless-paymaster"
BRIDGE_STACK="cctp-bridge"
AGENT_STACK="paymaster-agent-tools"
SCHEMA_REGISTRY="paymaster-schemas"

ETH_USDC="0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
# Public Ethereum Sepolia endpoints, tried in order. Used only for the balance check
# on your machine; the Lambda functions use the endpoints in lib/config.mjs.
ETH_RPCS="https://ethereum-sepolia.publicnode.com https://sepolia.drpc.org https://ethereum-sepolia-rpc.publicnode.com"

# Least-privilege identity for the MCP server (see phase_harden)
MCP_USER="paymaster-mcp-user"
MCP_POLICY="paymaster-mcp-policy"
MCP_PROFILE="paymaster-mcp"
# Minimum owner balance, in USDC. One Ethereum Sepolia transaction costs about 2 USDC in
# fees at typical testnet gas prices, and the faucet hands out 20 USDC per request.
MIN_OWNER_USDC=10

# ── Output helpers ───────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; DIM=''; OFF=''
fi

step() { printf '\n%s── %s%s\n' "$BOLD" "$1" "$OFF"; }
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$OFF" "$1"; }
info() { printf '%s   ·%s %s\n' "$DIM" "$OFF" "$1"; }
warn() { printf '%s   !%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '%s  error: %s%s\n' "$RED" "$1" "$OFF" >&2; exit 1; }


# ── Prerequisites ────────────────────────────────────────────────────────────
check_prereqs() {
  step "Checking prerequisites"

  command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 20 or later."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 20 ]] || die "Node.js 20 or later is required (found $(node -v))."
  ok "Node.js $(node -v)"

  command -v aws >/dev/null 2>&1 || die "AWS CLI not found. See https://aws.amazon.com/cli/"
  command -v sam >/dev/null 2>&1 || die "AWS SAM CLI not found. See https://aws.amazon.com/serverless/sam/"
  ok "AWS CLI and AWS SAM CLI present"

  aws sts get-caller-identity >/dev/null 2>&1 \
    || die "AWS credentials are not configured. Run 'aws configure', or use AWS CloudShell."

  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  # `aws configure list` reports the Region the AWS CLI will really use: the
  # AWS_REGION or AWS_DEFAULT_REGION variable first, then the profile. By contrast,
  # `aws configure get region` reads only ~/.aws/config, which is empty on CloudShell.
  REGION="$(aws configure list 2>/dev/null | awk '$1=="region" && $3!="<not" {print $3}' || true)"
  [[ -n "$REGION" ]] || die "No Region set. Run 'aws configure set region <region>' or 'export AWS_REGION=<region>'."
  # Pin it, so aws, sam and the helper scripts all use the Region reported here.
  export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
  ok "Account $ACCOUNT_ID, Region $REGION"
}

# Read one output value from a deployed stack. Prints nothing if absent.
stack_output() {
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text 2>/dev/null || true)"
  [[ "$value" == "None" ]] && value=""
  printf '%s' "$value"
}

# USDC balance of an address on Ethereum Sepolia, as a decimal string. Tries each
# endpoint in ETH_RPCS in turn. Prints "unknown" (never "0") when no endpoint answers,
# so an unreachable RPC is not mistaken for an empty wallet.
usdc_balance() {
  local address="$1"
  local script="$BRIDGE_DIR/.balance-check.mjs"
  local out=""

  cat > "$script" <<'NODE'
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { sepolia } from "viem/chains";

for (const url of process.env.ETH_RPCS.split(" ")) {
  try {
    // Fail fast: viem aborts the request after 8 seconds, DNS stalls included.
    const client = createPublicClient({
      chain: sepolia,
      transport: http(url, { timeout: 8_000, retryCount: 0 }),
    });
    const raw = await client.readContract({
      address: process.env.ETH_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [process.argv[2]],
    });
    console.log(formatUnits(raw, 6));
    process.exit(0);
  } catch {
    // try the next endpoint
  }
}
console.log("unknown");
NODE

  out="$(cd "$BRIDGE_DIR" && ETH_USDC="$ETH_USDC" ETH_RPCS="$ETH_RPCS" \
    node "$script" "$address" 2>/dev/null | tail -1)" || out=""
  rm -f "$script"

  if [[ "$out" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf '%s' "$out"
  else
    printf 'unknown'
  fi
}

# True when $1 is a number that is at least $2.
at_least() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk "BEGIN{exit !($1 >= $2)}"
}

# ── Phase: keys ──────────────────────────────────────────────────────────────
# Generates two throwaway keypairs and writes .env. cctp-bridge/.env.example is
# the template because it already lists every testnet contract address.
phase_keys() {
  step "Generating wallet keys"

  if [[ -f "$ENV_FILE" ]]; then
    ok ".env already exists, keeping the existing keys"
    info "Delete $ENV_FILE first if you want a fresh pair"
    # The stacks read the .env in their own directory: restore a copy that went missing.
    local dir
    for dir in "$GASLESS_DIR" "$BRIDGE_DIR"; do
      if [[ ! -f "$dir/.env" ]]; then
        cp "$ENV_FILE" "$dir/.env"
        chmod 600 "$dir/.env"
        info "Restored the missing .env in $(basename "$dir")/"
      fi
    done
    return
  fi

  ensure_deps "$BRIDGE_DIR"

  # Run from cctp-bridge/ because that is where viem is installed.
  (cd "$BRIDGE_DIR" && node - "$BRIDGE_DIR/.env.example" "$ENV_FILE" <<'NODE'
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "fs";

const [templatePath, outPath] = process.argv.slice(2);

const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const recipientKey = generatePrivateKey();
const recipient = privateKeyToAccount(recipientKey);

const content = readFileSync(templatePath, "utf8")
  .replace(/^OWNER_PRIVATE_KEY=.*$/m, `OWNER_PRIVATE_KEY=${ownerKey}`)
  .replace(/^OWNER_ADDRESS=.*$/m, `OWNER_ADDRESS=${owner.address}`)
  .replace(/^RECIPIENT_PRIVATE_KEY=.*$/m, `RECIPIENT_PRIVATE_KEY=${recipientKey}`)
  .replace(/^RECIPIENT_ADDRESS=.*$/m, `RECIPIENT_ADDRESS=${recipient.address}`);

const required = [
  "OWNER_PRIVATE_KEY", "OWNER_ADDRESS",
  "RECIPIENT_PRIVATE_KEY", "RECIPIENT_ADDRESS",
  "ETH_USDC_ADDRESS", "ETH_PAYMASTER_ADDRESS", "BASE_USDC_ADDRESS",
];
for (const key of required) {
  if (!new RegExp(`^${key}=.+`, "m").test(content)) {
    console.error(`Generated .env is missing ${key}`);
    process.exit(1);
  }
}

writeFileSync(outPath, content, { mode: 0o600 });
console.log(`  owner     ${owner.address}`);
console.log(`  recipient ${recipient.address}`);
NODE
  )

  chmod 600 "$ENV_FILE"
  ok "Wrote $ENV_FILE with permissions 600"

  # Both stacks that read a .env expect it in their own directory.
  cp "$ENV_FILE" "$GASLESS_DIR/.env"
  cp "$ENV_FILE" "$BRIDGE_DIR/.env"
  chmod 600 "$GASLESS_DIR/.env" "$BRIDGE_DIR/.env"
  ok "Copied .env into gasless-workflow/ and cctp-bridge/"
  warn "These are throwaway testnet keys. Never reuse them on mainnet."
}

ensure_deps() {
  if [[ ! -d "$1/node_modules" ]]; then
    info "Installing dependencies in $(basename "$1")"
    (cd "$1" && npm install --silent)
  fi
}

# ── Phase: fund ──────────────────────────────────────────────────────────────
phase_fund() {
  step "Funding wallets"
  [[ -f "$ENV_FILE" ]] || die "No .env found. Run './deploy.sh keys' first."

  # shellcheck disable=SC1090
  source "$ENV_FILE"
  ensure_deps "$BRIDGE_DIR"

  local balance
  balance="$(usdc_balance "$OWNER_ADDRESS")"
  if at_least "$balance" "$MIN_OWNER_USDC"; then
    ok "Owner holds $balance USDC on Ethereum Sepolia, which is enough"
    return
  fi

  cat <<EOF

  ${BOLD}Action required: fund these wallets with testnet USDC${OFF}

  Open ${BOLD}https://faucet.circle.com${OFF} and request USDC for:

    Ethereum Sepolia   $OWNER_ADDRESS
                       one request of 20 USDC. Each Ethereum Sepolia transaction costs
                       about 2 USDC in gas fees, on top of the amount you send.
    Base Sepolia       $RECIPIENT_ADDRESS
                       one request of 20 USDC. It pays the gas fee on the mint side of
                       a bridge.

  The faucet allows one request per address and network every 2 hours.

EOF
  if [[ "$balance" == "unknown" ]]; then
    warn "Could not read the owner balance: no Ethereum Sepolia RPC endpoint answered."
  else
    info "Owner balance right now: ${balance} USDC on Ethereum Sepolia"
  fi
  read -r -p "  Press Enter when both wallets are funded, or Ctrl-C to stop: " _

  balance="$(usdc_balance "$OWNER_ADDRESS")"
  if at_least "$balance" "$MIN_OWNER_USDC"; then
    ok "Owner now holds $balance USDC"
  elif [[ "$balance" == "unknown" ]]; then
    warn "Still cannot read the balance (no RPC endpoint answered). Continuing."
    warn "Check it yourself with './deploy.sh status' once your network allows it."
  else
    warn "Owner balance is $balance USDC, below the recommended $MIN_OWNER_USDC."
    warn "Deployment continues, but transfers fail once the balance cannot cover the fees."
  fi
}

# ── Phase: stacks ────────────────────────────────────────────────────────────
phase_stacks() {
  [[ -f "$ENV_FILE" ]] || die "No .env found. Run './deploy.sh keys' first."

  step "Storing private keys in AWS Secrets Manager"
  ensure_deps "$GASLESS_DIR"
  (cd "$GASLESS_DIR" && node scripts/aws-setup.mjs)
  ok "Secrets paymaster-key-owner and paymaster-key-recipient are ready"

  deploy_stack "gasless-workflow" "$GASLESS_DIR" "$GASLESS_STACK"
  GASLESS_SM_ARN="$(stack_output "$GASLESS_STACK" StateMachineArn)"
  [[ -n "$GASLESS_SM_ARN" ]] || die "Could not read StateMachineArn from $GASLESS_STACK."
  ok "Gasless workflow ARN captured"

  # The bridge runs each onchain leg as a nested execution of the gasless
  # workflow, so it needs that ARN at deploy time.
  deploy_stack "cctp-bridge" "$BRIDGE_DIR" "$BRIDGE_STACK" \
    "GaslessWorkflowStateMachineArn=$GASLESS_SM_ARN"
  BRIDGE_SM_ARN="$(stack_output "$BRIDGE_STACK" CctpBridgeStateMachineArn)"
  [[ -n "$BRIDGE_SM_ARN" ]] || die "Could not read CctpBridgeStateMachineArn from $BRIDGE_STACK."
  ok "CCTP bridge ARN captured"

  register_schemas

  # agent-tools has no Paymaster logic of its own: it needs both ARNs to
  # delegate to, so it must be deployed last.
  deploy_stack "agent-tools" "$AGENT_DIR" "$AGENT_STACK" \
    "GaslessWorkflowStateMachineArn=$GASLESS_SM_ARN" \
    "CctpBridgeStateMachineArn=$BRIDGE_SM_ARN"
  ok "Agent tools deployed and wired to both workflows"
}

deploy_stack() {
  local name="$1" dir="$2" stack="$3"
  shift 3

  step "Deploying $name"
  ensure_deps "$dir"

  # A stack left in ROLLBACK_COMPLETE can never be updated, only replaced.
  local status
  status="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)"
  if [[ "$status" == "ROLLBACK_COMPLETE" ]]; then
    warn "$stack is in ROLLBACK_COMPLETE from an earlier failure, deleting it"
    aws cloudformation delete-stack --stack-name "$stack"
    aws cloudformation wait stack-delete-complete --stack-name "$stack"
  fi

  local args=(
    --stack-name "$stack"
    --capabilities CAPABILITY_IAM
    --resolve-s3
    --no-confirm-changeset
    --no-fail-on-empty-changeset
  )
  [[ $# -gt 0 ]] && args+=(--parameter-overrides "$@")

  info "Building"
  (cd "$dir" && sam build >/dev/null)
  info "Deploying, which usually takes 1 to 2 minutes"
  (cd "$dir" && sam deploy "${args[@]}" >/dev/null)
  ok "$stack deployed"
}

register_schemas() {
  step "Registering tool schemas in Amazon EventBridge"

  if aws schemas describe-registry --registry-name "$SCHEMA_REGISTRY" >/dev/null 2>&1; then
    info "Registry $SCHEMA_REGISTRY already exists"
  else
    aws schemas create-registry --registry-name "$SCHEMA_REGISTRY" \
      --description "Input schemas for Circle Paymaster MCP tools" >/dev/null
    ok "Created registry $SCHEMA_REGISTRY"
  fi

  upsert_schema GaslessTransferToolInput "Input schema for the GaslessTransferTool MCP tool"
  upsert_schema CctpBridgeToolInput "Input schema for the CctpBridgeTool MCP tool"
}

upsert_schema() {
  local name="$1" description="$2"
  local file="$AGENT_DIR/schemas/$name.json"
  [[ -f "$file" ]] || die "Schema file not found: $file"

  if aws schemas describe-schema --registry-name "$SCHEMA_REGISTRY" \
       --schema-name "$name" >/dev/null 2>&1; then
    # update-schema fails with a ConflictException when the content is identical to the
    # current version, which is the normal case on a re-run. That is not an error here.
    local err
    if err="$(aws schemas update-schema \
        --registry-name "$SCHEMA_REGISTRY" --schema-name "$name" \
        --type JSONSchemaDraft4 --content "file://$file" 2>&1 >/dev/null)"; then
      ok "Updated schema $name"
    elif [[ "$err" == *"No change since the previous schema version"* ]]; then
      ok "Schema $name is already up to date"
    else
      die "Could not update schema $name: $err"
    fi
  else
    aws schemas create-schema \
      --registry-name "$SCHEMA_REGISTRY" --schema-name "$name" \
      --type JSONSchemaDraft4 --description "$description" \
      --content "file://$file" >/dev/null
    ok "Created schema $name"
  fi
}


# ── Phase: harden ────────────────────────────────────────────────────────────
# Creates the identity the MCP server runs as. It can start and describe the two
# tool state machines and read the two schemas, and nothing else. It cannot read
# the wallet keys in Secrets Manager, and it cannot change any resource.
phase_harden() {
  step "Creating the least-privilege IAM user for the MCP server"

  local policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${MCP_POLICY}"
  local rendered="$AGENT_DIR/paymaster-mcp-policy.json"
  local creds="$AGENT_DIR/config/${MCP_PROFILE}.credentials"

  sed -e "s|<REGION>|$REGION|g" -e "s|<ACCOUNT_ID>|$ACCOUNT_ID|g" \
    "$AGENT_DIR/paymaster-mcp-policy_template.json" > "$rendered"
  ok "Rendered the policy for account $ACCOUNT_ID in $REGION"

  if aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
    # IAM keeps at most 5 versions of a policy: drop the oldest non-default one first.
    local oldest count
    count="$(aws iam list-policy-versions --policy-arn "$policy_arn" \
      --query 'length(Versions[?!IsDefaultVersion])' --output text)"
    if [[ "$count" -ge 4 ]]; then
      oldest="$(aws iam list-policy-versions --policy-arn "$policy_arn" \
        --query 'sort_by(Versions[?!IsDefaultVersion], &CreateDate)[0].VersionId' --output text)"
      aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$oldest"
    fi
    aws iam create-policy-version --policy-arn "$policy_arn" \
      --policy-document "file://$rendered" --set-as-default >/dev/null
    ok "Updated policy $MCP_POLICY"
  else
    aws iam create-policy --policy-name "$MCP_POLICY" \
      --policy-document "file://$rendered" >/dev/null
    ok "Created policy $MCP_POLICY"
  fi

  if ! aws iam get-user --user-name "$MCP_USER" >/dev/null 2>&1; then
    aws iam create-user --user-name "$MCP_USER" >/dev/null
    ok "Created user $MCP_USER"
  fi
  aws iam attach-user-policy --user-name "$MCP_USER" --policy-arn "$policy_arn"
  ok "Attached $MCP_POLICY to $MCP_USER"

  # The secret half of an access key can only be read once, when it is created.
  # Keep the key in a private local file, so a re-run reuses it instead of rotating it.
  local current_id="" existing
  if [[ -f "$creds" ]]; then
    current_id="$(sed -n 's/^aws_access_key_id *= *//p' "$creds" | head -1)"
  fi
  existing="$(aws iam list-access-keys --user-name "$MCP_USER" \
    --query 'AccessKeyMetadata[].AccessKeyId' --output text)"

  if [[ -n "$current_id" && " $existing " == *" $current_id "* ]]; then
    ok "Access key already stored in agent-tools/config/${MCP_PROFILE}.credentials"
  else
    local old
    for old in $existing; do
      aws iam delete-access-key --user-name "$MCP_USER" --access-key-id "$old"
    done
    (
      umask 077
      aws iam create-access-key --user-name "$MCP_USER" \
        --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text \
      | awk -v profile="$MCP_PROFILE" -v region="$REGION" \
          '{ printf "[%s]\naws_access_key_id = %s\naws_secret_access_key = %s\nregion = %s\n", profile, $1, $2, region }' \
        > "$creds"
    )
    chmod 600 "$creds"
    ok "Created an access key and saved it to agent-tools/config/${MCP_PROFILE}.credentials"
    info "The secret is not printed. The file has permissions 600 and is git-ignored."
  fi
}

# ── Phase: mcp ───────────────────────────────────────────────────────────────
phase_mcp() {
  step "Building the MCP client configuration"

  local transfer_name bridge_name
  transfer_name="$(stack_output "$AGENT_STACK" GaslessTransferToolStateMachineName)"
  bridge_name="$(stack_output "$AGENT_STACK" CctpBridgeToolStateMachineName)"

  [[ -n "$transfer_name" ]] || die "Could not read the transfer tool name. Run './deploy.sh stacks' first."
  [[ -n "$bridge_name" ]] || die "Could not read the bridge tool name. Run './deploy.sh stacks' first."

  ok "Transfer tool: $transfer_name"
  ok "Bridge tool:   $bridge_name"

  local creds="$AGENT_DIR/config/${MCP_PROFILE}.credentials"
  [[ -f "$creds" ]] || die "No credentials for the MCP server. Run './deploy.sh harden' first."

  TRANSFER_SM_NAME="$transfer_name" BRIDGE_SM_NAME="$bridge_name" \
    MCP_AWS_PROFILE="$MCP_PROFILE" \
    bash "$AGENT_DIR/local-test/update-mcp-config.sh" >/dev/null
  ok "Updated agent-tools/config/mcp-claude-desktop.json (AWS profile: $MCP_PROFILE)"

  cat <<EOF

  ${BOLD}Action required: install the credentials and the config on the machine that runs your agent${OFF}

  Two files were generated in agent-tools/config/:
    ${MCP_PROFILE}.credentials     the AWS profile for the MCP server (keep it private)
    mcp-claude-desktop.json        the MCP server configuration

  1. Append the profile to your AWS credentials file on the laptop:
       cat ${MCP_PROFILE}.credentials >> ~/.aws/credentials
  2. Install the MCP configuration, which needs uv with Python 3.12:
       brew install uv && uv python install 3.12

  ${BOLD}Claude Desktop${OFF}
    Merge the "mcpServers" block into your config file, then quit and reopen:
      macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
      Windows  %APPDATA%\\Claude\\claude_desktop_config.json

  ${BOLD}Amazon Quick Desktop${OFF}
    Settings, then Capabilities, then MCP, then Add MCP, then Import the file.

  Running from AWS CloudShell? Print both files and copy them to your laptop:
    cat agent-tools/config/${MCP_PROFILE}.credentials agent-tools/config/mcp-claude-desktop.json

  Then ask your agent: ${BOLD}"Send 1 USDC to <address> on Ethereum Sepolia"${OFF}

EOF
}

# ── Phase: status ────────────────────────────────────────────────────────────
phase_status() {
  step "Stacks"
  local stack status
  for stack in "$GASLESS_STACK" "$BRIDGE_STACK" "$AGENT_STACK"; do
    status="$(aws cloudformation describe-stacks --stack-name "$stack" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "not deployed")"
    printf '  %-24s %s\n' "$stack" "$status"
  done

  step "Secrets"
  local secret
  for secret in paymaster-key-owner paymaster-key-recipient; do
    if aws secretsmanager describe-secret --secret-id "$secret" >/dev/null 2>&1; then
      printf '  %-24s %s\n' "$secret" "present"
    else
      printf '  %-24s %s\n' "$secret" "missing"
    fi
  done

  step "MCP identity"
  if aws iam get-user --user-name "$MCP_USER" >/dev/null 2>&1; then
    printf '  %-24s %s\n' "$MCP_USER" "present"
  else
    printf '  %-24s %s\n' "$MCP_USER" "missing"
  fi

  step "Tool schemas"
  if aws schemas describe-registry --registry-name "$SCHEMA_REGISTRY" >/dev/null 2>&1; then
    aws schemas list-schemas --registry-name "$SCHEMA_REGISTRY" \
      --query 'Schemas[].SchemaName' --output text | tr '\t' '\n' | sed 's/^/  /'
  else
    info "Registry $SCHEMA_REGISTRY not found"
  fi

  if [[ -f "$ENV_FILE" ]]; then
    step "Wallets"
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    printf '  %-24s %s\n' "owner" "$OWNER_ADDRESS"
    local owner_balance
    owner_balance="$(usdc_balance "$OWNER_ADDRESS")"
    if [[ "$owner_balance" == "unknown" ]]; then
      printf '  %-24s %s\n' "owner balance" "unknown (no Ethereum Sepolia RPC endpoint answered)"
    else
      printf '  %-24s %s USDC on Ethereum Sepolia\n' "owner balance" "$owner_balance"
    fi
    printf '  %-24s %s\n' "recipient" "$RECIPIENT_ADDRESS"
  fi
  printf '\n'
}

# ── Phase: destroy ───────────────────────────────────────────────────────────
phase_destroy() {
  local purge_keys="no"
  [[ "${1:-}" == "--purge-keys" ]] && purge_keys="yes"

  step "Deleting everything this script created"
  warn "This removes 3 stacks, their log groups, 2 secrets, the $SCHEMA_REGISTRY registry,"
  warn "and the $MCP_USER IAM user with its policy and access key."
  read -r -p "  Type 'delete' to confirm: " confirm
  [[ "$confirm" == "delete" ]] || die "Aborted."

  # Delete in reverse dependency order: agent-tools references the other two.
  local stack fn group
  for stack in "$AGENT_STACK" "$BRIDGE_STACK" "$GASLESS_STACK"; do
    if aws cloudformation describe-stacks --stack-name "$stack" >/dev/null 2>&1; then
      # CloudFormation does not delete Lambda log groups. Read the function names
      # now, while the stack still exists, so only its own log groups are removed.
      local groups=()
      for fn in $(aws cloudformation list-stack-resources --stack-name "$stack" \
          --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" \
          --output text); do
        groups+=("/aws/lambda/$fn")
      done

      info "Deleting $stack"
      aws cloudformation delete-stack --stack-name "$stack"
      aws cloudformation wait stack-delete-complete --stack-name "$stack" \
        || warn "$stack did not delete cleanly, check the CloudFormation console"
      ok "Deleted $stack"

      for group in "${groups[@]}"; do
        aws logs delete-log-group --log-group-name "$group" >/dev/null 2>&1 || true
      done
      [[ ${#groups[@]} -gt 0 ]] && ok "Deleted ${#groups[@]} log groups of $stack"
    fi
  done

  local name
  for name in GaslessTransferToolInput CctpBridgeToolInput; do
    if aws schemas delete-schema --registry-name "$SCHEMA_REGISTRY" \
         --schema-name "$name" >/dev/null 2>&1; then
      ok "Deleted schema $name"
    fi
  done
  if aws schemas delete-registry --registry-name "$SCHEMA_REGISTRY" >/dev/null 2>&1; then
    ok "Deleted registry $SCHEMA_REGISTRY"
  fi

  local secret
  for secret in paymaster-key-owner paymaster-key-recipient; do
    if aws secretsmanager delete-secret --secret-id "$secret" \
         --force-delete-without-recovery >/dev/null 2>&1; then
      ok "Deleted secret $secret"
    fi
  done

  # The MCP identity: access keys first, then the policy attachment, then the user,
  # then every policy version, then the policy itself.
  local policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${MCP_POLICY}" key version
  if aws iam get-user --user-name "$MCP_USER" >/dev/null 2>&1; then
    for key in $(aws iam list-access-keys --user-name "$MCP_USER" \
        --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
      aws iam delete-access-key --user-name "$MCP_USER" --access-key-id "$key"
    done
    aws iam detach-user-policy --user-name "$MCP_USER" --policy-arn "$policy_arn" >/dev/null 2>&1 || true
    aws iam delete-user --user-name "$MCP_USER"
    ok "Deleted IAM user $MCP_USER and its access keys"
  fi
  if aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
    for version in $(aws iam list-policy-versions --policy-arn "$policy_arn" \
        --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
      aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$version"
    done
    aws iam delete-policy --policy-arn "$policy_arn"
    ok "Deleted IAM policy $MCP_POLICY"
  fi

  # Generated local files. The wallet keys are kept unless you ask for them to go,
  # because an unfunded testnet wallet is worth keeping if you plan to redeploy.
  rm -f "$AGENT_DIR/config/${MCP_PROFILE}.credentials" "$AGENT_DIR/paymaster-mcp-policy.json" \
        "$GASLESS_DIR/local-test/env.json" "$GASLESS_DIR/local-test/test-event.json"
  ok "Removed the generated credentials file and test events"
  if [[ "$purge_keys" == "yes" ]]; then
    rm -f "$ENV_FILE" "$GASLESS_DIR/.env" "$BRIDGE_DIR/.env"
    ok "Removed the local .env files that hold the wallet keys"
  elif [[ -f "$ENV_FILE" ]]; then
    info "Kept the local .env files (wallet keys). Run './deploy.sh destroy --purge-keys' to remove them."
  fi

  info "If you appended the $MCP_PROFILE profile to ~/.aws/credentials, remove that section by hand."
  info "The AWS SAM deployment bucket (aws-sam-cli-managed-default-*) is shared by all your SAM"
  info "projects and is kept. See the Clean up section of README.md to delete it."
}

# ── Entry point ──────────────────────────────────────────────────────────────
main() {
  local phase="${1:-all}"

  case "$phase" in
    -h|--help|help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
      return 0
      ;;
  esac

  case "$phase" in
    keys)    check_prereqs; phase_keys ;;
    fund)    check_prereqs; phase_fund ;;
    stacks)  check_prereqs; phase_stacks ;;
    harden)  check_prereqs; phase_harden ;;
    mcp)     check_prereqs; phase_mcp ;;
    status)  check_prereqs; phase_status ;;
    destroy) check_prereqs; phase_destroy "${2:-}" ;;
    all)
      check_prereqs
      phase_keys
      phase_fund
      phase_stacks
      phase_harden
      phase_mcp
      step "Deployment complete"
      ok "All three stacks are deployed and the MCP identity and configuration are ready"
      info "Check anytime with './deploy.sh status'"
      info "Remove everything with './deploy.sh destroy'"
      printf '\n'
      ;;
    *) die "Unknown phase '$phase'. Run './deploy.sh --help'." ;;
  esac
}

main "$@"
