// Masked recordings (src/mask.js; ported from Asuvaan's insightsMasking tests): only the host's own words stay
// readable, every value, name, address and id is hidden before an event leaves the browser. The canary fills rrweb's
// events with a made-up person's details and asserts none of them survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLOCK_SELECTOR,
    PRIVATE_SELECTOR,
    buildUiMasker,
    createMask,
    createSanitizer,
    createTextMask,
    dropIds,
    maskCssUrls,
    maskUrl,
    nodeMatcher,
    scrubFreeText,
    splitSelectors,
    star,
    textMasker,
    uiStrings,
    urlRules,
} from '../src/mask.js';

// A host's dictionary: two languages of nested UI strings, as i18next holds them.
const EN = {
    common: { save: 'Save', cancel: 'Cancel', late: 'Late', delete: 'Delete' },
    list: { open: '{{count}} open', since: 'since {{date}}', received: '<b>Rent</b> received', pair: '{{a}} {{b}}' },
    form: { firstNamePlaceholder: 'Matti', exampleEmail: 'virtanen@example.com' },
    nav: { properties: 'Properties', tenants: 'Tenants' },
};
const FI = { common: { save: 'Tallenna', cancel: 'Peruuta', late: 'Myöhässä' } };
const ui = createTextMask({ dictionary: [EN, FI] });

const ID = '01a1222d-8e5d-73c2-8029-c269198a634f';
const ULID = '01HV3K9Z8M4Q7R2T5W6X8Y9ZAB';
// The made-up person: none of this may be in a masked recording.
const PRIVATE = ['Liisa', 'Virtanen', 'liisa.virtanen@example.fi', '+358 40 123 4567', '358401234567', 'FI21 1234 5600 0007 85',
    'Alahovintie', '010190-123A', ID, ULID, 'avatar-liisa.png'];

/* ── Rule 4: the dictionary ────────────────────────────────────────────── */

test('fail closed: with no dictionary every word is masked', () => {
    for (const mask of [createTextMask(), createTextMask({ dictionary: null }), createTextMask({ dictionary: () => { throw new Error('i18n not loaded'); } })]) {
        assert.equal(mask('Save'), '****');
        assert.equal(mask('Liisa Virtanen'), '***** ********');
        assert.equal(mask(' · – / '), ' · – / ', 'punctuation and symbols stay');
    }
    const noDictionary = createMask();
    assert.equal(noDictionary.text('Save', { closest: () => null }), '****');
    assert.equal(noDictionary.words('Cancel'), '******');
});

test('the dictionary leaves out example values a real person could share, and what `skip` names', () => {
    const strings = uiStrings([EN, FI]);
    assert.ok(strings.includes('Save') && strings.includes('Tallenna'), 'both languages are in');
    assert.ok(!strings.includes('Matti') && !strings.includes('virtanen@example.com'), 'placeholders and examples are not UI words');

    const skipped = uiStrings({ pay: { salary: 'Salary paid', rent: 'Rent paid' }, note: 'paid from a salary' }, { skip: /salary/i });
    assert.deepEqual(skipped, ['Rent paid'], 'by the key, and by the words when the key does not say it');
    const withSkip = createTextMask({ dictionary: () => uiStrings({ salary: 'Salary paid', save: 'Save' }, { skip: /salary/g }) });
    assert.equal(withSkip('Salary paid'), '****** ****', 'masked like a name');
    assert.equal(withSkip('Save'), 'Save', 'the rest of the dictionary still reads');
    assert.deepEqual(uiStrings(['Save', 'Save', 7, null]), ['Save'], 'a plain list works too');
});

