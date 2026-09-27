// Shut a process down once the process that launched it is gone.
//
// On Windows, killing a shell does not kill the processes it started, so a
// backgrounded engine or gateway outlives whatever stopped it and keeps its
// ports. dev.ts preloads this file into both (`bun --preload`, so the vendored
// engine source stays untouched) with EXIT_WITH_PID set to its own pid, and
// watches its own ancestors with ancestorPids() + watchProcesses().

const POLL_MS = 1000;
// The engine's SIGINT handler saves and logs out players before exiting; give
// it time, then stop regardless.
const FORCE_EXIT_MS = 30_000;

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM: it exists, we just may not signal it.
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Call onGone (once) as soon as any of `pids` has exited. */
export function watchProcesses(pids: number[], onGone: (pid: number) => void): void {
    const timer = setInterval(() => {
        const gone = pids.find(pid => !isAlive(pid));
        if (gone !== undefined) {
            clearInterval(timer);
            onGone(gone);
        }
    }, POLL_MS);
    timer.unref();
}

/**
 * The ancestors of `pid`, nearest first, at most `max` of them.
 *
 * Watching only the direct parent is not enough on Windows: with bun
 * installed through npm, Git Bash's `bun` is a sh.exe wrapper script, and
 * killing the shell leaves that wrapper (and whatever it started) running.
 */
export function ancestorPids(pid: number, max: number): number[] {
    const parents = process.platform === 'win32' ? windowsParents() : posixParents();
    const chain: number[] = [];
    let child = parents.get(pid);
    while (child && child.ppid > 1 && chain.length < max) {
        const parent = parents.get(child.ppid);
        // Stop at a parent that is already gone. Windows keeps a dead
        // parent's pid as ParentProcessId, and that pid can be reused by a
        // newer, unrelated process: a real parent always started first.
        if (!parent || parent.started > child.started) break;
        chain.push(child.ppid);
        child = parent;
    }
    return chain;
}

type ParentInfo = { ppid: number; started: number };

function windowsParents(): Map<number, ParentInfo> {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }';
    const out = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]).stdout.toString();
    const parents = new Map<number, ParentInfo>();
    for (const line of out.split(/\r?\n/)) {
        const [pid, ppid, started] = line.trim().split(' ').map(Number);
        if (pid && ppid !== undefined) parents.set(pid, { ppid, started: started || 0 });
    }
    return parents;
}

function posixParents(): Map<number, ParentInfo> {
    // Orphans are reparented to init on POSIX, so a live process's ppid is
    // always its real, live parent; no start-time check needed.
    const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=']).stdout.toString();
    const parents = new Map<number, ParentInfo>();
    for (const line of out.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid && ppid !== undefined) parents.set(pid, { ppid, started: 0 });
    }
    return parents;
}

/** Run the process's own SIGINT shutdown if it has one, else exit. */
function shutdownSelf(reason: string): void {
    console.log(`[exit-with-parent] ${reason}; shutting down`);
    setTimeout(() => process.exit(0), FORCE_EXIT_MS).unref();
    if (process.listenerCount('SIGINT') > 0) {
        process.emit('SIGINT');
    } else {
        process.exit(0);
    }
}

const watchedPid = Number(process.env.EXIT_WITH_PID);
if (watchedPid > 0) {
    watchProcesses([watchedPid], () => shutdownSelf(`launcher (pid ${watchedPid}) exited`));
}
