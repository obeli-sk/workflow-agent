import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('cloud creation and staging recover lost responses', async () => {
    await runE2eScript('test-e2e-cloud-create.sh');
});
