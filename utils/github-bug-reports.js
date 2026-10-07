"use strict";

const DEFAULT_OWNER = "tanawutmalirum29-ux";
const DEFAULT_REPO = "werewolf-online";
const DEFAULT_LABELS = ["bug-report"];
const DEFAULT_TIMEOUT_MS = 12000;
const GITHUB_API_VERSION = "2026-03-10";
const MAX_ISSUE_BODY_CHARS = 60000;
const GITHUB_ISSUE_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/;

function normalizeList(value, fallback = []) {
    const list = String(value ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10);
    return list.length ? list : fallback.slice();
}
function getGithubBugReportConfig(env = process.env) {
    const owner = String(env.GITHUB_BUG_REPORT_OWNER || DEFAULT_OWNER).trim();
    const repo = String(env.GITHUB_BUG_REPORT_REPO || DEFAULT_REPO).trim();
    const token = String(env.GITHUB_BUG_REPORT_TOKEN || env.GITHUB_TOKEN || "").trim();
    const labels = normalizeList(env.GITHUB_BUG_REPORT_LABELS, DEFAULT_LABELS);
    let configurationError = "";
    if (!owner || !repo) configurationError = "GITHUB_REPOSITORY_MISSING";
    else if (!token) configurationError = "GITHUB_TOKEN_MISSING";
    return { configured: !configurationError, configurationError, owner, repo, token, labels,
        repository: `${owner}/${repo}` };
}
function publicGithubText(value, max = 12000) {
    return String(value ?? "").replace(/[\u0000-\u001F]/g, " ").slice(0, max);
}
function buildGithubBugReportIssue({ report = {} } = {}) {
    const page = publicGithubText(report.page || "unknown", 100);
    const titleMessage = publicGithubText(report.message || "Bug report", 100).replace(/\s+/g, " ").trim() || "Bug report";
    const title = `[Bug] ${titleMessage}`.slice(0, 140);
    const lines = [
        "## Werewolf Online Bug Report",
        `- Source: ${publicGithubText(report.source || "client", 40)}`,
        `- Page: ${page}`,
        `- Version: ${publicGithubText(report.version || "unknown", 100)}`,
        `- Room: ${publicGithubText(report.roomId || "-", 40)}`,
        `- Player: ${publicGithubText(report.playerName || "-", 120)}`,
        `- Created: ${publicGithubText(report.createdAt || new Date().toISOString(), 80)}`,
        "",
        "### Message",
        publicGithubText(report.message || "-", 6000),
        "",
        "### Stack",
        "```text",
        publicGithubText(report.stack || "-", 12000),
        "```",
        "",
        "### Browser",
        publicGithubText(report.userAgent || "-", 600),
    ];
    return { title, body: lines.join("\n").slice(0, MAX_ISSUE_BODY_CHARS) };
}
function buildGithubBugReportStatus(env = process.env) {
    const cfg = getGithubBugReportConfig(env);
    return { configured: cfg.configured, configurationError: cfg.configurationError, repository: cfg.repository, labels: cfg.labels };
}
async function createGithubBugReportIssue({ issue, config = getGithubBugReportConfig(), fetchImpl = globalThis.fetch } = {}) {
    if (!config.configured) { const e = new Error(config.configurationError || "GITHUB_NOT_CONFIGURED"); e.code = config.configurationError || "GITHUB_NOT_CONFIGURED"; throw e; }
    if (typeof fetchImpl !== "function") { const e = new Error("FETCH_UNAVAILABLE"); e.code = "FETCH_UNAVAILABLE"; throw e; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json", "Content-Type": "application/json",
                Authorization: `Bearer ${config.token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION,
                "User-Agent": "werewolf-online-bug-reporter",
            },
            body: JSON.stringify({ title: issue.title, body: issue.body, labels: config.labels }),
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!response.ok) {
            const e = new Error(publicGithubText(data?.message || text || `HTTP_${response.status}`, 500));
            e.code = `GITHUB_HTTP_${response.status}`;
            e.publicCode = response.status === 401 ? "GITHUB_AUTH_FAILED" : response.status === 403 ? "GITHUB_FORBIDDEN_OR_RATE_LIMITED" : response.status === 404 ? "GITHUB_REPOSITORY_NOT_FOUND" : response.status === 422 ? "GITHUB_VALIDATION_FAILED" : "GITHUB_CREATE_ISSUE_FAILED";
            throw e;
        }
        const issueUrl = String(data?.html_url || "");
        const number = Number(data?.number) || 0;
        if (!number || !GITHUB_ISSUE_URL_RE.test(issueUrl)) { const e = new Error("GITHUB_RESPONSE_INVALID"); e.code = e.publicCode = "GITHUB_RESPONSE_INVALID"; throw e; }
        return { ok:true, number, issueUrl, title:String(data?.title || issue.title), repository:config.repository };
    } catch (error) {
        if (error?.name === "AbortError") { const e = new Error("GITHUB_REQUEST_TIMEOUT"); e.code = e.publicCode = "GITHUB_REQUEST_TIMEOUT"; throw e; }
        throw error;
    } finally { clearTimeout(timer); }
}

module.exports = { getGithubBugReportConfig, buildGithubBugReportStatus, buildGithubBugReportIssue, createGithubBugReportIssue, publicGithubText, GITHUB_API_VERSION, MAX_ISSUE_BODY_CHARS };