test('rule 4: the host words stay, data goes, templates keep their own words', () => {
    const mask = buildUiMasker(['Cancel', 'Save property', '{{count}} open', 'since {{date}}', '<b>Rent</b> received', '{{a}} {{b}}']);
    assert.equal(mask('Cancel'), 'Cancel');
    assert.equal(mask('  save   PROPERTY '), '  save   PROPERTY ', 'case and spacing do not matter');
    assert.equal(mask('Liisa Virtanen'), '***** ********');
    assert.equal(mask('3 open'), '* open');
    assert.equal(mask('since 1.8.2026'), 'since ********');
    assert.equal(mask('Rent'), 'Rent', 'the parts between Trans tags are strings of their own');
    assert.equal(mask('2'), '*', 'digits alone are data');
    assert.equal(mask('Liisa Virtanen'), '***** ********', 'a template made only of values keeps nothing');
    assert.equal(mask(''), '');
});

test("a host's readable() judge keeps what it says yes to; the dictionary decides the rest", () => {
    const mask = createTextMask({ dictionary: ['Save'], readable: (text) => /^Step \d of \d$/.test(text) });
    assert.equal(mask('Step 2 of 3'), 'Step 2 of 3');
    assert.equal(mask('Save'), 'Save');
    assert.equal(mask('Liisa'), '*****');
    const broken = createTextMask({ readable: () => { throw new Error('host bug'); } });
    assert.equal(broken('Liisa'), '*****', 'a judge that throws keeps nothing');
});

/* ── Rule 3: private selectors ─────────────────────────────────────────── */

test('rule 3: inside a private selector even the host words go', () => {
    const at = (inside) => ({ closest: (selector) => (selector === PRIVATE_SELECTOR && inside ? {} : null) });
    const mask = textMasker(ui);
    assert.equal(mask('Late', at(true)), '****');
    assert.equal(mask('Cancel', at(false)), 'Cancel');
    assert.equal(mask('Liisa', at(false)), '*****');
    assert.equal(mask('Cancel', null), '******', 'no element: treated as private');
    assert.equal(mask('Cancel', { closest: () => { throw new Error('detached'); } }), '******');
    for (const selector of ['[data-mybeast-private]', '[translate="no"]', '[data-insights-private]']) {
        assert.ok(PRIVATE_SELECTOR.includes(selector), selector);
    }
});

test("a host's own private selectors are added to the defaults, and their graphics are blocked", () => {
    const mask = createMask({ dictionary: ['Late'], privateSelectors: ['.person-card', '[data-secret], .row .name'], blockSelectors: '.chart svg' });
    assert.ok(mask.privateSelector.startsWith('[data-mybeast-private]'));
    assert.ok(mask.privateSelector.includes('.person-card') && mask.privateSelector.includes('.row .name'));
    const inside = { closest: (selector) => (selector === mask.privateSelector ? {} : null) };
    assert.equal(mask.text('Late', inside), '****');
    assert.match(mask.blockSelector, /\.person-card svg/);
    assert.match(mask.blockSelector, /\[data-secret\] svg/);
    assert.match(mask.blockSelector, /\.chart svg/);
    assert.match(BLOCK_SELECTOR, /svg:not\(\[aria-hidden="true"\]\)/, 'graphics that draw data are blocked');
    assert.match(BLOCK_SELECTOR, /\bimg\b/);
});

test('a block selector the browser cannot read is left out (rrweb would throw on every node)', () => {
    const valid = (selector) => {
        if (selector.includes('((')) throw new SyntaxError('bad');
        return true;
    };
    const mask = createMask({ blockSelectors: ['.ok', ':bad((x'], validSelector: valid });
    assert.match(mask.blockSelector, /\.ok/);
    assert.ok(!mask.blockSelector.includes('bad'));
});

test('serialized nodes are matched by simple selectors; a complex one by its last part (more, never less)', () => {
    const match = nodeMatcher('[data-mybeast-private], [translate="no"], .card.person, #who, span[data-kind~=secret], .row .name');
    assert.equal(match('div', { 'data-mybeast-private': '' }), true);
    assert.equal(match('span', { translate: 'no' }), true);
    assert.equal(match('span', { translate: 'yes' }), false);
    assert.equal(match('div', { class: 'card person big' }), true);
    assert.equal(match('div', { class: 'card' }), false);
    assert.equal(match('p', { id: 'who' }), true);
    assert.equal(match('span', { 'data-kind': 'a secret b' }), true);
    assert.equal(match('div', { 'data-kind': 'secret' }), false, 'the tag counts');
    assert.equal(match('td', { class: 'name' }), true, '.row .name: judged by .name');
    assert.equal(match('div', {}), false);
    assert.equal(nodeMatcher(':not(.x)')('div', {}), false, 'a pseudo-class is not judged here');
    assert.deepEqual(splitSelectors('a, [b="c,d"], :is(e, f)'), ['a', '[b="c,d"]', ':is(e, f)']);
});

