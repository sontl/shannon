# SSRF Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** One high-confidence server-side request forgery (SSRF) vulnerability was identified in `GET /api/fetch-url`. User-supplied URL input flows directly into an axios HTTP client without any validation, protocol restrictions, or host allowlisting. This enables attackers to force the backend server to make requests to internal services, cloud metadata endpoints, and private network resources.
- **Purpose of this Document:** This report provides the strategic context on the application's outbound request mechanisms, the confirmed vulnerability, and the data flow analysis necessary for the exploitation phase.

---

## 2. SSRF Vulnerability Analysis

### Finding SSRF-VULN-01: Unrestricted Arbitrary URL Fetch

**Endpoint:** `GET /api/fetch-url?url=`

**File:** `/repos/VulApp/backend/routes/debug.js`
**Lines 21-32:**

```javascript
router.get('/fetch-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    console.log(`Fetching URL (SSRF): ${url}`);
    const response = await axios.get(url);
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch URL', message: err.message });
  }
});
```

#### Data Flow Trace (Backward Taint Analysis)

| Step | Location | Data | Analysis |
|------|----------|------|----------|
| **SINK** | `routes/debug.js:27` | `axios.get(url)` | Outbound HTTP request — NO sanitization encountered |
| Input | `req.query.url` | Raw user-supplied query parameter | No URL parsing, validation, or sanitization before sink |

**Path:** `req.query.url` → `axios.get(url)` at line 27. No validation occurs at any point along this path.

#### Validation Analysis

| Check | Status | Details |
|-------|--------|---------|
| **Protocol Allowlist** | FAILED | No protocol validation. Any scheme permitted: `http://`, `https://`, `file://`, `gopher://`, `ftp://`, `dict://` |
| **Host/IP Allowlist** | FAILED | No hostname or IP validation. `127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12` all accessible |
| **URL Parsing Validation** | FAILED | No URL parsing or structural validation |
| **Scheme Restriction** | FAILED | Dangerous schemes like `file://`, `gopher://` not blocked |
| **Internal Network Block** | FAILED | No protection against localhost, cloud metadata, or private IP ranges |
| **Response Size Limit** | FAILED | No limits on response size returned to user |

#### Authentication and Access Control

The `authenticate` middleware (`middleware/auth.js`) is registered globally at `server.js:16`. However, it explicitly permits anonymous access:

```javascript
// middleware/auth.js:10-12
if (!token) {
  return next(); // Proceed as anonymous
}
```

This means `/api/fetch-url` is accessible **without authentication**. Furthermore, even if auth were enforced, the JWT "none" algorithm bypass (`middleware/auth.js:22-28`) allows trivial token forgery:

```javascript
const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
if (header.alg === 'none' || header.alg === 'None') {
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
  req.user = payload;
  return next();
}
```

A valid unsigned JWT can be forged with: `Header.eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0=.Payload.eyJpZCI6MSwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwicGxhbiI6ImZyZWUifQ=`

#### CORS Exposure

The backend has `cors({ origin: '*' })` at `server.js:11`, enabling cross-origin requests from any domain including the public `techviflaw.vn.gd` frontend. This makes the SSRF endpoint reachable from the internet via browser AJAX.

#### Impact

This is a **non-blind SSRF** (response is returned to the attacker), enabling:
1. **Cloud Metadata Retrieval:** AWS `169.254.169.254`, GCP `metadata.google.internal`
2. **Internal Service Access:** Access to internal-only APIs, admin panels, databases
3. **Port Scanning:** Probe internal network services
4. **Protocol Abuse:** `file://` to read local files, `gopher://` for protocol smuggling
5. **Data Exfiltration:** Sensitive data from internal services returned to attacker

**Confidence: HIGH**

---

## 3. Vectors Analyzed and Determined Not SSRF

The following sinks were analyzed and **excluded from the exploitation queue** because they do not involve outbound server-side HTTP requests made with user-controlled input:

### Open Redirect: `GET /api/utils/redirect?url=`
**File:** `routes/utils.js:70-77`
```javascript
router.get('/redirect', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter is required' });
  console.log(`[VULN] Open redirect to: ${url}`);
  res.redirect(url);
});
```
**Verdict: NOT SSRF** — `res.redirect(url)` returns a 3xx response instructing the client/browser to navigate elsewhere. The server makes no outbound HTTP request. This is an **open redirect**, not SSRF. The browser performs the redirect, not the server.

