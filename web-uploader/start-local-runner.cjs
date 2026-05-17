const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const command = isWindows
  ? ['powershell', '-ExecutionPolicy', 'Bypass', '-File', '.\\start-local.ps1']
  : ['bash', './start-local.command'];

const result = spawnSync(command[0], command.slice(1), {
  stdio: 'inherit',
  shell: false,
});

process.exit(result.status ?? 1);
