# Payload contract

Every payload a host and the Sessions module of services exchange has a JSON Schema here, by version (`v1/`). The
module (`services/schemas/sessions`) is the source; each SDK (mybeast/sessions-laravel, @mybeast/sessions) keeps a
copy under its own `schemas/` and a test fails when the copy differs from this one (when services/ is there). Change
a schema only together with the module and both SDKs. Paths are below `MYBEAST_SESSIONS_URL` (`…/sessions`).

The client token is the same contract as Errors' (`services/schemas/errors`) - one token format across My Beast
products, each module verifying it with its own project's signing keys.

| File | What |
|---|---|
| `v1/client-token.schema.json` | The claims of a client token (the browser's proof of who, and whether it may be recorded) |
| `v1/client-token-header.schema.json` | Its JWT header: HS256, `kid` = the signing key's public id |
| `v1/fixtures/client-token.json` | One token, fixed: the PHP SDK must mint it byte for byte, the service accept it, the JS SDK read it |
| `v1/recording-chunk.schema.json` | One chunk of a recording, unpacked: a JSON array of rrweb events and the marks the service reads |
| `v1/journey-steps.schema.json` | A batch of the host server's journey steps (`POST /v1/steps`) |
| `v1/key-flows.schema.json` | The host's key flows (`PUT /api/v1/flows`) |

## Uploading a chunk

`POST /v1/parts/{recording}?key=pk_…&t=<client token>&doc=<0-65535>&seq=<0-4294967295>`

- `{recording}`: a UUID the browser mints (`crypto.randomUUID()`); its first stored chunk binds it to the token's
  subject and account for good.
- `doc` counts the documents (full page loads) of the recording, `seq` the uploads within one. A repeated
  `(doc, seq)` is a no-op: the first write wins, so a retry is always safe.
- The body is the gzip of a `recording-chunk` array: at most 2 MiB as sent and 16 MiB unpacked (the gzip trailer's
  size is checked first). `Content-Type: text/plain`, no credentials: a CORS-simple request, so `keepalive` works as
  the page goes away (keep a keepalive body under 60 000 bytes - the browser's 64 KiB budget is shared).
- The token must say `rec: true` with a `consent_at`; a chunk whose first event is more than 5 s before
  `consent_at` is refused. With `mask: true` the service scans the unpacked chunk for e-mail addresses, Finnish
  personal ids, IBANs, phone numbers in international form and card numbers before anything is stored.

| Answer | Means | The SDK |
|---|---|---|
| 204 | Stored (or stored before) | goes on |
| 401 | No token, or it does not hold (ran out, wrong key) | asks the host for a fresh one (`getToken`), sends again; none: stops |
| 403 | Not this origin or key; the token does not allow recording; unmasked where the project requires masking (`{"refused":"not-recording"\|"mask-required"}`) | stops recording on this page |
| 403 `{"refused":"monthly-limit"}` | A new recording past the project's recordings this month (its package's, until the 1st UTC); a recording already open goes on | stops recording on this page |
| 402 | The project's subscription has ended | stops recording on this page |
| 403 `{"refused":"erased"}` | The recording was deleted or its person's or account's recordings erased while this tab still recorded (for a day after) | stops recording on this page |
| 403 `{"refused":"before-consent"}` | This chunk starts more than 5 s before `consent_at` (a tab's leftovers, or a browser clock behind the host's) | drops this chunk only; waits for its clock to pass `consent_at` before recording |
| 404 | The recording id is another subject's | starts a new recording |
| 409 | The recording was made for another account, masked the other way, or under a token with another `test` mark (`{"refused":"account"\|"masking"\|"test"}`) | starts a new recording |
| 413 | Too big | splits the chunk and sends the halves |
| 422 | Not a gzip of a JSON array of events, or a leak in a masked chunk (`{"refused":"leak","kinds":[…]}`) | drops the chunk |
| 429, 5xx, none | Busy or down | tries again later (3 tries); a third chunk in a row with no answer at all stops recording on this page |

- Every answer the service gives a listed origin carries `Access-Control-Allow-Origin`, refusals too, so the SDK can
  read them. An origin or key the project does not list gets a bare 403 the page cannot read (the SDK retries, and
  after three chunks with no answer stops).
- The service orders a recording's events by their timestamps, not by `seq`: a split chunk's halves are numbered after
  chunks already queued. The `Referer` is not read (the SDK sends the origin only).

## Erasing and reading back (the host's server)

All with the server secret (`Authorization: Bearer sk_….…`). An id is 1-64 of `A-Z a-z 0-9 . _ : -` (any other: 404, and
the SDKs answer 0 without asking); erasing again answers 0. An erasure's audit row never keeps the id it erased; an
export's is written before anything is read.

| Call | What | Answer |
|---|---|---|
| `DELETE /api/v1/subjects/{subject}/recordings` | Every recording of the person: rows, sealed files, the presses and dialogs read out of them | 200 `{"erased": n}` |
| `DELETE /api/v1/accounts/{account}/recordings` | Every recording of the account (the token's `acct`), whoever it was of | 200 `{"erased": n}` |
| `DELETE /api/v1/accounts/{account}/journey` | The account's journey: steps, key-flow runs, stuck occurrences (the stuck points stay, recounted) | 200 `{"erased": n}` |
| `GET /api/v1/subjects/{subject}/recordings/test-export` | The person's recordings made under a `test` token (a synthetic account: the host's masking canary), newest first, each chunk the events JSON as the browser sent it; gzip when asked | 200 `{"recordings": [{"id", "started_at", "masked", "chunks": […], "unreadable_chunks"}], "truncated": false}`; past 200 recordings or 32 MiB of events it stops at a whole chunk with `"truncated": true` (the SDK refuses a partial export) |

## The journey (the host's server)

All with the server secret (`Authorization: Bearer sk_….…`).

| Call | What | Answer |
|---|---|---|
| `POST /v1/steps` | A batch of up to 500 steps (`journey-steps`), gzip (`Content-Encoding: gzip`) or plain JSON, at most 2 MiB as sent | 202 `{"accepted": n, "dropped": n, "refused": [{"index": i, "reason": "…"}]}` - dropped: a person who objected; refused steps will never be taken (the SDK drops them; past the project's steps this month, its package's, they are refused as `monthly-limit` until the 1st UTC, and the SDK says so once a month). 413 too big (the SDK halves the batch); 422 not a batch (dropped: sending it again is refused again); 401 wrong secret, 429 too many, 5xx or no answer: kept and sent later |
| `PUT /api/v1/flows` | Every key flow (`key-flows`), replacing the project's - all or nothing | 200 `{"flows": n}`; 422 `{"message": "flows.<i>: <what>"}` and nothing changed; 401 wrong secret |
| `PUT /api/v1/subjects/{subject}/objection` | The person objects to the journey: theirs is erased, and none is kept from now on (server steps dropped, a recording's presses and dialogs not added) | 200 `{"erased": n}` |
| `DELETE /api/v1/subjects/{subject}/objection` | The objection is lifted | 204 |
| `DELETE /api/v1/subjects/{subject}/journey` | The person's journey erased (steps, flow runs, stuck occurrences) | 200 `{"erased": n}` |

A recording's presses and dialogs join its person's journey from the chunk ingest (the `press` and `dialog` marks, on
the browser's clock); a server step and a recording meet in one visit by person and time, not by the visit key.

A step may name its request (`request`: the id the host's log lines carry - its answer's `X-Request-Id`, which
mybeast/logs-laravel sets): the replay then opens exactly that request's lines in Logs. Send it only when there is one -
a service from before 28.10.2026 refuses the field, and refuses a step with any field it does not know.