/* ── Rules 5 and 6: URLs and ids ───────────────────────────────────────── */

test('rules 5 and 6: URLs keep route words, lose ids, names, files, queries and contact details', () => {
    assert.equal(maskUrl(`/properties/${ID}/tenancy?tab=money#late`), '/properties/:id/tenancy');
    assert.equal(maskUrl(`https://app.example.com/leases/42/payments/${ULID}`), 'https://app.example.com/leases/:id/payments/:id');
    assert.equal(maskUrl('/search?q=Virtanen&page=2'), '/search', 'query values never leave');
    assert.equal(maskUrl('mailto:liisa.virtanen@example.fi'), 'mailto:');
    assert.equal(maskUrl('tel:+358401234567'), 'tel:');
    assert.equal(maskUrl('https://www.google.com/maps/place/Alahovintie+6+A+8'), 'https://www.google.com/maps/place/:x');
    assert.equal(maskUrl('/storage/avatars/avatar-liisa.png'), '/storage/avatars/:x');
    assert.equal(maskUrl('/a.png 1x, /b.png 2x'), '/:x 1x,/:x 2x');
    assert.equal(maskUrl('javascript:alert(1)'), 'javascript:');
    assert.equal(maskCssUrls(`width:2px;background:url("/users/${ID}/avatar-liisa.png")`), 'width:2px;background:url("/users/:id/:x")');
    assert.equal(dropIds(`row-${ID} ${ULID}`), 'row-:id :id');
});

test("a host's own id patterns and route words", () => {
    const rules = urlRules({ idPatterns: [/INV-\d{4}-\d+/, /\bcus_[a-z0-9]{8}\b/i], routeWords: ['invoices', 'customers', 'new'] });
    assert.equal(dropIds('invoice INV-2026-0042 for cus_ab12cd34', rules), 'invoice :id for :id');
    assert.equal(maskUrl('/invoices/INV-2026-0042', rules), '/invoices/:id');
    assert.equal(maskUrl('/customers/liisa-virtanen', rules), '/customers/:x', 'a name slug is no route word');
    assert.equal(maskUrl('/customers/new', rules), '/customers/new');
    assert.equal(maskUrl('/u/liisa-virtanen'), '/u/liisa-virtanen', 'by default every lowercase word is a route word');
    const judge = urlRules({ routeWords: (segment) => segment.length < 5 });
    assert.equal(maskUrl('/abc/abcdef', judge), '/abc/:x');
    assert.equal(maskUrl('/abc', urlRules({ routeWords: () => { throw new Error('x'); } })), '/:x');
});

test('free text keeps its words and loses addresses, ids, IBANs, personal ids and long numbers', () => {
    const out = scrubFreeText(`Failed for liisa.virtanen@example.fi (${ID}) FI21 1234 5600 0007 85, 010190-123A, call +358 40 123 4567 at line 12`);
    for (const s of PRIVATE.filter((p) => !['Liisa', 'Virtanen', 'Alahovintie', 'avatar-liisa.png', ULID].includes(p))) assert.ok(!out.includes(s), s);
    assert.match(out, /^Failed for \*+ \(:id\)/);
    assert.match(out, /line 12$/, 'short numbers stay');
});

/* ── The canary: one page and its changes, as rrweb emits them ───────── */

let nextId = 1;
const el = (tagName, attributes = {}, childNodes = []) => ({ type: 2, id: nextId++, tagName, attributes, childNodes });
const txt = (textContent, extra = {}) => ({ type: 3, id: nextId++, textContent, ...extra });

