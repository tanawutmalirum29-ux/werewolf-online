// ============================================================
// botEngine.js — เอนจินให้บอทเล่นเองอัตโนมัติ
// ============================================================
// เฟส 2 (MVP): บอทกัด + บอทโหวต — สุ่มเป้า ยังไม่ฉลาด แค่ "ทำอะไรสักอย่างที่ถูกกติกา"
// เฟส 3: เพิ่มบทบาทพิเศษ (หมอ/ผู้หยั่งรู้-ผู้มีลาง-หมาป่าหยั่งรู้/แม่มด/ยายขี้โมโห/ลูกหมาป่า/
// หมาป่าผู้พิทักษ์/หมาป่านักเวท) ให้ใช้สกิลด้วย ไม่ปล่อยว่างทุกคืน (ดู bot-autonomous-ai-phases.md เฟส 3)
//
// runBotsFor(room, roomId, phase, deps)
//   room   — object ห้องปัจจุบัน (จาก rooms[roomId] ใน server.js)
//   roomId — รหัสห้อง
//   phase  — จังหวะที่ถูกเรียก: "wolfKill" | "vote" | "nightSkill" | "daySkill"
//   deps   — ฟังก์ชัน/ค่าที่ต้องพึ่งจาก server.js ส่งเข้ามาเป็น object เดียว (ต่างกันไปตาม phase
//            ที่เรียก) กันไม่ต้อง require server.js กลับ (จะเกิด circular require)

const BOT_ACTION_DELAY_MIN_MS = 2000; // 2 วิ
const BOT_ACTION_DELAY_MAX_MS = 8000; // 8 วิ — หน่วงเวลาสุ่มต่อบอทก่อน action (กันดูเป็นบอทชัดเกิน + กันชนเวลากันหมด)

// เฟส 5 / "แนวทาง B": llmBotEngine.js เป็นแค่ทางเลือกเสริมที่ต่อคิวก่อน botEngine.js เดิม — ไม่ได้
// แทนที่เลย ถ้า LLM ทำงานได้ก็ใช้ผลมัน ถ้าพัง/timeout/ปิดไว้ก็หลบไปใช้ของเดิม (สุ่ม) ทันที
// ดู bot-autonomous-ai-approach-b-technical.md สำหรับรายละเอียด flow เต็ม ๆ
const { chooseWolfKillTarget, chooseVoteTarget } = require("./llmBotEngine");

// เฟส 3: บอทแม่มดสุ่ม 30–50% โอกาสใช้ยาต่อคืน (ต่อขวด แยก roll กันคนละครั้ง) — ดูแผนเฟส 3
const WITCH_POTION_CHANCE_MIN = 0.3;
const WITCH_POTION_CHANCE_MAX = 0.5;

// เฟส 3: กลุ่มบทบาทพิเศษที่ทำ AI ให้ในเฟสนี้ (ดูหัวข้อ "สิ่งที่ตั้งใจไม่ทำ" ในแผนเฟส 3 สำหรับ
// role ที่ตั้งใจเว้นไว้ — ศาลเตี้ย/นายก/solo roles)
const SCOUT_ROLES = new Set(["หมาป่าหยั่งรู้", "ผู้มีลาง", "ผู้หยั่งรู้"]);
const DOCTOR_ROLE = "หมอ";
const DETECTIVE_ROLE = "นักสืบ"; // เลือก 2 คนต่อคืนเพื่อดูว่าอยู่ทีมเดียวกันไหม (=/≠) ผ่าน detective_scout
// หมายเหตุ: "บอดี้การ์ด" และ "อันธพาล" ตั้งใจไม่ทำ AI ให้ในเฟสนี้ — ทั้งคู่ auto-protect ตัวเอง
// อยู่แล้วใน resolve_night ฝั่ง server.js (ดูคอมเมนต์ "ปกป้องตัวเองอัตโนมัติ" ที่ role นั้นๆ)
// ต่อให้ AI เลือกเป้าให้ก็ไม่มีผลอะไรเพิ่ม จึงข้ามไปเลยตามที่แผนเฟส 3 ระบุ
// เฟส 5: หมาป่าจำเป้าที่เพิ่งถูกป้องกันสำเร็จเมื่อคืนก่อน → ลดโอกาสเลือกเป้าเดิมซ้ำ (ไม่ใช่ห้ามเด็ดขาด
// เพราะบางห้องผู้เล่นน้อยจนแทบไม่มีเป้าอื่นให้เลือก) ใช้ weighted random: เป้าที่โดนป้องกันไปแล้วเมื่อคืน
// ได้น้ำหนักต่ำกว่าเป้าอื่นมาก แทนที่จะสุ่มเท่ากันทุกคนแบบเฟส 2 เดิม
const WOLF_MEMORY_PROTECTED_WEIGHT = 1; // น้ำหนักของเป้าที่เพิ่งถูกป้องกันสำเร็จเมื่อคืนก่อน
const WOLF_MEMORY_NORMAL_WEIGHT = 4; // น้ำหนักของเป้าปกติที่ไม่เคยถูกป้องกัน (คืนก่อน)
// เฟส 5: หมาป่าฮั้วโหวตเป้าเดียวกันตอนกลางวัน 90% ของรอบ (สุ่มแยกกันคนละเป้าแค่ 10%) — เหมือนกลยุทธ์
// จริงของทีมหมาป่าที่ควรรวมเสียงกันกำจัดเป้าให้สำเร็จ ไม่กระจายจนไม่มีใครโดนประหารเลย (ดูคำขอผู้ใช้)
const WOLF_VOTE_COORDINATION_CHANCE = 0.9; // โอกาส 9 ต่อ 1 ตามที่ขอ
// เฟส 5: บอทชาวบ้าน (ไม่ใช่ทีมหมาป่า) โหวตตามคนที่ผู้หยั่งรู้/ผู้มีลางเปิดเผยความสงสัยไว้ในแชท 80%
// ของรอบ (ถ้ามีคนถูกพาดพิงและยังไม่ตาย) ที่เหลือ 20% สุ่มแยกกันปกติ — ดู detectPubliclySuspectedIds
// ใน server.js (parse ข้อความแชท) + room.publiclySuspectedIds
const VILLAGER_SUSPICION_FOLLOW_CHANCE = 0.8;
const MURDERER_ROLE = "ฆาตกรต่อเนื่อง"; // เฟส 5: ถ้าหมาป่าหยั่งรู้ส่องเจอว่าเป็นฆาตกรต่อเนื่องแล้ว หมาป่าจะไม่เลือกกัดเลย
// (server.js resolve_night มีกฎอยู่แล้วว่าหมาป่ากัดฆาตกรต่อเนื่องไม่ตาย เสียตาฟรีเปล่าๆ ทุกครั้ง — บอทที่รู้ข้อมูล
// นี้แล้ว [ผ่าน target.wolfSeerRevealed/wolfSeerRevealedRole ที่ performScoutTarget เซ็ตไว้] จึงควรเลี่ยงเป้านี้
// ไปเลือกเป้าอื่นแทนเสมอ)
const FOOL_ROLE = "คนบ้า"; // เฟส 6 (ตามคำขอผู้ใช้): ผลลางของคนบ้า/ฆาตกรต่อเนื่องออกเป็น "ไม่ทราบ" เหมือนกัน (ดู
// AURA_RESULT ใน server.js) แต่คนละความหมายกันโดยสิ้นเชิง — ฆาตกรต่อเนื่องอันตรายเหมือนหมาป่า ควรเตือนให้ระวัง/โหวต
// ส่วนคนบ้ากลับตรงข้าม (ชนะเกมถ้าถูกโหวตประหาร) จึงต้องเตือนไม่ให้โหวตแทน ผู้ที่ "เห็นบทบาทจริง" เท่านั้น
// (ผู้หยั่งรู้/ศาลเตี้ย) แยกสองกรณีนี้ออกจากกันได้ — ผู้มีลางเห็นแค่ผลลางเลยแยกไม่ได้ ดู classifyRevealedRole

