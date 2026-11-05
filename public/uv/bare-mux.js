var BareMux = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/@mercuryworkshop/bare-mux/dist/index.mjs
  var index_exports = {};
  __export(index_exports, {
    BareClient: () => k,
    BareMuxConnection: () => m,
    BareWebSocket: () => w,
    WebSocketFields: () => n,
    WorkerConnection: () => p,
    browserSupportsTransferringStreams: () => d,
    default: () => k,
    maxRedirects: () => e,
    validProtocol: () => f
  });
  var e = 20;
  var t = globalThis.fetch;
  var r = globalThis.SharedWorker;
  var a = globalThis.localStorage;
  var s = globalThis.navigator.serviceWorker;
  var o = MessagePort.prototype.postMessage;
  var n = { prototype: { send: WebSocket.prototype.send }, CLOSED: WebSocket.CLOSED, CLOSING: WebSocket.CLOSING, CONNECTING: WebSocket.CONNECTING, OPEN: WebSocket.OPEN };
  async function c() {
    const e2 = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).map(async (e3) => {
      const t3 = await (function(e4) {
        let t4 = new MessageChannel();
        return new Promise((r2) => {
          e4.postMessage({ type: "getPort", port: t4.port2 }, [t4.port2]), t4.port1.onmessage = (e5) => {
            r2(e5.data);
          };
        });
      })(e3);
      return await i(t3), t3;
    }), t2 = Promise.race([Promise.any(e2), new Promise((e3, t3) => setTimeout(t3, 1e3, new TypeError("timeout")))]);
    try {
      return await t2;
    } catch (e3) {
      if (e3 instanceof AggregateError) throw console.error("bare-mux: failed to get a bare-mux SharedWorker MessagePort as all clients returned an invalid MessagePort."), new Error("All clients returned an invalid MessagePort.");
      return console.warn("bare-mux: failed to get a bare-mux SharedWorker MessagePort within 1s, retrying"), await c();
    }
  }
  function i(e2) {
    const t2 = new MessageChannel(), r2 = new Promise((e3, r3) => {
      t2.port1.onmessage = (t3) => {
        "pong" === t3.data.type && e3();
      }, setTimeout(r3, 1500);
    });
    return o.call(e2, { message: { type: "ping" }, port: t2.port2 }, [t2.port2]), r2;
  }
  function l(e2, t2) {
    const a2 = new r(e2, "bare-mux-worker");
    return t2 && s.addEventListener("message", (t3) => {
      if ("getPort" === t3.data.type && t3.data.port) {
        console.debug("bare-mux: recieved request for port from sw");
        const a3 = new r(e2, "bare-mux-worker");
        o.call(t3.data.port, a3.port, [a3.port]);
      }
    }), a2.port;
  }
  var h = null;
  function d() {
    if (null === h) {
      const e2 = new MessageChannel(), t2 = new ReadableStream();
      let r2;
      try {
        o.call(e2.port1, t2, [t2]), r2 = true;
      } catch (e3) {
        r2 = false;
      }
      return h = r2, r2;
    }
    return h;
  }
  var p = class {
    constructor(e2) {
      this.channel = new BroadcastChannel("bare-mux"), e2 instanceof MessagePort || e2 instanceof Promise ? this.port = e2 : this.createChannel(e2, true);
    }
    createChannel(e2, t2) {
      if (self.clients) this.port = c(), this.channel.onmessage = (e3) => {
        "refreshPort" === e3.data.type && (this.port = c());
      };
      else if (e2 && SharedWorker) {
        if (!e2.startsWith("/") && !e2.includes(":")) throw new Error("Invalid URL. Must be absolute or start at the root.");
        this.port = l(e2, t2), console.debug("bare-mux: setting localStorage bare-mux-path to", e2), a["bare-mux-path"] = e2;
      } else {
        if (!SharedWorker) throw new Error("Unable to get a channel to the SharedWorker.");
        {
          const e3 = a["bare-mux-path"];
          if (console.debug("bare-mux: got localStorage bare-mux-path:", e3), !e3) throw new Error("Unable to get bare-mux workerPath from localStorage.");
          this.port = l(e3, t2);
        }
      }
    }
    async sendMessage(e2, t2) {
      this.port instanceof Promise && (this.port = await this.port);
      try {
        await i(this.port);
      } catch {
        return console.warn("bare-mux: Failed to get a ping response from the worker within 1.5s. Assuming port is dead."), this.createChannel(), await this.sendMessage(e2, t2);
      }
      const r2 = new MessageChannel(), a2 = [r2.port2, ...t2 || []], s2 = new Promise((e3, t3) => {
        r2.port1.onmessage = (r3) => {
          const a3 = r3.data;
          "error" === a3.type ? t3(a3.error) : e3(a3);
        };
      });
      return o.call(this.port, { message: e2, port: r2.port2 }, a2), await s2;
    }
  };
  var w = class extends EventTarget {
    constructor(e2, t2 = [], r2, a2) {
      super(), this.protocols = t2, this.readyState = n.CONNECTING, this.url = e2.toString(), this.protocols = t2;
      const s2 = (e3) => {
        this.protocols = e3, this.readyState = n.OPEN;
        const t3 = new Event("open");
        this.dispatchEvent(t3);
      }, o2 = async (e3) => {
        const t3 = new MessageEvent("message", { data: e3 });
        this.dispatchEvent(t3);
      }, c2 = (e3, t3) => {
        this.readyState = n.CLOSED;
        const r3 = new CloseEvent("close", { code: e3, reason: t3 });
        this.dispatchEvent(r3);
      }, i2 = () => {
        this.readyState = n.CLOSED;
        const e3 = new Event("error");
        this.dispatchEvent(e3);
      };
      this.channel = new MessageChannel(), this.channel.port1.onmessage = (e3) => {
        "open" === e3.data.type ? s2(e3.data.args[0]) : "message" === e3.data.type ? o2(e3.data.args[0]) : "close" === e3.data.type ? c2(e3.data.args[0], e3.data.args[1]) : "error" === e3.data.type && i2();
      }, r2.sendMessage({ type: "websocket", websocket: { url: e2.toString(), protocols: t2, requestHeaders: a2, channel: this.channel.port2 } }, [this.channel.port2]);
    }
    send(...e2) {
      if (this.readyState === n.CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
      let t2 = e2[0];
      t2.buffer && (t2 = t2.buffer.slice(t2.byteOffset, t2.byteOffset + t2.byteLength)), o.call(this.channel.port1, { type: "data", data: t2 }, t2 instanceof ArrayBuffer ? [t2] : []);
    }
    close(e2, t2) {
      o.call(this.channel.port1, { type: "close", closeCode: e2, closeReason: t2 });
    }
  };
  function u(e2, t2, r2) {
    console.error(`error while processing '${r2}': `, t2), e2.postMessage({ type: "error", error: t2 });
  }
  function f(e2) {
    for (let t2 = 0; t2 < e2.length; t2++) {
      const r2 = e2[t2];
      if (!"!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~".includes(r2)) return false;
    }
    return true;
  }
  var g = ["ws:", "wss:"];
  var y = [101, 204, 205, 304];
  var b = [301, 302, 303, 307, 308];
  var m = class {
    constructor(e2) {
      this.worker = new p(e2);
    }
    async getTransport() {
      return (await this.worker.sendMessage({ type: "get" })).name;
    }
    async setTransport(e2, t2, r2) {
      await this.setManualTransport(`
			const { default: BareTransport } = await import("${e2}");
			return [BareTransport, "${e2}"];
		`, t2, r2);
    }
    async setManualTransport(e2, t2, r2) {
      if ("bare-mux-remote" === e2) throw new Error("Use setRemoteTransport.");
      await this.worker.sendMessage({ type: "set", client: { function: e2, args: t2 } }, r2);
    }
    async setRemoteTransport(e2, t2) {
      const r2 = new MessageChannel();
      r2.port1.onmessage = async (t3) => {
        const r3 = t3.data.port, a2 = t3.data.message;
        if ("fetch" === a2.type) try {
          e2.ready || await e2.init(), await (async function(e3, t4, r4) {
            const a3 = await r4.request(new URL(e3.fetch.remote), e3.fetch.method, e3.fetch.body, e3.fetch.headers, null);
            if (!d() && a3.body instanceof ReadableStream) {
              const e4 = new Response(a3.body);
              a3.body = await e4.arrayBuffer();
            }
            a3.body instanceof ReadableStream || a3.body instanceof ArrayBuffer ? o.call(t4, { type: "fetch", fetch: a3 }, [a3.body]) : o.call(t4, { type: "fetch", fetch: a3 });
          })(a2, r3, e2);
        } catch (e3) {
          u(r3, e3, "fetch");
        }
        else if ("websocket" === a2.type) try {
          e2.ready || await e2.init(), await (async function(e3, t4, r4) {
            const [a3, s2] = r4.connect(new URL(e3.websocket.url), e3.websocket.protocols, e3.websocket.requestHeaders, (t5) => {
              o.call(e3.websocket.channel, { type: "open", args: [t5] });
            }, (t5) => {
              t5 instanceof ArrayBuffer ? o.call(e3.websocket.channel, { type: "message", args: [t5] }, [t5]) : o.call(e3.websocket.channel, { type: "message", args: [t5] });
            }, (t5, r5) => {
              o.call(e3.websocket.channel, { type: "close", args: [t5, r5] });
            }, (t5) => {
              o.call(e3.websocket.channel, { type: "error", args: [t5] });
            });
            e3.websocket.channel.onmessage = (e4) => {
              "data" === e4.data.type ? a3(e4.data.data) : "close" === e4.data.type && s2(e4.data.closeCode, e4.data.closeReason);
            }, o.call(t4, { type: "websocket" });
          })(a2, r3, e2);
        } catch (e3) {
          u(r3, e3, "websocket");
        }
      }, await this.worker.sendMessage({ type: "set", client: { function: "bare-mux-remote", args: [r2.port2, t2] } }, [r2.port2]);
    }
    getInnerPort() {
      return this.worker.port;
    }
  };
  var k = class {
    constructor(e2) {
      this.worker = new p(e2);
    }
    createWebSocket(e2, t2 = [], r2, a2) {
      try {
        e2 = new URL(e2);
      } catch (t3) {
        throw new DOMException(`Faiiled to construct 'WebSocket': The URL '${e2}' is invalid.`);
      }
      if (!g.includes(e2.protocol)) throw new DOMException(`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${e2.protocol}' is not allowed.`);
      Array.isArray(t2) || (t2 = [t2]), t2 = t2.map(String);
      for (const e3 of t2) if (!f(e3)) throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${e3}' is invalid.`);
      a2 = a2 || {};
      return new w(e2, t2, this.worker, a2);
    }
    async fetch(e2, r2) {
      const a2 = new Request(e2, r2), s2 = r2?.headers || a2.headers, o2 = s2 instanceof Headers ? Object.fromEntries(s2) : s2, n2 = a2.body;
      let c2 = new URL(a2.url);
      if (c2.protocol.startsWith("blob:")) {
        const e3 = await t(c2), r3 = new Response(e3.body, e3);
        return r3.rawHeaders = Object.fromEntries(e3.headers), r3.rawResponse = { body: e3.body, headers: Object.fromEntries(e3.headers), status: e3.status, statusText: e3.statusText }, r3.finalURL = c2.toString(), r3;
      }
      for (let e3 = 0; ; e3++) {
        let t2 = (await this.worker.sendMessage({ type: "fetch", fetch: { remote: c2.toString(), method: a2.method, headers: o2, body: n2 || void 0 } }, n2 ? [n2] : [])).fetch, s3 = new Response(y.includes(t2.status) ? void 0 : t2.body, { headers: new Headers(t2.headers), status: t2.status, statusText: t2.statusText });
        s3.rawHeaders = t2.headers, s3.rawResponse = t2, s3.finalURL = c2.toString();
        const i2 = r2?.redirect || a2.redirect;
        if (!b.includes(s3.status)) return s3;
        switch (i2) {
          case "follow": {
            const t3 = s3.headers.get("location");
            if (20 > e3 && null !== t3) {
              c2 = new URL(t3, c2);
              continue;
            }
            throw new TypeError("Failed to fetch");
          }
          case "error":
            throw new TypeError("Failed to fetch");
          case "manual":
            return s3;
        }
      }
    }
  };
  console.debug("bare-mux: running v2.1.8 (build 75b1f5a)");
  return __toCommonJS(index_exports);
})();