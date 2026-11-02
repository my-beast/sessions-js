# @mybeast/sessions

The browser SDK of **Sessions** (services.my-beast.com/sessions): an rrweb recording of your pages, masked before it
leaves the browser, sent in gzip chunks with the person's yes. Plain ES modules, no framework, and no build step of its
own: its imports are bare names, so a page needs a bundler (Vite, as a Laravel app has) or an import map. Errors are a
separate product: `@mybeast/errors`.

## Install

```bash
npm install @mybeast/sessions   # brings @rrweb/record 2.1.7, pinned
```

Its types are in the package (`types/`), for `@mybeast/sessions/mask` too.

`src/recorder.js` is the only file that imports rrweb (about 160 KB). A host that keeps its main bundle small can
`import('@mybeast/sessions')` when the browser is idle. The masking helpers alone (no rrweb) are
`@mybeast/sessions/mask` - for masking the host's own telemetry the same way (an error report's pressed labels, say).

## Use

The least that works, with mybeast/sessions-laravel's config in a Blade layout (`window.myBeast.sessions`, its
README's "Use"):

```js
import { init, createRecorder } from '@mybeast/sessions';

createRecorder(init(window.myBeast?.sessions)).start();   // no config, or no yes in its token: nothing is recorded
```

With no dictionary every word arrives starred, which is safe.

**List the page's origin.** A browser sends only from an origin the project lists, as the address bar shows it
(`https://app.example.com`, and `http://localhost:8000` for your own machine): the project's Settings → Browser
origins, in Sessions or in Errors - it is one list for the project. From any other origin the browser gets no answer,
and the recorder stops after three chunks.

With the options most hosts set:

```js
import { init, createRecorder } from '@mybeast/sessions';

// `config` is what your server made: mybeast/sessions-laravel's Sessions::clientConfig() - {url, key, env, token}.
const client = init(config); // null when anything is malformed: the recorder then does nothing

const recorder = createRecorder(client, {
    // a fresh token from a route of yours (sessions-laravel's README has one): 204 when there is none
    getToken: async () => {
        const response = await fetch('/sessions/token');
        return response.status === 200 ? response.text() : null;
    },
    dictionary: () => [...ownUiStrings],          // the only words a masked recording keeps readable
    currentPage: () => currentRouteName,          // the host's page name for `page` marks
    onChange: (state) => {},                      // {status, recording, upload}
});
recorder.start();

// Each response that brings a new token, before the new page is drawn (Inertia: router.on('beforeUpdate', ...)):
recorder.setToken(newToken);
// A client-side page change (pushState fires no event):
recorder.pageChanged('Invoice/Show', location.pathname + location.search);
```

**API**

| Call | Does |
|---|---|
| `start()` | Records this page and the next ones while the token allows it (`rec: true` and a `consent_at`). |
| `stop()` | Before a page that is not to be recorded, or on sign-out. What was recorded is still sent. |
| `setToken(token)` | A fresh token. Another `sub` or `acct` starts a new recording; another `mask` starts a recording of its own (never a mix); a token without `rec` stops recording until one with it comes. A token for another project, or an unreadable one, counts as no token. |
| `pageChanged(name, url)` | A `page` mark `{name, url}`, and what is buffered goes out. `url` defaults to the address bar. |
| `mark(tag, payload)` | A mark of your own: an rrweb custom event, tag at most 32 characters. Masked recordings put its strings through the dictionary, keep numbers and yes/no, cut it at 3 levels and 4000 characters. Your object is copied, never changed. |
| `flush()` | Sends what is buffered now. |
| `currentRecording()` | `{id, startedAt}` while recording, else `null`. Pass it to `@mybeast/errors` as `currentRecording` to link an error to its moment. |
| `requestHeaders()` | `{'X-Recording-Id', 'X-Recording-At'}` while recording, else `{}`. Your page's own `fetch` and `XMLHttpRequest` calls get them already (`tagRequests`); add them by hand to anything else that reaches your server. |
| `state()` | `{status: 'off' \| 'waiting' \| 'recording' \| 'paused' \| 'refused', recording, upload: {status, answer, doc, seq, bytes} \| null}`. |

