import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('mcp e2e (rs)', async () => {
    await runE2eScript('test-e2e-mcp.sh', ['rs']);
});

test('mcp e2e (js)', async () => {
    await runE2eScript('test-e2e-mcp.sh', ['js']);
});
