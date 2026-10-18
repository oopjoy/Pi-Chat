# Draft recovery and attachment retention

This is recovery storage, not a second delivery queue or Pi Session authority.

## Browser drafts

- Save per concrete page and Composer partition; another window never overwrites
  or deletes the active page's record.
- Keep a synchronous localStorage text/path journal and IndexedDB image bodies.
  The journal can recover the most recent text even if the last asynchronous
  transaction did not finish before an abrupt close.
- Offer recovery explicitly for the same Session (or New draft), retaining any
  newly typed editor content. Never restart delivery from persisted queue or
  in-flight state. In-flight content is labelled outcome-unknown for the user to
  check against history before choosing to send it again.
- Retain backups for 30 days, with bounded record/image storage. Storage refusal,
  quota exhaustion and missing image bodies are visible, not silently ignored.
- Restore only image bodies that exist and local paths the server can validate.
  Missing attachments are named in the recovery result. A failed validation
  request is not treated as proof that a file is missing.
- Browser-private storage is local user data, not encrypted credential storage.
  Browser/site-data clearing can remove it. It does not promise durability
  against disk failure or guarantee a final image transaction after a crash.

## Server-managed attachments

- Store new Windows file drops in `%LOCALAPPDATA%/PiChatData/attachments`,
  separate from `%TEMP%`, the installation and sensitive `.pi` configuration.
  Payloads have immutable UUID addresses; Pi Chat never rewrites them in place.
- New uploads have a 24-hour staging grace period. Saved browser drafts renew
  per-owner leases for 30 days; one window releasing its lease cannot release
  another window's lease.
- Before invoking the existing send pipeline, validate local paths and mark
  managed attachments retained. Marking precedes any possible Pi delivery.
  Retained means sent **or possibly sent**, not a proof of transcript delivery.
- Retained attachments have no automatic expiry. Deleting a draft/card does not
  delete a payload that may be referenced by Pi history.
- Automatic and explicit safe cleanup remove only expired, unretained entries
  without a valid lease. Entry locking serializes claim, retention and deletion;
  cleanup cannot win a race after a successful retention acknowledgement.
- Never traverse or delete arbitrary paths, symlinks, or unknown entries. Legacy
  `pi-chat-dropped` temp files are validated when used but not swept: their prior
  delivery ownership was never recorded. Existing transcript paths are not
  rewritten or silently relocated.

Both policies preserve the local-only scope. Neither resumes a model request,
creates a Session, changes the workspace, or edits Pi JSONL.
