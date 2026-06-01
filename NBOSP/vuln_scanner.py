#!/usr/bin/env python3
"""
Security Vulnerability Scanner — Complete Edition
Scans JS, HTML, and CSS files recursively.
Based on OWASP Top 10 2025/2026, MDN Security Guidelines, CWE Top 25,
and current threat intel (supply chain, CSS exfil, prototype pollution,
DOM clobbering, JWT abuse, etc.)
"""

import re
import os
import sys
from pathlib import Path
from dataclasses import dataclass
from collections import defaultdict

CRITICAL = "CRITICAL"
HIGH     = "HIGH"
MEDIUM   = "MEDIUM"
LOW      = "LOW"

SEVERITY_ICON = {CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🔵"}

@dataclass
class Finding:
    severity: str
    category: str
    description: str
    file: str
    line_no: int
    line_content: str
    recommendation: str


# ══════════════════════════════════════════════════════════════════════════════
#  JAVASCRIPT RULES
# ══════════════════════════════════════════════════════════════════════════════
JS_RULES = [

    # ── XSS Sinks ─────────────────────────────────────────────────────────────
    (CRITICAL, "XSS: innerHTML assignment",
     r'\.innerHTML\s*=(?!=)',
     "innerHTML assignment can execute injected HTML/scripts — XSS sink.",
     "Use textContent for plain text, or sanitize with DOMPurify before innerHTML."),

    (CRITICAL, "XSS: outerHTML assignment",
     r'\.outerHTML\s*=(?!=)',
     "outerHTML assignment is an XSS sink.",
     "Avoid outerHTML with user-controlled data."),

    (CRITICAL, "XSS: document.write()",
     r'document\.write\s*\(',
     "document.write() with user input executes arbitrary scripts.",
     "Remove document.write; use safe DOM APIs instead."),

    (CRITICAL, "XSS: eval()",
     r'\beval\s*\(',
     "eval() executes arbitrary code — classic code injection.",
     "Remove eval(). Use JSON.parse for data, refactor other logic."),

    (CRITICAL, "XSS: new Function()",
     r'new\s+Function\s*\(',
     "new Function() is eval-equivalent — arbitrary code execution.",
     "Refactor to avoid dynamic code generation."),

    (CRITICAL, "XSS: srcdoc attribute set from variable",
     r'\.srcdoc\s*=\s*[a-zA-Z_$`"\']',
     "srcdoc set dynamically is an XSS sink — HTML executes inside the iframe.",
     "Never set srcdoc from user-controlled data. Use sandbox + static content only."),

    (HIGH, "XSS: insertAdjacentHTML",
     r'\.insertAdjacentHTML\s*\(',
     "insertAdjacentHTML is an XSS sink if content is user-controlled.",
     "Sanitize with DOMPurify, or use insertAdjacentText."),

    (HIGH, "XSS: dangerouslySetInnerHTML (React)",
     r'dangerouslySetInnerHTML',
     "Bypasses React's XSS protection — dangerous with user content.",
     "Sanitize input with DOMPurify before using dangerouslySetInnerHTML."),

    (HIGH, "XSS: setTimeout/setInterval with string arg",
     r'(setTimeout|setInterval)\s*\(\s*["\']',
     "Passing a string to setTimeout/setInterval is eval-equivalent.",
     "Always pass a function reference, never a string literal."),

    (HIGH, "XSS: javascript: URI in JS",
     r'["\']javascript\s*:',
     "javascript: URI can execute code in href/src contexts.",
     "Disallow javascript: in URL contexts; validate/sanitize all URLs."),

    (HIGH, "XSS: document.writeln()",
     r'document\.writeln\s*\(',
     "document.writeln() is identical in risk to document.write — XSS sink.",
     "Remove document.writeln; use safe DOM APIs."),

    (MEDIUM, "XSS: location.hash/search used directly",
     r'location\.(hash|search)\s*(?!.*encodeURI)',
     "Reading location.hash or location.search without sanitization is a DOM XSS source.",
     "Sanitize or encode location.hash/search before using in DOM or logic."),

    (MEDIUM, "XSS: document.URL / document.referrer used directly",
     r'document\.(URL|referrer)\b',
     "document.URL and document.referrer are attacker-controlled DOM XSS sources.",
     "Validate and encode these values before any DOM insertion or redirect logic."),

    # ── Prototype Pollution ────────────────────────────────────────────────────
    (CRITICAL, "Prototype pollution: __proto__ access",
     r'__proto__',
     "Direct __proto__ access can pollute the Object prototype.",
     "Use Object.create(null) for plain dicts; validate all merge inputs."),

    (CRITICAL, "Prototype pollution: constructor.prototype access",
     r'constructor\s*\.\s*prototype\b',
     "constructor.prototype manipulation is a prototype pollution vector.",
     "Block constructor/prototype keys in any user-input merge/assign path."),

    (HIGH, "Prototype pollution: unsafe object merge",
     r'Object\.(assign|merge|extend|defaults)\s*\(\s*(?:this|obj|config|options|settings)',
     "Object.assign/merge with user-supplied input can trigger prototype pollution.",
     "Validate and strip __proto__, constructor, prototype keys from user input before merging."),

    # ── Credential / Secret Exposure ──────────────────────────────────────────
    (CRITICAL, "Hardcoded password",
     r'(?i)(password|passwd|pwd)\s*[=:]\s*["\'][^"\']{4,}["\']',
     "Hardcoded password detected in source.",
     "Move to environment variables. Rotate any exposed credentials immediately."),

    (HIGH, "Hardcoded secret: API key / token",
     r'(?i)(api[_\-.]?key|secret[_\-.]?key|access[_\-.]?token|auth[_\-.]?token|client[_\-.]?secret)\s*[=:]\s*["\'][A-Za-z0-9._\-]{16,}["\']',
     "Possible hardcoded API key or secret token.",
     "Move secrets to env vars or a secrets manager. Never commit to source control."),

    (HIGH, "Sensitive data in localStorage",
     r'localStorage\.setItem\s*\(\s*["\'][^"\']*(?:token|password|secret|key|auth)',
     "Sensitive data stored in localStorage is accessible to any JS on the page.",
     "Use httpOnly cookies for auth tokens; avoid sensitive data in localStorage."),

    (MEDIUM, "Sensitive data in sessionStorage",
     r'sessionStorage\.setItem\s*\(\s*["\'][^"\']*(?:token|password|secret|key|auth)',
     "Sensitive data in sessionStorage — still readable by any JS on the page.",
     "Prefer httpOnly cookies for sensitive tokens."),

    (MEDIUM, "Cookie without Secure/HttpOnly flags",
     r'document\.cookie\s*=\s*[^;]+(?!.*\bSecure\b)(?!.*\bHttpOnly\b)',
     "Cookie set without Secure and/or HttpOnly flags.",
     "Always set Secure; HttpOnly; SameSite=Strict on session/auth cookies."),

    # ── JWT Vulnerabilities ────────────────────────────────────────────────────
    (HIGH, "JWT: alg:none vulnerability",
     r'(?i)["\']alg["\']\s*:\s*["\']none["\']',
     "JWT algorithm set to 'none' — token signature is bypassed entirely.",
     "Never accept alg:none. Enforce a strict allowlist of signing algorithms server-side."),

    (HIGH, "JWT stored in localStorage",
     r'localStorage\.setItem\s*\([^)]*["\'](?:jwt|token|access_token|id_token)["\']',
     "JWT stored in localStorage is vulnerable to XSS theft.",
     "Store JWTs in httpOnly cookies, not localStorage."),

    (MEDIUM, "JWT decoded client-side without verification",
     r'atob\s*\([^)]*\.split\s*\(\s*["\']["\']',
     "Manual base64 decode of a JWT on the client — signature not verified.",
     "Never trust client-decoded JWT claims for authorization. Verify server-side only."),

    # ── Open Redirect ─────────────────────────────────────────────────────────
    (HIGH, "Open redirect: window.location from variable",
     r'window\.location(?:\.href)?\s*=\s*[a-zA-Z_$][a-zA-Z0-9_$]*',
     "window.location set from a variable — potential open redirect.",
     "Validate redirect destinations against an allowlist of trusted origins."),

    (HIGH, "Open redirect: location.replace/assign from variable",
     r'location\.(replace|assign)\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]',
     "location.replace/assign with a variable — potential open redirect.",
     "Validate all redirect URLs against a strict allowlist."),

    # ── CSRF via fetch/XHR ────────────────────────────────────────────────────
    (MEDIUM, "CSRF: fetch POST without CSRF header check",
     r'fetch\s*\([^)]*,\s*\{[^}]*method\s*:\s*["\']POST["\'](?![^}]*(?:csrf|xsrf|x-requested-with))',
     "fetch POST request with no visible CSRF token or X-Requested-With header.",
     "Include a CSRF token header (e.g. X-CSRF-Token) on all state-changing requests."),

    (MEDIUM, "CSRF: XMLHttpRequest open POST",
     r'\.open\s*\(\s*["\']POST["\']',
     "XHR POST — ensure a CSRF token header is set before send().",
     "Call xhr.setRequestHeader('X-CSRF-Token', token) before every state-changing XHR."),

    # ── postMessage ───────────────────────────────────────────────────────────
    (HIGH, "postMessage: listener without origin check",
     r'addEventListener\s*\(\s*["\']message["\']',
     "postMessage listener detected — must validate event.origin before processing.",
     "Always check event.origin against an explicit allowlist in message handlers."),

    (HIGH, "postMessage: sent with wildcard targetOrigin",
     r'\.postMessage\s*\([^,)]+,\s*["\'][*]["\']',
     "postMessage sent with targetOrigin='*' — any page can receive this message.",
     "Always specify an explicit trusted origin instead of '*'."),

    # ── DOM Clobbering ────────────────────────────────────────────────────────
    (MEDIUM, "DOM clobbering: global variable from DOM id",
     r'\bwindow\[["\'][a-zA-Z][a-zA-Z0-9_-]*["\']\]',
     "Accessing window[name] by string can be clobbered by HTML elements with matching id/name.",
     "Use let/const scoped variables; avoid relying on global HTML element references."),

    # ── JSONP ─────────────────────────────────────────────────────────────────
    (HIGH, "JSONP: callback parameter in URL",
     r'[?&]callback\s*=\s*[a-zA-Z_$][a-zA-Z0-9_$.]*',
     "JSONP callback parameter — attacker can control function name for arbitrary JS execution.",
     "Replace JSONP with CORS-enabled JSON APIs. If JSONP is unavoidable, strictly validate the callback name."),

    # ── Insecure Randomness ───────────────────────────────────────────────────
    (HIGH, "Insecure randomness: Math.random()",
     r'\bMath\.random\s*\(',
     "Math.random() is not cryptographically secure.",
     "Use crypto.getRandomValues() or crypto.randomUUID() for tokens/IDs."),

    # ── Supply Chain ──────────────────────────────────────────────────────────
    (HIGH, "Supply chain: Polyfill.io reference",
     r'polyfill\.io',
     "Polyfill.io was compromised in a July 2024 supply-chain attack affecting 380k+ sites.",
     "Remove polyfill.io. Self-host polyfills or use Cloudflare's mirror."),

    (HIGH, "Outdated jQuery < 3.5",
     r'jquery[.\-](?:1\.|2\.|3\.[0-4]\.)',
     "jQuery < 3.5.0 has XSS vulns (CVE-2020-11023, on CISA exploited catalog 2025).",
     "Upgrade to jQuery 3.7.x or later."),

    (MEDIUM, "Outdated Lodash < 4.17.21",
     r'lodash[.\-](?:0\.|1\.|2\.|3\.|4\.(?:0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17\.(?:0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20))\b)',
     "Lodash < 4.17.21 has prototype pollution and command injection CVEs.",
     "Upgrade to Lodash 4.17.21+."),

    # ── Sensitive Data Logging ────────────────────────────────────────────────
    (LOW, "Debug: console.log left in code",
     r'\bconsole\.log\s*\(',
     "console.log can expose internal data in production.",
     "Remove debug logging before production deployment."),

    (MEDIUM, "Debug: logging sensitive data",
     r'console\.(?:error|warn|info|log|debug)\s*\([^)]*(?:password|token|secret|key|ssn|credit)',
     "Logging call may expose sensitive values.",
     "Sanitize or remove sensitive data from all logging calls."),

    # ── Dangerous Patterns ────────────────────────────────────────────────────
    (MEDIUM, "Potential ReDoS: nested quantifiers in dynamic regex",
     r'new\s+RegExp\s*\([^)]*(?:[+*]){2,}',
     "Nested quantifiers in dynamic regex may cause catastrophic backtracking (ReDoS).",
     "Test regexes with vuln-regex-detector; avoid nested quantifiers."),

    (MEDIUM, "Client-side template injection: Angular/Vue expression in string",
     r'["\'].*\{\{.*\}\}.*["\']',
     "Template expression syntax in a string literal — potential CSTI if rendered by Angular/Vue.",
     "Never pass user input into Angular/Vue template contexts; sanitize and escape all user data."),

    (LOW, "Disabled certificate/TLS verification",
     r'(?i)(rejectUnauthorized|verify)\s*:\s*false',
     "TLS/SSL certificate verification disabled — MITM risk.",
     "Never set rejectUnauthorized:false in production. Fix the certificate chain instead."),

    (LOW, "window.opener not nulled on external link",
     r'window\.open\s*\([^)]*\)',
     "window.open without setting opener to null — target page can access window.opener.",
     "Use window.open(...); then set the returned ref.opener = null, or add rel='noopener' on links."),
]


# ══════════════════════════════════════════════════════════════════════════════
#  HTML RULES
# ══════════════════════════════════════════════════════════════════════════════
HTML_RULES = [

    # ── XSS Sinks ─────────────────────────────────────────────────────────────
    (CRITICAL, "XSS: javascript: in href",
     r'(?i)href\s*=\s*["\']javascript\s*:',
     "javascript: href executes code on click.",
     "Remove all javascript: hrefs. Use <button> with addEventListener."),

    (CRITICAL, "XSS: inline event handler",
     r'(?i)\bon(?:click|load|error|input|change|mouseover|submit|keydown|keyup|focus|blur|dblclick|mousedown|mouseup|contextmenu|drag|drop|paste|copy|cut)\s*=\s*["\'][^"\']+["\']',
     "Inline event handlers are XSS vectors and bypass CSP (without nonces).",
     "Move handlers to external JS and attach with addEventListener."),

    (CRITICAL, "XSS: data: URI in src/href",
     r'(?i)(?:src|href)\s*=\s*["\']data:text/html',
     "data:text/html URI in src/href executes embedded HTML/JS.",
     "Disallow data: URIs in src/href; validate all dynamic URL values."),

    # ── CSP Issues ────────────────────────────────────────────────────────────
    (CRITICAL, "CSP: unsafe-inline scripts",
     r'(?i)content-security-policy[^>]*script-src[^>]*unsafe-inline',
     "CSP allows unsafe-inline scripts — completely neutralises XSS protection.",
     "Remove 'unsafe-inline'. Use nonces or hashes for inline scripts."),

    (CRITICAL, "CSP: unsafe-eval",
     r'(?i)content-security-policy[^>]*unsafe-eval',
     "CSP allows unsafe-eval, permitting eval() and related sinks.",
     "Remove 'unsafe-eval'. Refactor any eval() usage."),

    (HIGH, "CSP: wildcard source (*)",
     r'(?i)content-security-policy[^>]*(?:script-src|default-src)[^>]*\*',
     "CSP uses wildcard (*) source — allows scripts from any origin.",
     "Restrict script-src and default-src to explicit trusted origins only."),

    # ── Hardcoded Credentials ─────────────────────────────────────────────────
    (CRITICAL, "Hardcoded credential in HTML",
     r'(?i)(?:password|secret|api[_-]?key)\s*=\s*[^\s"\'<>]{4,}',
     "Possible hardcoded credential or API key in HTML source.",
     "Remove immediately. Rotate any exposed credentials."),

    # ── Mixed Content ─────────────────────────────────────────────────────────
    (HIGH, "Mixed content: HTTP resource",
     r'(?i)(?:src|href|action)\s*=\s*["\']http://',
     "HTTP resource on an HTTPS page — mixed content, susceptible to MITM.",
     "Change all resource URLs to HTTPS."),

    # ── iframe Security ───────────────────────────────────────────────────────
    (HIGH, "iframe without sandbox",
     r'(?i)<iframe(?![^>]*sandbox)[^>]*>',
     "iframe without sandbox attribute allows full JS execution in embedded content.",
     "Add sandbox attribute to all iframes (e.g. sandbox='allow-scripts')."),

    (HIGH, "iframe: allow-scripts + allow-same-origin combined",
     r'(?i)sandbox\s*=\s*["\'][^"\']*allow-same-origin[^"\']*allow-scripts',
     "Combining allow-same-origin and allow-scripts negates the iframe sandbox.",
     "Remove allow-same-origin when loading untrusted iframe content."),

    # ── Supply Chain: SRI ─────────────────────────────────────────────────────
    (HIGH, "Supply chain: external script without SRI",
     r'(?i)<script[^>]*src\s*=\s*["\']https?://(?!(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)[^"\']*integrity)[^"\']*["\'](?![^>]*integrity)',
     "External script loaded without Subresource Integrity (integrity attribute).",
     "Add integrity='sha384-...' and crossorigin='anonymous' to all external <script> tags."),

    (HIGH, "Supply chain: external stylesheet without SRI",
     r'(?i)<link[^>]*rel\s*=\s*["\']stylesheet["\'][^>]*href\s*=\s*["\']https?://[^"\']*["\'](?![^>]*integrity)',
     "External stylesheet loaded without Subresource Integrity (integrity attribute).",
     "Add integrity and crossorigin attributes to all third-party <link> tags."),

    # ── Open Redirect via meta refresh ────────────────────────────────────────
    (HIGH, "Open redirect: meta http-equiv refresh with URL",
     r'(?i)<meta[^>]*http-equiv\s*=\s*["\']refresh["\'][^>]*url\s*=\s*(?:https?|//)',
     "Meta refresh redirect to an external URL — potential phishing/open redirect.",
     "Avoid meta refresh redirects to external URLs; validate all redirect targets."),

    # ── Clickjacking ──────────────────────────────────────────────────────────
    (MEDIUM, "Clickjacking: framebusting JS instead of headers",
     r'(?i)(?:top|parent|self)\.location\s*(?:!==?|===?)\s*(?:window\.)?location',
     "JS framebusting is bypassable; use X-Frame-Options or CSP frame-ancestors instead.",
     "Set X-Frame-Options: DENY and CSP frame-ancestors 'none' as server headers."),

    # ── target=_blank ─────────────────────────────────────────────────────────
    (MEDIUM, "target=_blank without rel=noopener",
     r'(?i)target\s*=\s*["\']_blank["\'](?![^>]*rel\s*=\s*["\'][^"\']*noopener)',
     "target='_blank' without rel='noopener noreferrer' — new page accesses window.opener.",
     "Add rel='noopener noreferrer' to all target='_blank' links."),

    # ── CSRF ──────────────────────────────────────────────────────────────────
    (MEDIUM, "CSRF: POST form without CSRF token",
     r'(?i)<form[^>]*method\s*=\s*["\']post["\'][^>]*>(?:(?!csrf|xsrf|_token).){0,500}?</form>',
     "POST form with no visible CSRF token field.",
     "Add a hidden CSRF token to every state-changing form."),

    # ── Sensitive Info Leakage ────────────────────────────────────────────────
    (MEDIUM, "HTML comment with sensitive info",
     r'(?i)<!--[^-]*(?:password|secret|token|key|todo.?fix|hack|internal|prod|staging)[^-]*-->',
     "HTML comment may contain sensitive info visible in page source.",
     "Remove all sensitive comments before production deployment."),

    (MEDIUM, "autocomplete not disabled on sensitive fields",
     r'(?i)<input[^>]*(?:type\s*=\s*["\']password["\']|name\s*=\s*["\'](?:card|ssn|cvv|pin|secret)["\'])[^>]*(?!autocomplete\s*=\s*["\']off["\'])',
     "Sensitive input field without autocomplete='off' — browser may cache value.",
     "Add autocomplete='off' to password and sensitive data fields."),

    # ── Input Validation ──────────────────────────────────────────────────────
    (LOW, "Input without type attribute",
     r'(?i)<input(?![^>]*\btype\b)[^>]*/?>',
     "Input with no type defaults to text — may skip appropriate validation.",
     "Always specify type on <input> elements."),

    (LOW, "Input file without accept attribute",
     r'(?i)<input[^>]*type\s*=\s*["\']file["\'](?![^>]*accept\s*=)',
     "File input without accept attribute — no client-side file type restriction.",
     "Add accept attribute to file inputs to restrict uploadable file types."),

    (LOW, "form action pointing to HTTP",
     r'(?i)<form[^>]*action\s*=\s*["\']http://',
     "Form submits credentials/data over plain HTTP.",
     "Change all form action URLs to HTTPS."),
]


# ══════════════════════════════════════════════════════════════════════════════
#  CSS RULES
# ══════════════════════════════════════════════════════════════════════════════
CSS_RULES = [

    # ── CSS Injection / Exfiltration ──────────────────────────────────────────
    (CRITICAL, "CSS injection: expression() — IE RCE",
     r'(?i)expression\s*\(',
     "CSS expression() is an IE-era arbitrary JS execution vector.",
     "Remove all CSS expression() calls immediately."),

    (HIGH, "CSS exfiltration: attribute selector with external url()",
     r'(?i)\[[^\]]*=[^\]]*\]\s*\{[^}]*url\s*\(',
     "CSS attribute selector combined with url() — classic CSS Exfil data exfiltration pattern.",
     "Ensure no user-controlled CSS reaches the page; use strict CSP style-src."),

    (HIGH, "CSS injection: user-controlled style block pattern",
     r'(?i)style\s*=\s*["\'][^"\']*url\s*\(',
     "Inline style with url() — if user-controlled, enables CSS-based data exfiltration.",
     "Never allow user input to reach style attributes without strict sanitization."),

    # ── Mixed Content / MITM ──────────────────────────────────────────────────
    (HIGH, "CSS: @import over HTTP",
     r'@import\s+(?:url\s*\(\s*)?["\']?http://',
     "@import over HTTP is susceptible to MITM and stylesheet injection.",
     "Use HTTPS for all @import URLs, or self-host stylesheets."),

    (MEDIUM, "CSS: background-image over HTTP",
     r'background(?:-image)?\s*:\s*url\s*\(\s*["\']?http://',
     "Background image loaded over HTTP — mixed content, MITM risk.",
     "Use HTTPS URLs for all background-image values."),

    (MEDIUM, "CSS: any url() over HTTP",
     r'(?<!\w)url\s*\(\s*["\']?http://',
     "CSS resource loaded over plain HTTP.",
     "Use HTTPS for all CSS url() references."),

    # ── Untrusted External Imports ────────────────────────────────────────────
    (HIGH, "CSS: @import from unlisted external origin",
     r'@import\s+(?:url\s*\(\s*)?["\']?https?://(?!(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|use\.typekit\.net))',
     "@import from an external origin outside commonly trusted CDNs.",
     "Review all external stylesheet imports; prefer self-hosting."),

    (HIGH, "CSS: dynamic url() with variable-like value",
     r'url\s*\(\s*(?!data:|["\'](?:data:|https?:|/))[^)]*[a-zA-Z_$][^)]*\)',
     "Dynamic url() value may be injectable — CSS data-exfiltration vector.",
     "Ensure all url() values are static, sanitized, and from trusted origins only."),

    # ── Clickjacking Aids ─────────────────────────────────────────────────────
    (MEDIUM, "CSS: extreme z-index — overlay/clickjacking risk",
     r'z-index\s*:\s*(?:[1-9]\d{5,}|9999[0-9]+)',
     "Extreme z-index may indicate a clickjacking overlay or UI redressing.",
     "Audit high z-index elements to confirm they aren't hiding legitimate UI."),

    (LOW, "CSS: pointer-events: none — potential clickjacking aid",
     r'pointer-events\s*:\s*none',
     "pointer-events: none on interactive elements can aid UI redressing/clickjacking.",
     "Audit all pointer-events:none; ensure it's not hiding malicious overlays."),

    (LOW, "CSS: opacity:0 on interactive element — potential clickjacking",
     r'opacity\s*:\s*0(?:\.0+)?\b',
     "opacity:0 can hide elements for clickjacking / invisible form overlays.",
     "Audit all opacity:0 usage on interactive elements."),

    # ── Content-based Exfil ────────────────────────────────────────────────────
    (MEDIUM, "CSS: content:attr() — attribute value exposure",
     r'content\s*:\s*attr\s*\([^)]+\)',
     "content:attr() renders HTML attribute values — can visually expose injected data.",
     "Validate dynamic content property sources; avoid user-controlled attribute injection."),

    # ── Fonts / Custom Resources ──────────────────────────────────────────────
    (MEDIUM, "CSS: @font-face with HTTP src",
     r'@font-face\s*\{[^}]*src\s*:[^}]*url\s*\(\s*["\']?http://',
     "Custom font loaded over HTTP — MITM risk, and potential font-ligature data exfil vector.",
     "Serve all fonts over HTTPS; self-host if possible."),
]


# ══════════════════════════════════════════════════════════════════════════════
#  ABSENCE CHECKS (whole-file patterns that should be PRESENT)
# ══════════════════════════════════════════════════════════════════════════════
def check_html_absences(filepath):
    findings = []
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        head = f.read(80_000)

    fname = str(Path(filepath))

    checks = [
        (r'(?i)content-security-policy',
         HIGH, "Missing Content-Security-Policy",
         "No CSP meta tag or header reference found in the HTML.",
         "Add a strict CSP. Server-side header is preferred over meta tag."),

        (r'(?i)x-frame-options|frame-ancestors',
         MEDIUM, "Missing X-Frame-Options / CSP frame-ancestors",
         "No clickjacking protection header found (X-Frame-Options or CSP frame-ancestors).",
         "Set X-Frame-Options: DENY and/or CSP frame-ancestors 'none' as server headers."),

        (r'(?i)x-content-type-options',
         LOW, "Missing X-Content-Type-Options",
         "No X-Content-Type-Options: nosniff found.",
         "Add X-Content-Type-Options: nosniff as an HTTP response header."),

        (r'(?i)referrer-policy',
         LOW, "Missing Referrer-Policy",
         "No Referrer-Policy found in HTML.",
         "Add Referrer-Policy: strict-origin-when-cross-origin."),

        (r'(?i)strict-transport-security',
         MEDIUM, "Missing Strict-Transport-Security (HSTS)",
         "No HSTS header reference found — sessions may be downgraded to HTTP.",
         "Add Strict-Transport-Security: max-age=31536000; includeSubDomains; preload."),

        (r'(?i)permissions-policy|feature-policy',
         LOW, "Missing Permissions-Policy",
         "No Permissions-Policy header reference found.",
         "Add Permissions-Policy to restrict access to browser APIs (camera, mic, geolocation)."),
    ]

    for pattern, sev, cat, desc, rec in checks:
        if not re.search(pattern, head):
            findings.append(Finding(sev, cat, desc, fname, 0, "(whole file)", rec))
    return findings


# ══════════════════════════════════════════════════════════════════════════════
#  SCANNER ENGINE
# ══════════════════════════════════════════════════════════════════════════════
CHUNK_SIZE = 500

def scan_file_chunked(filepath, rules):
    findings = []
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        chunk, offset = [], 0
        for line in f:
            chunk.append(line)
            if len(chunk) >= CHUNK_SIZE:
                findings += _scan_chunk(chunk, offset, str(filepath), rules)
                offset += len(chunk)
                chunk = []
        if chunk:
            findings += _scan_chunk(chunk, offset, str(filepath), rules)
    return findings


def _scan_chunk(lines, offset, filepath, rules):
    results = []
    for i, line in enumerate(lines):
        stripped = line.rstrip()
        for severity, category, pattern, description, recommendation in rules:
            try:
                if re.search(pattern, stripped, re.IGNORECASE):
                    results.append(Finding(
                        severity=severity, category=category,
                        description=description, file=filepath,
                        line_no=offset + i + 1,
                        line_content=stripped[:200],
                        recommendation=recommendation,
                    ))
            except re.error:
                pass
    return results


# ══════════════════════════════════════════════════════════════════════════════
#  REPORT
# ══════════════════════════════════════════════════════════════════════════════
SEVERITY_ORDER = {CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3}

def print_report(all_findings, root):
    sorted_f = sorted(all_findings,
                      key=lambda f: (SEVERITY_ORDER.get(f.severity, 9), f.file, f.line_no))
    counts = defaultdict(int)
    for f in sorted_f:
        counts[f.severity] += 1

    print("\n" + "=" * 72)
    print("  SECURITY VULNERABILITY SCAN REPORT")
    print("=" * 72)
    print(f"  Project : {root}")
    print(f"  Total   : {len(all_findings)} finding(s)")
    for sev in [CRITICAL, HIGH, MEDIUM, LOW]:
        if counts[sev]:
            print(f"    {SEVERITY_ICON[sev]} {sev}: {counts[sev]}")
    print("=" * 72)

    current_sev = None
    for f in sorted_f:
        if f.severity != current_sev:
            current_sev = f.severity
            icon = SEVERITY_ICON.get(f.severity, "")
            print(f"\n{'─' * 72}")
            print(f"  {icon} {f.severity} FINDINGS")
            print(f"{'─' * 72}")

        ref = f"line {f.line_no}" if f.line_no > 0 else "whole file"
        # Show path relative to root for readability
        try:
            display_path = str(Path(f.file).relative_to(root))
        except ValueError:
            display_path = f.file

        print(f"\n  [{f.category}]")
        print(f"  File   : {display_path} ({ref})")
        print(f"  Issue  : {f.description}")
        if f.line_no > 0:
            print(f"  Code   : {f.line_content.strip()[:120]}")
        print(f"  Fix    : {f.recommendation}")

    print("\n" + "=" * 72)
    print(f"  END OF REPORT — {len(all_findings)} finding(s) across {root}")
    print("=" * 72 + "\n")


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════
EXT_MAP = {
    ".js":   (JS_RULES,   "JS"),
    ".mjs":  (JS_RULES,   "JS"),
    ".cjs":  (JS_RULES,   "JS"),
    ".jsx":  (JS_RULES,   "JS"),
    ".ts":   (JS_RULES,   "JS"),   # TypeScript shares the same sinks
    ".tsx":  (JS_RULES,   "JS"),
    ".html": (HTML_RULES, "HTML"),
    ".htm":  (HTML_RULES, "HTML"),
    ".css":  (CSS_RULES,  "CSS"),
}

PROJECT_ROOT = Path(r"C:\Users\diraz\Downloads\novabyte-os\NBOSP")

SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", ".cache",
    "__pycache__", ".venv", "venv", ".next", "out",
    "coverage", ".turbo", ".parcel-cache",
}


