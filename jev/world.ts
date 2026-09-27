// Observation + action candidates for the Jev harness.
//
// Division of labour (per TypeSafe's guidance): code owns everything exact -
// enumerating what is possible right now, distances, level comparisons,
// arithmetic, execution. Jev only makes the semantic call: "which of these
// concrete actions best serves the goal?". So this file turns raw world state
// into (a) a compact, bucketed, text-first description and (b) a menu of
// executable candidates whose labels are the Choice options Jev picks from.

import type { BotActions } from '../sdk/actions';
import type { BotSDK } from '../sdk/index';
import { isPlayerChat, type BotWorldState, type GroundItem, type InventoryItem, type NearbyLoc, type NearbyNpc } from '../sdk/types';

export interface Outcome { success: boolean; message: string }

export interface Candidate {
    /** Human-readable, unique. This is the Choice option key Jev sees. */
    label: string;
    /** Extra context for the option (distance, relative strength, what a place is for). */
    detail?: string;
    run: (bot: BotActions, sdk: BotSDK) => Promise<Outcome>;
}

// ---- Known places (from learnings/*.md) --------------------------------------

export interface Place { name: string; x: number; z: number; about: string }

export const PLACES: Place[] = [
    { name: 'Lumbridge castle courtyard', x: 3222, z: 3218, about: 'Spawn point. Safe place to recover.' },
    { name: 'Lumbridge trees', x: 3195, z: 3220, about: 'Many regular trees for woodcutting.' },
    { name: 'Lumbridge general store', x: 3212, z: 3247, about: 'Shop that buys and sells common items.' },
    { name: 'Lumbridge range', x: 3230, z: 3196, about: 'Cooking range usable without a quest, for cooking raw food.' },
    { name: 'Lumbridge furnace', x: 3226, z: 3255, about: 'Furnace for smelting ore into bars.' },
    { name: 'Lumbridge goblins', x: 3252, z: 3230, about: 'Goblins and rats, easy combat training.' },
    { name: 'Lumbridge cow field', x: 3253, z: 3290, about: 'Cows, safe combat training; cowhides and bones drop.' },
    { name: 'Lumbridge chicken coop', x: 3237, z: 3295, about: 'Chickens, the safest combat training; feathers drop.' },
    { name: 'Draynor bank', x: 3092, z: 3243, about: 'Ground-floor bank closest to Lumbridge, for storing items. Dark wizards nearby are dangerous for weak players.' },
    { name: 'Draynor fishing spot', x: 3087, z: 3230, about: 'Net fishing for shrimps at level 1. Dark wizards to the north are dangerous for weak players.' },
    { name: 'Varrock west bank', x: 3185, z: 3436, about: 'Bank in Varrock.' },
    { name: 'Varrock oak trees', x: 3190, z: 3458, about: 'Oak trees for woodcutting at level 15 or higher.' },
    { name: 'South-east Varrock mine', x: 3285, z: 3365, about: 'Copper, tin and iron rocks for mining.' },
    { name: 'Varrock anvils', x: 3188, z: 3424, about: 'Anvils for smithing bars into items.' },
];

// ---- Buckets (Jev reads words better than numbers) ---------------------------

const dist = (d: number) => d <= 1 ? 'adjacent' : d <= 5 ? 'close by' : d <= 12 ? 'nearby' : 'far away';

function health(hp: number, max: number): string {
    const f = max > 0 ? hp / max : 1;
    return f >= 0.95 ? 'full health' : f >= 0.7 ? 'slightly hurt' : f >= 0.45 ? 'hurt' : f >= 0.25 ? 'low health' : 'critically low health';
}

function strength(npcLevel: number, myLevel: number): string {
    if (npcLevel <= 0) return '';
    const r = npcLevel / Math.max(1, myLevel);
    return r <= 0.5 ? 'much weaker than you' : r <= 1 ? 'about as strong as you or weaker'
        : r <= 1.5 ? 'somewhat stronger than you' : 'much stronger than you, dangerous';
}

