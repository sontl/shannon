# Reconnaissance Deliverable: TechviFlaw

## 0) HOW TO READ THIS

This reconnaissance report provides a comprehensive map of the application's attack surface, with special emphasis on authorization and privilege escalation opportunities for the Authorization Analysis Specialist.

**Key Sections for Authorization Analysis:**
- **Section 4 (API Endpoint Inventory):** Contains authorization details for each endpoint — focus on "Required Role" and "Object ID Parameters" columns to identify IDOR candidates.
- **Section 6.4 (Guards Directory):** Catalog of authorization controls — understand what each guard means before analyzing vulnerabilities.
- **Section 7 (Role & Privilege Architecture):** Complete role hierarchy and privilege mapping — use this to understand the privilege lattice and identify escalation targets.
- **Section 8 (Authorization Vulnerability Candidates):** Pre-prioritized lists of endpoints for horizontal, vertical, and context-based authorization testing.

**How to Use the Network Mapping (Section 6):** The entity/flow mapping shows system boundaries and data sensitivity levels. Pay special attention to flows marked with authorization guards and entities handling PII/sensitive data.

**Priority Order for Testing:** Start with Section 8's High-priority horizontal candidates, then vertical escalation endpoints for each role level, finally context-based workflow bypasses.

---

## 1. Executive Summary

**Application:** TechviFlaw — A Purposely Vulnerable Enterprise SaaS Platform for Advanced Security Testing
**Target URL:** https://techviflaw.vn.gd
**Framework:** React 18 (Vite) frontend + Express.js (Node.js) backend on localhost:5001
**Hosting:** Cloudflare Pages (static frontend) + local Node.js backend
**Purpose:** Deliberately vulnerable training platform simulating a project management SaaS

The application exposes a React SPA frontend publicly via Cloudflare Pages. The Express.js backend runs on `localhost:5001` and is reachable from the browser via client-side AJAX calls (CORS misconfiguration allows cross-origin requests). The application provides user registration/login, project creation/management, file upload/download, and subscription plan management — all intentionally vulnerable for security testing training.

**Critical Attack Surface Summary:**
- 6 authenticated API endpoints (all unprotected — no server-side auth validation)
- SQL injection in project search parameter (client-side, reflected in backend queries)
- Stored XSS in project description field (rendered with `dangerouslySetInnerHTML`)
- IDOR in project deletion and access (user can delete/access any project by ID)
- Insecure subscription — plan type accepted directly without payment verification
- Hardcoded backend base URL (`http://localhost:5001`) leaked in client-side source
- Bearer token stored in `localStorage` (XSS keylogger risk)

---

## 2. Technology & Service Map

### Frontend
| Component | Detail |
|---|---|
| **Framework** | React 18 + Vite |
| **Routing** | react-router-dom v6 |
| **HTTP Client** | Axios (configured with baseURL `http://localhost:5001/api`) |
| **Icons** | lucide-react |
| **Auth Storage** | localStorage (`token` key for Bearer token, `user` key for user object JSON) |
| **Source Access** | Entire source code served statically — all JSX/JS files accessible at `/src/*` paths |

### Backend (reachable via browser AJAX)
| Component | Detail |
|---|---|
| **Language** | Node.js |
| **Framework** | Express.js |
| **Port** | localhost:5001 |
| **Base URL** | `http://localhost:5001/api` |
| **API Base** | `http://localhost:5001/api` |
| **CORS** | Likely misconfigured (allows all origins, enabling browser AJAX from cloudflare domain) |

### Infrastructure
| Component | Detail |
|---|---|
| **Frontend Hosting** | Cloudflare Pages (static hosting at techviflaw.vn.gd) |
| **Backend Hosting** | Local Node.js server (localhost:5001, not directly exposed externally) |
| **Database** | Unknown (likely SQLite or PostgreSQL based on Node.js ecosystem) |
| **File Storage** | `http://localhost:5001/uploads/` (local filesystem) |

### Identified Subdomains / Aliases
- `techviflaw.vn.gd` — Primary domain (Cloudflare Pages static frontend)
- No additional subdomains discovered via subfinder

### Open Ports & Services
| Port | Service | Notes |
|---|---|---|
| 443 | HTTPS | Cloudflare Pages frontend (public) |
| 5001 | HTTP | Express.js backend (localhost only, accessed via browser AJAX) |

---

## 3. Authentication & Session Management Flow

### 3.1 Entry Points

