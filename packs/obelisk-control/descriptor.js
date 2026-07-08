// obelisk-control pack descriptor. This is the single source of truth for the
// agent's system prompt and tool catalog for the "control this Obelisk instance"
// use case. The generic core (workflow.agent-loop) calls this FFQN once at loop
// start, exposes the tools to the model, and dispatches each tool call to its
// `ffqn` via obelisk.call. The core knows nothing about these tools.
//
// obelisk-control:agent/pack.describe:
//   func() -> result<record { prompt: string, tools-json: string }, string>
//
// tools-json is a JSON array of tools:
//   { name, description, ffqn, params: [{ name, type, default? }] }
// `type` is a WIT type string (string, bool, u32, list<string>, option<string>,
// ...). The core builds the model-facing JSON schema and encodes the model's
// arguments into positional WIT params from these specs.

const OBELISK_DOCS_URL = 'https://obeli.sk/docs/latest/llms.txt/';
const nl = String.fromCharCode(10);

function p(name, type, def) { return def === undefined ? { name, type } : { name, type, default: def }; }
function tool(name, ffqn, description, params) { return { name, ffqn, description, params: params || [] }; }

const TOOLS = [
    // --- discover / inspect ---
    tool('obelisk.list_functions', 'obelisk-agent:tools/webapi.list-functions',
        'Discover callable Obelisk FFQNs. Returns each function with its full WIT (interface, signature, and referenced types).',
        [p('ffqn_prefix', 'string', ''), p('length', 'u32', 100)]),
    tool('obelisk.get_function_wit', 'obelisk-agent:tools/webapi.get-function-wit',
        'Return the WIT signature for one FFQN. Use before obelisk.call when the parameter types are not already known.',
        [p('ffqn', 'string')]),
    tool('obelisk.list_executions', 'obelisk-agent:tools/webapi.list-executions',
        'Page through executions, optionally filtered by function, id prefix, component digest, deployment, and state.',
        [p('ffqn_prefix', 'string', ''), p('execution_id_prefix', 'string', ''), p('show_derived', 'bool', false),
         p('hide_finished', 'bool', false), p('component_digest', 'string', ''), p('deployment_id', 'string', ''),
         p('cursor', 'string', ''), p('direction', 'string', ''), p('including_cursor', 'bool', false), p('length', 'u32', 20)]),
    tool('obelisk.get_execution', 'obelisk-agent:tools/webapi.get-execution',
        'Read one execution record: status, FFQN, timestamps, deployment id, and component metadata.',
        [p('execution_id', 'string')]),
    tool('obelisk.get_logs', 'obelisk-agent:tools/webapi.get-logs',
        'Read paginated logs and stream events for an execution.',
        [p('execution_id', 'string'), p('show_derived', 'bool', true), p('show_logs', 'bool', true), p('show_streams', 'bool', true),
         p('levels', 'list<string>', []), p('stream_types', 'list<string>', []), p('cursor', 'string', ''),
         p('direction', 'string', ''), p('including_cursor', 'bool', false), p('length', 'u32', 200)]),
    tool('obelisk.get_result', 'obelisk-agent:tools/webapi.get-result-json',
        'Read the final result for a finished execution.',
        [p('execution_id', 'string')]),
    tool('obelisk.list_deployments', 'obelisk-agent:tools/webapi.list-deployments',
        'List deployments and their status counters.',
        [p('cursor_from', 'string', ''), p('including_cursor', 'bool', false), p('length', 'u32', 20)]),
    tool('obelisk.current_deployment_id', 'obelisk-agent:tools/webapi.current-deployment-id',
        'Return the active deployment id.', []),
    tool('obelisk.get_deployment', 'obelisk-agent:tools/webapi.get-deployment',
        'Read deployment metadata and a paginated window of deployment TOML.',
        [p('deployment_id', 'string'), p('component_type', 'option<string>'), p('offset', 'option<u32>'),
         p('length', 'option<u32>'), p('max_bytes', 'option<u32>')]),
    tool('obelisk.get_component_source', 'obelisk-agent:tools/webapi.get-component-source',
        'Read a paginated window of a component source file from a stored deployment.',
        [p('deployment_id', 'string'), p('component', 'string'), p('offset', 'u32', 0), p('length', 'u32', 0)]),

    // --- native call: run any deployed function ---
    tool('obelisk.call', 'obelisk-control:tools/native.call',
        'Call any deployed Obelisk workflow or activity and wait for its result. params_json is a JSON array of positional parameters encoded from the target WIT (call obelisk.get_function_wit first when unsure). Errors include the runtime error and, when available, the target WIT.',
        [p('ffqn', 'string'), p('params_json', 'string', '[]')]),

    // --- deployment editing (stateless): read -> edit toml -> submit -> activate ---
    tool('obelisk.deployment_checkout', 'obelisk-agent:tools/webapi.deployment-checkout',
        'Read a deployment for editing. Returns { deployment_id, active_deployment_id, deployment_toml }. Owned JS/exec sources are referenced by location + content_digest; fetch their bytes with obelisk.deployment_read_blob. Defaults to the active deployment.',
        [p('deployment_id', 'option<string>')]),
    tool('obelisk.deployment_read_blob', 'obelisk-agent:tools/webapi.deployment-read-blob',
        'Read one deployment-owned source file (script/exec) from the content-addressed store by its content_digest.',
        [p('digest', 'string')]),
    tool('obelisk.deployment_submit', 'obelisk-agent:tools/webapi.deployment-submit',
        'Validate and store a complete deployment TOML as a new inactive deployment. edited_files_json is a JSON array of { path, content } for changed owned sources; the server fills content_digest. Pass the full manifest, not a diff.',
        [p('deployment_toml', 'string'), p('edited_files_json', 'string', '[]'), p('description', 'string'),
         p('allow_missing_runtime_config', 'bool', false), p('deployment_id', 'string', '')]),
    tool('obelisk.deployment_switch', 'obelisk-agent:tools/webapi.deployment-switch',
        'Enqueue a submitted deployment to become active on the next server restart (cold switch).',
        [p('deployment_id', 'string'), p('allow_missing_runtime_config', 'bool', false)]),
    tool('obelisk.deployment_confirm_apply', 'obelisk-agent:tools/deploy.confirm-apply',
        'Ask the operator to approve a hot redeploy of a submitted deployment. Blocks until the operator approves or rejects. Call this immediately before obelisk.deployment_apply.',
        [p('deployment_id', 'string'), p('summary', 'string')]),
    tool('obelisk.deployment_apply', 'obelisk-agent:tools/webapi.apply-deployment',
        'Hot-redeploy a submitted deployment now (re-verifies, then swaps executors). Only after obelisk.deployment_confirm_apply was approved. This is terminal for the current action.',
        [p('deployment_id', 'string')]),

    // --- human in the loop ---
    tool('input.ask_user', 'obelisk-agent:tools/input.ask-user',
        'Pause the workflow and ask the operator for missing information or approval that cannot be inferred safely.',
        [p('question', 'string')]),
];