// จัดหมวดบทบาทจริงที่ "เห็น" มา (ผู้หยั่งรู้ตอนส่อง / ศาลเตี้ยตอนดูบท) เป็น "bad" (หมาป่า/ฆาตกรต่อเนื่อง — อันตราย
// ควรเตือน+โหวต) / "fool" (คนบ้า — ห้ามโหวตประหารเด็ดขาด) / "good" (villager team ทั่วไปที่เหลือ)
function classifyRevealedRole(revealedRole, WOLF_ROLES) {
    if (revealedRole === FOOL_ROLE) return "fool";
    if ((WOLF_ROLES && WOLF_ROLES.has(revealedRole)) || revealedRole === MURDERER_ROLE) return "bad";
    return "good";
}
const WITCH_ROLE = "แม่มด";
const ELDER_ROLE = "ยายขี้โมโห";
const WOLF_CUB_ROLE = "ลูกหมาป่า";
// วางโล่ตอนกลางวัน (select_shield) — ไม่ใช่ตอนกลางคืน — รวมทั้งหมาป่าผู้พิทักษ์ (ทีมหมาป่า)
// และหนูน้อยผู้ใสซื่อ (ทีมชาวบ้าน) เพราะใช้กลไกเดียวกันทุกประการ (guardianShieldAvailable)
const GUARDIAN_ROLES = new Set(["หมาป่าผู้พิทักษ์", "หนูน้อยผู้ใสซื่อ"]);
const WIZARD_ROLE = "หมาป่านักเวท"; // เลือกเป้าร่ายเวทตอนกลางวัน (select_curse_target) — ไม่ใช่ตอนกลางคืน

// เฟส 5: ศาลเตี้ยดูบทบาทคนน่าสงสัย + บอกชาวบ้านในแชทถ้าเจอตัวจริง — ก่อนหน้านี้ตั้งใจไม่ทำ AI ให้เลย
// (ดูคอมเมนต์ "สิ่งที่ตั้งใจไม่ทำ" ด้านบน) ตอนนี้ผู้ใช้ขอเพิ่มเข้ามาเฉพาะเจาะจงแล้ว
const SHERIFF_ROLE = "ศาลเตี้ย";
// โอกาสที่บอทศาลเตี้ยจะ "ตัดสินใจใช้" สิทธิ์ดูบท (มีแค่ 1 ครั้งตลอดเกม) ในวันนั้นๆ ถ้ายังเหลืออยู่ —
// ไม่ใช่ทุกวันจะรีบใช้ทันที เหมือนผู้เล่นจริงบางคนก็เก็บไว้รอจังหวะ ผู้ใช้ไม่ได้ระบุตัวเลขชัดเจน
// (บอกแค่ "มีโอกาส") จึงตั้งค่ากลางๆ ไว้ก่อน ปรับได้ทีหลังถ้ารู้สึกว่าบอทใช้เร็ว/ช้าเกินไป
const SHERIFF_PEEK_USE_CHANCE = 0.5;
// เฟส 5: ผู้หยั่งรู้/ผู้มีลาง (ไม่รวมหมาป่าหยั่งรู้ซึ่งเป็นทีมหมาป่า) มีโอกาสบอกชาวบ้านในแชทถ้าส่องเจอ
// ผลลัพธ์ที่ชัดเจน (ผู้หยั่งรู้: เป็นทีมหมาป่าจริง/ไม่ใช่ / ผู้มีลาง: ลางออกร้าย/ดี) — ไม่บอกถ้าผลออกมา
// "ไม่ทราบ" เพราะไม่มีอะไรจะพูด ผู้ใช้ไม่ได้ระบุตัวเลขชัดเจนเช่นกัน
// เฟส 6 (ตามคำขอผู้ใช้): เดิมประกาศได้แค่กรณี "เจอคนร้าย" เท่านั้น ตอนนี้เพิ่มกรณี "เจอคนดี" ให้ประกาศ
// ได้ด้วย เพื่อช่วยตัดคนดีออกจากความสงสัยได้ — แต่กรณีผู้หยั่งรู้เจอคนดี ห้ามบอกชื่ออาชีพจริงเด็ดขาด
// (ดู runScoutAnnouncePhase) บอกได้แค่ "เป็นคนดี" เท่านั้น กันหมาป่ารู้ว่าใครถืออาชีพสำคัญแล้วเลือกฆ่าตรงเป้า
const SEER_REVEAL_CHANCE = 0.7;

