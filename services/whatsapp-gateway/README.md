# WhatsApp gateway security

Baileys authentication state under `auth/` is equivalent to a logged-in
WhatsApp session and must never be copied into logs, commits, or diagnostics.
The directory remains gitignored.

The gateway applies these controls at startup:

- process umask `077`, directory mode `0700`, and file mode `0600`;
- recursive hardening of existing session files, with symbolic links rejected;
- a silent Baileys logger because protocol/session-sync objects have no stable,
  exhaustive redaction schema;
- application lifecycle logs that omit QR payloads, phone numbers, JIDs,
  webhook response bodies, raw errors, and configured paths/URLs.

The QR remains available through the existing API because pairing requires it;
that endpoint must stay behind the existing operator access boundary. PM2 log
history created by older revisions is not rewritten by this code. Review and
expire historical logs separately under an explicitly authorized retention
procedure—do not paste them into issues or pull requests.

After a controlled deployment, verify without printing file contents:

```bash
find services/whatsapp-gateway/auth -type d ! -perm 0700 -print
find services/whatsapp-gateway/auth -type f ! -perm 0600 -print
```

Both commands should produce no output. A startup failure mentioning a
symbolic link or unsupported auth entry is fail-closed; inspect the path and do
not bypass the check or re-pair until its ownership is understood.
