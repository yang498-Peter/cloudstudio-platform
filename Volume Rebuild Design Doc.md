# Archived Volume Rebuild Design Document

This historical design document has been archived as part of the English documentation consolidation.

The current project documentation set is:

- `README.md` - repository overview and onboarding path.
- `DEPLOY.md` - first-time server deployment guide.
- `DEPLOY_SOP.md` - safe release, rollback, and maintenance SOP.
- `web-uploader/README.md` - main application development guide.
- `web-uploader/CODEBASE_MAP.md` - code map and debugging entry points.
- `web-uploader/STATE_MAP.md` - viewer state ownership guide.

When the volume workflow is redesigned again, create a new English design document that covers:

1. Target user scenarios, such as stockpile volume, plane cut/fill, and ground-fitted volume.
2. Authoritative data source and sampling rules.
3. Analysis surface and base surface definitions.
4. Server-side job lifecycle and generated artifacts.
5. Viewer preview and report behavior.
6. Auditability requirements for parameters, warnings, and diagnostics.
7. Regression tests and manual validation steps.
8. Deployment and rollback considerations.