// เช็คว่าบอทตัวนี้ "ควรให้ AI action แทน" ตอนนี้หรือไม่ — ใช้เช็คซ้ำ 2 จุดตามแผน:
// ตอนตั้ง timer (scheduleBotAction) และตอน timer ยิงจริง (ในนั้นอีกที) เพราะสถานะอาจ
// เปลี่ยนไปแล้วระหว่างรอ delay (เช่น โฮสต์เพิ่งเข้าสิง, บอทตายไปแล้ว, โฮสต์กดปิด AI)
function botEligibleNow(room, bot, deps) {
    if (!room.botAI || !room.botAI.enabled) return false;
    if (room.gameOver) return false; // เฟส 3: กันเรียก action หลังเกมจบไปแล้ว (เช่น ระหว่างรอ delay เกมดันจบพอดี)
    if (room.botAI.perBot && room.botAI.perBot[bot.id] === false) return false; // ปิด AI เฉพาะตัวนี้ไว้ (เฟส 4)
    if (!bot || !bot.isBot || !bot.alive) return false;
    if (deps.isPlayerCurrentlyConnected(bot)) return false; // มีคนเข้าสิงอยู่ ไม่แย่ง action จากคนคุม
    return true;
}

// กันเคสห้องถูกลบ/รีสตาร์ทไปแล้วระหว่างรอ delay ของ setTimeout (ดู kick host / reset ฯลฯ ใน server.js)
function roomStillLive(roomId, room, deps) {
    return !!(deps.rooms && deps.rooms[roomId] === room);
}

// เฟส 5 / "แนวทาง B": เช็คว่าบอทตัวนี้ถูกตั้งให้ใช้ LLM ตัดสินใจแทนสุ่มหรือไม่ (โฮสต์เปิดผ่าน
// toggle_bot_llm_mode ต่อตัว — ปิดเป็นค่าเริ่มต้นเสมอ ไม่มีผลอะไรถ้าไม่ได้เปิดเอง)
function botUsesLLM(room, bot) {
    return !!(room.botAI && room.botAI.llmBots && room.botAI.llmBots[bot.id]);
}

// สุ่มเป้าจากผู้เล่นที่ยังมีชีวิต ไม่ใช่ตัวเอง (และไม่ใช่ role ในเซ็ต excludeRoles ถ้ามี เช่น ทีมหมาป่า)
// เฟส 3: เพิ่ม includeSelf (default false) — ใช้กับหมาป่าผู้พิทักษ์ที่วางโล่ป้องกันตัวเองได้ด้วย
function randomAliveTarget(room, bot, excludeRoles, includeSelf) {
    const candidates = room.players.filter((p) => {
        if (!p.alive) return false;
        // แก้บั๊ก: เดิมไม่กันโฮสต์ออกจากรายชื่อเป้าที่บอทสุ่มเลือกได้เลย — โฮสต์ยังอยู่ใน room.players
        // (role:null, alive:true เสมอ) ทำให้บอทเสียตา action ไปกับการ "เลือกโฮสต์" แบบสุ่มได้บ่อยๆ
        // (ยิ่งห้องมีผู้เล่นน้อย โอกาสสุ่มโดนโฮสต์ยิ่งสูง) ทั้งที่โฮสต์ไม่ใช่ผู้เล่นในเกมจริง
        if (p.isHost) return false;
        if (!includeSelf && p.id === bot.id) return false;
        if (excludeRoles && excludeRoles.has(p.role)) return false;
        return true;
    });
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// เฟส 5: สุ่มเลือก 1 คนจาก candidates แบบถ่วงน้ำหนัก — ใช้กับหมาป่าเลี่ยงเป้าที่เพิ่งถูกป้องกันสำเร็จ
// เมื่อคืนก่อน (น้ำหนักต่ำกว่า ไม่ใช่ตัดออกเลย) getWeight(player) ต้องคืนเลข > 0 เสมอ
function weightedRandomPick(candidates, getWeight) {
    if (candidates.length === 0) return null;
    const weights = candidates.map(getWeight);
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0) return candidates[Math.floor(Math.random() * candidates.length)]; // กันเหนียว หารศูนย์
    let roll = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1]; // กันพลาดจาก floating point
}

// เฟส 3: สุ่มว่าแม่มดควรใช้ยาขวดนี้คืนนี้หรือไม่ — สุ่ม threshold 30–50% ก่อน แล้วค่อยทอยจริง
// (เรียกแยกกันคนละครั้งต่อขวด ไม่ให้ผลของยาป้องกันไปผูกกับยาพิษ)
function witchShouldUsePotion() {
    const chance = WITCH_POTION_CHANCE_MIN + Math.random() * (WITCH_POTION_CHANCE_MAX - WITCH_POTION_CHANCE_MIN);
    return Math.random() < chance;
}

// ตั้งเวลาหน่วงสุ่มก่อนให้บอทตัวหนึ่ง action จริง — เช็ค eligibility ทั้งตอนตั้งและตอนยิง
function scheduleBotAction(room, roomId, bot, deps, actionFn) {
    if (!botEligibleNow(room, bot, deps)) return; // guard จุดที่ 1: ตอนตั้ง timer

    const delayMs =
        BOT_ACTION_DELAY_MIN_MS + Math.floor(Math.random() * (BOT_ACTION_DELAY_MAX_MS - BOT_ACTION_DELAY_MIN_MS));

    setTimeout(() => {
        if (!roomStillLive(roomId, room, deps)) return;
        if (!botEligibleNow(room, bot, deps)) return; // guard จุดที่ 2: ตอน timer ยิงจริง
        actionFn();
    }, delayMs);
}

// ============================================================
// เฟส 2: บอทกัด + บอทโหวต
// ============================================================