function page() {
    const privateCard = el('div', { 'data-mybeast-private': '', class: 'card' }, [el('span', {}, [txt('Late')]), el('span', {}, [txt('Liisa Virtanen')])]);
    const legacyCard = el('div', { 'data-insights-private': '' }, [txt('Cancel')]);
    const body = el('body', {}, [
        el('div', { id: 'app', 'data-page': JSON.stringify({ props: { auth: { user: { email: 'liisa.virtanen@example.fi' } } } }) }, [
            el('a', { href: 'mailto:liisa.virtanen@example.fi', title: 'Liisa Virtanen', 'aria-label': 'Liisa Virtanen' }, [txt('Liisa Virtanen')]),
            el('a', { href: 'tel:+358401234567', 'data-tip': '+358 40 123 4567' }, [txt('+358 40 123 4567')]),
            el('a', { href: `/tenants/${ID}?q=Virtanen` }, [txt('Cancel')]),
            el('input', { type: 'hidden', name: 'iban', value: 'FI21 1234 5600 0007 85' }),
            el('input', { type: 'file', value: 'C:\\fakepath\\avatar-liisa.png' }),
            el('input', { type: 'checkbox', value: ID }),
            el('input', { type: 'text', value: '****' }), // rrweb's maskAllInputs did this one
            el('img', { alt: 'Liisa Virtanen', src: '/storage/avatars/avatar-liisa.png' }),
            el('span', { translate: 'no' }, [txt('Alahovintie 6 A 8')]),
            el('div', { id: `row-${ID}`, style: `background:url("/users/${ID}/avatar-liisa.png")`, 'data-copy': 'FI21 1234 5600 0007 85' }, [txt('010190-123A')]),
            privateCard,
            el('button', { 'aria-label': 'Cancel', 'data-state': 'open' }, [txt('Cancel')]),
            { type: 5, id: nextId++, textContent: 'Liisa was here' },
            el('style', {}, [txt('.card{color:red}', { isStyle: true })]),
            legacyCard,
        ]),
    ]);
    const html = el('html', { lang: 'fi' }, [el('head', {}, [el('title', {}, [txt('Liisa Virtanen · Example')])]), body]);

    return { snapshot: { type: 2, data: { node: { type: 0, id: nextId++, childNodes: [html] } }, timestamp: 1 }, privateCard, legacyCard };
}

const leaks = (value) => PRIVATE.filter((s) => JSON.stringify(value).toLowerCase().includes(s.toLowerCase()));

test('the canary: a full page keeps the host words and none of the person', () => {
    const clean = createSanitizer(ui);
    const { snapshot, legacyCard } = page();
    const meta = clean({ type: 4, data: { href: `http://localhost:8001/tenants/${ID}?q=Liisa`, width: 1440, height: 900 }, timestamp: 0 });
    const full = clean(snapshot);

    assert.deepEqual(leaks([meta, full]), []);
    const json = JSON.stringify(full);
    assert.ok(!json.includes('data-page'), "Inertia's data-page is gone");
    assert.equal(meta.data.href, 'http://localhost:8001/tenants/:id');
    assert.ok(json.includes('"textContent":"Cancel"'), 'the host word outside the card stays');
    assert.ok(json.includes('"aria-label":"Cancel"'));
    assert.ok(json.includes('"data-state":"open"'), 'component-library state attributes stay');
    assert.ok(json.includes('.card{color:red}'), 'CSS stays');
    assert.ok(json.includes('"href":"mailto:"') && json.includes('"href":"tel:"'));
    assert.ok(json.includes('"textContent":"****"'), "the private card's host word went too");
    assert.equal(legacyCard.childNodes[0].textContent, '******', '[data-insights-private] is private too');
    assert.ok(!json.includes('Liisa was here'), 'comments are emptied');
});

