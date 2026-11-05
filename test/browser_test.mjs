// browser_test.mjs — decode the fixtures with libheif.js in headless Chromium under a page
// whose ONLY CSP is `Content-Security-Policy: script-src 'self'`, and compare to the native
// reference decode. No listening server: the origin is a Playwright page.route fulfilment.
//
//   node test/browser_test.mjs <dir with libheif.js> <fixtures dir> [corpus dir]
//   e.g. node test/browser_test.mjs work/out work/fixtures work/src/libheif-1.23.7/fuzzing/data/corpus
// Needs Node >= 18 and the `playwright` npm package with its Chromium (headless shell).
// Set PWREQ=<path to a package.json> to resolve playwright from another project.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const { chromium } = createRequire(process.env.PWREQ || import.meta.url)("playwright");

const [libDir, fxDir, corpusDir] = process.argv.slice(2);
const ORIGIN = "https://heic-test.invalid";
const CSP = "script-src 'self'";
const fixtures = JSON.parse(fs.readFileSync(path.join(fxDir, "fixtures.json"), "utf8"));
const corpus = corpusDir ? fs.readdirSync(corpusDir).filter(f => /\.(heic|heif)$/.test(f)).sort() : [];

// Same-origin script FILES only (inline <script> would be blocked — that is the point).
const files = {
  "/index.html": ["text/html", '<!doctype html><meta charset="utf-8"><title>t</title>' +
    '<script src="/probe.js"></script><script src="/lib/libheif.js"></script>'],
  "/probe.js": ["text/javascript", `
    self.__violations = [];
    // CSP control from a same-origin script FILE (page.evaluate is DevTools and bypasses CSP).
    try { new Function("return 1"); self.__probeNewFunction = "allowed"; } catch (e) { self.__probeNewFunction = "blocked: " + e.name; }
    try { eval("1"); self.__probeEval = "allowed"; } catch (e) { self.__probeEval = "blocked: " + e.name; }
    try { new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); self.__probeWasm = "allowed"; } catch (e) { self.__probeWasm = "blocked: " + e.name; }
    document.addEventListener("securitypolicyviolation", e =>
      self.__violations.push(e.violatedDirective + " " + e.blockedURI + " " + (e.sample || "")));
    self.__wasmCalls = 0;
    if (self.WebAssembly) for (const k of ["instantiate", "compile", "instantiateStreaming", "compileStreaming"]) {
      const f = WebAssembly[k]; if (f) WebAssembly[k] = function () { self.__wasmCalls++; return f.apply(this, arguments); };
    }
  `],
};
for (const f of ["libheif.js", "heic-worker.js"]) files["/lib/" + f] = ["text/javascript", fs.readFileSync(path.join(libDir, f))];

const browser = await chromium.launch();
const hard = setTimeout(() => { console.log("HARD TIMEOUT"); process.exit(2); }, 15 * 60 * 1000);
const ctx = await browser.newContext({ bypassCSP: false });
const page = await ctx.newPage();
const logs = [];
page.on("console", m => logs.push(m.type() + ": " + m.text().slice(0, 300)));
page.on("pageerror", e => logs.push("pageerror: " + String(e).slice(0, 300)));
const otherRequests = [];   // anything the library fetched on its own (must stay empty)
ctx.on("request", r => { const u = r.url(); if (!/^https:\/\/heic-test\.invalid\/(index\.html|probe\.js|lib\/|fx\/|corpus\/)/.test(u)) otherRequests.push(u.slice(0, 120)); });
await ctx.route(ORIGIN + "/**", async route => {
  const u = new URL(route.request().url());
  const headers = { "Content-Security-Policy": CSP };
  if (files[u.pathname]) {
    const [ct, body] = files[u.pathname];
    return route.fulfill({ status: 200, headers: { ...headers, "Content-Type": ct }, body });
  }
  const m = u.pathname.match(/^\/(fx|corpus)\/([\w.+-]+)$/);
  if (m) {
    const p = path.join(m[1] === "fx" ? fxDir : corpusDir, m[2]);
    if (fs.existsSync(p)) return route.fulfill({ status: 200, headers: { ...headers, "Content-Type": "application/octet-stream" }, body: fs.readFileSync(p) });
  }
  return route.fulfill({ status: 404, headers, body: "nf" });
});
await page.goto(ORIGIN + "/index.html");