### Header Injection: `GET /api/utils/lang?lang=`
**File:** `routes/utils.js:85-92`
```javascript
router.get('/lang', (req, res) => {
  const { lang } = req.query;
  if (!lang) return res.status(400).json({ error: 'lang parameter is required' });
  res.setHeader('X-Language', lang);
  res.json({ message: `Language set to: ${lang}` });
});
```
**Verdict: NOT SSRF** — This is HTTP response header injection (CRLF injection). The `lang` parameter is reflected into a response header without sanitization. No outbound HTTP request is made. This is a **response splitting** vector, not SSRF.

### File Download: `GET /api/files/download?name=`
**File:** `routes/files.js:52-65`
```javascript
router.get('/download', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Filename is required' });
  const filePath = path.join(__dirname, '../uploads', name);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found', path: filePath });
  }
});
```
**Verdict: NOT SSRF** — This is a **path traversal** vulnerability (LFI) using `path.join` without traversal protection. No outbound HTTP request is made. All operations are local filesystem access.

### Command Injection: `GET /api/utils/ping?host=`
**File:** `routes/utils.js:11-27`
```javascript
router.get('/ping', (req, res) => {
  const { host } = req.query;
  const cmd = `ping -c 2 ${host}`;
  exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
```
**Verdict: NOT SSRF** — This is **command injection** (RCE), not SSRF. User input is passed to `exec()` to spawn a system shell command. No outbound HTTP request is made.

### File Upload: `POST /api/files/upload`
**File:** `routes/files.js:22-36`
**Verdict: NOT SSRF** — Multipart file upload with no type validation. File is stored on local filesystem. No outbound HTTP request.

### All Other Routes (projects.js, payment.js, auth.js)
**Verdict: NOT SSRF** — These routes perform database queries and local operations only. No HTTP client usage with user-controlled input.

---

## 4. Secure by Design: Validated Components

| Component/Flow | Endpoint/File | Defense Mechanism | Verdict |
|----------------|---------------|------------------|---------|
| Static File Serving | `server.js:74` — `express.static(path.join(__dirname, 'uploads'))` | Serves only local filesystem files from fixed directory; no URL fetching | SAFE (from SSRF) |
| Database Operations | `routes/projects.js`, `routes/payment.js`, `routes/auth.js` | No outbound HTTP client usage; SQLite operations only | SAFE (from SSRF) |
| All non-fetch-url utility routes | `routes/utils.js` | No axios/fetch/axios usage; only exec(), header setting, object merging | SAFE (from SSRF) |

---

## 5. Strategic Intelligence for Exploitation

**HTTP Client Library:** axios 1.13.6 (used in `routes/debug.js` for SSRF sink)

**Request Architecture:**
- The Express.js backend on `localhost:5001` is reachable from the public internet via browser AJAX due to CORS misconfiguration (`origin: '*'`)
- The `authenticate` middleware permits anonymous access (proceeds when no token is present)
- The JWT "none" algorithm bypass makes token forgery trivial if auth is needed
- No rate limiting, no request throttling on the SSRF endpoint

**Internal Services Accessible via SSRF:**
1. Cloud provider metadata: `http://169.254.169.254/latest/meta-data/` (AWS EC2), `http://metadata.google.internal/` (GCP)
2. Localhost services: `http://127.0.0.1:22/`, `http://127.0.0.1:3306/`, `http://127.0.0.1:5001/`
3. Internal network ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
4. Local filesystem via `file:///etc/passwd`

**Attacker Prerequisites (Externally):**
1. Forge an unsigned JWT with `alg: "none"` and a valid payload, OR register a new account to obtain a real token
2. Send AJAX request from browser to `http://localhost:5001/api/fetch-url?url=<target>`

---

## 6. Conclusion

**SSRF ANALYSIS COMPLETE**

One confirmed SSRF vulnerability was identified:

- **SSRF-VULN-01** (`GET /api/fetch-url?url=`): Complete absence of URL validation allows arbitrary outbound requests to internal services, cloud metadata endpoints, and private networks. The endpoint is accessible without authentication and exploitable from the public internet via the CORS-misconfigured frontend. Response data is returned to the attacker (non-blind SSRF).

All other sinks were analyzed and classified as non-SSRF (open redirect, header injection, path traversal, command injection). The exploitation queue has been updated with the single confirmed SSRF vulnerability for the exploitation phase.

---

*SSRF Analysis by SSRF Analysis Specialist. Target: https://techviflaw.vn.gd. Framework: React 19 + Vite frontend / Express.js 5.2.1 backend.*
