import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('cloud creation recovers a lost response', async () => {
    await runE2eScript('test-e2e-cloud-create.sh');
});
