'use strict';
// Web Crypto provides the same random primitives the shared game engine uses in Node.
globalThis.WerewolfRandom = {
    randomUUID: () => crypto.randomUUID(),
    randomBytes: size => {
        const bytes = crypto.getRandomValues(new Uint8Array(size));
        return { toString: () => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') };
    },
    randomInt: max => {
        if (!Number.isSafeInteger(max) || max < 1 || max > 0xffffffff) throw new Error('Invalid random bound');
        const limit = Math.floor(0x100000000 / max) * max;
        let value;
        do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= limit);
        return value % max;
    }
};
