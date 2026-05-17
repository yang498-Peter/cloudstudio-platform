const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const command = isWindows
  ? ['powershell', '-ExecutionPolicy', 'Bypass', '-File', '.\\setup-local.ps1']
  : ['bash', './setup-local.sh'];

const result = spawnSync(command[0], command.slice(1), {
  stdio: 'inherit',
  shell: false,
});

process.exit(result.status ?? 1);