function fullness(used: number): string {
    return used >= 28 ? 'full' : used >= 24 ? 'nearly full' : used >= 10 ? 'partly full' : 'mostly empty';
}

const clean = (s: string) => s.replace(/@\w+@/g, '').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (s: string) => new RegExp(`^${esc(s)}$`, 'i');
const IGNORED_OPTS = /^(examine|use|drop|walk here|cancel)$/i;

function nearestPlace(x: number, z: number): { place: Place; d: number } {
    let best = { place: PLACES[0]!, d: Infinity };
    for (const p of PLACES) {
        const d = Math.max(Math.abs(p.x - x), Math.abs(p.z - z));
        if (d < best.d) best = { place: p, d };
    }
    return best;
}

function nearestBy<T extends { name: string; distance: number; reachable?: boolean }>(items: T[]): T[] {
    const byName = new Map<string, T>();
    for (const it of items) {
        if (it.reachable === false) continue;
        const cur = byName.get(it.name);
        if (!cur || it.distance < cur.distance) byName.set(it.name, it);
    }
    return [...byName.values()].sort((a, b) => a.distance - b.distance);
}

const invSummary = (inv: InventoryItem[]) => {
    const counts = new Map<string, number>();
    for (const it of inv) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
    return [...counts].map(([n, c]) => c > 1 ? `${n} x${c}` : n);
};

// ---- Observation --------------------------------------------------------------

export interface HistoryEntry { action: string; result: string }

/** Compact, text-first view of the world for Jev. Only what a decision needs. */
export function describe(s: BotWorldState, goal: string, history: HistoryEntry[]) {
    const p = s.player!;
    const here = nearestPlace(p.worldX, p.worldZ);
    const trained = s.skills.filter(k => k.baseLevel > 1).map(k => `${k.name} ${k.baseLevel}`);
    const open = s.bank.isOpen ? 'bank window' : s.shop.isOpen ? `shop window (${s.shop.title})`
        : s.dialog.isOpen ? 'dialog' : s.modalOpen ? 'some interface' : 'none';

    return {
        goal,
        player: {
            combat_level: p.combatLevel,
            health: health(p.hp, p.maxHp),
            in_combat: p.combat.inCombat,
            location: `${here.d <= 15 ? 'at' : here.d <= 40 ? 'near' : 'far from'} ${here.place.name}${p.level > 0 ? `, upstairs (floor ${p.level})` : ''}`,
        },
        skills: trained.length ? [...trained, 'every other skill is level 1'] : ['every skill is level 1'],
        inventory: {
            fullness: fullness(s.inventory.length),
            free_slots: 28 - s.inventory.length,
            items: invSummary(s.inventory),
        },
        equipped: s.equipment.map(e => e.name),
        open_interface: open,
        recent_actions: history.slice(-6),
        // Game messages only: other players' chat is untrusted text that could steer the model.
        recent_game_messages: s.gameMessages.filter(m => !isPlayerChat(m.type)).slice(-5).map(m => clean(m.text)).filter(Boolean),
    };
}

// ---- Execution helpers ---------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** After starting a repeating activity (mining, fishing, combat), wait until it stops. */
async function waitWhileBusy(sdk: BotSDK, maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    let idle = 0;
    let last = sdk.getState();
    while (Date.now() < end && idle < 3) {
        await sleep(600);
        const s = sdk.getState();
        const p = s?.player;
        if (!s || !p) break;
        if (s.inventory.length >= 28 || p.hp / Math.max(1, p.maxHp) < 0.4 || s.dialog.isOpen) break;
        const moved = last?.player && (last.player.worldX !== p.worldX || last.player.worldZ !== p.worldZ);
        idle = (p.animId === -1 && !p.combat.inCombat && !moved) ? idle + 1 : 0;
        last = s;
    }
}

const ok = (r: { success: boolean; message: string }): Outcome => ({ success: r.success, message: r.message });

