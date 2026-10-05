import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function tests(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? tests(path) : entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests('src').sort()], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