**Options** (all optional)

| Option | Default | |
|---|---|---|
| `getToken()` | none | Async; returns a fresh client token or `null`. Asked on a 401, and two minutes before a token runs out. Without it a 401 stops recording until `setToken`. |
| `idleMinutes` / `maxMinutes` | 30 / 120 | Without input for `idleMinutes` recording pauses; the next input starts a new recording. One recording lasts at most `maxMinutes`. |
| `dictionary` | none | Your UI strings: an array, nested objects (i18next resources, one per language), or a function returning either (read once, on first use). |
| `readable(text)` | none | Your own judge: `true` keeps a text as it is. Asked before the dictionary. |
| `privateSelectors` | `[data-mybeast-private]`, `[translate="no"]` | Added to the defaults. Inside, every word is masked, dictionary words too. `[data-insights-private]` works as an alias. |
| `blockSelectors` | media, every `svg` not `aria-hidden`, `[data-mybeast-block]`, `<private> svg` | Added to the defaults. rrweb keeps an empty box of the same size. |
| `keepAttributes` | structural and ARIA ones, `data-state` and the like | Attribute names whose values stay (your CSS selects on them). Others go through the dictionary. |
| `idPatterns` | UUIDs, ULIDs, digits | RegExps of your own ids (`/INV-\d{4}-\d+/`): `:id` in URLs, attributes and messages. |
| `routeWords` | any lowercase word | The path segments that stay, as a list or a predicate. Set it when your URLs carry name slugs (`/u/liisa-virtanen`): by default those stay. |
| `currentPage()` | none | Your page name for the `page` mark at each document start. |
| `onChange(state)` | none | Hears every change of `state()`. |
| `tagRequests` | `true` | While recording, your page's own requests (`fetch`, `XMLHttpRequest`) to its own origin carry `X-Recording-Id` and `X-Recording-At` (ms into the recording): `mybeast/sessions-laravel` files each journey step under the recording, `mybeast/errors-laravel` opens an error's replay at its second. Never to another origin (no preflight is asked of it) or to Sessions; a header your page set itself is kept. `false` leaves your requests alone - `requestHeaders()` gives them to add yourself. |

## Masking

Masked unless the token says `mask: false` in so many words. Fail closed: with no dictionary every word is masked.

