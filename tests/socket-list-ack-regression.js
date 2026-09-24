const fs = require('fs');
const assert = require('assert');
const path = require('path');
const reporter = fs.readFileSync(path.join(__dirname, '..', 'public/js/error-reporter.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert(server.includes('socket.on("list_open_rooms", (cb) => {'), 'server list_open_rooms handler must exist');
assert(server.includes('cb(getOpenRoomsList());'), 'legacy list_open_rooms callback contract must remain array payload');
assert(reporter.includes('Array.isArray(res) && /^(list_open_rooms|list_open_rooms_players)$/.test(eventName)'), 'diagnostic reporter must treat legacy list arrays as successful ACK payloads');
assert(reporter.includes('var ok=!!(res&&res.ok===true) || arrayPayloadSuccess'), 'diagnostic success classification must include list array payloads');

console.log('socket-list-ack regression: PASS');
