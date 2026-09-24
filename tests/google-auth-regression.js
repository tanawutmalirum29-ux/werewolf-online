const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "public/js/index.main.js"), "utf8");

// Static regression checks for the production routing/security fix.
assert(serverSource.includes('app.get("/auth/google/start"'), "missing browser GET start endpoint");
assert(serverSource.includes('res.redirect(302, result.url)'), "GET start must redirect directly to Google");
assert(indexSource.includes('window.location.assign(`/auth/google/start?${params.toString()}`)'), "login client must use GET navigation start");
assert(indexSource.includes('method:"POST"'), "link flow must keep POST");
assert(serverSource.includes("function requestJsonHttps("), "missing Google HTTPS helper");
assert(serverSource.includes("req.setTimeout"), "Google upstream call must be bounded");
assert(serverSource.includes("GOOGLE_UPSTREAM_TIMEOUT"), "Google upstream timeout code missing");
assert(serverSource.includes('String(claims.azp || "") === clientId'), "multi-audience azp validation missing");

const loginBranchStart = indexSource.indexOf('if (mode === "login") {');
const loginBranchEnd = indexSource.indexOf('// Link still uses POST', loginBranchStart);
assert(loginBranchStart >= 0 && loginBranchEnd > loginBranchStart, "could not isolate login branch");
const loginBranch = indexSource.slice(loginBranchStart, loginBranchEnd);
assert(!loginBranch.includes("accountToken"), "login navigation must never carry accountToken");
assert(loginBranch.includes("accountId") && loginBranch.includes('reauth'), "reauth login must carry only account identity context");

const normalizeStart = serverSource.indexOf("function normalizeReturnTo(");
const normalizeEnd = serverSource.indexOf("\nfunction hashAccountToken", normalizeStart);
assert(normalizeStart >= 0 && normalizeEnd > normalizeStart, "could not isolate normalizeReturnTo");
const normalizeReturnTo = new Function(`${serverSource.slice(normalizeStart, normalizeEnd)}\nreturn normalizeReturnTo;`)();
assert.strictEqual(normalizeReturnTo("/profile?tab=account"), "/profile?tab=account");
assert.strictEqual(normalizeReturnTo("https://evil.example/phish"), "/");
assert.strictEqual(normalizeReturnTo("//evil.example/phish"), "/");
assert.strictEqual(normalizeReturnTo("\\evil.example\\phish"), "/");

const authUrlStart = serverSource.indexOf("function googleAuthorizeUrl(");
const authUrlEnd = serverSource.indexOf("\nasync function linkGoogleIdentityToAccount", authUrlStart);
assert(authUrlStart >= 0 && authUrlEnd > authUrlStart, "could not isolate googleAuthorizeUrl");
const googleAuthorizeUrl = new Function("URL", `const GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"; const GOOGLE_SCOPES = "openid profile email"; const GOOGLE_CALLBACK_URL = "https://game.example/auth/google/callback"; ${serverSource.slice(authUrlStart, authUrlEnd)}\nreturn googleAuthorizeUrl;`)(URL);
const authUrl = new URL(googleAuthorizeUrl("signed-state", "pkce-challenge", "nonce-value"));
assert.strictEqual(authUrl.origin, "https://accounts.google.com");
assert.strictEqual(authUrl.searchParams.get("code_challenge_method"), "S256");
assert.strictEqual(authUrl.searchParams.get("nonce"), "nonce-value");
assert.strictEqual(authUrl.searchParams.get("client_id"), "test-client.apps.googleusercontent.com");
assert(!authUrl.search.includes("accountToken"), "Google authorization URL must not contain account token");

// Pull the real standalone helpers into isolated functions so we can test redirect safety and
// upstream timeout/error handling without booting the game server or touching DynamoDB.
const start = serverSource.indexOf("function requestJsonHttps(");
const end = serverSource.indexOf("\nfunction normalizeGoogleIssuer", start);
assert(start >= 0 && end > start, "could not isolate requestJsonHttps helper");
const helperSource = serverSource.slice(start, end);
const requestJsonHttps = new Function("https", "URL", "URLSearchParams", "Buffer", `${helperSource}\nreturn requestJsonHttps;`)(https, URL, URLSearchParams, Buffer);

function makeCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-google-test-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  return { dir, key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

(async () => {
  const originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const tls = makeCertificate();
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [{ kid: "test-kid", kty: "RSA", n: "abc", e: "AQAB" }] }));
      return;
    }
    if (req.url === "/token") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "test only" }));
      return;
    }
    if (req.url === "/slow") {
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `https://127.0.0.1:${port}`;

  try {
    const keys = await requestJsonHttps(`${base}/jwks`, { timeoutMs: 1000 });
    assert(Array.isArray(keys.keys) && keys.keys[0].kid === "test-kid", "HTTPS JSON helper should parse JSON response");

    await assert.rejects(
      () => requestJsonHttps(`${base}/token`, {
        method: "POST",
        form: { grant_type: "authorization_code", client_id: "test", code: "invalid", redirect_uri: "https://example.invalid/callback" },
        timeoutMs: 1000,
      }),
      (e) => e && e.code === "GOOGLE_UPSTREAM_HTTP_ERROR" && e.status === 400 && e.upstreamCode === "invalid_grant"
    );

    await assert.rejects(
      () => requestJsonHttps(`${base}/slow`, { timeoutMs: 1000 }),
      (e) => e && e.code === "GOOGLE_UPSTREAM_TIMEOUT"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tls.dir, { recursive: true, force: true });
    if (originalTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsSetting;
  }

  console.log("PASS: Google auth regression checks + bounded HTTPS helper");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
