// Run the local game engine and gateway together:  bun server/dev.ts
//
// Both children run bun.exe directly (not `bun run <script>`, whose extra
// process layer is what was left behind) with exit-with-parent.ts preloaded, so
// they shut down cleanly when this launcher goes away. This launcher in turn
// exits when the shell or terminal that started it does. Ctrl+C works too.

import { join } from 'path';

import { ancestorPids, watchProcesses } from './exit-with-parent';

const SERVER_DIR = import.meta.dir;
const WATCHDOG = join(SERVER_DIR, 'exit-with-parent.ts');

const services = [
    { name: 'engine', cwd: join(SERVER_DIR, 'engine'), entry: 'src/app.ts' },
    { name: 'gateway', cwd: join(SERVER_DIR, 'gateway'), entry: 'gateway.ts' }
];

const children = services.map(({ name, cwd, entry }) => {
    const child = Bun.spawn({
        cmd: [process.execPath, '--preload', WATCHDOG, entry],
        cwd,
        env: { ...process.env, EXIT_WITH_PID: String(process.pid) },
        stdout: 'inherit',
        stderr: 'inherit'
    });
    console.log(`[dev] started ${name} (pid ${child.pid})`);
    return { name, child };
});

// If either service dies, stop: the other one follows once we exit.
for (const { name, child } of children) {
    child.exited.then(code => {
        console.log(`[dev] ${name} exited with code ${code}; stopping`);
        process.exit(code ?? 1);
    });
}

// Ctrl+C reaches the children directly too; wait for their clean shutdown
// (the exited handlers above end this process), with a fallback.
process.on('SIGINT', () => {
    setTimeout(() => process.exit(0), 35_000).unref();
});
process.on('SIGTERM', () => process.exit(0));

// Watch a few levels up, not just the direct parent: a wrapper between us and
// the shell (npm's `bun` shim, a `bun run` script) can outlive the shell.
// Exit straight away when any of them goes: the children are watching for
// exactly that, and run their own clean shutdown.
const MAX_ANCESTORS = 4;
const ancestors = ancestorPids(process.pid, MAX_ANCESTORS);
if (ancestors.length === 0) ancestors.push(process.ppid);
watchProcesses(ancestors, pid => {
    console.log(`[dev] launching process (pid ${pid}) exited; stopping`);
    process.exit(0);
});