const WIT_JSON_MAPPING = [
    '## WIT to JSON Mapping',
    'Use obelisk.get_function_wit to inspect a target function signature before obelisk.call when the parameters are not already known.',
    'Encode params_json as a JSON array of positional arguments in WIT parameter order.',
    'WIT kebab-case identifiers become snake_case JSON keys and variant or enum values.',
    'bool maps to JSON true or false.',
    'Integers and floats map to JSON numbers; Obelisk rejects lossy numeric conversions instead of rounding.',
    'char and string map to JSON strings.',
    'option<T> maps to the JSON value for T or null for none.',
    'list<T> maps to a JSON array.',
    'tuple<T1, T2> maps to a JSON array in tuple order.',
    'record { field-name: T } maps to a JSON object such as {"field_name": value}.',
    'variant { case-name(T) } maps to a JSON string for no-payload cases or an object such as {"case_name": value} for payload cases.',
    'enum { case-name } maps to the JSON string "case_name".',
    'flags { flag-name } maps to an array of active flag strings such as ["flag_name"].',
    'result<T, E> maps to {"ok": value} or {"err": value}; result with no payload uses null.',
].join(nl);

const DEPLOYMENT_RULES = [
    '## Deployment Editing Rules',
    'Read the deployment first with obelisk.deployment_checkout; it returns the full deployment_toml. Fetch owned source files with obelisk.deployment_read_blob using each component content_digest.',
    'Edit the deployment_toml text yourself and collect any changed owned sources as { path, content } entries.',
    'Submit the complete edited manifest with obelisk.deployment_submit (edited_files_json carries the changed sources); it stores a new inactive deployment and validates the whole thing.',
    'Activate only when the operator requested it: obelisk.deployment_switch for the next restart, or obelisk.deployment_confirm_apply followed by obelisk.deployment_apply for an approved hot redeploy.',
    'All component configuration lives in the TOML; owned source code lives in the edited_files_json entries.',
].join(nl);

const SYSTEM_PROMPT = [
    'You are the planner inside an Obelisk durable workflow.',
    'The workflow exposes Obelisk-side tools that you call; it runs each and returns the result.',
    'Your job is to investigate, plan, and decide which durable actions are needed.',
    'Call the provided tools for durable, replayable actions that should appear in the Obelisk execution log; use your own built-in reasoning freely for non-durable investigation within a turn.',
    'When you have a response for the operator, reply as Markdown without a tool call (use fenced Mermaid blocks only for diagrams). The workflow will wait for the operator to decide whether to continue.',
    'To pause for operator input, call input.ask_user.',
    'Never invent execution IDs, FFQNs, deployment IDs, tools, or tool arguments. Discover them first.',
    'If a tool returns an error, decide whether to retry, use another tool, ask the operator, or respond with an explanation.',
    WIT_JSON_MAPPING,
    DEPLOYMENT_RULES,
].join(nl + nl);

export default async function describe() {
    const response = await fetch(OBELISK_DOCS_URL, { headers: { accept: 'text/plain' } });
    if (!response.ok) {
        throw `failed to fetch Obelisk documentation: HTTP ${response.status}: ${await response.text()}`;
    }
    const docs = await response.text();
    const prompt = [SYSTEM_PROMPT, '', '# Obelisk documentation', 'The following reference was fetched from ' + OBELISK_DOCS_URL + '.', '', docs].join(nl);
    return { prompt, tools_json: JSON.stringify(TOOLS) };
}
