const fs = require("node:fs");
const path = require("node:path");
const { friendlyMessage } = require("../lib/messages");
const entries = JSON.parse(fs.readFileSync("generated-artifacts/frontend-copy-changes.json", "utf8"));
for (const name of fs.readdirSync("lib").filter(name => name.endsWith(".js"))) {
  const source = fs.readFileSync(path.join("lib", name), "utf8");
  const patterns = [
    /new JobError\("([A-Z_]+)",\s*"([^"]*)"/g,
    /new JobError\("([A-Z_]+)",\s*`([^`]*)`/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) entries.push({
    screen: "Errors", old: match[2], new: friendlyMessage(match[1]),
    action: "Replaced; technical details kept in sanitized service logs",
  });
}
entries.push(
  {screen:"Setup",old:"Edited · [use case]",new:"",action:"Removed with the reset control"},
  {screen:"Setup",old:"Reset to sample defaults",new:"",action:"Removed with the edited-status row"},
  {screen:"Setup",old:"Experiment setup / Your selections stay in this browser. / Saved on this device",new:"",action:"Removed entire panel; background saving retained"},
  {screen:"Simulation",old:"Provider calls happen only when you click Run baseline or Evaluate transcript. Loading this page, restoring history, and polling never starts a paid call. Before & after comparison is unavailable and coming next.",new:"",action:"Removed entire notice"},
  {screen:"Errors",old:"Could not parse evaluator output. Expected summary, parameters and findings in one JSON object.",new:"We couldn't finish this evaluation. Please try again.",action:"Replaced"},
  {screen:"Errors",old:"Server restarted during this run. Any captured output is partial. Start a new run manually.",new:friendlyMessage("SERVER_RESTARTED"),action:"Replaced"},
  {screen:"Errors",old:"Run output could not be saved to disk.",new:friendlyMessage("STORAGE_FAILURE"),action:"Replaced"},
);
const unique = [...new Map(entries.map(entry => [JSON.stringify([entry.screen,entry.old,entry.new]),entry])).values()];
const escape = value => String(value ?? "").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Product copy changes</title><style>body{margin:0;padding:32px;font:15px/1.5 system-ui,sans-serif;color:#253533;background:#fafaf8}main{max-width:1300px;margin:auto}h1{font-size:28px}p{color:#586a66}table{width:100%;border-collapse:collapse;background:white}th,td{padding:14px;text-align:left;vertical-align:top;border:1px solid #dde4df;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eef3ef}td:first-child{width:110px}td:last-child{width:150px}@media(max-width:650px){body{padding:12px}th,td{padding:8px;font-size:12px}}</style><main><h1>Product copy changes</h1><p>Complete list of ${unique.length} changed, removed, or relocated strings. Technical details are hidden from normal users; they remain available in developer mode where indicated.</p><table><thead><tr><th>Screen</th><th>Previous text</th><th>New text</th><th>Change</th></tr></thead><tbody>${unique.map(entry=>`<tr><td>${escape(entry.screen)}</td><td>${escape(entry.old)}</td><td>${escape(entry.new)||"—"}</td><td>${escape(entry.action)}</td></tr>`).join("")}</tbody></table></main></html>`;
fs.writeFileSync("generated-artifacts/product-copy-changes.html", html);
console.log(`Copy audit generated: ${unique.length} entries.`);