async function interactNpcThenWait(bot: BotActions, sdk: BotSDK, npc: NearbyNpc, option: string): Promise<Outcome> {
    const r = await bot.interactNpc(npc, exact(option));
    if (r.success) await waitWhileBusy(sdk, 25_000);
    return ok(r);
}

async function interactLocThenWait(bot: BotActions, sdk: BotSDK, loc: NearbyLoc, option: string): Promise<Outcome> {
    const r = await bot.interactLoc(loc, exact(option));
    if (r.success) await waitWhileBusy(sdk, 25_000);
    return ok(r);
}

function withDelta(sdk: BotSDK, before: BotWorldState, base: Outcome): Outcome {
    // Attach observed effects so Jev's history reflects what actually happened.
    const after = sdk.getState();
    if (!after) return base;
    const xp = after.skills
        .map(k => ({ name: k.name, gained: k.experience - (before.skills.find(b => b.name === k.name)?.experience ?? k.experience) }))
        .filter(k => k.gained > 0).map(k => `${k.name} xp gained`);
    const invDelta = after.inventory.length - before.inventory.length;
    const bits = [...xp];
    if (invDelta > 0) bits.push('inventory gained items');
    if (invDelta < 0) bits.push('inventory lost items');
    return bits.length ? { ...base, message: `${base.message} (${bits.join(', ')})` } : base;
}

/**
 * Eat whenever HP drops below 40%, even in the middle of a long action (walks
 * past aggressive monsters are where bots get hurt). One eat packet at a time.
 */
function startHpGuard(sdk: BotSDK, onEat: (food: string) => void): () => void {
    let busy = false;
    const timer = setInterval(async () => {
        const s = sdk.getState();
        const p = s?.player;
        if (busy || !s || !p || p.hp / Math.max(1, p.maxHp) >= 0.4) return;
        const food = s.inventory.find(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text)));
        const eat = food?.optionsWithIndex.find(o => /^eat$/i.test(o.text));
        if (!food || !eat) return;
        busy = true;
        try {
            await sdk.sendUseItem(food.slot, eat.opIndex);
            await sdk.waitForTicks(2);
            onEat(food.name);
        } finally { busy = false; }
    }, 600);
    return () => clearInterval(timer);
}