function runWolfKillPhase(room, roomId, deps) {
    const { performWolfKill, WOLF_ROLES } = deps;
    const wolfBots = room.players.filter(
        (p) => p.isBot && p.alive && WOLF_ROLES.has(p.role) && p.role !== "หมาป่าหยั่งรู้" // หมาป่าหยั่งรู้ไม่ร่วมล่า (ใช้ scout_target แทน — ดู runScoutPhase)
    );
    wolfBots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, async () => {
            if (!room.isNight) return; // คืนอาจจบไปแล้วระหว่างรอ delay
            if (!WOLF_ROLES.has(bot.role) || bot.role === "หมาป่าหยั่งรู้") return; // role อาจเปลี่ยนไปแล้ว (กันเหนียว)

            const candidates = room.players.filter(
                (p) =>
                    p.alive &&
                    !p.isHost && // กันโฮสต์ออกจากเป้ากัดของหมาป่า (ดูคอมเมนต์ที่ randomAliveTarget)
                    p.id !== bot.id &&
                    !WOLF_ROLES.has(p.role) && // ห้ามกัดทีมหมาป่ากันเอง
                    // เฟส 5: ถ้าหมาป่าหยั่งรู้ส่องเจอแล้วว่าเป็นฆาตกรต่อเนื่อง ตัดออกจากเป้าเลย (กัดไม่ตายเสียตาฟรีแน่ๆ)
                    !(p.wolfSeerRevealed && p.wolfSeerRevealedRole === MURDERER_ROLE)
            ); // ลิสต์เป้าที่ถูกกติกาจริง ๆ (ใช้ทั้งสองเส้นทาง)
            if (candidates.length === 0) return;

            // เฟส 5: เป้าที่เพิ่งถูกป้องกันสำเร็จเมื่อคืนก่อน (ดู room.wolfMemory ที่ resolve_night เซ็ตไว้)
            // ได้น้ำหนักต่ำกว่าปกติตอนสุ่ม แทนที่จะสุ่มเท่ากันทุกคนเหมือนเฟส 2 เดิม
            const recentlyProtectedIds = (room.wolfMemory && room.wolfMemory.recentlyProtectedIds) || [];

            let targetId = null;
            if (botUsesLLM(room, bot)) {
                targetId = await chooseWolfKillTarget(room, bot, candidates, deps).catch(() => null);
                // เช็คซ้ำหลัง await เพราะสถานะอาจเปลี่ยนไปแล้วระหว่างรอ Claude API ตอบ (คืนจบ/บอทตาย/โดนเข้าสิง)
                if (!roomStillLive(roomId, room, deps)) return;
                if (!botEligibleNow(room, bot, deps)) return;
                if (!room.isNight) return;
            }
            const target = targetId
                ? candidates.find((p) => p.id === targetId)
                : weightedRandomPick(candidates, (p) =>
                      recentlyProtectedIds.includes(p.id) ? WOLF_MEMORY_PROTECTED_WEIGHT : WOLF_MEMORY_NORMAL_WEIGHT
                  ); // LLM ปิด/พัง/timeout → สุ่มถ่วงน้ำหนักแทนทันที
            if (!target) return;
            performWolfKill(room, roomId, bot.id, target.id);
        });
    });
}

function runVotePhase(room, roomId, deps) {
    const { performCastVote, WOLF_ROLES } = deps;
    const voterBots = room.players.filter((p) => p.isBot && p.alive);

    // เฟส 5: ตัดสินใจ "เป้าที่หมาป่าจะฮั้วโหวตร่วมกัน" ครั้งเดียวตอนเริ่มเฟสนี้ (ก่อนตั้ง timer ของ
    // แต่ละตัว) ไม่ใช่ให้แต่ละตัวสุ่มเองตอน action จริง เพราะงั้นจะไม่มีทาง "ตรงกัน" ได้เลย — สุ่มทอย
    // ครั้งเดียวว่ารอบนี้จะฮั้วหรือไม่ (90%) แล้วเลือกเป้าฮั้วแบบสุ่มจากผู้เล่นที่ไม่ใช่ทีมหมาป่า
    // (WOLF_ROLES อาจ undefined ถ้า deps ไม่ครบ — กันเหนียวไว้ ถือว่าไม่ฮั้วถ้าไม่มีข้อมูลทีมหมาป่า)
    let wolfCoordinatedTargetId = null;
    if (WOLF_ROLES && Math.random() < WOLF_VOTE_COORDINATION_CHANCE) {
        const coordinationCandidates = room.players.filter((p) => p.alive && !p.isHost && !WOLF_ROLES.has(p.role));
        if (coordinationCandidates.length > 0) {
            wolfCoordinatedTargetId =
                coordinationCandidates[Math.floor(Math.random() * coordinationCandidates.length)].id;
        }
    }

    voterBots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, async () => {
            if (!room.voteMode) return; // รอบโหวตอาจปิดไปแล้วระหว่างรอ delay

            const candidates = room.players.filter((p) => p.alive && !p.isHost && p.id !== bot.id);
            if (candidates.length === 0) return;

            let targetId = null;
            if (botUsesLLM(room, bot)) {
                targetId = await chooseVoteTarget(room, bot, candidates, deps).catch(() => null);
                // เช็คซ้ำหลัง await เหมือนฝั่ง wolfKill — โหวตอาจปิดไปแล้วระหว่างรอ Claude API ตอบ
                if (!roomStillLive(roomId, room, deps)) return;
                if (!botEligibleNow(room, bot, deps)) return;
                if (!room.voteMode) return;
            }

            // เฟส 5: ถ้าเป็นหมาป่าและรอบนี้ทอยติด "ฮั้ว" ไว้ตอนต้นเฟส → ใช้เป้าที่ฮั้วกันไว้แทนการ
            // สุ่มแยกกันคนละเป้า (เช็คซ้ำว่าเป้ายังมีชีวิตอยู่จริงตอนนี้ เพราะอาจตายไปแล้วระหว่างรอ
            // delay 2–8 วิ ของแต่ละตัว) LLM path (ด้านบน) ยังคงสำคัญกว่าเสมอถ้าเปิดใช้และได้ผลลัพธ์มา
            if (!targetId && WOLF_ROLES && WOLF_ROLES.has(bot.role) && wolfCoordinatedTargetId) {
                const coordinatedTarget = candidates.find((p) => p.id === wolfCoordinatedTargetId);
                if (coordinatedTarget) targetId = coordinatedTarget.id;
            }

            // เฟส 5: บอทฝั่งชาวบ้าน (ไม่ใช่ทีมหมาป่า) โหวตตามคนที่เคยถูกผู้หยั่งรู้/ผู้มีลางเปิดเผยความ
            // สงสัยไว้ในแชทกลางวัน (ดู detectPubliclySuspectedIds ใน server.js ที่ parse ข้อความไว้ให้
            // แล้วเก็บใน room.publiclySuspectedIds) — 80% เชื่อ/ตามข้อมูลนี้ ถ้ามีคนถูกพาดพิงและยังไม่ตาย
            // ที่เหลืออีก 20% (หรือไม่มีใครถูกพาดพิงเลย) ยังสุ่มแยกกันปกติ — ไม่ใช้กับหมาป่า เพราะถ้าคนที่
            // ถูกส่องเจอจริงคือหมาป่าเอง จะกลายเป็นหมาป่าช่วยโหวตไล่ทีมตัวเองออกไปเฉยๆ (ขัดกลยุทธ์)
            if (!targetId && WOLF_ROLES && !WOLF_ROLES.has(bot.role)) {
                const suspectedIds = room.publiclySuspectedIds || [];
                const suspectedCandidates = candidates.filter((p) => suspectedIds.includes(p.id));
                if (suspectedCandidates.length > 0 && Math.random() < VILLAGER_SUSPICION_FOLLOW_CHANCE) {
                    targetId = suspectedCandidates[Math.floor(Math.random() * suspectedCandidates.length)].id;
                }
            }

            // เฟส 6 (ตามคำขอผู้ใช้): คนที่ถูกผู้หยั่งรู้/ศาลเตี้ยเปิดเผยว่าเป็น "คนบ้า" ไว้ในแชท
            // (room.publiclyProtectedIds) ให้บอทฝั่งชาวบ้านเลี่ยงไม่สุ่มโหวตเข้าเป้านั้นเด็ดขาด (โหวตประหาร
            // คนบ้า = คนบ้าชนะเกมทันที) — ไม่ใช้กับหมาป่า เพราะหมาป่าอาจอยากใช้เป้านี้บังหน้าตัวเองอยู่แล้ว
            const target = targetId
                ? candidates.find((p) => p.id === targetId)
                : (() => {
                      const protectedIds = room.publiclyProtectedIds || [];
                      const pool =
                          protectedIds.length > 0 && (!WOLF_ROLES || !WOLF_ROLES.has(bot.role))
                              ? candidates.filter((p) => !protectedIds.includes(p.id))
                              : candidates;
                      const finalPool = pool.length > 0 ? pool : candidates; // กันเหนียวไม่ให้ไม่มีเป้าเลย
                      return finalPool[Math.floor(Math.random() * finalPool.length)];
                  })(); // LLM ปิด/พัง/timeout → สุ่มแทนทันที (เลี่ยงเป้าที่ถูกป้องกันไว้ถ้าเป็นไปได้)
            if (!target) return;
            performCastVote(room, roomId, bot.id, target.id);
        });
    });
}