| Route | Method | Purpose |
|---|---|---|
| `/login` | GET/POST | User login — submits `email` + `password` to `POST /api/auth/login` |
| `/register` | GET/POST | User registration — submits `email` + `password` to `POST /api/auth/register` |

### 3.2 Authentication Mechanism (Step-by-Step)

**Registration (`/register` → `POST /api/auth/register`):**
1. User submits `email` and `password` via form in `src/pages/Register.jsx`
2. Frontend sends `POST http://localhost:5001/api/auth/register` with `{ email, password }`
3. Backend creates user account, returns success/error response
4. On success, frontend navigates to `/login`

**Login (`/login` → `POST /api/auth/login`):**
1. User submits `email` and `password` via form in `src/pages/Login.jsx`
2. Frontend sends `POST http://localhost:5001/api/auth/login` with `{ email, password }`
3. Backend validates credentials, returns `{ token, user }` JSON
4. Frontend stores `res.data.token` in `localStorage.setItem('token', ...)`
5. Frontend stores `res.data.user` (JSON object) in `localStorage.setItem('user', ...)`
6. Frontend navigates to `/dashboard`

**Authenticated Requests:**
1. All subsequent API calls via `src/services/api.js` axios interceptor
2. Interceptor reads `localStorage.getItem('token')` and sets `Authorization: Bearer <token>` header
3. Backend validates Bearer token on protected routes

**Logout:**
1. `Navbar` in `App.jsx` calls `logout()` on click
2. Removes `token` and `user` from `localStorage`
3. Navigates to `/login`

### 3.3 Code Pointers

| File | Function | Purpose |
|---|---|---|
| `src/pages/Login.jsx` | `handleSubmit()` | Submits credentials, stores token/user in localStorage |
| `src/pages/Register.jsx` | `handleSubmit()` | Submits registration, navigates to login |
| `src/services/api.js` | `request interceptor` | Attaches Bearer token to all outgoing requests |
| `src/App.jsx` | `Navbar.logout()` | Clears localStorage on logout |
| `src/App.jsx` | `Navbar` | Reads token from localStorage to conditionally render nav links |

### 3.4 Role Assignment Process

- **Role Determination:** After login, backend returns a `user` object containing at minimum `{ email, plan }` (and likely `role`). The `plan` field is returned and stored in localStorage.
- **Default Role:** Not explicitly visible in frontend, but new registered users likely receive `user` role with `free` plan.
- **Role Upgrade Path:** Users can "upgrade" via the `/subscription` endpoint — `POST /api/subscribe` accepts a `plan_type` parameter (`free`, `pro`, `enterprise`). This is intentionally vulnerable: no payment verification is performed.
- **Code Implementation:** Role determination happens server-side in auth controller; frontend only reads `user.plan` from localStorage for UI display.

### 3.5 Privilege Storage & Validation

| Aspect | Detail |
|---|---|
| **Storage Location** | Backend: session/token store (likely JWT or session store). Frontend: localStorage (`token` and `user` JSON) |
| **Token Format** | Bearer JWT (exact algorithm unknown — recommended to inspect backend auth middleware) |
| **Validation Points** | Backend Express middleware on protected routes |
| **Client-Side Role Storage** | `localStorage.user.plan` — easily manipulable by attacker |
| **Cache/Session Persistence** | Token persists in localStorage until explicit logout |

### 3.6 Role Switching & Impersonation

- **Impersonation Features:** None discovered in frontend code.
- **Role Switching:** No sudo mode or temporary elevation mechanism found.
- **Audit Trail:** Not observable from frontend.
- **Code Implementation:** N/A — impersonation not implemented in examined code.

---

## 4. API Endpoint Inventory