// Renderer RSS sampler (the page's renderer = the child chrome process with the largest RSS growth).
function ppidOf(pid) { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return +st.slice(st.lastIndexOf(")") + 2).split(" ")[1]; }
function descendsFromUs(pid) { for (let p = pid, i = 0; p > 1 && i < 20; i++) { p = ppidOf(p); if (p === process.pid) return true; } return false; }
// Renderer processes = chrome processes started with --type=renderer by THIS node process tree.
function rendererPids() {
  const out = [];
  for (const d of fs.readdirSync("/proc").filter(x => /^\d+$/.test(x))) {
    try { const cl = fs.readFileSync(`/proc/${d}/cmdline`, "utf8"); if (cl.includes("--type=renderer") && descendsFromUs(+d)) out.push(+d); } catch {}
  }
  return out;
}
function rssKB(pid) { try { return +fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]; } catch { return 0; } }
async function withPeak(fn) {
  const pids = rendererPids();
  const base = Object.fromEntries(pids.map(p => [p, rssKB(p)]));
  const peak = { ...base };
  const t = setInterval(() => { for (const p of pids) peak[p] = Math.max(peak[p], rssKB(p)); }, 50);
  const r = await fn();
  clearInterval(t);
  for (const p of pids) peak[p] = Math.max(peak[p], rssKB(p));
  const grow = pids.map(p => [peak[p] - base[p], peak[p], base[p]]).sort((a, b) => b[0] - a[0])[0] || [0, 0, 0];
  return { r, peakRssMB: +(grow[1] / 1024).toFixed(1), baseRssMB: +(grow[2] / 1024).toFixed(1), growthMB: +(grow[0] / 1024).toFixed(1) };
}

const results = { csp: CSP, controls: {}, fixtures: [], errors: [], worker: null, corpus: [] };

// Controls: the CSP really is enforced in this page (eval-ish code from the page realm is refused).
results.controls = await page.evaluate(() => {
  let fn = "allowed"; try { new Function("return 1"); } catch (e) { fn = "blocked: " + e.name; }
  return { evaluateNewFunction_devtools: fn, pageScriptNewFunction: self.__probeNewFunction, pageScriptEval: self.__probeEval,
    pageScriptNativeWasm: self.__probeWasm, violationsFromControls: self.__violations.length, heicDecode: typeof HeicDecode, createModuleLeaked: typeof createLibheifModule };
});

for (const fx of fixtures) {
  const m = await withPeak(() => page.evaluate(async (fx) => {
    const buf = new Uint8Array(await (await fetch("/fx/" + fx.file)).arrayBuffer());
    const ref = new Uint8Array(await (await fetch("/fx/" + fx.name + ".ref.rgba")).arrayBuffer());
    const t0 = performance.now();
    let out;
    try { out = await HeicDecode.decode(buf); } catch (e) { return { name: fx.name, error: e.code + " " + e.message }; }
    const ms = performance.now() - t0;
    const im = out[0];
    let maxDiff = 0, se = 0, nDiff = 0;
    const n = Math.min(ref.length, im.rgba.length);
    for (let i = 0; i < n; i++) { const d = Math.abs(im.rgba[i] - ref[i]); if (d) { nDiff++; se += d * d; if (d > maxDiff) maxDiff = d; } }
    const mse = se / n;
    return { name: fx.name, ms: Math.round(ms), width: im.width, height: im.height, hasAlpha: im.hasAlpha,
      imageCount: im.imageCount, sizeMatch: im.width === fx.width && im.height === fx.height && im.rgba.length === ref.length,
      maxDiff, diffBytes: nDiff, psnr: mse === 0 ? "inf" : +(10 * Math.log10(255 * 255 / mse)).toFixed(2), entries: out.length };
  }, fx));
  results.fixtures.push({ ...m.r, peakRendererRssMB: m.peakRssMB, rendererBaseMB: m.baseRssMB, rendererGrowthMB: m.growthMB });
  console.log(JSON.stringify(results.fixtures.at(-1)));
}