// ============================================================
// เฟส 3: บทบาทพิเศษที่ใช้สกิลตอนกลางคืน (trigger จาก start_night เหมือน wolfKill)
// ============================================================

// หมอ: สุ่มป้องกัน 1 คนต่อคืน (ไม่ใช่ตัวเอง) — บอดี้การ์ด/อันธพาล ข้ามไปเลยตามที่ตั้งใจไว้ (ดูคอมเมนต์บนสุด)
function runDoctorPhase(room, roomId, deps) {
    const { performSelectTarget } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === DOCTOR_ROLE);
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (!room.isNight) return;
            if (bot.role !== DOCTOR_ROLE) return;
            if (room.selectedTargets && room.selectedTargets[bot.id]) return; // เลือกไปแล้ว (กันตั้ง action ซ้ำ)
            const target = randomAliveTarget(room, bot, null);
            if (!target) return;
            performSelectTarget(room, roomId, bot.id, target.id);
        });
    });
}

// หมาป่าหยั่งรู้ / ผู้มีลาง / ผู้หยั่งรู้: สุ่มส่องคนที่ยังไม่เคยส่องคืนนี้ — คนละ 1 ครั้งต่อคืน
function runScoutPhase(room, roomId, deps) {
    const { performScoutTarget, WOLF_ROLES } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && SCOUT_ROLES.has(p.role));
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (!room.isNight) return;
            if (!SCOUT_ROLES.has(bot.role)) return;
            if (bot.scoutedThisNight) return; // ใช้สิทธิ์คืนนี้ไปแล้ว
            const excludeRoles = bot.role === "หมาป่าหยั่งรู้" ? WOLF_ROLES : null; // หมาป่าหยั่งรู้ส่องทีมตัวเองไม่ได้
            const target = randomAliveTarget(room, bot, excludeRoles);
            if (!target) return;
            performScoutTarget(room, roomId, bot.id, target.id);
        });
    });
}

// นักสืบ: สุ่มเลือก 2 คนที่ยังไม่ตาย (ไม่ใช่ตัวเอง) มาเทียบทีมกัน — คนละ 1 ครั้งต่อคืน
// ต่างจาก runScoutPhase ตรงที่ต้องสุ่ม 2 เป้าที่ไม่ซ้ำกันมาพร้อมกัน แล้วยิง performDetectiveScout ครั้งเดียว
function runDetectivePhase(room, roomId, deps) {
    const { performDetectiveScout } = deps;
    if (!performDetectiveScout) return; // กันเหนียว เผื่อ deps เก่ายังไม่มีฟังก์ชันนี้
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === DETECTIVE_ROLE);
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (!room.isNight) return;
            if (bot.role !== DETECTIVE_ROLE) return;
            if (bot.detectiveScoutedThisNight) return; // ใช้สิทธิ์คืนนี้ไปแล้ว
            const candidates = room.players.filter((p) => p.alive && !p.isHost && p.id !== bot.id);
            if (candidates.length < 2) return;
            const shuffled = [...candidates].sort(() => Math.random() - 0.5);
            const [targetA, targetB] = shuffled;
            performDetectiveScout(room, roomId, bot.id, targetA.id, targetB.id);
        });
    });
}

