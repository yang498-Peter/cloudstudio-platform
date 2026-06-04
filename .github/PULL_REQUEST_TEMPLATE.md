## Summary

-

## Verification

- [ ] `git diff --check`
- [ ] `cd web-uploader && npm run check:public-release`
- [ ] `cd web-uploader && npm run check:i18n` if UI text changed
- [ ] Relevant unit or smoke tests passed

## Public Release Safety

- [ ] No credentials, SSH keys, tokens, `.env` files, or certificates
- [ ] No customer scans, generated point clouds, exports, cache, or job outputs
- [ ] No private server IPs, domains, usernames, or operational runbooks
- [ ] No local memory files, internal notes, Word documents, or temporary artifacts
