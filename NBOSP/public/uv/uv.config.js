/*global Ultraviolet*/
// XOR codec can produce chars like # and ? that break URL parsing:
//   # → browser treats as fragment and STRIPS it from the SW request
//   ? → starts query string
//   % → if raw in path, browser may encode it as %25 (double-encode)
// Fix: escape only those three chars (% first to avoid double-escaping).
// decodeUrl does decodeURIComponent first so it reverses this correctly.
// Do NOT use encodeURIComponent on the whole XOR output — Firefox keeps
// %2F as %2F in paths (doesn't normalise to /), so the XOR decoder would
// then receive the literal chars '%', '2', 'F' and produce garbage.
const _xorEnc = Ultraviolet.codec.xor.encode;
const _xorDec = Ultraviolet.codec.xor.decode;
self.__uv$config = {
    prefix: '/uv/service/',
    encodeUrl: (url) => {
        const xored = _xorEnc(url);
        // Escape % first, then # and ? so they aren't misread by the browser
        return xored.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
    },
    decodeUrl: (encoded) => {
        try { return _xorDec(decodeURIComponent(encoded)); } catch { return _xorDec(encoded); }
    },
    handler: '/uv/uv.handler.js',
    client: '/uv/uv.client.js',
    bundle: '/uv/uv.bundle.js',
    config: '/uv/uv.config.js',
    sw: '/uv/sw.js',
};