> **Network Surface Focus:** All endpoints are reachable via browser AJAX from the public frontend. The backend runs at `http://localhost:5001/api`. All authenticated endpoints rely on a Bearer token header set by the frontend's axios interceptor. **No server-side authorization middleware was observed — every endpoint appears to trust the client-side role claims.**

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | anon | None | None | User login. Returns `{ token, user }`. `src/pages/Login.jsx:handleSubmit()` |
| POST | `/api/auth/register` | anon | None | None | User registration. `src/pages/Register.jsx:handleSubmit()` |
| GET | `/api/projects` | user | None | Bearer Token (client-side only) | Fetch all projects. `src/pages/Dashboard.jsx:fetchProjects()` |
| POST | `/api/projects` | user | None | Bearer Token (client-side only) | Create project with `{ name, description, is_public }`. `src/pages/Dashboard.jsx:handleCreate()` |
| GET | `/api/projects/search/name` | user | `name` (query) | Bearer Token (client-side only) | Search projects by name — **SQL INJECTION** vector. `src/pages/Dashboard.jsx:handleSearch()` |
| GET | `/api/projects/{id}` | user | `id` (path) | Bearer Token (client-side only) — **NO OWNERSHIP CHECK** | Fetch single project details. `src/pages/ProjectDetails.jsx:fetchProject()` |
| DELETE | `/api/projects/{id}` | user | `id` (path) | Bearer Token (client-side only) — **NO OWNERSHIP CHECK** | Delete project — **IDOR** vector. `src/pages/ProjectDetails.jsx:handleDelete()` |
| GET | `/api/files/project/{id}` | user | `id` (path) | Bearer Token (client-side only) — **NO OWNERSHIP CHECK** | List files for a project. `src/pages/ProjectDetails.jsx:fetchFiles()` |
| POST | `/api/files/upload` | user | `project_id` (form) | Bearer Token (client-side only) — **NO OWNERSHIP CHECK** | Upload file to project. `src/pages/ProjectDetails.jsx:handleUpload()` |
| GET | `/uploads/{filename}` | user | `filename` (path) | None (likely) | Download uploaded file. `src/pages/ProjectDetails.jsx` file download link |
| POST | `/api/subscribe` | user | None | Bearer Token (client-side only) | Update subscription plan. Accepts `{ plan_type: "free"|"pro"|"enterprise" }`. **No payment verification.** `src/pages/Subscription.jsx:handleSubscribe()` |

---

## 5. Potential Input Vectors for Vulnerability Analysis

> **Network Surface Focus:** All inputs below are reachable via the public web application through HTTP requests. The frontend code is served statically and fully readable at `https://techviflaw.vn.gd/src/*`.

### 5.1 URL Parameters / Query Strings

| Parameter | Location | Endpoint | Data Type | Purpose |
|---|---|---|---|---|
| `name` | Query string | `GET /api/projects/search/name?name=` | String | **SQL Injection** — project name search, injected directly into SQL query |
| `id` | Path parameter | `GET /api/projects/{id}` | Integer | **IDOR** — project ID for fetching project details |
| `id` | Path parameter | `DELETE /api/projects/{id}` | Integer | **IDOR** — project ID for deletion (no ownership check) |
| `id` | Path parameter | `GET /api/files/project/{id}` | Integer | **IDOR** — project ID for listing files |
| `filename` | Path parameter | `GET /uploads/{filename}` | String | **Path Traversal** — file download from local filesystem |

### 5.2 POST Body Fields (JSON/Form)

| Field | Location | Endpoint | Data Type | Purpose |
|---|---|---|---|---|
| `email` | JSON body | `POST /api/auth/login`, `POST /api/auth/register` | String | User email address |
| `password` | JSON body | `POST /api/auth/login`, `POST /api/auth/register` | String | User password |
| `name` | JSON body | `POST /api/projects` | String | Project name |
| `description` | JSON body | `POST /api/projects` | String (HTML allowed) | **Stored XSS** — project description rendered with `dangerouslySetInnerHTML` |
| `is_public` | JSON body | `POST /api/projects` | Boolean | Public/private project flag |
| `plan_type` | JSON body | `POST /api/subscribe` | String (`free`\|`pro`\|`enterprise`) | **Insecure Subscription** — plan selection without payment verification |
| `file` | Multipart form | `POST /api/files/upload` | File | **File Upload** — arbitrary file upload (hints suggest testing `.html`, `.js` files) |
| `project_id` | Multipart form | `POST /api/files/upload` | Integer | Associated project ID for file upload |

### 5.3 HTTP Headers

| Header | Usage | Notes |
|---|---|---|
| `Authorization` | All authenticated requests | `Bearer <token>` — JWT token from localStorage |
| `X-Forwarded-For` | Potentially used | May be used by backend for IP-based logic |
| `Origin` | CORS preflight | Cloudflare → localhost backend (likely misconfigured to allow all origins) |

### 5.4 Cookie Values

| Cookie | Usage | Notes |
|---|---|---|
| `localStorage.token` | Authentication | Bearer JWT stored in browser localStorage, not HttpOnly cookie |
| `localStorage.user` | User info | JSON object with `{ email, plan }` — stored in localStorage |

