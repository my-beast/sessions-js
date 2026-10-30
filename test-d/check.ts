// The README's example, type-checked against types/ through the package's own name (npm run test:types; outside test/, which node --test would run).
import { createRecorder, init, type SessionsConfig } from '@mybeast/sessions';
import { createMask, maskUrl, urlRules } from '@mybeast/sessions/mask';

declare const config: SessionsConfig;
declare const ownUiStrings: string[];
declare const currentRouteName: string | null;

const client = init(config);
const recorder = createRecorder(client, {
    getToken: async () => (await fetch('/sessions/token')).text(),
    dictionary: () => [...ownUiStrings],
    currentPage: () => currentRouteName,
    onChange: (state) => state.status === 'recording' && state.recording?.startedAt,
});
recorder.start();
recorder.setToken('a.b.c');
recorder.pageChanged('Invoice/Show', location.pathname + location.search);
recorder.mark('checkout', { step: 2 });
const headers: Record<string, string> = recorder.requestHeaders();
const at: number | undefined = recorder.currentRecording()?.startedAt;
void headers;
void at;

const mask = createMask({ idPatterns: [/INV-\d{4}-\d+/], routeWords: ['invoices', 'show'] });
const masked: string = mask.url('/invoices/INV-2026-1');
const path: string = maskUrl('/u/liisa', urlRules({ routeWords: (segment) => segment === 'u' }));
void masked;
void path;
