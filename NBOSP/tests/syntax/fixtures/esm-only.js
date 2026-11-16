// Deliberately ESM-only JavaScript. Under NBOSP (a CommonJS package) a
// plain `node --check` of this .js file fails; the js-syntax.js ESM
// fallback (re-parse through a temporary .mjs copy) must accept it.
// Used to prove the fallback path actually engages.
export const answer = 42;
export default answer;