test('the canary: changes later in the recording are judged like the node they land on', () => {
    const clean = createSanitizer(ui);
    const { snapshot, privateCard } = page();
    clean(snapshot);
    const lateText = privateCard.childNodes[0].childNodes[0];
    const button = snapshot.data.node.childNodes[0].childNodes[1].childNodes[0].childNodes[11];

    const mutation = clean({ type: 3, data: {
        source: 0,
        adds: [
            { parentId: privateCard.id, nextId: null, node: txt('Cancel') }, // inside the card: masked though a host word
            { parentId: button.id, nextId: null, node: el('span', { title: 'Liisa Virtanen' }, [txt('Liisa')]) },
            { parentId: 999999, nextId: null, node: txt('Cancel') }, // a parent never seen: private
        ],
        attributes: [
            { id: button.id, attributes: { 'aria-label': 'Liisa Virtanen', 'data-state': 'closed' } },
            { id: 424242, attributes: { title: 'Cancel', value: 'Liisa' } }, // a node never seen: everything masked
        ],
        texts: [{ id: lateText.id, value: 'Cancel' }, { id: 31337, value: 'Liisa' }],
        removes: [],
    }, timestamp: 2 });
    const input = clean({ type: 3, data: { source: 5, id: 12, text: 'Liisa Virtanen', isChecked: false }, timestamp: 3 });

    assert.deepEqual(leaks([mutation, input]), []);
    assert.equal(mutation.data.adds[0].node.textContent, '******');
    assert.equal(mutation.data.adds[2].node.textContent, '******');
    assert.equal(mutation.data.attributes[0].attributes['data-state'], 'closed');
    assert.equal(mutation.data.attributes[1].attributes.title, '******');
    assert.equal(mutation.data.texts[0].value, '******');
    assert.equal(input.data.text, '***** ********');
});

test("the canary: the marks keep what they say about the page, not about people", () => {
    const clean = createSanitizer(ui);
    const custom = (tag, payload) => clean({ type: 5, data: { tag, payload }, timestamp: 4 });

    const env = custom('env', { path: `/tenants/${ID}?q=Virtanen`, w: 1440, h: 900, dpr: 2, lang: 'fi', theme: 'dark', translated: true, doc: 2, masked: false, extra: 'Liisa' });
    const pageMark = custom('page', { name: 'Tenant/Show', url: `/tenants/${ID}?q=Liisa` });
    const pageNamedBadly = custom('page', { name: `liisa.virtanen@example.fi ${ID}`, url: '/' });
    const visit = custom('visit', { phase: 'start', method: 'PUT', url: `/leases/${ID}/rent?amount=650`, who: 'Liisa' });
    const pressName = custom('press', { label: 'Liisa Virtanen', tag: 'a', role: '', href: 'mailto:liisa.virtanen@example.fi' });
    const pressUi = custom('press', { label: 'Cancel', tag: 'button', role: 'tab', href: '' });
    const dialog = custom('dialog', { open: true, title: 'Liisa Virtanen' });
    const refusedKey = custom('refused', { fields: ['email'], first: 'rules.email' });
    const refusedText = custom('refused', { fields: ['email'], first: 'liisa.virtanen@example.fi is taken' });
    const error = custom('error', { name: 'TypeError', message: `Cannot read ${ID} for liisa.virtanen@example.fi` });
    const broken = custom('broken', { kind: 'Liisa Virtanen' });
    const hidden = custom('hidden', { who: 'Liisa' });
    const own = custom('checkout', { step: 2, ok: true, label: 'Save', who: 'Liisa Virtanen', nested: { iban: 'FI21 1234 5600 0007 85', ids: [ID] } });

    assert.deepEqual(leaks([env, pageMark, pageNamedBadly, visit, pressName, pressUi, dialog, refusedKey, refusedText, error, broken, hidden, own]), []);
    assert.deepEqual(env.data.payload, { path: '/tenants/:id', w: 1440, h: 900, dpr: 2, lang: 'fi', theme: 'dark', translated: true, doc: 2, masked: true });
    assert.deepEqual(pageMark.data.payload, { name: 'Tenant/Show', url: '/tenants/:id' });
    assert.deepEqual(visit.data.payload, { phase: 'start', method: 'put', url: '/leases/:id/rent' });
    assert.equal(pressUi.data.payload.label, 'Cancel');
    assert.equal(pressUi.data.payload.role, 'tab');
    assert.equal(pressName.data.payload.href, 'mailto:');
    assert.equal(refusedKey.data.payload.first, 'rules.email');
    assert.equal(error.data.payload.name, 'TypeError');
    assert.equal(broken.data.payload.kind, 'unknown');
    assert.deepEqual(hidden.data.payload, {}, 'a built-in mark keeps only its own fields');
    assert.equal(own.data.payload.step, 2, "a host's own mark keeps its numbers");
    assert.equal(own.data.payload.ok, true);
    assert.equal(own.data.payload.label, 'Save', '...and its strings that are host words');
    assert.equal(own.data.payload.who, '***** ********');
    assert.equal(own.data.payload.nested.ids[0], '***', 'an id, then no host word: masked');
});

