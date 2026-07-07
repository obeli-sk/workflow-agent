// Builds the agent's system prompt and the OpenAI tool schemas from one source
// of truth (TOOL_SCHEMAS). The workflow sends `tools` to the LLM endpoint via
// native tool-calling, so the prompt no longer carries a tool-call envelope or
// per-tool schemas; it keeps only role, WIT<->JSON mapping, and deployment rules.
//
// obelisk-agent:agent/prompt.load-system-prompt:
//   func() -> result<record { prompt: string, tools-json: string }, string>

const OBELISK_DOCS_URL = 'https://obeli.sk/docs/latest/llms.txt/';
const nl = String.fromCharCode(10);

function tool(name, purpose, args, notes = []) {
    return { name, purpose, args, notes };
}

const TOOL_SCHEMAS = [
    tool('obelisk.list_functions', 'Discover callable Obelisk FFQNs, each with its full WIT (the interface, the function signature, and every type it references).', {
        ffqn_prefix: 'string, optional',
        length: 'u32, optional; default 100',
    }),
    tool('obelisk.get_function_wit', 'Return the WIT signature for one FFQN. Use it before native calls or submissions when parameter types are not already known.', {
        ffqn: 'string, required',
    }),
    tool('obelisk.list_executions', 'Page through executions, optionally filtered by function, execution id prefix, component digest, deployment, and state.', {
        ffqn_prefix: 'string, optional',
        execution_id_prefix: 'string, optional',
        show_derived: 'bool, optional',
        hide_finished: 'bool, optional',
        component_digest: 'string, optional',
        deployment_id: 'string, optional',
        cursor: 'string, optional',
        direction: 'enum string, optional; older or newer',
        including_cursor: 'bool, optional',
        length: 'u32, optional; default 20',
    }),
    tool('obelisk.get_execution', 'Read one execution record, including status, FFQN, timestamps, deployment id, and component metadata.', {
        execution_id: 'string, required',
    }),
    tool('obelisk.get_logs', 'Read paginated logs and stream events for an execution.', {
        execution_id: 'string, required',
        show_derived: 'bool, optional; default true',
        show_logs: 'bool, optional; default true',
        show_streams: 'bool, optional; default true',
        levels: 'list<string>, optional',
        stream_types: 'list<string>, optional',
        cursor: 'string, optional',
        direction: 'enum string, optional; older or newer',
        including_cursor: 'bool, optional',
        length: 'u32, optional; default 200',
    }),
    tool('obelisk.call', 'Submit a workflow or activity child execution natively and wait for its result.', {
        ffqn: 'string, required',
        params_json: 'string, required; JSON array of positional parameters encoded from the target function WIT, for example "[123,\"name\"]"',
    }, [
        'Call obelisk.get_function_wit first unless the target WIT is already known.',
        'params_json is a string containing the JSON array, not an array value in args.',
        'Errors include the runtime error and, when available, the expected WIT for the target FFQN.',
    ]),
    tool('obelisk.submit', 'Compatibility alias for native join-set submission. Creates a join set, submits one child execution, and returns join_set_id plus execution_id without waiting.', {
        ffqn: 'string, required',
        params_json: 'string, required; JSON array of positional parameters encoded from the target function WIT, for example "[123,\"name\"]"',
    }, [
        'Use obelisk.call for the common submit-and-await case.',
        'Use obelisk.join_set_join_next or obelisk.join_set_close with the returned join_set_id.',
    ]),
    tool('obelisk.join_set_create', 'Create a native workflow join set for running many child executions or delays in parallel.', {}, [
        'Returns a workflow-local join_set_id handle. This is not an Obelisk execution id.',
    ]),
    tool('obelisk.join_set_submit', 'Submit one child workflow or activity execution into an existing native join set.', {
        join_set_id: 'string, required; handle returned by obelisk.join_set_create or obelisk.submit',
        ffqn: 'string, required',
        params_json: 'string, required; JSON array of positional parameters encoded from the target function WIT',
    }),
    tool('obelisk.join_set_delay', 'Submit a durable delay into an existing native join set.', {
        join_set_id: 'string, required; handle returned by obelisk.join_set_create or obelisk.submit',
        duration: 'record, required; Obelisk duration such as {"seconds": 5}',
    }),
    tool('obelisk.join_set_join_next', 'Wait until the next submitted execution or delay in a join set completes.', {
        join_set_id: 'string, required',
    }, [
        'Returns the joined child id/type when available; for executions, use obelisk.get_result with that execution_id if you need to read the final result separately.',
    ]),
    tool('obelisk.join_set_join_next_try', 'Poll a join set once without waiting.', {
        join_set_id: 'string, required',
    }, [
        'Returns ready=false when no child has completed yet.',
    ]),
    tool('obelisk.join_set_close', 'Close a native join set and release its workflow-local handle.', {
        join_set_id: 'string, required',
    }),
    tool('obelisk.get_result', 'Read the final result for a finished execution.', {
        execution_id: 'string, required',
    }),
    tool('obelisk.list_deployments', 'List deployments and their status counters.', {
        cursor_from: 'string, optional',
        including_cursor: 'bool, optional',
        length: 'u32, optional; default 20',
    }),
    tool('obelisk.current_deployment_id', 'Return the active deployment id.', {}),
    tool('obelisk.get_deployment', 'Read deployment metadata and a paginated window of deployment TOML.', {
        deployment_id: 'string, required',
        component_type: 'string, optional',
        offset: 'u32, optional',
        length: 'u32, optional',
        max_bytes: 'u32, optional',
    }),
    tool('obelisk.get_component_source', 'Read a paginated window of a component source file from a stored deployment.', {
        deployment_id: 'string, required',
        component: 'string, required; component identifier from the deployment',
        offset: 'u32, required',
        length: 'u32, required',
    }),
    tool('obelisk.deployment_checkout', 'Create an in-memory deployment working copy for editing. Call this before reading or changing components.', {
        deployment_id: 'string, optional; defaults to active deployment',
        from_scratch: 'bool, optional',
    }),
    tool('obelisk.deployment_list_components', 'List components in the checked-out working copy and any pending dirty component.', {}),
    tool('obelisk.deployment_read_component', 'Read one component from the checked-out working copy. Owned JS and exec components also return script.', {
        section: 'string, required; for example activity_js or workflow_js',
        id: 'string, required; component id shown by checkout/list_components',
    }),
    tool('obelisk.deployment_put_component', 'Add or replace exactly one component in the checked-out working copy.', {
        section: 'string, required',
        id: 'string, required',
        toml: 'string, required; exactly one complete component TOML block',
        script: 'string, optional; source body for deployment-owned JS or exec components',
    }, [
        'Read the component before replacing it.',
        'All component configuration belongs in the TOML block; source code belongs in script.',
        'After changing one component, call obelisk.deployment_submit before editing another component.',
    ]),
    tool('obelisk.deployment_remove_component', 'Remove exactly one component from the checked-out working copy.', {
        section: 'string, required',
        id: 'string, required',
    }),
    tool('obelisk.deployment_submit', 'Validate and store the checked-out working copy as a new inactive deployment.', {
        description: 'string, required',
        allow_missing_runtime_config: 'bool, optional; default false',
        deployment_id: 'string, optional',
    }),
    tool('obelisk.deployment_activate', 'Activate a submitted deployment on next restart or by hot redeploy after operator approval.', {
        deployment_id: 'string, optional; defaults to latest submitted/checked-out deployment when available',
        mode: 'enum string, required; enqueue or apply',
        allow_missing_runtime_config: 'bool, optional; only meaningful for enqueue',
        summary: 'string, optional; approval summary for apply',
    }, [
        'mode enqueue switches on next server restart.',
        'mode apply blocks for operator approval and is terminal for the current workflow turn after it returns.',
    ]),
    tool('input.ask_user', 'Pause the workflow and ask the operator for missing information or approval that cannot be inferred safely.', {
        question: 'string, required',
    }),
];

