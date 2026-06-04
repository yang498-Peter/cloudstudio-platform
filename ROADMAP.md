# CloudStudio Roadmap

CloudStudio is open source so teams can build on a practical, self-hostable
foundation for browser-based point cloud workflows. This roadmap keeps the
public direction easy to scan while detailed implementation work is split into
focused pull requests or fresh issues.

## Near-Term Priorities

### Upload and Security Hardening

- Keep archive extraction, multipart uploads, and path handling inside strict
  project storage boundaries.
- Require explicit production secrets and fail safely when deployment
  configuration is incomplete.
- Reduce public API responses to browser-safe metadata only.
- Keep runtime data, generated jobs, uploads, exports, credentials, and logs out
  of Git and away from public static routes.

### Reliable Conversion and Publishing

- Make long-running conversion and publishing jobs easier to inspect, retry,
  timeout, and recover.
- Improve readiness checks for Potree conversion and 3D Gaussian Splatting
  publishing so project status reflects the real processing state.
- Add focused tests around upload, conversion, publishing, and job-state
  transitions.

### Deployment and Operations

- Continue improving the Ubuntu deployment flow for AI-assisted setup,
  validation, and troubleshooting.
- Strengthen PM2, Nginx, rollback, storage, and dependency-audit guidance for
  production-style deployments.
- Keep server-specific paths, IPs, domains, credentials, and operational notes
  out of the public repository.

### Viewer, Measurement, and i18n

- Improve multilingual coverage for viewer controls, volume tools, clipping
  tools, and dynamic UI messages.
- Continue polishing measurement, profile, clipping, DXF, and volume workflows
  for browser-native review.
- Make 3DGS asset metadata more explicit so each scene can preserve its own
  display settings.

## Contribution Direction

Good contributions are small, verifiable, and useful to more than one deployment:

- deployment documentation for additional cloud providers
- sample-data instructions that do not include customer or proprietary data
- tests for upload, conversion, viewer, and API behavior
- i18n improvements
- UI polish for point cloud review, measurement, and sharing workflows
- security hardening that keeps self-hosted deployments safer by default

If you want to work on one of these areas, open a focused issue or pull request
with the expected behavior, test plan, and any deployment impact.