test('a sanitizer that cannot read an event lets nothing out', () => {
    const clean = createSanitizer(ui);
    const hostile = { type: 2, get data() { throw new Error('boom'); }, timestamp: 1 };
    assert.equal(clean(hostile), null);
    assert.equal(clean(null), null);
    assert.equal(clean({ type: 5, data: { payload: {} }, timestamp: 1 }), null, 'a mark without a tag');
});

/* ── What Asuvaan's independent review found (23.10.2026) ────────────── */

test("an iframe's document never leaves: its attach, its changes, its inputs", () => {
    const clean = createSanitizer(ui);
    const { snapshot } = page();
    clean(snapshot);
    const frame = el('iframe', {});
    const doc = { type: 0, id: nextId++, childNodes: [el('html', {}, [el('body', {}, [txt('Liisa Virtanen, 010190-123A')])])] };
    assert.equal(clean({ type: 3, data: { source: 0, adds: [{ parentId: frame.id, nextId: null, node: doc }], removes: [], texts: [], attributes: [], isAttachIframe: true }, timestamp: 5 }), null);
    const body = doc.childNodes[0].childNodes[0];
    const later = clean({ type: 3, data: { source: 0, adds: [{ parentId: body.id, nextId: null, node: txt('FI21 1234 5600 0007 85') }], removes: [], texts: [{ id: body.childNodes[0].id, value: 'Liisa' }], attributes: [{ id: body.id, attributes: { title: 'Liisa' } }] }, timestamp: 6 });
    assert.deepEqual([later.data.adds, later.data.texts, later.data.attributes], [[], [], []]);
    assert.equal(clean({ type: 3, data: { source: 5, id: body.id, text: 'x', isChecked: false }, timestamp: 7 }), null);
    assert.equal(clean({ type: 3, data: { source: 3, id: doc.id, x: 0, y: 10 }, timestamp: 8 }), null, 'scrolling inside it');
});

test('style changes sent as a diff, CSS added at run time and field names lose their ids', () => {
    const clean = createSanitizer(ui);
    const { snapshot } = page();
    clean(snapshot);
    const button = snapshot.data.node.childNodes[0].childNodes[1].childNodes[0].childNodes[11];
    const diff = clean({ type: 3, data: { source: 0, adds: [], removes: [], texts: [], attributes: [{ id: button.id, attributes: { style: { 'view-transition-name': `row-${ID}`, background: [`url("/users/${ID}/avatar-liisa.png")`, 'important'], color: false } } }] }, timestamp: 9 });
    const rule = clean({ type: 3, data: { source: 8, id: 3, adds: [{ rule: `.x{background:url(/users/${ID}/a.png)}`, index: 0 }] }, timestamp: 10 });
    const fields = clean({ type: 5, data: { tag: 'refused', payload: { fields: [`rows.${ID}.amount`], first: 'rules.required' } }, timestamp: 11 });
    assert.deepEqual(leaks([diff, rule, fields]), []);
    assert.equal(diff.data.attributes[0].attributes.style['view-transition-name'], 'row-:id');
    assert.equal(fields.data.payload.fields[0], 'rows.:id.amount');
});