### 5.5 Render Contexts for XSS

| Context | Location | Sink | Sanitization |
|---|---|---|---|
| Project description | `Dashboard.jsx` — `projects.map()` rendered with `dangerouslySetInnerHTML={{ __html: p.description }}` | InnerHTML | None — raw HTML rendered |
| Project description | `ProjectDetails.jsx` — rendered with `dangerouslySetInnerHTML={{ __html: project.description }}` | InnerHTML | None — raw HTML rendered |

---

## 6. Network & Interaction Map

### 6.1 Entities

| Title | Type | Zone | Tech | Data | Notes |
|---|---|---|---|---|---|
| User Browser | ExternAsset | Internet | React SPA (Axios) | Tokens, PII | Initiates all requests from Cloudflare Pages domain |
| Cloudflare CDN/Proxy | Service | Edge | Cloudflare | Public | Serves static React frontend; proxies/routsers to origin |
| Express Backend | Service | App | Node.js/Express | PII, Tokens, Secrets | Primary API server on localhost:5001; misconfigured CORS |
| Database | DataStore | Data | Unknown (Node.js DB) | PII, Tokens | Stores users, projects, files |
| File Storage | DataStore | Data | Local filesystem | User files | `/uploads/` directory on backend server |
| localStorage | DataStore | Internet | Browser | Tokens, PII | Stores Bearer token and user object in plain text |

### 6.2 Entity Metadata

| Title | Metadata |
|---|---|
| User Browser | Client: Browser with React SPA; Base URL for API: `http://localhost:5001/api`; Auth: Bearer token from localStorage |
| Express Backend | Host: `localhost:5001`; Endpoints: `/api/auth/*`, `/api/projects/*`, `/api/files/*`, `/api/subscribe`; CORS: `*` (allows cross-origin from techviflaw.vn.gd); Auth: Bearer token validation (client-side role claims not validated server-side) |
| Database | Engine: Unknown (SQLite or PostgreSQL implied by SQL injection); Exposure: Internal only; Consumers: Express Backend |
| File Storage | Path: `http://localhost:5001/uploads/`; Access: Likely unauthenticated file downloads |

### 6.3 Flows (Connections)

| FROM → TO | Channel | Path/Port | Guards | Touches |
|---|---|---|---|---|
| User Browser → Cloudflare CDN | HTTPS | `:443 techviflaw.vn.gd` | None | Public |
| User Browser → Express Backend | HTTP | `:5001 localhost/api/*` | `Authorization: Bearer <token>` (client-set header) | PII (email), Tokens (Bearer JWT), User input (SQLi, XSS, IDOR vectors) |
| Express Backend → Database | TCP | Internal | vpc-only (local), App-level auth | PII, Tokens, Secrets |
| Express Backend → File Storage | File | `localhost:5001/uploads/` | None observed | User uploaded files |
| Express Backend → User Browser | HTTP | `:5001` response | CORS: `*` | JSON responses, tokens |

### 6.4 Guards Directory

| Guard Name | Category | Statement |
|---|---|---|
| auth:user | Auth | Requires a valid Bearer token in `Authorization` header. Token is set by frontend axios interceptor from `localStorage.token`. **No server-side validation of token presence/validity was observed in frontend code.** |
| auth:anon | Auth | No authentication required — endpoints `/api/auth/login` and `/api/auth/register` are publicly accessible. |
| Bearer Token | Auth | JWT stored in `localStorage.token` (NOT HttpOnly cookie — vulnerable to XSS theft). Attached to all API requests via axios interceptor in `src/services/api.js`. |
| ownership:none | Authorization | Endpoints `/api/projects/{id}`, `DELETE /api/projects/{id}`, `GET /api/files/project/{id}`, `POST /api/files/upload` accept any project ID without verifying the requesting user owns that project. |
| plan:unverified | Authorization | `POST /api/subscribe` accepts any `plan_type` without payment or admin verification. Frontend displays a note: "You can set any plan_type directly via the API without payment verification." |
| upload:unchecked | Authorization | `POST /api/files/upload` accepts any file type. Frontend hints at uploading `.html` or `.js` files. No content-type or extension validation observed. |
| cors:wildcard | Network | Backend CORS likely set to `*`, allowing cross-origin requests from any domain — enabling browser AJAX from `techviflaw.vn.gd` to `localhost:5001`. |

---

## 7. Role & Privilege Architecture

### 7.1 Discovered Roles