// แม่มด: ยาป้องกัน+ยาพิษ แยก roll กันคนละครั้ง (30–50% ต่อขวดต่อคืน) ใช้ performSelectTarget
// สำหรับยาป้องกัน (อยู่ใน protectRoles ฝั่ง server.js) และ performWitchPoison สำหรับยาพิษ
function runWitchPhase(room, roomId, deps) {
    const { performSelectTarget, performWitchPoison } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === WITCH_ROLE);
    bots.forEach((bot) => {
        // ยาป้องกัน
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (!room.isNight) return;
            if (bot.role !== WITCH_ROLE) return;
            if ((room.nightCount || 0) <= 1) return; // ห้ามใช้น้ำยาคืนแรก (ตามคำขอผู้ใช้) — server ก็เช็คซ้ำอยู่แล้ว
            if (!(bot.witchProtectPotions > 0)) return;
            if (room.selectedTargets && room.selectedTargets[bot.id]) return; // เลือกไปแล้ว
            if (!witchShouldUsePotion()) return; // ทอยไม่ติด คืนนี้ไม่ใช้ยาป้องกัน
            const target = randomAliveTarget(room, bot, null);
            if (!target) return;
            performSelectTarget(room, roomId, bot.id, target.id);
        });
        // ยาพิษ — roll แยกจากยาป้องกันโดยสิ้นเชิง ไม่ผูกผลกัน
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (!room.isNight) return;
            if (bot.role !== WITCH_ROLE) return;
            if ((room.nightCount || 0) <= 1) return; // ห้ามใช้น้ำยาคืนแรก (ตามคำขอผู้ใช้) — server ก็เช็คซ้ำอยู่แล้ว
            if (!(bot.witchPoisonPotions > 0)) return;
            if (!witchShouldUsePotion()) return; // ทอยไม่ติด คืนนี้ไม่ใช้ยาพิษ
            const candidates = room.players.filter((p) => p.alive && !p.isHost && p.id !== bot.id && !p.witchPoisonPending);
            if (candidates.length === 0) return;
            const target = candidates[Math.floor(Math.random() * candidates.length)];
            performWitchPoison(room, roomId, bot.id, target.id);
        });
    });
}

// ยายขี้โมโห: สุ่มเป้าใบ้ 1 คนต่อคืน (ไม่จำกัดขวด/จำนวนครั้งเหมือนแม่มด)
function runElderPhase(room, roomId, deps) {
    const { performSelectTarget } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === ELDER_ROLE);
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (!room.isNight) return;
            if (bot.role !== ELDER_ROLE) return;
            if (room.selectedTargets && room.selectedTargets[bot.id]) return;
            const target = randomAliveTarget(room, bot, null);
            if (!target) return;
            performSelectTarget(room, roomId, bot.id, target.id);
        });
    });
}

// ลูกหมาป่า: สุ่มจองเป้าที่จะ "ลากตายด้วย" — เลือกได้ทั้งวันทั้งคืน เป้าคงอยู่ข้ามคืนจนกว่าจะตาย
// (ไม่ถูกเคลียร์ทุกเช้าเหมือนหมอ/แม่มด/ยายขี้โมโห — ดูคอมเมนต์ performSelectTarget ฝั่ง server.js)
// จึงเลือกครั้งเดียวพอ ไม่ต้องเลือกซ้ำทุกคืนถ้ามีเป้าอยู่แล้ว
function runWolfCubPhase(room, roomId, deps) {
    const { performSelectTarget, WOLF_ROLES } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === WOLF_CUB_ROLE);
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (bot.role !== WOLF_CUB_ROLE) return;
            if (room.selectedTargets && room.selectedTargets[bot.id]) return; // จองเป้าไว้แล้ว
            const target = randomAliveTarget(room, bot, WOLF_ROLES); // ห้ามจองทีมหมาป่ากันเอง
            if (!target) return;
            performSelectTarget(room, roomId, bot.id, target.id);
        });
    });
}

// ============================================================
// เฟส 3: บทบาทพิเศษที่ใช้สกิลตอนกลางวัน (trigger จาก resolve_night ตอนเข้าสู่วันใหม่ —
// ต่างจากกลุ่มบนเพราะ select_shield/select_curse_target ใช้ได้เฉพาะตอน !room.isNight เท่านั้น)
// ============================================================

// หมาป่าผู้พิทักษ์: วางโล่ป้องกันการประหาร 1 ครั้งตลอดเกม — วางใหม่ทุกวันที่ยังไม่ได้วาง
// (shieldTargets ถูกเคลียร์ทุกครั้งที่ปิดรอบโหวต/เข้าคืนใหม่ฝั่ง server.js) เลือกได้รวมถึงตัวเอง
function runGuardianShieldPhase(room, roomId, deps) {
    const { performSelectShield } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && GUARDIAN_ROLES.has(p.role));
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (room.isNight) return; // วางโล่ได้เฉพาะตอนกลางวันเท่านั้น
            if (!GUARDIAN_ROLES.has(bot.role)) return;
            if (!(bot.guardianShieldAvailable > 0)) return; // ใช้ไปแล้ว ไม่มีให้วางซ้ำ
            if (room.shieldTargets && room.shieldTargets[bot.id]) return; // วางไว้แล้ววันนี้
            const target = randomAliveTarget(room, bot, null, true); // includeSelf: วางป้องกันตัวเองได้
            if (!target) return;
            performSelectShield(room, roomId, bot.id, target.id);
        });
    });
}

// หมาป่านักเวท: สุ่มเป้าร่ายเวททุกวัน (คำสาปมีผลแค่วันนั้น ถูกล้างทุกเช้า ต้องเลือกใหม่เสมอ)
// เฟส 5: เลี่ยงไม่ร่ายใส่ "บทบาทส่อง" (SCOUT_ROLES: หมาป่าหยั่งรู้/ผู้หยั่งรู้/ผู้มีลาง) ตามที่ผู้ใช้ขอ —
// ใช้ excludeRoles ของ randomAliveTarget ที่มีอยู่แล้วแทนการเขียน filter เอง
function runWizardCursePhase(room, roomId, deps) {
    const { performSelectCurseTarget } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === WIZARD_ROLE);
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (room.isNight) return; // เลือกเป้าร่ายเวทได้เฉพาะตอนกลางวันเท่านั้น
            if (bot.role !== WIZARD_ROLE) return;
            if (room.curseTargets && room.curseTargets[bot.id]) return; // เลือกไว้แล้ววันนี้
            const target = randomAliveTarget(room, bot, SCOUT_ROLES);
            if (!target) return;
            performSelectCurseTarget(room, roomId, bot.id, target.id);
        });
    });
}