test('event kinds no rule has judged never leave', () => {
    const clean = createSanitizer(ui);
    assert.equal(clean({ type: 3, data: { source: 11, payload: { level: 'log', payload: ['Liisa'] } }, timestamp: 1 }), null, 'console log');
    assert.equal(clean({ type: 3, data: { source: 9, id: 1, commands: [] }, timestamp: 1 }), null, 'canvas');
    assert.equal(clean({ type: 3, data: { source: 10, family: 'x', fontSource: 'x' }, timestamp: 1 }), null, 'font');
    assert.equal(clean({ type: 6, data: { plugin: 'rrweb/console@1', payload: {} }, timestamp: 1 }), null, 'a plugin');
    assert.notEqual(clean({ type: 3, data: { source: 2, type: 2, id: 1, x: 1, y: 1 }, timestamp: 1 }), null, 'a click stays');
});

test('an error mark keeps its kind; a private control keeps no chosen state; a host keeps its own attributes', () => {
    const clean = createSanitizer(ui, { keepAttributes: ['data-tone'] });
    const error = clean({ type: 5, data: { tag: 'error', payload: { name: 'TypeError', message: '{"person":"Liisa Virtanen","street":"Alahovintie 6"}' } }, timestamp: 1 });
    const oddName = clean({ type: 5, data: { tag: 'error', payload: { name: 'Liisa Virtanen', message: 'x' } }, timestamp: 1 });
    assert.deepEqual(leaks([error, oddName]), []);
    assert.equal(error.data.payload.name, 'TypeError');

    const chips = el('div', { 'data-mybeast-private': '' }, [el('button', { role: 'radio', 'aria-checked': 'true' }), el('input', { type: 'radio', checked: true })]);
    const open = el('input', { type: 'checkbox', checked: true });
    const toned = el('span', { 'data-tone': 'warning', 'data-other': 'warning' });
    clean({ type: 2, data: { node: { type: 0, id: nextId++, childNodes: [el('html', {}, [el('body', {}, [chips, open, toned])])] } }, timestamp: 2 });
    assert.equal('aria-checked' in chips.childNodes[0].attributes, false);
    assert.equal('checked' in chips.childNodes[1].attributes, false);
    assert.equal(open.attributes.checked, true, 'outside a private node the state stays');
    assert.equal(toned.attributes['data-tone'], 'warning', 'kept: the host styles on it');
    assert.equal(toned.attributes['data-other'], '*******', 'not kept: masked like text');
    const privInput = clean({ type: 3, data: { source: 5, id: chips.childNodes[1].id, text: 'on', isChecked: true }, timestamp: 3 });
    const openInput = clean({ type: 3, data: { source: 5, id: open.id, text: 'on', isChecked: true }, timestamp: 3 });
    assert.equal('isChecked' in privInput.data, false);
    assert.equal(openInput.data.isChecked, true);
});

test("a host's private selector reaches the sanitizer too (attributes and later changes)", () => {
    const mask = createMask({ dictionary: ['Late', 'Cancel'], privateSelectors: '.person-card' });
    const clean = mask.sanitizer();
    const card = el('section', { class: 'person-card', title: 'Late' }, [el('span', {}, [txt('Late')])]);
    clean({ type: 2, data: { node: { type: 0, id: nextId++, childNodes: [el('html', {}, [el('body', {}, [card])])] } }, timestamp: 1 });
    assert.equal(card.attributes.title, '****');
    assert.equal(card.childNodes[0].childNodes[0].textContent, '****');
    const later = clean({ type: 3, data: { source: 0, adds: [{ parentId: card.id, nextId: null, node: txt('Cancel') }], removes: [], texts: [], attributes: [] }, timestamp: 2 });
    assert.equal(later.data.adds[0].node.textContent, '******');
    assert.equal(star('a b'), '* *');
});
