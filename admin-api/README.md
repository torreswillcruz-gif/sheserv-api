# SheServe Admin API

This is a separately deployable Express service for provider approvals and plan
administration. It shares the marketplace database and JWT signing secret; it
does not issue tokens, expose a public registration route, or grant admin roles.

## Local setup

1. Deploy or start the parent `marketplace-api` once so its schema and plan
   catalog exist.
2. Set `DATABASE_URL`, `DATABASE_SSL`, and the same `JWT_SECRET` used by the
   marketplace API.
3. Run `npm install`, then `npm start`.

The service listens on `PORT` (default `3001`) and exposes `GET /health`.

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
- `PATCH /api/v1/admin/providers/{providerId}/approval`
  - Body: `{"status":"active"}` or
    `{"status":"rejected","reason":"Reason for rejection"}`
  - Approval does not modify identity verification.
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