// เฟส 5: ศาลเตี้ยมีโอกาสใช้สิทธิ์ "ดูบทบาท" (มีแค่ 1 ครั้งตลอดเกม) กับคนที่น่าสงสัย แล้วบอกชาวบ้านใน
// แชทถ้าเจอว่าเป็นทีมหมาป่าจริงๆ — เลือกเป้าจากคนที่เคยถูกพาดพิงไว้ในแชทก่อน (room.publiclySuspectedIds)
// ถ้ามี ไม่งั้นสุ่มทั่วไป (ไม่มีอะไรพิเศษให้เลือกก็สุ่ม ตามที่ผู้ใช้เคยระบุไว้ก่อนหน้านี้)
function runSheriffPhase(room, roomId, deps) {
    const { performSheriffPeek, performBotChatMessage, WOLF_ROLES } = deps;
    const bots = room.players.filter((p) => p.isBot && p.alive && p.role === SHERIFF_ROLE);
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (room.isNight) return; // ดูบทได้เฉพาะตอนกลางวันเท่านั้น
            if (bot.role !== SHERIFF_ROLE) return;
            if (!(bot.sheriffPeeks > 0)) return; // ใช้ไปแล้ว/ไม่มีสิทธิ์เหลือ
            if (bot.sheriffUsedToday) return; // ใช้ความสามารถวันนี้ไปแล้ว (ยิงหรือดูบท อย่างใดอย่างหนึ่ง)
            if (Math.random() >= SHERIFF_PEEK_USE_CHANCE) return; // ทอยไม่ติด วันนี้ยังไม่ใช้สิทธิ์

            const candidates = room.players.filter((p) => p.alive && !p.isHost && p.id !== bot.id);
            if (candidates.length === 0) return;
            const suspectedIds = room.publiclySuspectedIds || [];
            const suspectedCandidates = candidates.filter((p) => suspectedIds.includes(p.id));
            const target =
                suspectedCandidates.length > 0
                    ? suspectedCandidates[Math.floor(Math.random() * suspectedCandidates.length)]
                    : candidates[Math.floor(Math.random() * candidates.length)];

            performSheriffPeek(room, roomId, bot.id, target.id);

            // เช็คผลทันทีหลัง peek (performSheriffPeek เป็นฟังก์ชัน sync ไม่ต้อง await) — target
            // คืออ็อบเจกต์เดียวกับใน room.players จึงอ่านค่าที่เพิ่งถูกเซ็ตไปได้ตรงๆ ทันที
            const revealedRole = target.sheriffRevealedRoleBy && target.sheriffRevealedRoleBy[bot.id];
            if (!revealedRole) return;
            const category = classifyRevealedRole(revealedRole, WOLF_ROLES);
            if (category === "bad") {
                // เจอทีมหมาป่า/ฆาตกรต่อเนื่อง → บอกชาวบ้านในแชท + เก็บไว้ให้บอทชาวบ้านใช้โหวตตามด้วย (ระบบเดียวกับ
                // detectPubliclySuspectedIds ที่ทำไว้ก่อนหน้านี้)
                room.publiclySuspectedIds = room.publiclySuspectedIds || [];
                if (!room.publiclySuspectedIds.includes(target.id)) room.publiclySuspectedIds.push(target.id);
                performBotChatMessage(
                    room,
                    roomId,
                    bot.id,
                    `🔍 ผมดูบทบาทของ ${target.name} ด้วยความสามารถศาลเตี้ยแล้ว เขาไม่ใช่ชาวบ้านแน่นอน!`
                );
            } else if (category === "fool") {
                // เจอคนบ้า → เตือนไม่ให้โหวตประหารเด็ดขาด (ตามคำขอผู้ใช้) + เก็บไว้ให้บอทชาวบ้านเลี่ยงโหวต
                room.publiclyProtectedIds = room.publiclyProtectedIds || [];
                if (!room.publiclyProtectedIds.includes(target.id)) room.publiclyProtectedIds.push(target.id);
                performBotChatMessage(
                    room,
                    roomId,
                    bot.id,
                    `🔍 ผมดูบทบาทของ ${target.name} ด้วยความสามารถศาลเตี้ยแล้ว เขาเป็นคนบ้านะ อย่าโหวตประหารเขาเชียว ไม่งั้นเสียท่าแน่!`
                );
            }
            // category === "good" (ชาวบ้านทั่วไป) — ศาลเตี้ยยังไม่พูดถึงกรณีนี้ตามพฤติกรรมเดิม
        });
    });
}

