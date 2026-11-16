'use strict';

// Deliberately unparseable JavaScript — fails both the CJS parse and the
// ESM re-parse. Used by syntax.test.js to prove js-syntax.js reports
// genuine syntax errors instead of silently passing everything.
const broken = {
