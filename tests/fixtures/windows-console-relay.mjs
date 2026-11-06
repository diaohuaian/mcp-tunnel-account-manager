import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [executable, reportDirectory] = process.argv.slice(2);
fs.writeFileSync(path.join(reportDirectory, 'relay.json'), JSON.stringify({
  pid: process.pid, parentPid: process.ppid,
  privateValue: process.env.CONSOLE_FIXTURE_PRIVATE,
  inheritedUserProfile: Object.hasOwn(process.env, 'USERPROFILE')
}));
// Deliberately do NOT use windowsHide/CreateNoWindow. Like the real tunnel's
// stdio backend launch, this must inherit the parent's hidden console.
const child = spawn(executable, ['child', reportDirectory], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end();
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', () => { process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
