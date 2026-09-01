// obelisk-agent:workflow-js/workflow.run-cancellable
//   func(prompt: string, model: option<string>, descriptor-ffqn: option<string>,
//        effort: option<string>, name: option<string>) -> result<_, string>
//
// Phase 0 scaffold: proves the JS workflow FFQN deploys and verifies alongside
// the Rust workflow_wasm under a distinct package name
// (obelisk-agent:workflow-js vs obelisk-agent:workflow). Real session/agent-loop
// logic lands in later phases; see ../../../docs/js-backend-migration.md.
export default function runCancellable(prompt, _model, _descriptorFfqn, _effort, _name) {
    console.log(`workflow-js scaffold received prompt: ${prompt}`);
}
