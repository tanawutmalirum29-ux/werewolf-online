const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const player = fs.readFileSync(path.join(root, 'public/js/player.main.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public/js/host.main.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/js/index.main.js'), 'utf8');
const infraPath = path.join(root, '.ebextensions/01-high-availability.config');
const infraAvailable = fs.existsSync(infraPath);
const infra = infraAvailable ? fs.readFileSync(infraPath, 'utf8') : '';
const runtimeReplay = process.env.WW_BUG_REPLAY === '1';

function must(condition, label) {
    if (!condition) {
        console.error(`FAIL: ${label}`);
        process.exit(1);
    }
    console.log(`PASS: ${label}`);
}

must(server.includes('const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;'), 'instance identity is unique per process');
must(server.includes('const ROOM_LEASE_STAT_KEY = "ROOM_LEASE";'), 'room lease uses a dedicated durable key');
must(server.includes('const ROOM_LEASE_TTL_MS'), 'room lease has a bounded TTL');
must(server.includes('const ROOM_LEASE_RENEW_MS'), 'room lease is renewed while room is live');
must(server.includes('function acquireRoomLease(roomId'), 'room lease acquisition exists');
must(server.includes('function renewRoomLease(roomId)'), 'room lease renewal exists');
must(server.includes('function releaseRoomLease(roomId)'), 'room lease release exists');
must(server.includes('function releaseAllLocalRoomLeases(reason = "shutdown")'), 'shutdown releases all local leases');
must(server.includes('if (deploymentHandoffInProgress()) {\n        roomRecoveryDeferred = true;'), 'new instances defer room recovery during Immutable deployment');
must(server.includes('recoverPersistedRooms({ requireLease: true })'), 'deferred recovery requires room lease ownership');
must(server.includes('deploymentRoomRecoveryCompleted = true;'), 'deployment handoff is explicitly completed after fenced recovery');
must(server.includes('roomRecoveryDeferred = !!out.deferred;'), 'recovery keeps waiting when a previous owner still holds a lease');
must(server.includes('attribute_not_exists(#leaseEpoch) AND attribute_not_exists(#writer)'), 'legacy unfenced snapshot can only be claimed before fencing exists');
must(server.includes('#leaseEpoch < :leaseEpoch'), 'new lease epoch fences stale snapshot writers');
must(server.includes('#writer = :writer AND #leaseEpoch = :leaseEpoch'), 'same owner/epoch requires state-version monotonicity');
must(server.includes('if (room.isTesterRoom !== true && leaseEpoch <= 0)'), 'normal room snapshots require a live lease');
must(server.includes('attribute_not_exists(#leaseEpoch) AND attribute_not_exists(#writer)) OR (#writer = :writer AND #leaseEpoch = :leaseEpoch)'), 'room deletion is lease-fenced');
must(server.includes('if (deletedSnapshot) {\n            try { await updatePersistedRoomIndex'), 'ROOM_INDEX is changed only after snapshot deletion succeeds');
must(server.includes('ROOM_SNAPSHOT_STAT_KEY || sk === ROOM_LEASE_STAT_KEY'), 'admin reset clears stale room leases too');
must(server.includes('const recoveredGameOverDeadlineAt = Number(room.gameOverDeadlineAt)'), 'game-over deadline is captured before timer cleanup');
must(server.includes('const recoveredVoteDeadline = Number(room.voteDeadline)'), 'vote deadline is captured before timer cleanup');
must(server.includes('room.__recoveredVoteResolutionPending = true'), 'expired recovered vote is deferred safely');
must(server.includes('function resumeRecoveredRoomRuntimeTransitions(room, roomId, deps)'), 'recovered runtime transitions have a live socket context');
must(server.includes('resumeRecoveredRoomRuntimeTransitions(room, roomId, nightBotDeps());'), 'join/sync resumes pending recovered vote transitions');
must(server.includes('connectionStateRecovery: {'), 'Socket.IO connection-state recovery is enabled');
must(server.includes('maxDisconnectionDuration: 120_000'), 'Socket.IO recovery window is bounded');
must(player.includes('"ROOM_FAILOVER_WAIT"') && player.includes('"ROOM_LEASE_UNAVAILABLE"'), 'player recognizes transient room handoff failures');
must(player.includes('attempt < 20'), 'player auto-rejoin is bounded');
must(host.includes('"ROOM_FAILOVER_WAIT"') && host.includes('"ROOM_LEASE_UNAVAILABLE"'), 'host recognizes transient room handoff failures');
must(host.includes('attempt < 20'), 'host auto-relogin is bounded');
must(index.includes('ROOM_FAILOVER_WAIT') && index.includes('ROOM_LEASE_UNAVAILABLE'), 'index account-context lookup retries deployment handoff failures');
if (infraAvailable) {
    must(infra.includes("MinSize: '2'"), 'EB keeps at least two instances');
    must(infra.includes("DeploymentPolicy: Immutable"), 'EB remains Immutable');
    must(infra.includes('HealthCheckPath: /ready'), 'EB routes only strict-ready instances into service');
    must(infra.includes("DeregistrationDelay: '30'"), 'ALB has connection draining delay');
} else if (runtimeReplay) {
    console.log('SKIP: EB/ALB source manifest is not shipped in deployed runtime; runtime failover contracts remain enforced above');
} else {
    must(false, 'EB/ALB source manifest is present');
}

console.log('room-failover-handoff regression: PASS');
