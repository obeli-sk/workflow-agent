import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

// Runs an existing scripts/test-e2e-*.sh suite as a single node:test case.
// Output is buffered instead of streamed live, since suites (and, within a
// suite, the rs/js backend pair) run concurrently and interleaved live
// output would be unreadable. On failure the full output is folded into the
// Error's own message so it shows up in node:test's "failing tests" summary,
// not just a bare exit-code line.
export function runE2eScript(script, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(path.join(ROOT, 'scripts', script), args, {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${script} ${args.join(' ')} exited with code ${code}\n\n${output}`));
        });
    });
}
