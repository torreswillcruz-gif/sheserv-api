# SheServe Admin API

This is a separately deployable Express service for provider approvals and plan
administration. It shares the marketplace database and JWT signing secret; it
does not issue tokens, expose a public registration route, or grant admin roles.

## Local setup

1. Deploy or start the parent `marketplace-api` once so its schema and plan
   catalog exist.
2. Set `DATABASE_URL`, `DATABASE_SSL`, and the same `JWT_SECRET` used by the
   marketplace API.
3. Set `MARKETPLACE_API_URL` to the marketplace API base URL (for example
   `https://sheserv-api.onrender.com`; `http://api:3000` in Docker Compose).
   The admin panel signs in through it.
4. Run `npm install`, then `npm start`.

The service listens on `PORT` (default `3001`) and exposes `GET /health`.

## Admin panel

Open `/admin/` on the admin service (for example `http://localhost:3001/admin/`)
and sign in with an account that has the `admin` role. The panel lists
providers by status (pending, approved, rejected) with their contact details,
bio and active services, and lets the administrator approve or reject them
(a reason is required to reject and is sent to the provider).

Sign-in goes through `POST /api/v1/admin/session` (also `/refresh` and
`/logout`), which forwards the credentials to the marketplace API and only
returns the session when the account currently has the `admin` role. The
admin API still does not issue tokens itself. The session is kept in the
browser tab (`sessionStorage`) and ends when the tab is closed.

## Granting administrator access

Register or choose an existing user through the marketplace API, then add the
role through a trusted database session. Replace the placeholder with the
administrator's account email:

```sql
UPDATE users
SET roles = array_append(roles, 'admin')
WHERE email = lower('<administrator-email>')
  AND NOT roles @> ARRAY['admin']::text[];
```

Sign in again through `POST /api/v1/auth/sessions` to obtain a token. The admin
service checks the current database role on every request, so role revocation
takes effect immediately. To revoke access:

```sql
UPDATE users SET roles = array_remove(roles, 'admin')
WHERE email = lower('<administrator-email>');
UPDATE refresh_tokens SET revoked = true
WHERE user_id = (SELECT id FROM users WHERE email = lower('<administrator-email>'));
```

Never add `admin` to the public registration role schema or store the shared
JWT secret in source control.

## Routes

All routes except health require an access token from the marketplace API with a
currently active `admin` role. Responses use JSON and the standard API error
shape.

- `GET /api/v1/admin/providers?status=pending&limit=50&offset=0`
  - Each item includes the active services and the current plan.
- `PATCH /api/v1/admin/providers/{providerId}/approval`
  - Body: `{"status":"active"}` or
    `{"status":"rejected","reason":"Reason for rejection"}`
  - Approving a provider is her verification: it sets `verified = true`
    (required to appear in the app search) and resolves her pending
    verification requests. Rejecting sets `verified = false`.
- `GET /api/v1/admin/verifications?result=pending&limit=50&offset=0`
  - Identity verification requests (`pending`, `approved`, `rejected`) with the
    requester's contact details and roles.
- `PATCH /api/v1/admin/verifications/{verificationId}`
  - Body: `{"result":"approved"}` or
    `{"result":"rejected","reason":"Reason for rejection"}`
  - Manual review (identity confirmed outside the app). Approving also sets the
    provider `verified` mark; it does not change the provider approval. The
    user is notified and sees the reason in the app.
- `GET /api/v1/admin/plans`
- `PUT /api/v1/admin/plans/{planCode}`
  - `planCode` is `free`, `standard`, `pro`, or `premium`.
  - Body fields: `displayName`, `description`, `monthlyApprovalLimit`,
    `features`, and `active`.
- `PATCH /api/v1/admin/providers/{providerId}/plan`
  - Body: `{"planCode":"premium"}`
- `GET /api/v1/admin/audit-events?limit=50&offset=0`

Every approval, plan edit, and assignment is written to
`admin_audit_events`. The plan catalog is shared with the marketplace API.
Monthly quote limits and the `finance`, `clients`, `statistics`, `promotions`,
and `team` features are enforced by the API and reflected in the provider app.
Other feature flags are stored and returned for future consumers.

## Render deployment

The parent `render.yaml` defines both web services. Set `DATABASE_URL` and
`JWT_SECRET` for `sheserve-admin-api` to the exact same values configured for
`marketplace-api`. Deploy the marketplace service first so the shared schema is
ready before the admin service starts.
