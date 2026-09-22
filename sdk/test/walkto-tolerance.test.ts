/**
 * walkTo must honor a caller tolerance below 2 on the final waypoint, and
 * judge tolerance in tiles (Chebyshev), not Euclidean distance.
 * Bug-report harvest 2026-09-21 (openGE/openBank/staircase "Stuck at" family).
 */
import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

function makeBot(start: { x: number; z: number }) {
    const sdk = new BotSDK({ botUsername: 'test' });
    let pos = { ...start };
    const state = () => ({
        player: { worldX: pos.x, worldZ: pos.z, x: pos.x, z: pos.z, level: 0, lifeId: 1, isDead: false },
        tick: 1, gameMessages: [], nearbyLocs: [], nearbyNpcs: [], inventory: [],
        dialog: { isOpen: false, options: [], isWaiting: false }, interface: { isOpen: false },
    });
    (sdk as any).getState = state;
    const bot = new BotActions(sdk);
    (bot as any).dismissBlockingUI = async () => {};
    const steps: number[] = [];
    (bot as any).helpers.walkStepToward = async (tx: number, tz: number, tolerance: number) => {
        steps.push(tolerance);
        // The stepper stops as soon as it is within its tolerance, like the real one.
        const dx = Math.sign(tx - pos.x), dz = Math.sign(tz - pos.z);
        while (Math.max(Math.abs(tx - pos.x), Math.abs(tz - pos.z)) > tolerance) pos = { x: pos.x + dx, z: pos.z + dz };
        return { status: 'arrived' as const, pos: { ...pos } };
    };
    return { sdk, bot, steps, pos: () => pos };
}

describe('walkTo tolerance', () => {
    test('tolerance 0 reaches the exact tile', async () => {
        const { sdk, bot, steps, pos } = makeBot({ x: 3200, z: 3200 });
        (sdk as any).sendFindPath = async () => ({ success: true, reachedDestination: true, waypoints: [{ x: 3205, z: 3200 }, { x: 3210, z: 3200 }] });
        const r = await bot.walkTo(3210, 3200, 0);
        expect(r.success).toBe(true);
        expect(pos()).toEqual({ x: 3210, z: 3200 });
        // Intermediate waypoint keeps the loose 2-tile pass; the final one uses the caller's 0.
        expect(steps).toEqual([2, 0]);
    });

    test('tolerance 1 accepts a diagonally adjacent tile', async () => {
        const { sdk, bot } = makeBot({ x: 3201, z: 3201 });
        (sdk as any).sendFindPath = async () => { throw new Error('should not path: already within 1 tile (diagonal)'); };
        const r = await bot.walkTo(3200, 3200, 1);
        expect(r.success).toBe(true);
        expect(r.message).toBe('Already at destination');
    });
});
