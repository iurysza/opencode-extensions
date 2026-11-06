#!/usr/bin/env node
// Required CI capability probe. No CLI fixtures, SDK imports, credentials or paid calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, requireIsolationTools, sandboxCommand, sandboxedSpawn } from "../isolation.mjs";

const die = message => { throw new Error(`ISOLATION FAIL-CLOSED: ${message}`); };
requireIsolationTools(die);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
mkdirSync(join(repo, ".fixtures"), { recursive: true });
const root = mkdtempSync(join(repo, ".fixtures/isolation-probe-"));
const base = join(root, "base");
const extra = join(root, 'extra-"quoted\\denied');
const cwd = process.cwd();
const servers = [];
let child, timer;
try {
  mkdirSync(extra); writeFileSync(join(extra, "fixture"), "fixture-only\n");
  prepareIsolatedBase(base, "capability", die, { extraReadDenials: [extra] });
  symlinkSync(join(base, "denied-probe"), join(base, "denied-link"));
  process.chdir(base); // Short relative unix-socket name, even in a long checkout path.
  const endpoints = [];
  for (const host of ["127.0.0.1", "::1", "unix"]) {
    const server = createServer(socket => socket.end("private-loopback\n")); servers.push(server);
    await new Promise((ok, fail) => { server.once("error", fail); host === "unix" ? server.listen("./probe.sock", ok) : server.listen(0, host, ok); });
    endpoints.push(host === "unix" ? { path: "./probe.sock" } : { host, port: server.address().port });
  }
  const script = `
    const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');
    const [base,extra,endpoints]=process.argv.slice(1);
    function denied(path){assert.throws(()=>fs.readFileSync(path),e=>['EACCES','EPERM'].includes(e.code));}
    denied(base+'/denied-probe');denied(base+'/denied-link');denied(extra+'/fixture');
    assert.equal(process.env.HOME,base+'/home');assert.equal(process.env.XDG_CONFIG_HOME,base+'/config');
    assert.equal(process.env.CURSOR_API_KEY,undefined);assert.equal(process.env.ISOLATION_FAKE_MARKER,undefined);
    if(process.platform==='linux'){
      denied('/proc/1/root'+base+'/denied-probe');denied('/proc/self/root'+extra+'/fixture');
      for(const line of fs.readFileSync('/proc/self/status','utf8').split('\\n').filter(x=>/^Cap(Inh|Prm|Eff|Amb):/.test(x)))assert.match(line,/:\\s+0+$/);
      for(const fd of fs.readdirSync('/proc/self/fd')){let link;try{link=fs.readlinkSync('/proc/self/fd/'+fd)}catch{continue}assert.ok(!/^(net|pid):\\[/.test(link));}
      const targets=[base+'/denied-probe',extra,...fs.readdirSync(base+'/.isolation-masks').map(x=>base+'/.isolation-masks/'+x)];
      for(const path of targets){
        assert.throws(()=>fs.chmodSync(path,0o700),e=>['EROFS','EPERM','EACCES'].includes(e.code));
        assert.throws(()=>fs.renameSync(path,path+'.moved'),e=>['EROFS','EBUSY','EPERM','EACCES'].includes(e.code));
      }
    }
    function connect(endpoint,external=false){return new Promise((ok,fail)=>{
      const s=net.connect(endpoint);let data='';const end=e=>{s.destroy();e?fail(e):ok()};
      s.on('data',x=>data+=x);s.once('end',()=>end(external||data!=='private-loopback\\n'?Error('unexpected connection'):null));
      s.once('error',e=>end(external&&['EPERM','EACCES',...(process.platform==='linux'?['ENETUNREACH','EHOSTUNREACH']:[])].includes(e.code)?null:e));
      s.setTimeout(2000,()=>end(Error('connection timeout is not denial proof')));
      if(external)s.once('connect',()=>end(Error('external connection allowed')));
    })}
    (async()=>{for(const e of JSON.parse(endpoints))await connect(e);for(const host of ['192.0.2.1','2001:db8::1'])await connect({host,port:80},true);console.log(JSON.stringify({pass:true}))})().catch(()=>{console.error('child capability proof failed');process.exitCode=2});
  `;
  child = sandboxedSpawn(base, process.execPath, ["-e", script, base, extra, JSON.stringify(endpoints)], base);
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 10000);
  const status = await new Promise((ok, fail) => { child.once("error", fail); child.once("close", ok); });
  clearTimeout(timer); child = undefined;
  assert.equal(status, 0, `child capability proof failed: ${stderr.slice(0, 300)}`);
  assert.equal(JSON.parse(stdout).pass, true);
  if (process.platform === "linux") {
    const marker = `isolation-descendant-${process.pid}-${Date.now()}`;
    const app = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[1]],{detached:true,stdio:'ignore'});child.once('spawn',()=>console.log('descendant-ready'));setInterval(()=>{},1000);`;
    const invocation = sandboxCommand(base, process.execPath, ["-e", app, marker]);
    const timed = spawnSync(invocation.command, invocation.args, { cwd: base, encoding: "utf8", timeout: 1500, killSignal: "SIGKILL" });
    assert.equal(timed.error?.code, "ETIMEDOUT");
    assert.ok(timed.stdout?.includes("descendant-ready"), "timeout proof did not start its descendant");
    // This /proc is already private to the trusted driver, never the host process list.
    const survivors = () => readdirSync("/proc").filter(pid => /^\d+$/u.test(pid)).filter(pid => {
      try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker); } catch { return false; }
    });
    const deadline = Date.now() + 5000;
    while (survivors().length && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
    assert.equal(survivors().length, 0, "timeout left a detached sandbox descendant");
  }
  console.log(JSON.stringify({ pass: true, backend: process.platform === "linux" ? "bubblewrap" : "sandbox-exec", checks: { filesystemReadDenial: true, symlinkDenial: true, extraPolicyDenial: true, cleanEnvironment: true, driverIPv4: true, driverIPv6: true, unixSocket: true, externalIPv4Denied: true, externalIPv6Denied: true, ...(process.platform === "linux" ? { privateProc: true, immutableMasks: true, droppedCapabilities: true, bootstrapDescriptorsClosed: true, timeoutDescendantCleanup: true } : {}) } }));
} finally {
  clearTimeout(timer);
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
}
