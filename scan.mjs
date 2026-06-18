// Enforcer Radar engine: scans public buying signals, merges into an accumulating leads.json.
// Runs in GitHub Actions on a schedule. No keys needed beyond the Actions GITHUB_TOKEN.
import { readFileSync, writeFileSync, existsSync } from "fs";

const GH = process.env.GH_TOKEN || "";
const now = Date.now();

const KW = [
  { re: /\b(kyc|know your customer|identity verification|id verification)\b/i, v: "identity", w: 5, lab: "KYC / identity" },
  { re: /\b(aml|sanctions screening|compliance check)\b/i, v: "identity", w: 4, lab: "AML / compliance" },
  { re: /\b(verifiable credential|credential issuer|digital identity)\b/i, v: "credential", w: 4, lab: "credentials" },
  { re: /\b(neobank|banking app|bank account|core banking)\b/i, v: "fintech", w: 5, lab: "banking app" },
  { re: /\b(fintech|payments|remittance|money transfer|stablecoin|payroll)\b/i, v: "fintech", w: 4, lab: "fintech / payments" },
  { re: /\b(crypto wallet|wallet app|embedded wallet|custody)\b/i, v: "wallet", w: 4, lab: "wallet" },
  { re: /\b(membership|members platform|community platform)\b/i, v: "membership", w: 3, lab: "membership" },
];
const JUNK = /\b(awesome|curated list|list of|tutorials?|boilerplate|cheat.?sheet|roadmap|getting.started)\b/i;
const NEWS = /\b(awesome|list of|comparison|roundup|how to)\b/i;
const VENDOR = /^(persona|plaid|privy|onfido|sumsub|veriff|auth0|okta|workos|clerkinc)\//i;
const HIRE = /\b(kyc|aml|compliance|identity|onboarding|verification|fraud|risk|trust and safety|payments? engineer)\b/i;
const GH_TOPICS = [
  { q: "topic:kyc", v: "identity", w: 5 }, { q: "topic:aml", v: "identity", w: 5 },
  { q: "topic:identity-verification", v: "identity", w: 5 }, { q: "topic:verifiable-credentials", v: "credential", w: 5 },
  { q: "topic:neobank", v: "fintech", w: 4 }, { q: "topic:fintech", v: "fintech", w: 4 },
];
const ATS_GH = ["brex","mercury","gusto","chime","lithic","marqeta","alloy","affirm","stripe","checkr"];

const matchKW = (t) => { t = t || ""; for (const k of KW) if (k.re.test(t)) return k; return null; };
const score = (w, ms, eng) => {
  const rec = Math.max(0, 1 - (now - ms) / (30 * 864e5));
  const e = Math.min(1, (eng || 0) / 200);
  return Math.max(0, Math.min(100, Math.round(w * 9 + rec * 40 + e * 15)));
};
async function jget(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(url + " -> " + r.status); return r.json(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function github() {
  const out = []; const since = new Date(now - 45 * 864e5).toISOString().slice(0, 10);
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "enforcer-radar" };
  if (GH) headers.Authorization = "Bearer " + GH;
  for (const k of GH_TOPICS) {
    try {
      const j = await jget(`https://api.github.com/search/repositories?q=${encodeURIComponent(k.q + " pushed:>" + since)}&sort=updated&order=desc&per_page=30`, { headers });
      for (const it of j.items || []) {
        if (it.fork || it.archived) continue;
        const text = it.full_name + " " + (it.description || "");
        if (JUNK.test(text) || VENDOR.test(it.full_name)) continue;
        const m = matchKW(it.description || "");
        out.push({ id: "gh_" + it.id, name: it.full_name, source: "GitHub", vertical: m ? m.v : k.v, term: m ? m.lab : k.q.replace("topic:", ""), w: Math.max(k.w, m ? m.w : 0), ms: new Date(it.pushed_at || it.updated_at).getTime(), eng: it.stargazers_count || 0, url: it.html_url, desc: it.description, author: it.owner && it.owner.login });
      }
    } catch (e) { console.log("gh", k.q, e.message); }
    await sleep(2500); // stay well under search rate limit
  }
  return out;
}
async function hn() {
  const out = [];
  try {
    const j = await jget("https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=100");
    for (const h of j.hits || []) { if (!h.title) continue; const m = matchKW(h.title); if (!m || NEWS.test(h.title)) continue;
      out.push({ id: "hn_" + h.objectID, name: h.title, source: "Show HN", vertical: m.v, term: m.lab, w: m.w + 1, ms: (h.created_at_i || 0) * 1000, eng: (h.points || 0) + (h.num_comments || 0) * 2, url: h.url || "https://news.ycombinator.com/item?id=" + h.objectID, author: h.author }); }
  } catch (e) { console.log("hn show", e.message); }
  for (const term of ["KYC", "identity verification", "verifiable credentials", "neobank", "compliance onboarding"]) {
    try { const j = await jget(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(term)}&tags=story&hitsPerPage=12`);
      for (const h of j.hits || []) { if (!h.title) continue; const m = matchKW(h.title); if (!m || NEWS.test(h.title)) continue;
        out.push({ id: "hn_" + h.objectID, name: h.title, source: "Hacker News", vertical: m.v, term: m.lab, w: m.w, ms: (h.created_at_i || 0) * 1000, eng: (h.points || 0) + (h.num_comments || 0) * 2, url: h.url || "https://news.ycombinator.com/item?id=" + h.objectID, author: h.author }); }
    } catch (e) { console.log("hn", term, e.message); }
  }
  return out;
}
async function hiring() {
  const out = [];
  for (const slug of ATS_GH) {
    try {
      const j = await jget(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      const roles = (j.jobs || []).filter((job) => HIRE.test(job.title || "")).slice(0, 4);
      if (!roles.length) continue;
      const latest = Math.max(...roles.map((r) => new Date(r.updated_at || now).getTime()));
      const company = slug.charAt(0).toUpperCase() + slug.slice(1);
      out.push({ id: "hire_" + slug, name: company, source: "Hiring", vertical: "identity", term: "hiring: " + roles[0].title, w: 4, ms: latest, eng: roles.length * 30, url: roles[0].absolute_url || ("https://boards.greenhouse.io/" + slug), desc: "Open roles: " + roles.map((r) => r.title).join(" · "), author: company });
    } catch (e) { console.log("ats", slug, e.message); }
  }
  return out;
}

async function main() {
  const fresh = [...(await github()), ...(await hn()), ...(await hiring())];
  const store = new Map();
  if (existsSync("leads.json")) { try { for (const l of JSON.parse(readFileSync("leads.json", "utf8"))) store.set(l.id, l); } catch (e) {} }
  let added = 0, updated = 0;
  for (const l of fresh) {
    l.score = score(l.w, l.ms, l.eng);
    const prev = store.get(l.id);
    if (prev) { prev.last_seen = now; prev.score = l.score; prev.ms = l.ms; prev.eng = l.eng; prev.desc = l.desc || prev.desc; updated++; }
    else { l.first_seen = now; l.last_seen = now; store.set(l.id, l); added++; }
  }
  // drop anything not seen in 60 days, keep top 300 by score
  const cutoff = now - 60 * 864e5;
  let all = [...store.values()].filter((l) => (l.last_seen || now) > cutoff).sort((a, b) => b.score - a.score).slice(0, 300);
  writeFileSync("leads.json", JSON.stringify({ updated_at: new Date().toISOString(), count: all.length, leads: all }, null, 0));
  console.log(`scan done: ${fresh.length} fresh, +${added} new, ~${updated} updated, ${all.length} stored`);
}
main();