// เฟส 5/6: ผู้หยั่งรู้/ผู้มีลางบอกข้อมูลแก่ชาวบ้านในแชท ถ้าคืนก่อนส่องเจอผลที่ชัดเจน — ไม่รวมหมาป่าหยั่งรู้
// เพราะเป็นทีมหมาป่าเอง พิจารณาแค่ครั้งเดียวต่อเป้าที่เพิ่งส่อง (ไม่ถามซ้ำทุกวันเรื่องเป้าเดิม) ใช้
// scoutAnnouncedTargetIds เก็บว่า "พิจารณาไปแล้ว" (ไม่ว่าจะได้พูดจริงหรือทอยไม่ติดก็ตาม กันถามซ้ำเป้าเดิม
// ไปเรื่อยๆ ทุกวัน)
// เฟส 6 (ตามคำขอผู้ใช้): เจอคนร้าย → ประกาศเตือนได้ตามเดิม / เจอคนดี → ประกาศ "ตัดความสงสัย" ได้เพิ่มด้วย
// แต่ต้อง "ไม่บอกบทตรงๆ" — บอกแค่ผลลาง (ดี/ร้าย) เท่านั้น ห้ามพูดชื่ออาชีพจริงเด็ดขาดไม่ว่ากรณีใด
// เพื่อไม่ให้ข้อมูลรั่วไหลว่าใครถืออาชีพสำคัญ (เช่น หมอ/ผู้มีลาง) ให้หมาป่าเลือกฆ่าตรงเป้าได้
function runScoutAnnouncePhase(room, roomId, deps) {
    const { performBotChatMessage, WOLF_ROLES } = deps;
    const bots = room.players.filter(
        (p) => p.isBot && p.alive && (p.role === "ผู้หยั่งรู้" || p.role === "ผู้มีลาง")
    );
    bots.forEach((bot) => {
        scheduleBotAction(room, roomId, bot, deps, () => {
            if (room.isNight) return; // ประกาศได้เฉพาะกลางวันเท่านั้น
            if (bot.role !== "ผู้หยั่งรู้" && bot.role !== "ผู้มีลาง") return;
            const targetId = bot.lastScoutTargetId;
            if (!targetId) return; // ยังไม่เคยส่องใครเลย

            bot.scoutAnnouncedTargetIds = bot.scoutAnnouncedTargetIds || [];
            if (bot.scoutAnnouncedTargetIds.includes(targetId)) return; // พิจารณาเป้านี้ไปแล้ว ไม่ถามซ้ำ
            bot.scoutAnnouncedTargetIds.push(targetId); // พิจารณาแล้วนับจากนี้ ไม่ว่าผลด้านล่างจะเป็นอย่างไร

            const target = room.players.find((p) => p.id === targetId);
            if (!target || !target.alive) return; // เป้าตายไปแล้ว/หาไม่เจอ ไม่มีประโยชน์จะพูดถึงอีก

            // ผู้หยั่งรู้เห็นบทบาทจริง → แยกได้ครบ 3 หมวด (bad/fool/good) ด้วย classifyRevealedRole
            // ผู้มีลางเห็นแค่ผลลาง (ดี/ร้าย/ไม่ทราบ) → แยกฆาตกรต่อเนื่อง/คนบ้าออกจาก "ไม่ทราบ" อื่นๆ ไม่ได้ จึงข้าม
            // ผลลาง "ไม่ทราบ" ไปเหมือนเดิม (ดูคอมเมนต์ FOOL_ROLE ด้านบน)
            let category;
            if (bot.role === "ผู้หยั่งรู้") {
                const revealedRole = target.trueSeerRevealedRoleBy && target.trueSeerRevealedRoleBy[bot.id];
                if (!revealedRole) return;
                category = classifyRevealedRole(revealedRole, WOLF_ROLES);
            } else {
                const aura = target.auraRevealedTo && target.auraRevealedTo[bot.id];
                if (aura !== "ดี" && aura !== "ร้าย") return; // "ไม่ทราบ" ไม่มีอะไรให้พูด (แยกฆาตกรต่อเนื่อง/คนบ้าไม่ได้)
                category = aura === "ร้าย" ? "bad" : "good";
            }

            if (Math.random() >= SEER_REVEAL_CHANCE) return; // ทอยไม่ติด รอบนี้เลือกไม่บอก

            if (category === "bad") {
                room.publiclySuspectedIds = room.publiclySuspectedIds || [];
                if (!room.publiclySuspectedIds.includes(target.id)) room.publiclySuspectedIds.push(target.id);
                performBotChatMessage(
                    room,
                    roomId,
                    bot.id,
                    `🔮 ฉันรู้สึกว่า ${target.name} ไม่ใช่ชาวบ้านนะ ทุกคนระวังตัวไว้!`
                );
            } else if (category === "fool") {
                // เจอคนบ้า (ตามคำขอผู้ใช้) — บอกตรงๆ ว่า "บ้า" เพื่อเตือนไม่ให้โหวตประหารเด็ดขาด ต่างจาก
                // กรณี "เจอคนดี" ด้านล่างที่ห้ามบอกชื่ออาชีพจริง เพราะคนบ้าไม่ใช่อาชีพที่หมาป่าอยากได้ข้อมูลไปฆ่า
                room.publiclyProtectedIds = room.publiclyProtectedIds || [];
                if (!room.publiclyProtectedIds.includes(target.id)) room.publiclyProtectedIds.push(target.id);
                performBotChatMessage(
                    room,
                    roomId,
                    bot.id,
                    `🔮 ฉันรู้สึกว่า ${target.name} เป็นคนบ้านะ อย่าโหวตประหารเขาเชียว ไม่คุ้มแน่ๆ!`
                );
            } else {
                // เจอคนดี — บอกแค่ "เป็นคนดี" เพื่อตัดออกจากความสงสัย ห้ามบอกชื่ออาชีพจริงเด็ดขาด
                performBotChatMessage(
                    room,
                    roomId,
                    bot.id,
                    `🔮 ฉันรู้สึกว่า ${target.name} เป็นคนดีนะ ไม่ต้องสงสัยเขาหรอก`
                );
            }
        });
    });
}

function runBotsFor(room, roomId, phase, deps) {
    if (!room || !room.botAI || !room.botAI.enabled) return;
    if (!deps) return;

    switch (phase) {
        case "wolfKill":
            runWolfKillPhase(room, roomId, deps);
            break;
        case "vote":
            runVotePhase(room, roomId, deps);
            break;
        case "nightSkill":
            // เฟส 3: รวมบทบาทพิเศษที่ใช้สกิล "ตอนกลางคืน" ทั้งหมดไว้ที่ trigger เดียว
            runDoctorPhase(room, roomId, deps);
            runScoutPhase(room, roomId, deps);
            runDetectivePhase(room, roomId, deps);
            runWitchPhase(room, roomId, deps);
            runElderPhase(room, roomId, deps);
            runWolfCubPhase(room, roomId, deps);
            break;
        case "daySkill":
            // เฟส 3: บทบาทพิเศษที่ใช้สกิล "ตอนกลางวัน" เท่านั้น (แยก phase จาก nightSkill เพราะ
            // select_shield/select_curse_target ฝั่ง server.js ปฏิเสธถ้าเรียกตอนกลางคืน)
            runGuardianShieldPhase(room, roomId, deps);
            runWizardCursePhase(room, roomId, deps);
            // เฟส 5: ศาลเตี้ยดูบทคนน่าสงสัย + ผู้หยั่งรู้/ผู้มีลางเผยข้อมูลมีประโยชน์ในแชท (ทั้งคู่เพิ่ง
            // เพิ่มตามคำขอผู้ใช้ — เดิมตั้งใจไม่ทำ AI ให้ศาลเตี้ยเลย ดูคอมเมนต์ที่ SHERIFF_ROLE ด้านบน)
            runSheriffPhase(room, roomId, deps);
            runScoutAnnouncePhase(room, roomId, deps);
            break;
        default:
            // phase ที่ยังไม่รองรับ — ยัง no-op เหมือนเดิม
            return;
    }
}

module.exports = { runBotsFor };
