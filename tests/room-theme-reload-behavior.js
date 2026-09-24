const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert(start >= 0, `missing ${name}`);
    const brace = source.indexOf("{", start);
    let depth = 0;
    for (let i = brace; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unterminated ${name}`);
}

function loadFunctions(file, names, sandboxExtras) {
    const source = fs.readFileSync(file, "utf8");
    const prefixes = source.includes("HOST_ROOM_THEME_KEY_PREFIX") ? 'const HOST_ROOM_THEME_KEY_PREFIX = "ww_host_room_theme_";' : 'const PLAYER_ROOM_THEME_KEY_PREFIX = "ww_player_room_theme_";';
    const code = prefixes + "\n" + names.map((n) => extractFunction(source, n)).join("\n");
    const sandbox = Object.assign({
        String,
        document: {
            body: {
                _classes: new Set(),
                classList: {
                    toggle(name, on) { if (on) sandbox.document.body._classes.add(name); else sandbox.document.body._classes.delete(name); },
                    add(...names) { names.forEach((n) => sandbox.document.body._classes.add(n)); },
                    remove(...names) { names.forEach((n) => sandbox.document.body._classes.delete(n)); },
                    contains(name) { return sandbox.document.body._classes.has(name); },
                },
            },
        },
    }, sandboxExtras || {});
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

// Host boot/reload contract.
{
    const store = new Map();
    const s = loadFunctions("public/js/host.main.js", [
        "hostRoomThemeKey", "readSavedHostRoomTheme", "writeSavedHostRoomTheme",
        "applySavedHostRoomTheme", "syncHostTimeTheme", "persistHostRoomTheme"
    ], { hostStorage: {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    }, roomId: "" });

    store.set("ww_host_room_theme_ABCDE", "day");
    s.applySavedHostRoomTheme("ABCDE");
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));

    store.set("ww_host_room_theme_ABCDE", "night");
    s.applySavedHostRoomTheme("ABCDE");
    assert(s.document.body._classes.has("is-night"));
    assert(!s.document.body._classes.has("is-day"));

    // Exact regression guard: initial/no-room, waiting, and game-over must never expose dark default.
    s.syncHostTimeTheme({ started: false, gameOver: false, isNight: false });
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));
    s.syncHostTimeTheme({ started: true, gameOver: false, isNight: false });
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));
    s.syncHostTimeTheme({ started: true, gameOver: false, isNight: true });
    assert(s.document.body._classes.has("is-night"));
    assert(!s.document.body._classes.has("is-day"));
    s.syncHostTimeTheme({ started: true, gameOver: true, isNight: true });
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));

    s.persistHostRoomTheme({ roomId: "ABCDE", started: false, gameOver: false, isNight: false });
    assert.strictEqual(store.get("ww_host_room_theme_ABCDE"), "day");
    s.persistHostRoomTheme({ roomId: "ABCDE", started: true, gameOver: false, isNight: true });
    assert.strictEqual(store.get("ww_host_room_theme_ABCDE"), "night");
    s.persistHostRoomTheme({ roomId: "ABCDE", started: true, gameOver: true, isNight: true });
    assert(!store.has("ww_host_room_theme_ABCDE"));
}

// Player boot/reload contract + stale-room cleanup hint.
{
    const store = new Map();
    const s = loadFunctions("public/js/player.main.js", [
        "playerRoomThemeKey", "readSavedPlayerRoomTheme", "writeSavedPlayerRoomTheme",
        "applySavedPlayerRoomTheme", "syncPlayerTimeTheme"
    ], { ww_store: {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    }});

    s.joined = false;
    // loadFunctions exposes globals only, so assign the state variables in the sandbox explicitly.
    s.currentRoomId = "ABCDE";
    s.lastRoomData = null;
    s.syncPlayerTimeTheme(null);
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));
    s.joined = true;
    s.lastRoomData = null;
    s.syncPlayerTimeTheme({ roomId: "ABCDE", started: false, gameOver: false, isNight: false });
    assert(s.document.body._classes.has("is-day"));
    s.syncPlayerTimeTheme({ roomId: "ABCDE", started: true, gameOver: false, isNight: true });
    assert(s.document.body._classes.has("is-night"));
    assert(!s.document.body._classes.has("is-day"));
    s.syncPlayerTimeTheme({ roomId: "ABCDE", started: true, gameOver: true, isNight: true });
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));

    store.set("ww_player_room_theme_ABCDE", "day");
    s.applySavedPlayerRoomTheme("ABCDE");
    assert(s.document.body._classes.has("is-day"));
    assert(!s.document.body._classes.has("is-night"));

    store.set("ww_player_room_theme_ABCDE", "night");
    s.applySavedPlayerRoomTheme("ABCDE");
    assert(s.document.body._classes.has("is-night"));
    assert(!s.document.body._classes.has("is-day"));

    s.writeSavedPlayerRoomTheme("ABCDE", "");
    assert(!store.has("ww_player_room_theme_ABCDE"));
}

console.log("room-theme-reload-behavior: PASS");
