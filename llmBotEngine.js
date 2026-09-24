// ============================================================
// llmBotEngine.js — บอทที่ตัดสินใจด้วย Claude แทนการสุ่ม (เฟส 5 / "แนวทาง B")
// ============================================================
// ดู bot-autonomous-ai-approach-b-technical.md สำหรับ flow เต็ม ๆ ไฟล์นี้ implement
// ตามเอกสารนั้นคำต่อคำ: buildBotContext + askLLMForAction
//
// สำคัญ: ไฟล์นี้ไม่ import อะไรจาก server.js/botEngine.js เลย (กัน circular require เหมือนที่
// botEngine.js ทำอยู่แล้ว) — รับทุกอย่างที่ต้องใช้ผ่านพารามิเตอร์ตรง ๆ
//
// ทุกฟังก์ชัน export คืนค่า:
//   - targetId (string) ถ้า LLM ตอบมาแล้ว valid
//   - null ถ้า LLM ตอบไม่ได้ / timeout / parse ไม่ผ่าน / target ไม่ถูกกติกา
// ผู้เรียก (botEngine.js) มีหน้าที่ fallback ไปสุ่มเองถ้าได้ null กลับมา — ไฟล์นี้ไม่ fallback ให้เอง
// เพื่อให้ตรรกะ "ทำงานได้ก็ใช้ผล ถ้าพังก็หลบไปใช้ของเดิม" อยู่ที่จุดเดียว (ในตัว caller)

const LLM_TIMEOUT_MS = 7000; // 7 วิ ตามเอกสาร (ช่วง 6-8 วิ)
const LLM_MODEL = "claude-haiku-4-5-20251001"; // Haiku: เรียกถี่ ข้อความสั้น ไม่ต้องคิดหนัก — เช็คชื่อรุ่น/ราคาที่ docs.claude.com ก่อน deploy จริงเสมอ เพราะเปลี่ยนได้เรื่อย ๆ

// ทีมของแต่ละบทบาท — ใช้บอก LLM คร่าว ๆ ว่าตัวเองอยู่ฝั่งไหน (ไม่ใช่กติกาเกมแบบละเอียด)
function getTeamOf(role, wolfRoles) {
    if (wolfRoles && wolfRoles.has(role)) return "หมาป่า";
    const soloRoles = new Set(["คนบ้า", "นักล่าหัว", "ฆาตกรต่อเนื่อง"]);
    if (soloRoles.has(role)) return "โซโล่";
    return "ชาวบ้าน";
}

// หมายเหตุ fog-of-war: ฟังก์ชันนี้คือจุดเสี่ยงที่สุดในทั้งไฟล์ — หลักคือ "whitelist ไม่ใช่ blacklist"
// หยิบเฉพาะ field ที่อนุญาตใส่ context ห้ามส่ง room หรือ player object ทั้งก้อนเข้าไปเด็ดขาด
// (แม้จะดู "สะดวก" กว่า) เพราะพลาดลืมลบ field เดียวบอทก็โกงข้อมูลได้ทันที
function buildBotContext(room, bot, deps) {
    const wolfRoles = deps.WOLF_ROLES;

    const aliveePlayers = room.players
        .filter((p) => p.alive)
        .map((p) => ({ id: p.id, name: p.name })); // ห้ามแนบ role คนอื่นเด็ดขาด

    const deadPlayers = room.players
        .filter((p) => !p.alive)
        .map((p) => ({
            id: p.id,
            name: p.name,
            // เปิดเผยเฉพาะบทที่เกมเปิดให้ "ทุกคน" เห็นจริง ๆ แล้วเท่านั้น (roleRevealPublic)
            role: p.roleRevealPublic ? p.role : null,
        }));

    // แชทกลางวันย้อนหลัง (public เท่านั้น — ไม่ใช่ wolfChatHistory/private chat) ให้พอวิเคราะห์ได้
    const dayChatLog = (room.globalChatHistory || [])
        .slice(-30)
        .map((m) => ({ name: m.name, text: m.text }));

    return {
        myRole: bot.role,
        myTeam: getTeamOf(bot.role, wolfRoles),
        aliveePlayers,
        deadPlayers,
        myKnownInfo: getRoleSpecificKnowledge(room, bot, wolfRoles),
        dayChatLog,
        round: room.isNight ? room.nightCount || 0 : room.dayCount || 0,
        phase: room.isNight ? "night" : "day",
    };
}