1. Inputs: every value masked (rrweb's `maskAllInputs`); typing shows as stars; hidden and file inputs' values dropped.
2. Media, and every `svg` that is not `aria-hidden`, blocked.
3. Inside a private selector every word is masked, and a control's chosen state (checked, selected) is dropped.
4. Other text stays only if it is one of your dictionary's strings (any case, whitespace folded); a template
   (`{{count}} open`) keeps its own words and masks what was filled in. Digits alone are always masked.
5. Attributes are allow-listed; URLs keep their path, never `?query` or `#hash`; `mailto:` / `tel:` keep only the scheme.
6. Ids out of every URL and attribute; an iframe's document, console logs, canvas and fonts never leave; an event the
   sanitizer cannot read is dropped.

Build the dictionary with the helpers: `uiStrings(sources, {skip})` collects strings from nested objects and leaves
out placeholders and examples (`EXAMPLE_KEY`) and whatever `skip` (a RegExp on keys and texts) names - your words
that would say something about the person they show beside. `buildUiMasker`, `createTextMask`, `createMask`,
`maskUrl`, `dropIds` and `scrubFreeText` are exported for your own needs.

Unmasked (`mask: false`, for local debugging) hides only passwords and `[data-mybeast-block]`.

## Marks

The SDK marks on its own: `env` at each document start (path, size, language, theme, browser-translated, masked),
`page` (from `currentPage()` and `pageChanged`), `press` (a control's spoken label), `dialog` (open/close, its
title), `hidden` / `visible`, `pagehide`, and `error` (window errors and unhandled rejections: name and masked
message only). A host that knows its requests and forms adds `visit`, `refused` and `broken` with `mark()`;
`visitPayload(phase, visit)` and `refusedPayload(errors)` build their payloads. A built-in tag keeps only its own
fields; any other tag is masked as described under `mark()`.

## What leaves, and what the answers do

One recording per tab (sessionStorage `mybeast-rec-*`), carried across full page loads as documents 1, 2, …; a
duplicated tab takes its own (BroadcastChannel `mybeast-rec`). Chunks go every 5 s and on every page change, one
request at a time: `POST {url}/v1/parts/{recording}?key=&t=&doc=&seq=`, the gzip of a JSON array of events,
`Content-Type: text/plain`, no credentials, no other header - CORS-simple, so the last chunk can ride `keepalive`
(under 60 000 bytes) as the page goes away. What a page could not send waits in the tab for the next page, without
its token. Each chunk goes with the token it was recorded under. Recording waits while the browser's clock is behind
the token's `consent_at` (the service refuses events from more than 5 s before the yes).

| Answer | The SDK |
|---|---|
| 204 | goes on |
| 401 | sends again with a fresher token (`setToken`'s, or `getToken`'s); none: stops until `setToken` |
| 402 | stops recording on this page: the project's subscription has ended |
| 403 | stops recording on this page (a refused leftover of an earlier recording is only dropped) |
| 403 `before-consent` | drops that chunk only: it began before the yes (a leftover, or this browser's clock behind the host's) |
| 404 / 409 | starts a new recording; a second refusal in a row stops |
| 413 | splits the chunk and sends the halves; one event too big is dropped and a new snapshot taken |
| 422 | drops the chunk |
| 429, 5xx, none | tries again on the next beat, 3 tries |
| none, 3 chunks in a row | stops recording on this page: Sessions cannot be reached from it (an origin it does not list gets no CORS header, so the page sees no answer; a blocker; no network) |

`answerFor(status, refused)` is exported. A keepalive sent while the tab is only hidden that gets no answer goes back
in the queue; one sent as the page leaves cannot be sent again. Nothing here throws into your page: every listener is wrapped, every promise
caught, and rrweb's own errors are swallowed.

## Working on this SDK

For whoever changes the SDK, in its repository: the npm package holds only `src/`, `schemas/` and `types/`, and the
demo uses My Beast's own local checkout.

### Demo

In My Beast's own checkout: the demo borrows services/ two folders up.

```bash
npm install
php -S 127.0.0.1:8008      # in this folder, or the launch entry mybeast-sessions-js-demo
```

Open `http://localhost:8008/examples/demo.html` (localhost: an origin is matched exactly). It reads
`examples/demo-config.php` (`{url, key, env, token}`, minted from services/ two folders up, where Sessions is a
module: its "asuvaan" project lists `http://localhost:8008` as an origin, and a client token with `rec: true` and a
`consent_at`), records the page, and shows the recording id and the last upload's answer. Type in the form, open the
dialog, change the page, throw an error: the private card and everything outside the demo's dictionary arrive starred.

### Tests

Node 20 or newer.

```bash
npm install && npm test && npm run test:types   # node --test, then tsc on test-d/; schemas/ must equal services/schemas/sessions (when services/ is there)
```

### Releasing

Set `version` in `package.json`, add it to `CHANGELOG.md`, then tag it: `git tag v0.2.0 && git push --tags`. The
Publish workflow checks that the tag is the version, runs the tests and stages it on npm through npm's trusted
publishing (no token stored anywhere). It goes live when a maintainer approves it with the npm organisation's
two-factor code: the package's Staged Packages tab on npmjs.com, or `npm stage approve <id>`. The first version went by
hand (`npm publish --access public`); then the package's settings on npmjs.com named this repository's `publish.yml`
as its trusted publisher, allowed to stage only.
