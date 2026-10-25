export function serverInfo(overrides = {}) {
    return {
        app_name: "demo", app_env_prefix: "TEST_", obelisk_version: "0.43.0",
        deployment_id: "Dep_1", node_run_id: "Run_1", app_config_digest: "digest",
        started_at: "2026-10-25T00:00:00Z", ...overrides,
    };
}