def collect_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext in EXT_MAP:
                yield Path(dirpath) / fname, *EXT_MAP[ext]


def main():
    root = PROJECT_ROOT
    if len(sys.argv) > 1:
        root = Path(sys.argv[1])

    if not root.exists():
        print(f"ERROR: Project root not found: {root}", file=sys.stderr)
        sys.exit(1)

    print(f"\nScanning project : {root}")
    print(f"File types       : .js .mjs .cjs .jsx .ts .tsx .html .htm .css")
    print(f"Skipping dirs    : {', '.join(sorted(SKIP_DIRS))}\n")

    all_findings, file_count = [], 0

    for fpath, rules, label in collect_files(root):
        file_count += 1
        try:
            rel = fpath.relative_to(root)
        except ValueError:
            rel = fpath
        size_kb = fpath.stat().st_size / 1024
        print(f"  Scanning {rel} ({size_kb:.1f} KB) [{label}]...")

        findings = scan_file_chunked(str(fpath), rules)
        if label == "HTML":
            findings += check_html_absences(str(fpath))

        print(f"    → {len(findings)} finding(s)")
        all_findings.extend(findings)

    if file_count == 0:
        print(f"  ⚠  No scannable files found under {root}", file=sys.stderr)
        sys.exit(0)

    print(f"\n  {file_count} file(s) scanned.")
    print_report(all_findings, root)


if __name__ == "__main__":
    main()