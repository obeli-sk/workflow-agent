image := "ghcr.io/obeli-sk/obelisk-agent-server:latest"

build:
  docker build -t {{image}} agent-server

serve:
  obelisk server run -d deployment.toml

# Workflow params are JSON: a quoted prompt string and the backend option
# (null => claude). Prompts containing double quotes should use the web UI.
run prompt:
  sh -c 'obelisk execution submit ${OBELISK_SUBMIT_FLAGS:-} -f obelisk-agent:workflow/workflow.run -- "\"{{prompt}}\"" null'

run-codex prompt:
  sh -c 'obelisk execution submit ${OBELISK_SUBMIT_FLAGS:-} -f obelisk-agent:workflow/workflow.run -- "\"{{prompt}}\"" "\"codex\""'