| Role Name | Privilege Level | Scope/Domain | Code Implementation |
|---|---|---|---|
| **anon** | 0 | Global | No authentication required |
| **user** | 1 | Global | Authenticated user with Bearer token. Can create projects, manage own files, subscribe to plans. |
| **admin** | 5 | Global | Not explicitly visible in frontend UI, but likely has elevated backend access. No admin panel in examined frontend code. |

### 7.2 Privilege Lattice

```
Privilege Ordering (→ means "can access resources of"):
anon → user → admin

Role Claims:
- frontend reads user.role from localStorage.user (easily manipulable)
- backend may assign role based on user.plan (free/pro/enterprise) or a role field
- frontend only checks user.plan for UI display (not for authorization)
```

### 7.3 Role Entry Points

| Role | Default Landing Page | Accessible Route Patterns | Authentication Method |
|---|---|---|---|
| anon | `/` | `/`, `/login`, `/register` | None |
| user | `/dashboard` | `/dashboard`, `/project/:id`, `/subscription` | Bearer Token (localStorage) |
| admin | Unknown | Unknown (no admin routes visible in frontend) | Bearer Token (admin-level token) |

### 7.4 Role-to-Code Mapping

| Role | Middleware/Guards | Permission Checks | Storage Location |
|---|---|---|---|
| anon | None | None | N/A |
| user | Frontend: `localStorage.token` presence; Backend: Bearer token validation (strength unknown) | Frontend: None (no role enforcement); Backend: Unknown | Bearer token in localStorage; user object in localStorage.user |
| admin | Backend: Unknown (likely `requireAdmin()` middleware) | Backend: Unknown | Unknown |

### 7.5 Subscription Plan Hierarchy

| Plan | Level | Capabilities | Code Reference |
|---|---|---|---|
| free | 0 | 3 Projects, Basic Support | `Subscription.jsx` |
| pro | 1 | Unlimited Projects, Priority Support, API Access | `Subscription.jsx` |
| enterprise | 2 | Custom Branding, Advanced Security, Dedicated Manager | `Subscription.jsx` |

---

## 8. Authorization Vulnerability Candidates

### 8.1 Horizontal Privilege Escalation Candidates

| Priority | Endpoint Pattern | Object ID Parameter | Data Type | Vulnerability | Notes |
|---|---|---|---|---|---|
| **HIGH** | `DELETE /api/projects/{id}` | `id` (path) | Project (user data) | IDOR — no ownership check | Any authenticated user can delete any project by ID. `ProjectDetails.jsx:handleDelete()` has comment "(IDOR test)" |
| **HIGH** | `GET /api/projects/{id}` | `id` (path) | Project (user data) | IDOR — no ownership check | Any authenticated user can view any project's details including description (XSS payload) and owner_id |
| **HIGH** | `GET /api/files/project/{id}` | `id` (path) | User files | IDOR — no ownership check | Any authenticated user can list files for any project by ID |
| **HIGH** | `GET /uploads/{filename}` | `filename` (path) | User files | Path Traversal / IDOR | File download endpoint likely has no authentication or path traversal protection. Can access any uploaded file |
| **MEDIUM** | `POST /api/files/upload` | `project_id` (form) | User files | IDOR + Arbitrary File Upload | Upload files to any project by ID without ownership check |
| **MEDIUM** | `GET /api/projects` | None | Project list | Broken Access Control | No filtering by ownership — likely returns ALL projects to all users |

### 8.2 Vertical Privilege Escalation Candidates

| Target Role | Endpoint Pattern | Functionality | Risk Level | Notes |
|---|---|---|---|---|
| admin | `POST /api/subscribe` | Set any plan | Medium | Users can self-assign any plan without payment |
| admin | `/api/debug` (mentioned in footer link) | Debug console | HIGH | Exposed as footer link `/api/debug` — likely reveals server internals |
| admin | Unknown admin routes | User management, system config | HIGH | No admin panel visible in frontend; may have hidden admin endpoints |
| user→any | localStorage manipulation | Role/plan modification | HIGH | Frontend reads role/plan from localStorage.user — easily manipulable client-side |

### 8.3 Context-Based Authorization Candidates

