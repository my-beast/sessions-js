// @mybeast/sessions - session recordings of a page, sent to Sessions (services.my-beast.com/sessions).
export { init, mayRecord } from './client.js';
export { readClaims, secondsLeft } from './token.js';
export { createRecorder } from './recorder.js';
export { answerFor, refusedPayload, visitPayload } from './rules.js';
// For the host's dictionary (rule 4) and its own masking needs.
export {
    PRIVATE_SELECTORS,
    BLOCK_SELECTORS,
    EXAMPLE_KEY,
    buildUiMasker,
    createMask,
    createTextMask,
    dropIds,
    maskUrl,
    scrubFreeText,
    star,
    uiStrings,
    urlRules,
} from './mask.js';
