const fs = require("fs");
const assert = require("assert");

const server = fs.readFileSync("server.js", "utf8");
const reporter = fs.readFileSync("public/js/error-reporter.js", "utf8");

const createStart = server.indexOf('socket.on("create_room"');
const createEnd = server.indexOf('    // ----------------------------------------------------------------\n    // LIST OPEN ROOMS', createStart);
assert(createStart >= 0 && createEnd > createStart, "create_room handler must exist");
const create = server.slice(createStart, createEnd);

assert(create.includes('cb({ ok: true, roomId: id, token: hostToken'),
  "successful create_room ACK must explicitly declare ok:true");
assert(/cb\(\{\s*ok:\s*true,[\s\S]*roomId:\s*id/.test(create),
  "create_room success ACK must contain the created room id");

assert(reporter.includes('var createRoomPayloadSuccess = eventName === "create_room"'),
  "diagnostics must recognize a successful legacy create_room payload");
assert(reporter.includes('|| createRoomPayloadSuccess'),
  "diagnostics must not report successful create_room ACK as SOCKET_ACK_ERROR");

console.log("create-room-ack regression: PASS");