// ข้อมูลเฉพาะบทบาทที่บอทตัวนี้ "รู้จริง" ตามกติกาเกม — เฟสนี้ทำแค่ที่จำเป็นสำหรับ wolfKill/vote
// (เพื่อนหมาป่าสำหรับทีมหมาป่า) ยังไม่รวมผลส่อง/ข้อมูลบทบาทพิเศษอื่น ๆ (เก็บไว้ถ้าขยายไป role อื่นทีหลัง)
function getRoleSpecificKnowledge(room, bot, wolfRoles) {
    const info = {};
    if (wolfRoles && wolfRoles.has(bot.role)) {
        info.wolfTeammates = room.players
            .filter((p) => p.alive && p.id !== bot.id && wolfRoles.has(p.role))
            .map((p) => ({ id: p.id, name: p.name }));
    }
    return info;
}

// เรียก Claude API จริง — คืน { target, chat } หรือ null ถ้า fail/timeout/invalid
async function askLLMForAction(context, actionType, validTargets) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null; // ไม่ได้ตั้ง key ไว้ — fallback ไปสุ่มเงียบ ๆ (ไม่ throw ให้เกมพัง)

    const actionLabel =
        actionType === "wolfKill" ? "เลือกเป้าที่จะกัดคืนนี้" : "โหวตคนที่สงสัยว่าเป็นหมาป่า";

    const systemPrompt = `คุณคือผู้เล่นบอทในเกม werewolf (มาเฟีย) ออนไลน์ บทของคุณคือ "${context.myRole}" (ทีม ${context.myTeam})
ตอนนี้คือ${actionLabel} จากรายชื่อผู้เล่นที่ยังมีชีวิตที่ให้มาเท่านั้น
ตอบเป็น JSON เท่านั้น รูปแบบ: {"target": "<playerId ที่เลือก>", "chat": "<ข้อความสั้นๆ ที่จะพูด หรือ null>"}
ห้ามมีข้อความอื่นนอกจาก JSON ห้ามใส่ markdown code fence`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: LLM_MODEL,
                max_tokens: 300,
                system: systemPrompt,
                messages: [{ role: "user", content: JSON.stringify(context) }],
            }),
            signal: controller.signal,
        });

        if (!res.ok) return null;

        const data = await res.json();
        const rawText = data?.content?.[0]?.text;
        if (!rawText) return null;

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            return null; // ตอบไม่เป็น JSON ตามที่สั่ง — ไม่พยายาม "เดา" อะไรเพิ่ม แค่ fallback
        }

        if (!parsed || !validTargets.has(parsed.target)) return null; // เป้าไม่อยู่ในลิสต์ที่อนุญาต

        return parsed;
    } catch {
        return null; // timeout / network error / อื่น ๆ ทั้งหมดเข้าทางนี้
    } finally {
        clearTimeout(timeout);
    }
}

// เลือกเป้ากัดสำหรับบอทหมาป่า — validTargets ต้องเป็น alive players ที่ไม่ใช่ทีมหมาป่า (caller เตรียมมาให้)
async function chooseWolfKillTarget(room, bot, validTargetPlayers, deps) {
    const context = buildBotContext(room, bot, deps);
    const validTargets = new Set(validTargetPlayers.map((p) => p.id));
    const result = await askLLMForAction(context, "wolfKill", validTargets);
    return result ? result.target : null;
}

// เลือกเป้าโหวตสำหรับบอท — validTargets ต้องเป็น alive players ที่ไม่ใช่ตัวเอง (caller เตรียมมาให้)
async function chooseVoteTarget(room, bot, validTargetPlayers, deps) {
    const context = buildBotContext(room, bot, deps);
    const validTargets = new Set(validTargetPlayers.map((p) => p.id));
    const result = await askLLMForAction(context, "vote", validTargets);
    return result ? result.target : null;
}

module.exports = { chooseWolfKillTarget, chooseVoteTarget, buildBotContext, askLLMForAction };
