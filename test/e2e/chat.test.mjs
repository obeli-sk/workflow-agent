import { test } from 'node:test';
import { runE2eScript } from './helpers.mjs';

test('chat e2e', async () => {
    await runE2eScript('test-e2e-chat.sh');
});
