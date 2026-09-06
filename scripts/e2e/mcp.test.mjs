import { describe, test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

// concurrency: true runs the rs/js siblings in parallel; safe since every
// port each backend uses is offset (see e2e_backend_port_offset in
// scripts/e2e-lib.sh), so the two servers never collide.
describe('mcp e2e', { concurrency: true }, () => {
    test('rs', async () => {
        await runE2eScript('test-e2e-mcp.sh', ['rs']);
    });

    test('js', async () => {
        await runE2eScript('test-e2e-mcp.sh', ['js']);
    });
});
