import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';

// rs-sdk: the outfit as it renders on the player, for the equipment board's /sprite/player
// images: 12 appearance-protocol slots (0 = empty, 0x100+idk = identity kit, 0x200+obj = worn
// item), mirroring Player.generateAppearance. Resolved here because the wearpos2/3 masking
// needs obj config the web layer doesn't load.
export function outfitAppearance(player: Player): string {
    const worn = player.getInventory(InvType.WORN);
    const hidden = new Set<number>();
    if (worn) {
        for (let slot = 0; slot < worn.capacity; slot++) {
            const item = worn.get(slot);
            if (item) {
                const config = ObjType.get(item.id);
                if (config.wearpos2 !== -1) hidden.add(config.wearpos2);
                if (config.wearpos3 !== -1) hidden.add(config.wearpos3);
            }
        }
    }

    const slots: number[] = [];
    for (let slot = 0; slot < 12; slot++) {
        const item = worn?.get(slot);
        if (hidden.has(slot)) {
            slots.push(0);
        } else if (item) {
            slots.push(0x200 + item.id);
        } else {
            slots.push(player.getAppearanceInSlot(slot));
        }
    }
    return JSON.stringify({ gender: player.gender, colors: player.colors, slots });
}
