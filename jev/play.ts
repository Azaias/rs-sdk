// Jev plays the game.
//
//   bun jev/play.ts <bot> [--goal "train woodcutting"] [--minutes 2] [--steps N] [--dry-run]
//
// Each step: code observes the world and enumerates every concrete action it can
// execute right now; one Jev request (via OpenRouter) picks the action that best
// serves the goal (Choice) and, speculatively in the same request, judges whether
// the goal is already met (Noul). Code executes the pick, records what actually
// happened, and loops. Without --goal, Jev first picks an activity from a menu,
// and picks a new one whenever the current one is done.
//
// Traces (state, options, answers, outcomes, cost) go to bots/<bot>/jev_runs/*.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { runScript } from '../sdk/runner';
import type { BotActions } from '../sdk/actions';
import type { BotSDK } from '../sdk/index';
import type { BotWorldState } from '../sdk/types';
import { JevClient, choice, noul, topChoices } from './client';
import { candidates, describe, execute, type Candidate, type HistoryEntry } from './world';

// ---- Args + bot credentials ------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const botName = argv[0];
if (!botName || botName.startsWith('-')) {
    console.error('usage: bun jev/play.ts <bot> [--goal "..."] [--minutes 2] [--steps N] [--dry-run]');
    process.exit(1);
}
const envPath = join(process.cwd(), 'bots', botName, 'bot.env');
if (!existsSync(envPath)) throw new Error(`No bot.env for "${botName}" at ${envPath}`);
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (t && !t.startsWith('#') && eq > 0) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const minutes = Number(opt('minutes') ?? 1);
const maxSteps = Number(opt('steps') ?? Infinity);
const dryRun = flag('dry-run');
const userGoal = opt('goal');

const jev = new JevClient();
const runDir = join(process.cwd(), 'bots', botName, 'jev_runs');
mkdirSync(runDir, { recursive: true });
const tracePath = join(runDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const trace = (entry: object) => appendFileSync(tracePath, JSON.stringify({ t: Date.now(), ...entry }) + '\n');

// ---- Questions -------------------------------------------------------------------

const ACTION_INSTRUCTIONS = {
    question: 'Which one of these actions should the player take next to make the most progress toward `goal`?',
    consider: [
        '`recent_actions` shows what was just tried and what happened. Keep doing an action that is working; avoid repeating one that just failed.',
        'When `inventory.fullness` is full, gathering more is impossible until items are banked, dropped, or used up.',
        'When `player.health` is low or critically low, eating food or getting away from danger comes first.',
        'Walk somewhere else only when nothing useful for `goal` is available nearby.',
    ],
};

const GOAL_DONE = noul(
    'Has the player completely achieved `goal`, judging from `skills`, `inventory`, and `recent_actions`?',
    { true: 'The end condition of `goal` is clearly met right now.', false: '`goal` is still in progress, or it has no clear end condition that is met.' },
);

const GOALS: Record<string, string> = {
    'Train Woodcutting by chopping trees near Lumbridge': 'Needs an axe.',
    'Train Fishing by net fishing for shrimps at Draynor': 'Needs a small fishing net.',
    'Train Mining at the south-east Varrock mine': 'Needs a pickaxe.',
    'Train combat by fighting chickens and cows near Lumbridge': 'Better with a weapon equipped and food to eat.',
    'Train Firemaking by lighting fires with logs': 'Needs a tinderbox and logs.',
    'Train Cooking by cooking raw food on the Lumbridge range': 'Needs raw food.',
    'Bank items at Draynor bank to free up inventory space': 'Useful when the inventory is full of items worth keeping.',
    'Sell spare items at the Lumbridge general store for coins': 'Useful when carrying items worth selling.',
};

async function pickGoal(s: BotWorldState, previous: string[]): Promise<string> {
    const { inventory, skills, equipped, player } = describe(s, '', []);
    const res = await jev.ask(
        { player, skills, inventory, equipped, previous_goals: previous.slice(-3) },
        {
            goal: choice(
                'Which activity should this player do next? Prefer one the player has the tools for, and a change from `previous_goals`.',
                GOALS,
            ),
        },
    );
    const a = res.answers.goal;
    console.log(`[jev] goal -> ${a.choice}  (conf ${a.confidence.toFixed(2)}; ${topChoices(a).map(([k, p]) => `${k.split(' by ')[0]} ${p.toFixed(2)}`).join(' | ')})`);
    trace({ kind: 'goal', answers: res.answers, usage: res.usage });
    return a.choice;
}

// ---- Code-owned reflexes -----------------------------------------------------------

/** Survival rules are exact thresholds, so they live in code rather than in a model call. */
async function reflex(s: BotWorldState, bot: BotActions): Promise<string | null> {
    const p = s.player!;
    if (p.hp / Math.max(1, p.maxHp) >= 0.4) return null;
    const food = s.inventory.find(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text)));
    if (food) return `reflex: ate ${food.name} -> ${(await bot.eatFood(food)).message}`;
    if (p.combat.inCombat) return `reflex: fled toward Lumbridge -> ${(await bot.walkTo(3222, 3218, 4)).message}`;
    return null;
}

