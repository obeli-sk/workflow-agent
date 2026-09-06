import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('agent-workflow e2e (rs)', async () => {
    await runE2eScript('test-e2e-agent-workflow.sh', ['rs']);
});

test('agent-workflow e2e (js)', async () => {
    await runE2eScript('test-e2e-agent-workflow.sh', ['js']);
});