// Map a schema arg description ("u32, optional; default 100") to a JSON Schema type.
function jsonType(desc) {
    const d = String(desc).toLowerCase();
    if (d.startsWith('u32') || d.startsWith('u64') || d.startsWith('s32') || d.startsWith('s64') || d.startsWith('integer')) return 'integer';
    if (d.startsWith('bool')) return 'boolean';
    if (d.startsWith('record')) return 'object';
    if (d.startsWith('list')) return 'array';
    return 'string';
}

// Convert TOOL_SCHEMAS into OpenAI function tools.
function buildTools() {
    return TOOL_SCHEMAS.map((t) => {
        const properties = {};
        const required = [];
        for (const field of Object.keys(t.args)) {
            const desc = t.args[field];
            properties[field] = { type: jsonType(desc), description: desc };
            if (/required/i.test(desc)) required.push(field);
        }
        const description = t.notes.length > 0 ? `${t.purpose} Notes: ${t.notes.join(' ')}` : t.purpose;
        return { type: 'function', function: { name: t.name, description, parameters: { type: 'object', properties, required } } };
    });
}

const WIT_JSON_MAPPING = [
    '## WIT to JSON Mapping',
    'Use obelisk.get_function_wit to inspect the target function signature before obelisk.call, obelisk.submit, or obelisk.join_set_submit when the parameters are not already known.',
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
    'Checkout first with obelisk.deployment_checkout.',
    'Read a component with obelisk.deployment_read_component before editing it.',
    'Change exactly one component with obelisk.deployment_put_component or obelisk.deployment_remove_component.',
    'Submit after each component change with obelisk.deployment_submit.',
    'Repeat the checkout/read/edit/submit cycle for larger changes.',
    'All component config lives in the TOML block; owned source code lives in the script field.',
    'Use obelisk.deployment_activate only when the operator requested activation or activation is necessary to complete the task.',
].join(nl);

const SYSTEM_PROMPT = [
    'You are the planner inside an Obelisk durable workflow.',
    'The workflow exposes Obelisk-side tools that you call; it runs each and returns the result.',
    'Your job is to investigate, plan, and decide which durable actions are needed.',
    'Call the provided tools for durable, replayable actions that should appear in the Obelisk execution log; use your own built-in tools freely for non-durable investigation within a turn.',
    'When you are done, reply with your final answer as Markdown (use fenced Mermaid blocks only for diagrams). Do not call a tool on your final turn.',
    'To pause for operator input, call input.ask_user.',
    'Never invent execution IDs, FFQNs, deployment IDs, tools, or tool arguments. Discover them first.',
    'If a tool returns an error, decide whether to retry, use another tool, ask the operator, or finish with an explanation.',
    WIT_JSON_MAPPING,
    DEPLOYMENT_RULES,
].join(nl + nl);

export default async function load_system_prompt() {
    const response = await fetch(OBELISK_DOCS_URL, { headers: { accept: 'text/plain' } });
    if (!response.ok) {
        throw `failed to fetch Obelisk documentation: HTTP ${response.status}: ${await response.text()}`;
    }
    const docs = await response.text();
    const prompt = [SYSTEM_PROMPT, '', '# Obelisk documentation', 'The following reference was fetched from ' + OBELISK_DOCS_URL + '.', '', docs].join(nl);
    return { prompt, tools_json: JSON.stringify(buildTools()) };
}