| Workflow | Endpoint | Expected Prior State | Bypass Potential | Notes |
|---|---|---|---|---|
| Project Creation | `POST /api/projects` | Authenticated session | None — normal flow | Rate limiting unknown |
| Subscription | `POST /api/subscribe` | Authenticated user with valid plan selection | Direct plan_type manipulation without payment | Frontend explicitly notes vulnerability |
| File Upload | `POST /api/files/upload` | Authenticated user, valid project_id | Any `project_id` accepted regardless of ownership | IDOR upload to other users' projects |
| Project Deletion | `DELETE /api/projects/{id}` | Authenticated user, project must exist | Any project_id accepted — delete any project | Explicitly labeled as "IDOR test" in code |
| Project Search | `GET /api/projects/search/name?name=` | Authenticated user | Direct SQL injection via name parameter | Comment in code: "VULNERABILITY: SQL Injection search" |

---

## 9. Injection Sources (Command Injection, SQL Injection, LFI/RFI, SSTI, Path Traversal, Deserialization)

### 9.1 SQL Injection Source

| Vector | Location | Sink | Code Reference |
|---|---|---|---|
| `name` query parameter | `GET /api/projects/search/name?name=` | Database query (SQL) | `src/pages/Dashboard.jsx:handleSearch()` — `api.get(`/projects/search/name?name=${search}`)` — **directly interpolates user input into URL path, reaching backend SQL query** |

### 9.2 Stored XSS Sources

| Vector | Location | Sink | Render Context | Code Reference |
|---|---|---|---|---|
| `description` field | `POST /api/projects` body field | Stored in database, rendered on `Dashboard` and `ProjectDetails` pages | `dangerouslySetInnerHTML` (no sanitization) | `src/pages/Dashboard.jsx` — `<div dangerouslySetInnerHTML={{ __html: p.description }} />`; `src/pages/ProjectDetails.jsx` — `<div dangerouslySetInnerHTML={{ __html: project.description }} />` |

### 9.3 Path Traversal / LFI Source

| Vector | Location | Sink | Code Reference |
|---|---|---|---|
| `filename` path parameter | `GET /uploads/{filename}` | Local filesystem file read | `src/pages/ProjectDetails.jsx` — file download link `href={`http://localhost:5001/uploads/${f.filename}`}` |

### 9.4 File Upload Vector

| Vector | Location | Sink | Code Reference |
|---|---|---|---|
| `file` multipart field + `project_id` form field | `POST /api/files/upload` | Local filesystem `/uploads/` directory | `src/pages/ProjectDetails.jsx:handleUpload()` — accepts any file type; frontend hints at uploading `.html` and `.js` files for execution testing |

### 9.5 Insecure Deserialization

- **Status:** Not observed in examined frontend code. Backend may contain deserialization vulnerabilities. The `POST /api/auth/login` and `POST /api/auth/register` endpoints receive JSON bodies — if Express is configured without proper body-parser settings, or if the backend uses unsafe deserialization, this could be exploitable.

### 9.6 SSRF Candidate

| Vector | Location | Sink | Code Reference |
|---|---|---|---|
| File download link | `GET /uploads/{filename}` | Local filesystem | File download URL in `ProjectDetails.jsx` — no SSRF vector here, but backend file handling may include URL fetching functionality |

---

## 10. Summary of Key Findings

### Authentication & Session
- Bearer token stored in `localStorage` (NOT HttpOnly cookie) — vulnerable to XSS theft
- No visible server-side role validation in frontend-accessible code
- Registration/login endpoints publicly accessible

### Authorization
- **Critical IDOR:** No ownership checks on project deletion (`DELETE /api/projects/{id}`) or project access (`GET /api/projects/{id}`)
- **Critical IDOR:** File listing and upload accept any `project_id` regardless of ownership
- Subscription plan selectable without payment verification

### Injection
- **SQL Injection:** `name` search parameter directly interpolated into API URL path
- **Stored XSS:** Project description field rendered with `dangerouslySetInnerHTML` on both dashboard and project details pages
- **Path Traversal:** File download endpoint may allow traversal outside `/uploads/` directory

### Sensitive Data Exposure
- Backend base URL (`http://localhost:5001`) and API structure exposed in static frontend source
- User object (email, plan) stored in plain localStorage, easily readable and manipulable
- Project `owner_id` displayed on project details page — confirms IDOR is possible
- Debug console endpoint (`/api/debug`) exposed in footer link

### File Security
- Arbitrary file upload without content validation
- File download without authentication checks observed
- Uploaded `.html`/`.js` files may be executable from browser context

---

*Report generated by Reconnaissance Agent. Target: https://techviflaw.vn.gd. Framework: React 18 + Vite frontend / Express.js backend.*