// ---- Main loop -------------------------------------------------------------------------

async function play(bot: BotActions, sdk: BotSDK) {
    let s = sdk.getState();
    if (!s?.player) throw new Error('No world state - is the bot client open?');
    if (sdk.findNearbyNpc(/runescape guide|tutorial/i)) {
        console.log('[jev] tutorial detected, skipping it:', (await bot.skipTutorial()).message);
    }

    const goals: string[] = [];
    let goal = userGoal ?? await pickGoal(sdk.getState()!, goals);
    goals.push(goal);
    console.log(`[jev] goal: ${goal}   model: ${jev.model}   trace: ${tracePath}`);

    const history: HistoryEntry[] = [];
    const failures = new Map<string, { streak: number; blockedUntil: number }>();
    const deadline = Date.now() + minutes * 60_000;
    let doneStreak = 0;

    for (let step = 1; step <= maxSteps && Date.now() < deadline; step++) {
        await bot.dismissBlockingUI();
        s = sdk.getState();
        if (!s?.player) { await sdk.waitForTicks(2); continue; }

        const reflexNote = dryRun ? null : await reflex(s, bot);
        if (reflexNote) {
            console.log(`[step ${step}] ${reflexNote}`);
            history.push({ action: 'automatic safety action', result: reflexNote });
            continue;
        }

        // A label that failed twice in a row sits out a few steps, so Jev can't loop on it.
        const menu = candidates(s).filter(c => (failures.get(c.label)?.blockedUntil ?? 0) < step);
        const state = describe(s, goal, history);
        const criteria = Object.fromEntries(menu.map(c => [c.label, c.detail || null]));

        const t0 = Date.now();
        const res = await jev.ask(state, { action: choice(ACTION_INSTRUCTIONS, criteria), goal_done: GOAL_DONE });
        const ms = Date.now() - t0;
        const a = res.answers.action;
        const picked = menu.find(c => c.label === a.choice) as Candidate;
        const alts = topChoices(a, 3).slice(1).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(' | ');
        const done = res.answers.goal_done.noul;

        console.log(`[step ${step}] ${a.choice}  (p ${a.probabilities[a.choice]!.toFixed(2)}, conf ${a.confidence.toFixed(2)}, done ${done.toFixed(2)}, ${menu.length} options, ${ms}ms)${alts ? `  alt: ${alts}` : ''}`);

        if (dryRun) {
            console.log('\n[dry-run] state sent to Jev:\n' + JSON.stringify(state, null, 2));
            console.log(`\n[dry-run] options:\n  ${menu.map(c => `${c.label}${c.detail ? ` -- ${c.detail}` : ''}`).join('\n  ')}`);
            trace({ kind: 'step', step, dryRun: true, state, options: criteria, answers: res.answers, usage: res.usage });
            break;
        }

        const outcome = await execute(picked, bot, sdk);
        console.log(`          -> ${outcome.success ? 'ok' : 'FAILED'}: ${outcome.message}`);
        history.push({ action: picked.label, result: `${outcome.success ? 'succeeded' : 'failed'}: ${outcome.message}` });
        trace({ kind: 'step', step, goal, state, options: criteria, answers: res.answers, usage: res.usage, latencyMs: ms, outcome });

        const f = failures.get(picked.label) ?? { streak: 0, blockedUntil: 0 };
        f.streak = outcome.success ? 0 : f.streak + 1;
        if (f.streak >= 2) { f.blockedUntil = step + 5; f.streak = 0; }
        failures.set(picked.label, f);

        doneStreak = done >= 0.85 ? doneStreak + 1 : 0;
        if (doneStreak >= 2) {
            if (userGoal) { console.log('[jev] goal judged complete, stopping.'); break; }
            goal = await pickGoal(sdk.getState()!, goals);
            goals.push(goal);
            history.length = 0;
            doneStreak = 0;
        }
    }

    console.log(`[jev] ${jev.calls} Jev calls, ${jev.inputTokens} input tokens, $${jev.costUsd.toFixed(5)}`);
}

await runScript(({ bot, sdk }) => play(bot, sdk), { timeout: minutes * 60_000 + 120_000 });
