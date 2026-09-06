import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('bash-workflow e2e', async () => {
    await runE2eScript('test-e2e-bash-workflow.sh');
});