// Second 12 MP decode on a warm module (steady-state time).
results.warm12mp = await page.evaluate(async () => {
  const buf = new Uint8Array(await (await fetch("/fx/iphone_grid_4032x3024.heic")).arrayBuffer());
  const t0 = performance.now(); await HeicDecode.decode(buf); return Math.round(performance.now() - t0);
});

// Clean-error paths.
results.errors = await page.evaluate(async () => {
  const grid = new Uint8Array(await (await fetch("/fx/iphone_grid_4032x3024.heic")).arrayBuffer());
  const tries = {
    pixelCap10MP: () => HeicDecode.decode(grid, { maxPixels: 10_000_000 }),
    byteCap1MB: () => HeicDecode.decode(grid, { maxBytes: 1_000_000 }),
    garbage: () => HeicDecode.decode(new Uint8Array(4096).fill(7)),
    truncatedHalf: () => HeicDecode.decode(grid.slice(0, grid.length >> 1)),
    truncatedHalfLenient: () => HeicDecode.decode(grid.slice(0, grid.length >> 1), { lenient: true }),
    truncatedHeader: () => HeicDecode.decode(grid.slice(0, 600)),
    notBytes: () => HeicDecode.decode("x"),
  };
  const out = {};
  for (const [k, f] of Object.entries(tries)) {
    const t0 = performance.now();
    try { const r = await f(); out[k] = "RESOLVED " + r[0].width + "x" + r[0].height; }
    catch (e) { out[k] = (e.code || "?") + ": " + String(e.message).slice(0, 120); }
    out[k] += " (" + Math.round(performance.now() - t0) + " ms)";
  }
  // and the module still works afterwards
  try { const r = await HeicDecode.decode(new Uint8Array(await (await fetch("/fx/alpha_800x600.heic")).arrayBuffer())); out.afterErrors = "ok " + r[0].width + "x" + r[0].height; }
  catch (e) { out.afterErrors = "FAIL " + e.code; }
  return out;
});

// Same-origin worker FILE.
results.worker = await withPeak(() => page.evaluate(async () => {
  const buf = await (await fetch("/fx/iphone_grid_4032x3024.heic")).arrayBuffer();
  const ref = new Uint8Array(await (await fetch("/fx/iphone_grid_4032x3024.ref.rgba")).arrayBuffer());
  const w = new Worker("/lib/heic-worker.js");
  const t0 = performance.now();
  const d = await new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => rej(new Error("worker error: " + e.message)); w.postMessage({ id: 1, buffer: buf }, [buf]); });
  const ms = performance.now() - t0;
  w.terminate();
  if (!d.ok) return { error: d.error };
  const im = d.images[0];
  let maxDiff = 0; for (let i = 0; i < ref.length; i++) { const x = Math.abs(im.rgba[i] - ref[i]); if (x > maxDiff) maxDiff = x; }
  return { ms: Math.round(ms), width: im.width, height: im.height, maxDiff, version: d.version, transferredType: im.rgba.constructor.name };
}));
console.log("worker", JSON.stringify(results.worker));

// Robustness: upstream fuzz/test corpus — every file must resolve or reject cleanly (no hang).
for (const f of corpus) {
  const r = await page.evaluate(async (f) => {
    const buf = new Uint8Array(await (await fetch("/corpus/" + f)).arrayBuffer());
    const t0 = performance.now();
    const p = HeicDecode.decode(buf).then(r => "ok " + r[0].width + "x" + r[0].height, e => e.code + ": " + String(e.message).slice(0, 90));
    const to = new Promise(res => setTimeout(() => res("TIMEOUT 30s"), 30000));
    const s = await Promise.race([p, to]);
    return s + " (" + Math.round(performance.now() - t0) + " ms)";
  }, f);
  results.corpus.push([f, r]);
}

results.violations = await page.evaluate(() => self.__violations);
results.wasmCalls = await page.evaluate(() => self.__wasmCalls);
results.version = await page.evaluate(() => HeicDecode.version);
results.otherRequests = otherRequests;
results.logs = logs.filter(l => !/^(log|debug):/.test(l)).slice(0, 30);
clearTimeout(hard);
await browser.close();
console.log("RESULTS " + JSON.stringify(results, null, 1));
