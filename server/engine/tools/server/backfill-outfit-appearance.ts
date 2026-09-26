// One-off: fill hiscore_outfit.appearance for rows written before the column existed, from each
// player's save (the login server fills it on every save after that). Only touches rows that are
// still empty, and skips rows whose listed items no longer match the save's worn items so the
// sprite never disagrees with the icons beside it.
//
// Run from server/engine with the world's GE_DATABASE (PlayerLoading prefers the exchange
// checkpoint over the .sav, same as the login server):
//   GE_DATABASE=/opt/server/data/market.sqlite bun tools/server/backfill-outfit-appearance.ts [--dry-run]
import fs from 'fs';

import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { db } from '#/db/query.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import { outfitAppearance } from '#/server/login/OutfitAppearance.js';

const dryRun = process.argv.includes('--dry-run');

InvType.load('data/pack');
ObjType.load('data/pack');

const rows = await db
    .selectFrom('hiscore_outfit')
    .innerJoin('account', 'account.id', 'hiscore_outfit.account_id')
    .select(['hiscore_outfit.account_id', 'hiscore_outfit.profile', 'hiscore_outfit.items', 'account.username'])
    .where('hiscore_outfit.appearance', 'is', null)
    .execute();

let filled = 0;
let noSave = 0;
let stale = 0;
let failed = 0;
for (const row of rows) {
    const file = `data/players/${row.profile}/${row.username}.sav`;
    if (!fs.existsSync(file)) {
        noSave++;
        continue;
    }

    try {
        const player = PlayerLoading.load(row.username, new Packet(fs.readFileSync(file)), null);

        // same item selection as LoginServer.updateWealthHiscores (ammo slot excluded)
        const worn = player.getInventory(InvType.WORN);
        const wornIds: number[] = [];
        for (let slot = 0; worn && slot < worn.capacity; slot++) {
            const item = worn.get(slot);
            if (slot !== 13 && item) wornIds.push(item.id);
        }
        const listedIds = (JSON.parse(row.items) as { id: number }[]).map(i => i.id);
        if (wornIds.join() !== listedIds.join()) {
            stale++;
            continue;
        }

        if (!dryRun) {
            await db
                .updateTable('hiscore_outfit')
                .set({ appearance: outfitAppearance(player) })
                .where('account_id', '=', row.account_id)
                .where('profile', '=', row.profile)
                .where('appearance', 'is', null)
                .execute();
        }
        filled++;
    } catch (err) {
        failed++;
        console.error(row.username, err instanceof Error ? err.message : err);
    }
}

console.log(`${dryRun ? '[dry run] ' : ''}${rows.length} rows without appearance: ${filled} filled, ${stale} stale (items changed since), ${noSave} without a save, ${failed} failed`);
process.exit(0);
