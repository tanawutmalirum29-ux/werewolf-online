'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Amplify serves only the frontend. Room state stays on one Node game server.
const value = process.env.GAME_SERVER_URL?.trim();
if (!value) throw new Error('Set GAME_SERVER_URL to the HTTPS origin of your running game server before building Amplify.');
const url = new URL(value);
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('GAME_SERVER_URL must be an HTTPS origin, e.g. https://your-game.onrender.com (no path or credentials).');
}
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), output, { recursive: true });
fs.writeFileSync(path.join(output, 'js/config.js'), `window.WEREWOLF_CONFIG = ${JSON.stringify({ serverUrl: url.origin })};\n`);
fs.mkdirSync(path.join(output, 'socket.io'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/socket.io/client-dist/socket.io.min.js'), path.join(output, 'socket.io/socket.io.js'));
console.log('Amplify static frontend built in dist/. Game server runs separately.');
