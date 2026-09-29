'use strict';

const DEFAULT_OWNER = 'tanawutmalirum29-ux';
const DEFAULT_REPO = 'werewolf-bug-reports';
const DEFAULT_LABELS = ['bug-report'];
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_BRANCH = 'main';
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SCREENSHOT_METADATA_CHARS = 12000;
const MAX_ISSUE_BODY_CHARS = 60000;
const MAX_ISSUE_TITLE_CHARS = 140;
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_ISSUE_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/;

function normalizeList(value, fallback = []) {
    const list = String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 10);
    return list.length ? list : fallback.slice();
}

function getGithubBugReportConfig(env = process.env) {
    const owner = String(env.GITHUB_BUG_REPORT_OWNER || DEFAULT_OWNER).trim();
    const repo = String(env.GITHUB_BUG_REPORT_REPO || DEFAULT_REPO).trim();
    const token = String(env.GITHUB_BUG_REPORT_TOKEN || '').trim();
    const labels = normalizeList(env.GITHUB_BUG_REPORT_LABELS, DEFAULT_LABELS);
    const branch = String(env.GITHUB_BUG_REPORT_BRANCH || DEFAULT_BRANCH).trim().replace(/[^A-Za-z0-9_.\/-]/g, '').slice(0, 120) || DEFAULT_BRANCH;
    const timeoutMsRaw = Number(env.GITHUB_BUG_REPORT_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(timeoutMsRaw)
        ? Math.max(3000, Math.min(30000, Math.round(timeoutMsRaw)))
        : DEFAULT_TIMEOUT_MS;
    const repoNameValid = /^[A-Za-z0-9_.-]{1,100}$/.test(owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(repo);
    return {
        owner,
        repo,
        repository: `${owner}/${repo}`,
        token,
        labels,
        branch,
        timeoutMs,
        configured: !!token && repoNameValid,
        configurationError: !repoNameValid ? 'GITHUB_REPOSITORY_INVALID' : (!token ? 'GITHUB_TOKEN_MISSING' : ''),
    };
}

function publicGithubText(value, max = 12000) {
    return String(value ?? '')
        .replace(/((?:^|[?&\s\"'\{\[,;])(?:token|accountToken|testerPass|tp|ts|jr|ac|authorization|cookie|secret|password)\s*[=:]\s*)[^&\s,;)]+/gi, '$1[REDACTED]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, '[REDACTED_CREDENTIAL]')
        .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
        .replace(/\r/g, '')
        .slice(0, max);
}

function sanitizeGithubObject(value, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return value == null ? '' : publicGithubText(value, 1200);
    if (typeof value === 'string') return publicGithubText(value, 1200);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeGithubObject(item, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, raw] of Object.entries(value).slice(0, 80)) {
            if (/token|secret|password|authorization|cookie|accountToken|googleSub|email|ipAddress|remoteAddress|privateKey|accessKey/i.test(String(key))) {
                out[String(key).slice(0, 100)] = '[REDACTED]';
                continue;
            }
            out[String(key).slice(0, 100)] = sanitizeGithubObject(raw, depth + 1);
        }
        return out;
    }
    return publicGithubText(String(value), 1200);
}

function safeJson(value, maxChars = 14000) {
    try {
        const json = JSON.stringify(sanitizeGithubObject(value), null, 2);
        return publicGithubText(json, maxChars).replace(/```/g, '` ` `');
    } catch (_) {
        return publicGithubText(String(value ?? ''), maxChars).replace(/```/g, '` ` `');
    }
}

function issueTitle(event = {}) {
    const kind = publicGithubText(event.kind || event.type || 'error', 40).replace(/[\r\n]+/g, ' ').trim() || 'error';
    const page = publicGithubText(event.page || 'unknown', 32).replace(/[\r\n]+/g, ' ').trim() || 'unknown';
    const reportId = publicGithubText(event.id || 'event', 24).replace(/[^A-Za-z0-9_.:-]/g, '-');
    const incidentKeyHash = publicGithubText(event.incidentKeyHash || '', 40).replace(/[^a-f0-9]/gi, '').toLowerCase();
    const suffix = incidentKeyHash ? `incident:${incidentKeyHash.slice(0, 20)}` : reportId;
    return `[BUG] ${kind} · ${page} · ${suffix}`.slice(0, MAX_ISSUE_TITLE_CHARS);
}

function shortLine(value, max = 700) {
    return publicGithubText(value, max).replace(/[\r\n]+/g, ' ').trim() || '-';
}

function buildGithubBugReportIssue({ event = {}, analysis = {}, relatedEvents = [], serverBreadcrumbs = [], incident = null, serverInfo = {}, gameProfile = null } = {}) {
    const primary = {
        id: event.id || '',
        time: event.time || '',
        source: event.source || '',
        kind: event.kind || '',
        page: event.page || '',
        message: event.message || '',
        file: event.file || '',
        line: event.line || 0,
        column: event.column || 0,
        status: event.status || 0,
        endpoint: event.endpoint || '',
        action: event.action || '',
        operation: event.operation || '',
        operationId: event.operationId || '',
        traceId: event.traceId || '',
        sessionId: event.sessionId || '',
        requestId: event.requestId || '',
        clientRequestId: event.clientRequestId || '',
        durationMs: event.durationMs || 0,
        roomId: event.roomId || '',
        fingerprint: event.fingerprint || '',
        incidentKeyHash: event.incidentKeyHash || '',
        permission: event.permission || null,
        context: event.context || {},
        state: event.state || {},
        data: event.data || {},
        stack: event.stack || '',
        featureKeys: Array.isArray(event.featureKeys) ? event.featureKeys.slice(0, 40) : [],
        featureLabels: Array.isArray(event.featureLabels) ? event.featureLabels.slice(0, 40) : [],
        gameProfileSnapshot: event.gameProfileSnapshot || null,
    };

    const related = (Array.isArray(relatedEvents) ? relatedEvents : []).slice(0, 36).map((item) => ({
        id: item?.id || '', time: item?.time || '', source: item?.source || '', kind: item?.kind || item?.type || '',
        page: item?.page || '', message: item?.message || '', status: item?.status || 0, endpoint: item?.endpoint || '',
        action: item?.action || '', operation: item?.operation || '', operationId: item?.operationId || '',
        traceId: item?.traceId || '', sessionId: item?.sessionId || '', requestId: item?.requestId || '',
        roomId: item?.roomId || '', fingerprint: item?.fingerprint || '', permission: item?.permission || null,
        featureKeys: Array.isArray(item?.featureKeys) ? item.featureKeys.slice(0, 20) : [],
        featureLabels: Array.isArray(item?.featureLabels) ? item.featureLabels.slice(0, 20) : [],
    }));

    const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline.slice(0, 60) : [];
    const chain = Array.isArray(analysis?.causalChain) ? analysis.causalChain.slice(0, 12) : [];
    const downstream = Array.isArray(analysis?.downstreamEffects) ? analysis.downstreamEffects.slice(0, 8) : [];
    const breadcrumbs = Array.isArray(serverBreadcrumbs) ? serverBreadcrumbs.slice(-80) : [];
    const profile = primary.gameProfileSnapshot || gameProfile || null;
    const profileFeatureKeys = Array.isArray(profile?.implementedFeatureKeys) ? profile.implementedFeatureKeys.slice(0, 40) : [];
    const profileFeatureLabels = Array.isArray(profile?.implementedFeatureLabels) ? profile.implementedFeatureLabels.slice(0, 24) : [];
    const profileRolesByTeam = profile?.rolesByTeam && typeof profile.rolesByTeam === 'object' ? profile.rolesByTeam : {};
    const profileRoleLines = Object.entries(profileRolesByTeam).slice(0, 10).map(([team, names]) => `- **${shortLine(team, 60)}:** ${Array.isArray(names) ? names.slice(0, 20).map((x)=>shortLine(x, 80)).join(', ') : '-'}`);
    const primaryFeatures = primary.featureLabels.length ? primary.featureLabels.slice(0, 16).map((x)=>shortLine(x, 100)).join(', ') : (primary.featureKeys.length ? primary.featureKeys.join(', ') : '-');

    const lines = [
        '<!-- WEREWOLF-DIAGNOSTIC-REPORT -->',
        `<!-- WEREWOLF-DIAGNOSTIC-ID: ${shortLine(primary.id, 120)} -->`,
        '',
        '## Summary',
        `- **Report ID:** ${shortLine(primary.id, 140)}`,
        `- **Time:** ${shortLine(primary.time, 80)}`,
        `- **Source / page:** ${shortLine(primary.source, 40)} / ${shortLine(primary.page, 60)}`,
        `- **Kind:** ${shortLine(primary.kind, 80)}`,
        `- **HTTP:** ${Number(primary.status) || 0 || '-'}`,
        `- **Endpoint:** ${shortLine(primary.endpoint, 500)}`,
        `- **Room:** ${shortLine(primary.roomId, 80)}`,
        `- **Running version:** ${shortLine(serverInfo.appVersion || '-', 120)}`,
        `- **Node:** ${shortLine(serverInfo.node || '-', 60)}`,
        '',
        '### Reported error',
        shortLine(primary.message, 2000),
        '',
        '## Game / Feature snapshot',
        `- **Game build at event:** ${shortLine(profile?.appVersion || serverInfo.appVersion || '-', 120)}`,
        `- **Source hash:** ${shortLine(profile?.sourceHash || '-', 40)}`,
        `- **Feature set hash:** ${shortLine(profile?.featureSetHash || '-', 40)}`,
        `- **Role count:** ${Number(profile?.roleCount) || 0}`,
        `- **Primary feature tags:** ${primaryFeatures}`,
        `- **Implemented feature count:** ${profileFeatureKeys.length}`,
        `- **Implemented features:** ${profileFeatureLabels.length ? profileFeatureLabels.join(', ') : (profileFeatureKeys.join(', ') || '-')}`,
        `- **Win conditions:** ${Array.isArray(profile?.winConditions) && profile.winConditions.length ? profile.winConditions.join(', ') : '-'}`,
        ...(profileRoleLines.length ? ['### Roles by team', ...profileRoleLines] : []),
        `- **Replay scenario count:** ${Number(profile?.replay?.scenarioCount) || 0}`,
        `- **Replay taxonomy version:** ${Number(profile?.taxonomy?.version) || 0}`,
        ...(profile?.runtime?.available ? [
            '### Runtime game state (safe)',
            `- **Room type:** ${shortLine(profile.runtime.roomType || '-', 40)}`,
            `- **Phase:** ${shortLine(profile.runtime.phase || '-', 40)}`,
            `- **Players:** ${Number(profile.runtime.playerCount) || 0} · **Alive:** ${Number(profile.runtime.aliveCount) || 0} · **Bots:** ${Number(profile.runtime.botCount) || 0} · **Tester:** ${Number(profile.runtime.testerCount) || 0}`,
            `- **State version:** ${Number(profile.runtime.stateVersion) || 0} · **Day:** ${Number(profile.runtime.day) || 0} · **Night:** ${profile.runtime.isNight ? 'yes' : 'no'}`,
            `- **Reveal dead role:** ${profile.runtime.settings?.revealDeadRole === false ? 'off' : 'on'}`,
            `- **Role counts:** ${safeJson(profile.runtime.roleCounts || {}, 2500)}`,
        ] : []),
        '',
        '## Analysis',
        `- **Cause code:** ${shortLine(analysis.causeCode || 'UNCLASSIFIED', 100)}`,
        `- **Failure stage:** ${shortLine(analysis.failureStage || 'unknown', 120)}`,
        `- **Root cause source:** ${shortLine(analysis.rootCauseSource || 'unknown', 100)}`,
        `- **Confidence:** ${shortLine(analysis.confidence || 'low', 40)}`,
        `- **Root cause:** ${shortLine(analysis.rootCause || 'ยังระบุไม่ได้', 1800)}`,
        `- **Next step:** ${shortLine(analysis.nextStep || 'ตรวจข้อมูลด้านล่าง', 1800)}`,
        '',
        ...(incident?.incidentKeyHash ? [
            `<!-- WEREWOLF-INCIDENT-KEY-HASH: ${shortLine(incident.incidentKeyHash, 40)} -->`,
            ...(incident.githubBugKeyHash ? [`<!-- WEREWOLF-GITHUB-BUG-KEY-HASH: ${shortLine(incident.githubBugKeyHash, 40)} -->`] : []),
            '## Incident consolidation',
            `- **Incident key hash:** ${shortLine(incident.incidentKeyHash, 40)}`,
            ...(incident.githubBugKeyHash ? [`- **GitHub bug key hash:** ${shortLine(incident.githubBugKeyHash, 40)}`] : []),
            `- **Root event:** ${shortLine(incident.rootEventId || primary.id, 140)}`,
            `- **Requested event:** ${shortLine(incident.requestedEventId || primary.id, 140)}`,
            `- **Related failure events:** ${Number(incident.relatedFailureCount) || 0}`,
            `- **Replay run / operation:** ${shortLine(incident.replayRunId || primary.operationId || '-', 160)}`,
            '- เหตุการณ์ที่อยู่ใน incident เดียวกันจะถูกอ้างอิงใน Related events แทนการสร้าง Issue แยกหลายใบ',
            '',
        ] : []),
        '## Runtime identifiers',
        `- **Trace ID:** ${shortLine(primary.traceId, 160)}`,
        `- **Session ID:** ${shortLine(primary.sessionId, 160)}`,
        `- **Operation ID:** ${shortLine(primary.operationId, 160)}`,
        `- **Request ID:** ${shortLine(primary.requestId, 160)}`,
        `- **Client Request ID:** ${shortLine(primary.clientRequestId, 160)}`,
        `- **Action:** ${shortLine(primary.action, 160)}`,
        `- **Operation:** ${shortLine(primary.operation, 160)}`,
        `- **Fingerprint:** ${shortLine(primary.fingerprint, 120)}`,
        '',
        '## Causal chain',
        chain.length ? chain.map((item, index) => `${index + 1}. **${shortLine(item.stage, 120)}** · ${shortLine(item.status, 60)} · ${shortLine(item.evidence, 900)}`).join('\n') : '- ไม่มี causal chain ที่บันทึกไว้',
        '',
        '## Timeline',
        timeline.length ? timeline.map((item) => `- ${shortLine(item.time, 80)} | ${shortLine(item.stage || '-', 100)} | ${shortLine(item.kind || '-', 100)} | ${shortLine(item.code || '-', 100)} | ${shortLine(item.label || '', 500)}`).join('\n') : '- ไม่มี timeline',
        '',
        '## Related events',
        related.length ? related.map((item) => `- ${shortLine(item.time, 80)} | **${shortLine(item.kind, 100)}** | ${shortLine(item.source, 40)} | ${shortLine(item.page, 60)} | ${shortLine(item.message, 700)}${item.traceId ? ` | trace=${shortLine(item.traceId, 120)}` : ''}`).join('\n') : '- ไม่มี related event',
        '',
        '## Downstream effects',
        downstream.length ? downstream.map((item) => `- ${shortLine(item.evidence || item.stage || item.kind || '-', 1000)}`).join('\n') : '- ไม่พบ downstream effect ที่มีหลักฐานชัดเจน',
        '',
        '## Client / server details',
        '```json',
        safeJson({
            primary: primary,
            permission: primary.permission,
            context: primary.context,
            state: primary.state,
            data: primary.data,
            stack: publicGithubText(primary.stack, 8000),
            server: serverInfo,
            gameProfile: profile,
        }, 20000),
        '```',
        '',
        '<details>',
        '<summary>Sanitized related event payload</summary>',
        '',
        '```json',
        safeJson(related, 18000),
        '```',
        '</details>',
        '',
        '<details>',
        '<summary>Server breadcrumbs (sanitized)</summary>',
        '',
        '```json',
        safeJson(breadcrumbs, 15000),
        '```',
        '</details>',
        '',
        '> รายงานนี้สร้างจาก Werewolf Diagnostics อัตโนมัติ ข้อมูลลับที่ระบบตรวจพบจะถูกลบ/ปิดบังก่อนส่ง',
    ];

    return {
        title: issueTitle(primary),
        body: publicGithubText(lines.join('\n'), MAX_ISSUE_BODY_CHARS),
    };
}

function buildGithubBugReportStatus(env = process.env) {
    const config = getGithubBugReportConfig(env);
    return {
        configured: config.configured,
        repository: config.repository,
        labels: config.labels.slice(),
        reason: config.configurationError,
    };
}


function assertScreenshotConfig(config) {
    if (!config?.configured) {
        const error = new Error(config?.configurationError || 'GITHUB_BUG_REPORT_NOT_CONFIGURED');
        error.code = config?.configurationError || 'GITHUB_BUG_REPORT_NOT_CONFIGURED';
        error.publicCode = error.code;
        throw error;
    }
    return config;
}

function githubResponseHeader(response, name, max = 400) {
    try {
        return String(response?.headers?.get?.(name) || '').trim().slice(0, max);
    } catch (_) {
        return '';
    }
}

function classifyGithubContentsWriteFailure({ response, data = null, responseText = '' } = {}) {
    const status = Number(response?.status) || 0;
    const message = publicGithubText(data?.message || responseText || `HTTP_${status}`, 700);
    const acceptedPermissions = githubResponseHeader(response, 'X-Accepted-GitHub-Permissions', 240);
    const rateLimitRemaining = githubResponseHeader(response, 'X-RateLimit-Remaining', 40);
    const rateLimitReset = githubResponseHeader(response, 'X-RateLimit-Reset', 40);
    const rateLimitMessage = /rate limit|secondary rate limit|abuse detection|too many requests/i.test(message);
    const exhausted = /^0$/.test(rateLimitRemaining);

    let publicCode = 'GITHUB_CREATE_FILE_FAILED';
    if (status === 401) publicCode = 'GITHUB_AUTH_FAILED';
    else if (status === 429 || (status === 403 && (rateLimitMessage || exhausted))) publicCode = 'GITHUB_RATE_LIMITED';
    else if (status === 403 && (/resource not accessible by personal access token|permission|not authorized|forbidden|insufficient|write access/i.test(message) || /contents/i.test(acceptedPermissions))) {
        publicCode = 'GITHUB_CONTENTS_PERMISSION_REQUIRED';
    } else if (status === 403) publicCode = 'GITHUB_FORBIDDEN_OR_RATE_LIMITED';
    else if (status === 404) publicCode = 'GITHUB_REPOSITORY_NOT_FOUND';
    else if (status === 409) publicCode = 'GITHUB_CONTENT_CONFLICT';
    else if (status === 422) publicCode = 'GITHUB_VALIDATION_FAILED';

    return { publicCode, githubStatus:status, githubMessage:message, githubAcceptedPermissions:acceptedPermissions, githubRateLimitRemaining:rateLimitRemaining, githubRateLimitReset:rateLimitReset };
}

function sanitizeGithubRepoPath(value, fallback = '') {
    const raw = String(value || '').replace(/\\/g, '/').replace(/[^A-Za-z0-9_.\/-]+/g, '-');
    const cleaned = raw.split('/').filter((part) => part && part !== '.' && part !== '..').slice(0, 12).join('/').replace(/-+/g, '-').slice(0, 420);
    if (!cleaned || cleaned.startsWith('/') || cleaned.includes('..')) return fallback;
    return cleaned;
}

function screenshotGithubPath({ capturedAt, page, width, height, fileName } = {}) {
    const date = new Date(capturedAt || Date.now());
    const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const yyyy = validDate.getUTCFullYear();
    const mm = String(validDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(validDate.getUTCDate()).padStart(2, '0');
    const safePage = sanitizeGithubRepoPath(page, 'page').split('/').pop() || 'page';
    const safeWidth = Math.max(1, Math.min(7680, Math.round(Number(width) || 0)));
    const safeHeight = Math.max(1, Math.min(4320, Math.round(Number(height) || 0)));
    const safeFile = sanitizeGithubRepoPath(fileName, `werewolf-${safePage}-${safeWidth}x${safeHeight}.png`).split('/').pop();
    return `screenshots/${yyyy}/${mm}/${dd}/${safePage}/${safeWidth}x${safeHeight}/${safeFile}`;
}

function buildGithubScreenshotMetadata(metadata = {}) {
    const clean = {
        kind: 'admin-internal-browser-screenshot',
        application: 'Werewolf Online',
        page: publicGithubText(metadata.page || metadata.title || 'unknown', 120),
        path: publicGithubText(metadata.path || '/', 240),
        viewport: {
            width: Math.max(1, Math.min(7680, Math.round(Number(metadata.width) || 0))),
            height: Math.max(1, Math.min(4320, Math.round(Number(metadata.height) || 0))),
            mode: publicGithubText(metadata.mode || 'unknown', 30),
            presetId: publicGithubText(metadata.presetId || '', 80),
            presetLabel: publicGithubText(metadata.presetLabel || '', 120),
            orientation: publicGithubText(metadata.orientation || '', 30),
            zoom: publicGithubText(metadata.zoom || '', 30),
        },
        dpr: Math.max(0.1, Math.min(10, Number(metadata.dpr) || 1)),
        captureMode: metadata.captureMode === 'game' ? 'game' : 'evidence',
        capturedAt: publicGithubText(metadata.capturedAt || new Date().toISOString(), 60),
        browser: publicGithubText(metadata.browser || '', 240),
        userAgent: publicGithubText(metadata.userAgent || '', 600),
        captureEngine: publicGithubText(metadata.captureEngine || 'html2canvas-viewport', 60),
        scroll: {
            x: Math.round((Number(metadata.scrollX) || 0) * 100) / 100,
            y: Math.round((Number(metadata.scrollY) || 0) * 100) / 100,
            activeContainers: Math.max(0, Math.min(1000, Math.round(Number(metadata.activeScrollContainers) || 0))),
            visualViewportScale: Math.max(0.1, Math.min(10, Number(metadata.visualViewportScale) || 1)),
        },
    };
    return JSON.stringify(clean, null, 2);
}

async function createGithubRepositoryFile({ path, content, message, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch, contentType = 'text/plain' } = {}) {
    assertScreenshotConfig(config);
    if (typeof fetchImpl !== 'function') {
        const error = new Error('GITHUB_FETCH_UNAVAILABLE');
        error.code = 'GITHUB_FETCH_UNAVAILABLE';
        error.publicCode = error.code;
        throw error;
    }
    const repoPath = sanitizeGithubRepoPath(path);
    if (!repoPath) {
        const error = new Error('GITHUB_PATH_INVALID');
        error.code = 'GITHUB_PATH_INVALID';
        error.publicCode = error.code;
        throw error;
    }
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    if (!buffer.length) {
        const error = new Error('GITHUB_FILE_EMPTY');
        error.code = 'GITHUB_FILE_EMPTY';
        error.publicCode = error.code;
        throw error;
    }
    if (buffer.length > MAX_SCREENSHOT_BYTES) {
        const error = new Error('GITHUB_SCREENSHOT_TOO_LARGE');
        error.code = 'GITHUB_SCREENSHOT_TOO_LARGE';
        error.publicCode = error.code;
        throw error;
    }
    if (contentType === 'application/json' && buffer.length > MAX_SCREENSHOT_METADATA_CHARS) {
        const error = new Error('GITHUB_SCREENSHOT_METADATA_TOO_LARGE');
        error.code = 'GITHUB_SCREENSHOT_METADATA_TOO_LARGE';
        error.publicCode = error.code;
        throw error;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
    try {
        const response = await fetchImpl(url, {
            method: 'PUT',
            headers: {
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.token}`,
                'X-GitHub-Api-Version': GITHUB_API_VERSION,
                'User-Agent': 'werewolf-online-admin-screenshot-reporter',
            },
            body: JSON.stringify({
                message: String(message || `Admin screenshot: ${repoPath}`).slice(0, 160),
                branch: config.branch || DEFAULT_BRANCH,
                content: buffer.toString('base64'),
            }),
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!response.ok) {
            const failure = classifyGithubContentsWriteFailure({ response, data, responseText:text });
            const error = new Error(failure.githubMessage);
            error.code = `GITHUB_HTTP_${response.status}`;
            error.githubStatus = failure.githubStatus;
            error.publicCode = failure.publicCode;
            error.githubMessage = failure.githubMessage;
            error.githubAcceptedPermissions = failure.githubAcceptedPermissions;
            error.githubRateLimitRemaining = failure.githubRateLimitRemaining;
            error.githubRateLimitReset = failure.githubRateLimitReset;
            throw error;
        }
        const htmlUrl = String(data?.content?.html_url || '');
        const downloadUrl = String(data?.content?.download_url || '');
        const sha = String(data?.content?.sha || '');
        if (!htmlUrl || !sha) {
            const error = new Error('GITHUB_RESPONSE_INVALID');
            error.code = 'GITHUB_RESPONSE_INVALID';
            error.publicCode = error.code;
            throw error;
        }
        return { ok:true, path:repoPath, htmlUrl, downloadUrl, sha, branch:config.branch || DEFAULT_BRANCH, repository:config.repository };
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeout = new Error('GITHUB_REQUEST_TIMEOUT');
            timeout.code = 'GITHUB_REQUEST_TIMEOUT';
            timeout.publicCode = timeout.code;
            throw timeout;
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function createGithubScreenshotFiles({ imageBuffer, imagePath, metadata, metadataPath, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    assertScreenshotConfig(config);
    const metaText = buildGithubScreenshotMetadata(metadata);
    if (!metadataPath) metadataPath = `${String(imagePath || '').replace(/\.png$/i, '')}.json`;
    const metaResult = await createGithubRepositoryFile({
        path: metadataPath,
        content: metaText,
        message: `Admin screenshot metadata: ${imagePath}`,
        config,
        fetchImpl,
        contentType: 'application/json',
    });
    const imageResult = await createGithubRepositoryFile({
        path: imagePath,
        content: imageBuffer,
        message: `Admin screenshot: ${imagePath}`,
        config,
        fetchImpl,
        contentType: 'image/png',
    });
    return { ok:true, image:imageResult, metadata:metaResult, metadataText:metaText };
}


async function githubGraphqlRequest({ query, variables = {}, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    assertScreenshotConfig(config);
    if (typeof fetchImpl !== 'function') {
        const error = new Error('GITHUB_FETCH_UNAVAILABLE');
        error.code = 'GITHUB_FETCH_UNAVAILABLE';
        error.publicCode = error.code;
        throw error;
    }
    if (!String(query || '').trim()) {
        const error = new Error('GITHUB_GRAPHQL_QUERY_REQUIRED');
        error.code = 'GITHUB_GRAPHQL_QUERY_REQUIRED';
        error.publicCode = error.code;
        throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetchImpl('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.token}`,
                'X-GitHub-Api-Version': GITHUB_API_VERSION,
                'User-Agent': 'werewolf-online-admin-github-maintenance',
            },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!response.ok) {
            const error = new Error(publicGithubText(data?.message || text || `HTTP_${response.status}`, 500));
            error.code = `GITHUB_HTTP_${response.status}`;
            error.githubStatus = response.status;
            error.publicCode = response.status === 401
                ? 'GITHUB_AUTH_FAILED'
                : (response.status === 403 || response.status === 429)
                    ? 'GITHUB_FORBIDDEN_OR_RATE_LIMITED'
                    : response.status === 404
                        ? 'GITHUB_REPOSITORY_NOT_FOUND'
                        : 'GITHUB_GRAPHQL_FAILED';
            throw error;
        }
        if (Array.isArray(data?.errors) && data.errors.length) {
            const first = data.errors[0] || {};
            const message = publicGithubText(first.message || 'GitHub GraphQL returned an error', 500);
            const error = new Error(message);
            error.code = 'GITHUB_GRAPHQL_ERROR';
            error.publicCode = /resource not accessible|forbidden|permission|not authorized/i.test(message)
                ? 'GITHUB_FORBIDDEN_OR_RATE_LIMITED'
                : 'GITHUB_GRAPHQL_FAILED';
            throw error;
        }
        if (!data || !Object.prototype.hasOwnProperty.call(data, 'data')) {
            const error = new Error('GITHUB_RESPONSE_INVALID');
            error.code = 'GITHUB_RESPONSE_INVALID';
            error.publicCode = error.code;
            throw error;
        }
        return data.data;
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeout = new Error('GITHUB_REQUEST_TIMEOUT');
            timeout.code = 'GITHUB_REQUEST_TIMEOUT';
            timeout.publicCode = timeout.code;
            throw timeout;
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function searchGithubIssuesByText({ queryText, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch, limit = 30 } = {}) {
    assertScreenshotConfig(config);
    const text = publicGithubText(queryText, 300).replace(/[\"\\]/g, (match) => `\\${match}`).trim();
    if (!text) return [];
    const first = Math.max(1, Math.min(50, Number(limit) || 30));
    const query = `query($q:String!,$first:Int!){search(query:$q,type:ISSUE,first:$first){nodes{... on Issue{id number title url state body}}}}`;
    const data = await githubGraphqlRequest({
        query,
        variables: {
            q: `repo:${config.owner}/${config.repo} \"${text}\"`,
            first,
        },
        config,
        fetchImpl,
    });
    const nodes = Array.isArray(data?.search?.nodes) ? data.search.nodes : [];
    return nodes.filter((item) => item?.id && Number(item?.number) > 0).map((item) => ({
        id: String(item.id),
        number: Number(item.number),
        title: publicGithubText(item.title || '', 180),
        url: String(item.url || ''),
        state: String(item.state || '').toUpperCase(),
        body: publicGithubText(item.body || '', 70000),
    }));
}

async function listAllGithubIssues({ config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    const query = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    issues(first:100,after:$cursor,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){
      nodes{id number title url state}
      pageInfo{hasNextPage endCursor}
      totalCount
    }
  }
}`;
    const issues = [];
    let cursor = null;
    let totalCount = 0;
    do {
        const data = await githubGraphqlRequest({
            query,
            variables: { owner: config.owner, name: config.repo, cursor },
            config,
            fetchImpl,
        });
        const connection = data?.repository?.issues;
        if (!connection) {
            const error = new Error('GITHUB_REPOSITORY_NOT_FOUND');
            error.code = 'GITHUB_REPOSITORY_NOT_FOUND';
            error.publicCode = error.code;
            throw error;
        }
        totalCount = Number(connection.totalCount) || totalCount;
        for (const item of Array.isArray(connection.nodes) ? connection.nodes : []) {
            if (item?.id && Number(item?.number) > 0) issues.push({
                id: String(item.id),
                number: Number(item.number),
                title: publicGithubText(item.title || '', 180),
                url: String(item.url || ''),
                state: String(item.state || '').toUpperCase(),
            });
        }
        const pageInfo = connection.pageInfo || {};
        cursor = pageInfo.hasNextPage ? String(pageInfo.endCursor || '') : null;
        if (pageInfo.hasNextPage && !cursor) {
            const error = new Error('GITHUB_PAGINATION_INVALID');
            error.code = 'GITHUB_PAGINATION_INVALID';
            error.publicCode = error.code;
            throw error;
        }
    } while (cursor);
    return { issues, totalCount };
}

async function deleteGithubIssueById({ issueId, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    const id = String(issueId || '').trim();
    if (!id) {
        const error = new Error('GITHUB_ISSUE_ID_REQUIRED');
        error.code = 'GITHUB_ISSUE_ID_REQUIRED';
        error.publicCode = error.code;
        throw error;
    }
    const mutation = `mutation($issueId:ID!){deleteIssue(input:{issueId:$issueId}){repository{url}}}`;
    await githubGraphqlRequest({
        query: mutation,
        variables: { issueId: id },
        config,
        fetchImpl,
    });
    return { ok:true, issueId:id };
}

async function clearAllGithubIssues({ config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    assertScreenshotConfig(config);
    const listed = await listAllGithubIssues({ config, fetchImpl });
    const deleted = [];
    const failed = [];
    // Fetch the complete list first so deletion cannot move a pagination cursor.
    for (const issue of listed.issues) {
        try {
            await deleteGithubIssueById({ issueId:issue.id, config, fetchImpl });
            deleted.push(issue);
        } catch (error) {
            failed.push({
                number:issue.number,
                title:issue.title,
                url:issue.url,
                code:String(error?.publicCode || error?.code || 'GITHUB_ISSUE_DELETE_FAILED'),
            });
        }
    }
    return {
        ok: failed.length === 0,
        repository: config.repository,
        found: listed.issues.length,
        totalCount: listed.totalCount,
        deleted: deleted.length,
        failed,
        deletedIssueNumbers: deleted.map((x) => x.number),
    };
}


async function listAllGithubScreenshotFiles({ config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    assertScreenshotConfig(config);
    if (typeof fetchImpl !== 'function') throw Object.assign(new Error('GITHUB_FETCH_UNAVAILABLE'), { code:'GITHUB_FETCH_UNAVAILABLE', publicCode:'GITHUB_FETCH_UNAVAILABLE' });
    const refUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/ref/heads/${encodeURIComponent(config.branch || DEFAULT_BRANCH)}`;
    const refResponse = await fetchImpl(refUrl, {
        method:'GET', headers:{ Accept:'application/vnd.github+json', Authorization:`Bearer ${config.token}`, 'X-GitHub-Api-Version':GITHUB_API_VERSION, 'User-Agent':'werewolf-online-admin-screenshot-maintenance' },
    });
    const refText = await refResponse.text();
    let refData=null; try { refData=refText?JSON.parse(refText):null; } catch (_) {}
    if (!refResponse.ok) {
        const error=new Error(publicGithubText(refData?.message||refText||`HTTP_${refResponse.status}`,500));
        error.code=`GITHUB_HTTP_${refResponse.status}`; error.githubStatus=refResponse.status;
        error.publicCode=refResponse.status===401?'GITHUB_AUTH_FAILED':(refResponse.status===403||refResponse.status===429)?'GITHUB_FORBIDDEN_OR_RATE_LIMITED':refResponse.status===404?'GITHUB_REPOSITORY_NOT_FOUND':'GITHUB_SCREENSHOT_LIST_FAILED';
        throw error;
    }
    const sha=String(refData?.object?.sha||'');
    if(!sha) throw Object.assign(new Error('GITHUB_RESPONSE_INVALID'),{code:'GITHUB_RESPONSE_INVALID',publicCode:'GITHUB_RESPONSE_INVALID'});
    const treeUrl=`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`;
    const treeResponse=await fetchImpl(treeUrl,{method:'GET',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${config.token}`,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'werewolf-online-admin-screenshot-maintenance'}});
    const treeText=await treeResponse.text(); let treeData=null; try { treeData=treeText?JSON.parse(treeText):null; } catch (_) {}
    if(!treeResponse.ok){
        const error=new Error(publicGithubText(treeData?.message||treeText||`HTTP_${treeResponse.status}`,500));
        error.code=`GITHUB_HTTP_${treeResponse.status}`; error.githubStatus=treeResponse.status;
        error.publicCode=treeResponse.status===401?'GITHUB_AUTH_FAILED':(treeResponse.status===403||treeResponse.status===429)?'GITHUB_FORBIDDEN_OR_RATE_LIMITED':treeResponse.status===404?'GITHUB_REPOSITORY_NOT_FOUND':'GITHUB_SCREENSHOT_LIST_FAILED';
        throw error;
    }
    if(treeData?.truncated) throw Object.assign(new Error('GITHUB_SCREENSHOT_TREE_TRUNCATED'),{code:'GITHUB_SCREENSHOT_TREE_TRUNCATED',publicCode:'GITHUB_SCREENSHOT_TREE_TRUNCATED'});
    const files=(Array.isArray(treeData?.tree)?treeData.tree:[]).filter(item=>item?.type==='blob' && /^screenshots\/(?:.+\/)?[^/]+\.(?:png|json)$/i.test(String(item.path||''))).map(item=>({path:String(item.path),sha:String(item.sha)}));
    return {files,branch:config.branch||DEFAULT_BRANCH,treeSha:sha};
}

async function deleteGithubRepositoryFile({ path, sha, message, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    assertScreenshotConfig(config);
    const repoPath=sanitizeGithubRepoPath(path);
    if(!repoPath || !sha) throw Object.assign(new Error('GITHUB_SCREENSHOT_FILE_REFERENCE_REQUIRED'),{code:'GITHUB_SCREENSHOT_FILE_REFERENCE_REQUIRED',publicCode:'GITHUB_SCREENSHOT_FILE_REFERENCE_REQUIRED'});
    const url=`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
    const response=await fetchImpl(url,{method:'DELETE',headers:{Accept:'application/vnd.github+json','Content-Type':'application/json',Authorization:`Bearer ${config.token}`,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'werewolf-online-admin-screenshot-maintenance'},body:JSON.stringify({message:String(message||`Remove Admin screenshot: ${repoPath}`).slice(0,160),sha,branch:config.branch||DEFAULT_BRANCH})});
    const text=await response.text(); let data=null; try{data=text?JSON.parse(text):null;}catch(_){}
    if(!response.ok){
        const error=new Error(publicGithubText(data?.message||text||`HTTP_${response.status}`,500)); error.code=`GITHUB_HTTP_${response.status}`; error.githubStatus=response.status;
        error.publicCode=response.status===401?'GITHUB_AUTH_FAILED':(response.status===403||response.status===429)?'GITHUB_FORBIDDEN_OR_RATE_LIMITED':response.status===404?'GITHUB_REPOSITORY_NOT_FOUND':response.status===409?'GITHUB_CONTENT_CONFLICT':'GITHUB_SCREENSHOT_DELETE_FAILED'; throw error;
    }
    return {ok:true,path:repoPath,commitUrl:String(data?.commit?.html_url||'')};
}

async function clearAllGithubScreenshotFiles({ config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    const listed=await listAllGithubScreenshotFiles({config,fetchImpl});
    const deleted=[]; const failed=[];
    for(const file of listed.files){
        try { await deleteGithubRepositoryFile({path:file.path,sha:file.sha,message:`Remove Admin screenshot: ${file.path}`,config,fetchImpl}); deleted.push(file); }
        catch(error){ failed.push({path:file.path,code:String(error?.publicCode||error?.code||'GITHUB_SCREENSHOT_DELETE_FAILED')}); }
    }
    return {ok:failed.length===0,repository:config.repository,found:listed.files.length,deleted:deleted.length,remaining:listed.files.length-deleted.length,failed,deletedPaths:deleted.map(x=>x.path)};
}

async function createGithubBugReportIssue({ issue, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    if (!config.configured) {
        const error = new Error(config.configurationError || 'GITHUB_BUG_REPORT_NOT_CONFIGURED');
        error.code = config.configurationError || 'GITHUB_BUG_REPORT_NOT_CONFIGURED';
        error.publicCode = error.code;
        throw error;
    }
    if (typeof fetchImpl !== 'function') {
        const error = new Error('GITHUB_FETCH_UNAVAILABLE');
        error.code = 'GITHUB_FETCH_UNAVAILABLE';
        error.publicCode = error.code;
        throw error;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`;
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.token}`,
                'X-GitHub-Api-Version': GITHUB_API_VERSION,
                'User-Agent': 'werewolf-online-diagnostic-reporter',
            },
            body: JSON.stringify({
                title: issue.title,
                body: issue.body,
                labels: config.labels,
            }),
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!response.ok) {
            const error = new Error(publicGithubText(data?.message || text || `HTTP_${response.status}`, 500));
            error.code = `GITHUB_HTTP_${response.status}`;
            error.githubStatus = response.status;
            error.publicCode = response.status === 401
                ? 'GITHUB_AUTH_FAILED'
                : (response.status === 403 || response.status === 429)
                    ? 'GITHUB_FORBIDDEN_OR_RATE_LIMITED'
                    : response.status === 404
                        ? 'GITHUB_REPOSITORY_NOT_FOUND'
                        : response.status === 422
                            ? 'GITHUB_VALIDATION_FAILED'
                            : 'GITHUB_CREATE_ISSUE_FAILED';
            throw error;
        }
        const issueUrl = String(data?.html_url || '');
        const number = Number(data?.number) || 0;
        if (!GITHUB_ISSUE_URL_RE.test(issueUrl) || !number) {
            const error = new Error('GITHUB_RESPONSE_INVALID');
            error.code = 'GITHUB_RESPONSE_INVALID';
            error.publicCode = error.code;
            throw error;
        }
        return { ok:true, number, issueUrl, title:String(data?.title || issue.title), repository:config.repository };
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeout = new Error('GITHUB_REQUEST_TIMEOUT');
            timeout.code = 'GITHUB_REQUEST_TIMEOUT';
            timeout.publicCode = timeout.code;
            throw timeout;
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    getGithubBugReportConfig,
    buildGithubBugReportStatus,
    buildGithubBugReportIssue,
    createGithubBugReportIssue,
    githubGraphqlRequest,
    listAllGithubIssues,
    searchGithubIssuesByText,
    deleteGithubIssueById,
    clearAllGithubIssues,
    listAllGithubScreenshotFiles,
    deleteGithubRepositoryFile,
    clearAllGithubScreenshotFiles,
    createGithubRepositoryFile,
    classifyGithubContentsWriteFailure,
    githubResponseHeader,
    createGithubScreenshotFiles,
    screenshotGithubPath,
    buildGithubScreenshotMetadata,
    MAX_SCREENSHOT_BYTES,
    publicGithubText,
    GITHUB_API_VERSION,
    MAX_ISSUE_BODY_CHARS,
};