export async function execute(c: Candidate, bot: BotActions, sdk: BotSDK): Promise<Outcome> {
    const before = sdk.getState()!;
    const ate: string[] = [];
    const stopGuard = startHpGuard(sdk, food => ate.push(food));
    try {
        const out = withDelta(sdk, before, await c.run(bot, sdk));
        return ate.length ? { ...out, message: `${out.message} (health got low, ate ${ate.join(', ')})` } : out;
    } catch (err) {
        return { success: false, message: `error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
        stopGuard();
    }
}

// ---- Candidate enumeration ------------------------------------------------------

function npcCandidates(s: BotWorldState): Candidate[] {
    const me = s.player!.combatLevel;
    const out: Candidate[] = [];
    for (const npc of nearestBy(s.nearbyNpcs).slice(0, 12)) {
        for (const opt of npc.optionsWithIndex) {
            if (IGNORED_OPTS.test(opt.text)) continue;
            const o = opt.text;
            const label = `${o} ${npc.name}`;
            const detailBits = [dist(npc.distance)];
            if (/^attack$/i.test(o)) detailBits.push(strength(npc.combatLevel, me), npc.inCombat ? 'already fighting someone' : '');
            const detail = detailBits.filter(Boolean).join(', ');

            let run: Candidate['run'];
            if (/^attack$/i.test(o)) {
                run = async (bot, sdk) => {
                    const r = await bot.attack(npc);
                    if (r.success) await waitWhileBusy(sdk, 40_000);
                    return ok(r);
                };
            } else if (/^talk-to$/i.test(o)) {
                run = async bot => ok(await bot.talkTo(npc));
            } else if (/^pickpocket$/i.test(o)) {
                run = async bot => ok(await bot.pickpocketNpc(npc));
            } else if (/^trade$/i.test(o)) {
                run = async bot => ok(await bot.openShop(npc));
            } else if (/^bank$/i.test(o)) {
                run = async bot => ok(await bot.openBank());
            } else {
                run = (bot, sdk) => interactNpcThenWait(bot, sdk, npc, o);
            }
            out.push({ label, detail, run });
        }
    }
    return out;
}

function locCandidates(s: BotWorldState): Candidate[] {
    const out: Candidate[] = [];
    for (const loc of nearestBy(s.nearbyLocs).slice(0, 15)) {
        for (const opt of loc.optionsWithIndex) {
            if (IGNORED_OPTS.test(opt.text)) continue;
            const o = opt.text;
            let run: Candidate['run'];
            if (/^chop down$/i.test(o)) run = async bot => ok(await bot.chopTree(loc));
            else if (/^(open|close)$/i.test(o) && /door|gate/i.test(loc.name)) run = async bot => ok(await bot.openDoor(loc));
            else if (/^(bank|use-quickly)$/i.test(o) && /bank/i.test(loc.name)) run = async bot => ok(await bot.openBank());
            else run = (bot, sdk) => interactLocThenWait(bot, sdk, loc, o);
            out.push({ label: `${o} ${loc.name}`, detail: dist(loc.distance), run });
        }
    }
    return out;
}

function groundCandidates(s: BotWorldState): Candidate[] {
    if (s.inventory.length >= 28) return [];
    return nearestBy<GroundItem>(s.groundItems).slice(0, 8).map(item => ({
        label: `Pick up ${item.name}`,
        detail: `lying on the ground ${dist(item.distance)}`,
        run: async bot => ok(await bot.pickupItem(item)),
    }));
}

function inventoryCandidates(s: BotWorldState): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const has = (re: RegExp) => s.inventory.some(i => re.test(i.name));

    for (const item of s.inventory) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        for (const opt of item.optionsWithIndex) {
            if (IGNORED_OPTS.test(opt.text)) continue;
            const o = opt.text;
            let run: Candidate['run'];
            if (/^eat$/i.test(o)) run = async bot => ok(await bot.eatFood(exact(item.name)));
            else if (/^(wield|wear)$/i.test(o)) run = async bot => ok(await bot.equipItem(exact(item.name)));
            else run = async (_bot, sdk) => {
                const cur = sdk.findInventoryItem(exact(item.name));
                if (!cur) return { success: false, message: `no ${item.name} in inventory` };
                const r = await sdk.sendUseItem(cur.slot, opt.opIndex);
                await sdk.waitForTicks(2);
                return ok(r);
            };
            out.push({ label: `${o} ${item.name}`, detail: 'from your inventory', run });
        }
        out.push({
            label: `Drop all ${item.name}`,
            detail: 'permanently discards them to free inventory space',
            run: async bot => ok(await bot.dropItem(exact(item.name), 'all')),
        });
    }

    if (has(/^tinderbox$/i) && has(/logs$/i)) {
        out.push({
            label: 'Light a fire with your logs', detail: 'trains Firemaking',
            run: async (bot, sdk) => {
                const r = await bot.burnLogs();
                if (r.success) return ok(r);
                // Usually "You can't light a fire here" (standing on a fire or blocked tile): step aside, retry once.
                const p = sdk.getState()!.player!;
                const jitter = () => Math.round(Math.random() * 6 - 3) || 2;
                await bot.walkTo(p.worldX + jitter(), p.worldZ + jitter(), 1);
                return ok(await bot.burnLogs());
            },
        });
    }
    if (has(/^knife$/i) && has(/logs$/i)) {
        out.push({ label: 'Fletch logs into arrow shafts', detail: 'trains Fletching', run: async bot => ok(await bot.fletchLogs('arrow shaft')) });
    }
    const raw = s.inventory.find(i => /^raw /i.test(i.name));
    const heat = s.nearbyLocs.find(l => /^(range|cooking range|fire)$/i.test(l.name) && l.reachable !== false);
    if (raw && heat) {
        out.push({
            label: `Cook ${raw.name} on the ${heat.name}`, detail: `trains Cooking, ${dist(heat.distance)}`,
            run: async (bot, sdk) => {
                const r = await bot.useItemOnLoc(exact(raw.name), heat);
                if (r.success) await waitWhileBusy(sdk, 40_000);
                return ok(r);
            },
        });
    }
    return out;
}

function interfaceCandidates(s: BotWorldState): Candidate[] | null {
    if (s.bank.isOpen) {
        const out: Candidate[] = [];
        for (const name of new Set(s.inventory.map(i => i.name))) {
            out.push({ label: `Deposit all ${name}`, detail: 'into the bank', run: async bot => ok(await bot.depositItem(exact(name), -1)) });
        }
        for (const item of s.bank.items.slice(0, 20)) {
            out.push({ label: `Withdraw ${item.name}`, detail: `bank holds ${item.count}`, run: async bot => ok(await bot.withdrawItem(item, 1)) });
        }
        out.push({ label: 'Close the bank', run: async bot => ok(await bot.closeBank()) });
        return out;
    }
    if (s.shop.isOpen) {
        const coins = s.inventory.filter(i => /^coins$/i.test(i.name)).reduce((a, i) => a + i.count, 0);
        const out: Candidate[] = [];
        for (const item of s.shop.shopItems.filter(i => i.count > 0 && i.buyPrice <= coins).slice(0, 20)) {
            out.push({ label: `Buy one ${item.name}`, detail: 'you can afford it', run: async bot => ok(await bot.buyFromShop(item, 1)) });
        }
        for (const item of s.shop.playerItems.slice(0, 15)) {
            out.push({ label: `Sell one ${item.name}`, detail: 'for coins', run: async bot => ok(await bot.sellToShop(item, 1)) });
        }
        out.push({ label: 'Close the shop', run: async bot => ok(await bot.closeShop()) });
        return out;
    }
    if (s.dialog.isOpen && s.dialog.options.length > 0) {
        const out: Candidate[] = s.dialog.options.map(o => ({
            label: `Say "${clean(o.text)}"`, detail: 'dialog reply',
            run: async (_bot, sdk) => { const r = await sdk.sendClickDialog(o.index); await sdk.waitForTicks(2); return ok(r); },
        }));
        out.push({ label: 'Leave the conversation', run: async bot => ok(await bot.closeInterface()) });
        return out;
    }
    return null;
}

function movementCandidates(s: BotWorldState): Candidate[] {
    const p = s.player!;
    const out: Candidate[] = PLACES
        .filter(pl => Math.max(Math.abs(pl.x - p.worldX), Math.abs(pl.z - p.worldZ)) > 12)
        .map(pl => ({
            label: `Walk to ${pl.name}`, detail: pl.about,
            run: async (bot: BotActions) => ok(await bot.walkTo(pl.x, pl.z, 4)),
        }));
    out.push({
        label: 'Explore the surrounding area',
        detail: 'walk a short distance in a random direction to find new things',
        run: async bot => {
            const a = Math.random() * Math.PI * 2;
            return ok(await bot.walkTo(Math.round(p.worldX + Math.cos(a) * 14), Math.round(p.worldZ + Math.sin(a) * 14), 3));
        },
    });
    out.push({ label: 'Wait a moment', detail: 'do nothing for a few seconds', run: async (_b, sdk) => { await sdk.waitForTicks(5); return { success: true, message: 'waited' }; } });
    return out;
}

/** Every concrete action available right now. Labels are unique. */
export function candidates(s: BotWorldState): Candidate[] {
    const list = interfaceCandidates(s)
        ?? [...npcCandidates(s), ...locCandidates(s), ...groundCandidates(s), ...inventoryCandidates(s), ...movementCandidates(s)];
    const unique = new Map<string, Candidate>();
    for (const c of list) if (!unique.has(c.label)) unique.set(c.label, c);
    return [...unique.values()].slice(0, 255); // Choice limit
}
