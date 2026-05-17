# Dependency Audit Notes

Date: 2026-05-17

Scope: production dependencies for `web-uploader`.

## Current Resolution

`path-to-regexp` and `qs` are not direct application dependencies. They are pulled in through `express@4.22.1`:

```text
potree-local-uploader
└── express@4.22.1
    ├── path-to-regexp@0.1.x
    └── qs@6.14.x
```

The Express 4 dependency ranges allow safe patch updates inside the existing major line:

- `path-to-regexp`: `0.1.12` -> `0.1.13`
- `qs`: `6.14.1` -> `6.14.2`

The lockfile was refreshed with:

```bash
cd web-uploader
npm update path-to-regexp qs --package-lock-only
npm audit --omit=dev --json
```

Result after the lockfile refresh: `found 0 vulnerabilities`.

## Policy

Do not run blind `npm audit fix` for this project. It may cross major-version boundaries or change upload middleware behavior. Prefer:

1. Identify whether the vulnerable package is direct or transitive.
2. Check whether the current semver range admits a patched version.
3. Refresh the lockfile only for the affected package(s).
4. Run `npm audit --omit=dev --json`.
5. Run the focused smoke/unit checks listed in `docs/audit/product-hardening-index.md`.

If a future advisory cannot be fixed inside the current semver ranges, record the package path, blocked version range, risk, and planned upgrade issue before deferring.
