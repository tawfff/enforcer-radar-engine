// Enforcer Radar engine: scans public buying signals, merges into an accumulating leads.json.
// Runs in GitHub Actions on a schedule. No keys needed beyond the Actions GITHUB_TOKEN.
import { readFileSync, writeFileSync, existsSync } from "fs";

const GH = process.env.GH_PAT || process.env.GH_TOKEN || ""; // PAT (code-search capable) preferred, Actions token as fallback
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
// Off-domain noise: popular hardware/systems/graphics repos that mis-tag themselves with our topics (e.g. uACPI tagged "aml"),
// plus retail-trading-tool / personal-finance-toy / adtech README-spam that rides topic:fintech (verified 2026-06-24: drops 6 such, zero real buyers).
const OFF = /\b(acpi|uefi|bios|firmware|kernel|device driver|bootloader|rtos|microcontroller|fpga|verilog|opengl|vulkan|ray.?trac\w*|game engine|operating system|compiler|emulator|robotics|proxmox|kubevirt|hypervisor|virtualiz\w*|virtualis\w*|qemu|lxd|incus|containerd|podman|scalper|backtest\w*|quant\w*[ -]?trading|trading[ -]?bot|expense[ -]?tracker|recommendation system|stock[ -]?market data|anti.?spoof\w*|presentation.?attack|gitleaks|secret.?scann\w*|leaked.?(api[ -]?)?keys?|quantum.?financial.?system|qfs|pi.?network|forex|arbitrage|algorithmic[ -]?trading|trading[ -]?(system|nexus|algorithm\w*|marketplace|strateg\w*)|signal fusion|quantitative (investment|trading)|stock[ -]?portfolio|trade options|options trading|large.?cap stock|análisis de acciones|stock (analysis|sentiment)|tightvnc|lagofast|law.?corpus|crpgs?)\b/i;
// Demo/test/template repos are not buyers, even when on-topic. Match on the repo name.
const DEMO = /\b(demo|sample|examples?|playground|starter|template|ui.?kit|testing|test.app|tutorial|workshop|clone|practice|assignment|quickstart|sandbox|awesome|boilerplate)\b/i;
const NEWS = /\b(awesome|list of|comparison|roundup|how to)\b/i;
// Pirated-software / SEO-spam repos that tag popular topics to ride them (e.g. "AML Maple" karaoke crack tagged topic:aml).
const CRACK = /\b(crack|keygen|nulled|warez|repack|cracked|patch.?repo|aml.?maple|activation.?key|license.?key|serial.?key)\b/i;
// AI-agent / MCP / dev-tool / security-tool projects that mis-tag identity & fintech topics to ride them. NOT buyers (no compliance budget; mostly brand-new 0-star repos). Verified 2026-06-22 to remove 22 such leads and zero real buyers.
const TOOL = /\b(mcp server|model context protocol|coding agent|agent framework|agent skills|llm[ -]?agent|langgraph|langchain|prompt injection|burp suite|claude code|ai agents?|gpg|pgp key|keygen|skip-invite|behavioral assurance|paste.?ready prompts?)\b/i;
const VENDOR = /^(persona|plaid|privy|onfido|sumsub|sumsubstance|innovatrics|doubangotelecom|faceonlive|kby-ai|veriff|auth0|okta|workos|clerkinc|complycube|verifyblind|vouchsafe)\//i;
const HIRE = /\b(kyc|aml|compliance|identity|onboarding|verification|fraud|risk|trust and safety|payments? engineer)\b/i;
const STRONG = /\b(kyc|aml|pld|cdd|sanctions?|financial crime|money laundering|lavagem|compliance|fraud)\b/i; // rank these strongest-intent roles to the front so the card opener shows them, not generic "onboarding"
const GH_TOPICS = [
  { q: "topic:kyc", v: "identity", w: 5 }, { q: "topic:aml", v: "identity", w: 5 },
  { q: "topic:identity-verification", v: "identity", w: 5 }, { q: "topic:verifiable-credentials", v: "credential", w: 5 },
  { q: "topic:neobank", v: "fintech", w: 4 }, { q: "topic:fintech", v: "fintech", w: 4 },
  { q: "topic:ssi", v: "credential", w: 5 },
];
const ATS_GH = ["brex","mercury","gusto","chime","lithic","marqeta","alloy","affirm","stripe","checkr","monzo","sofi","nubank","robinhood","gemini","ripple","coinbase","bitpanda","n26","gocardless","solarisbank","block","blockchain","adyen","tide","sumup","thunes","c6bank","payoneer","ebury","bvnk","okx","luno","bybit","xendit","inter","tamara"];
// Teams importing a competitor's SDK in package.json = actively building = the warmest buyers. Each lead carries its own outreach hook (the vendor they shipped).
const SDK_QUERIES = [
  { q: '"onfido-sdk-ui" filename:package.json', vendor: "Onfido", v: "identity", w: 6 },
  { q: '"@sumsub/websdk" filename:package.json', vendor: "Sumsub", v: "identity", w: 6 },
  { q: '"@veriff/incontext-sdk" filename:package.json', vendor: "Veriff", v: "identity", w: 6 },
  { q: '"@alloyidentity/web-sdk" filename:package.json', vendor: "Alloy", v: "identity", w: 6 },
  { q: '"@workos-inc/node" filename:package.json', vendor: "WorkOS", v: "identity", w: 5 },
  { q: '"@privy-io/react-auth" filename:package.json', vendor: "Privy", v: "wallet", w: 5 },
  { q: '"@privy-io/server-auth" filename:package.json', vendor: "Privy", v: "wallet", w: 5 },
  { q: '"react-plaid-link" filename:package.json', vendor: "Plaid", v: "fintech", w: 5 },
  { q: '"plaid-node" filename:package.json', vendor: "Plaid", v: "fintech", w: 5 },
  { q: '"@unit-finance/unit-node-sdk" filename:package.json', vendor: "Unit", v: "fintech", w: 5 },
];
// Vendor / SDK-mirror orgs to never surface as "buyers" (their own repos, demos, type stubs).
const VENDOR_LOGINS = new Set(["privy-io","plaid","onfido","sumsub","veriff","getveriff","workos","workos-inc","unit-finance","alloy","alloy-samples","usealloy","alloyidentity","lithic","lithic-com","persona","withpersona","marqeta","definitelytyped","scalablytyped","cdnjs","ootbdev"]);
// Repo-farm / directory accounts that mass-publish single-purpose repos tagged with our topics. NOT buyers:
// api-evangelist = 10k-repo public API directory (Kin Lane research dumps); cognis-digital = 376-repo MCP-tool farm building KYC/AML toolkits (a tool vendor, not a buyer).
// qinisolabs = week-old "labs" org mass-publishing single-purpose "for AI agents" micro-tools (sanctionwise/companieswise/localecheck), a tool vendor not a buyer; ariannamethod = off-domain weightless-neural-network research project that mis-tags topic:aml.
// shaostoul = off-domain personal "Humanity" civilizational/philosophy project (10 stars) that self-tags verifiable-credentials/decentralized-identity to ride those topics; not a buyer (flagged junk 06-19, was sitting at score 86).
// smileidentity = Smile ID (smile.id), African KYC/identity-verification VENDOR (Enforcer competitor) publishing its own SDK/API-reference repos; zhu-j-faceonlive = FaceOnLive affiliate account (blog faceonlive.com), biometric ID-verification vendor's product/demo repos. Both are anchored-VENDOR-regex misses (like SumSubstance 06-25): vendors, never buyers. Added 2026-07-07, drop 6 stored leads.
// ghostfolio = Ghostfolio (8987 stars, Org), "Open Source Wealth Management Software" = a self-hosted personal-finance/portfolio TRACKER riding topic:fintech, never a KYC buyer (same off-domain-single-flagship class as xbbg-org). Owner-banned not text-filtered because `wealth management` would false-negative a real wealthtech/robo-advisor buyer. abolfazltafakori = AbolfazlTafakori/Phonix (2 stars, User), "Self-hosted storefront and back office for digital goods" = an e-commerce storefront riding topic:kyc, not a buyer. Added 2026-07-20, drop 2 stored leads.
const OWNER_DENY = new Set(["api-evangelist","cognis-digital","qinisolabs","ariannamethod","shaostoul","xbbg-org","cccpan","smileidentity","zhu-j-faceonlive","remoprinz","karbine98kz","ghostfolio","abolfazltafakori"]);
const OWNER_CAP = 3; // no single GitHub owner may flood the board (guards against future repo-farms)

const matchKW = (t) => { t = t || ""; for (const k of KW) if (k.re.test(t)) return k; return null; };
const score = (w, ms, eng) => {
  const rec = Math.max(0, 1 - (now - ms) / (30 * 864e5));
  const e = Math.min(1, (eng || 0) / 200);
  return Math.max(0, Math.min(100, Math.round(w * 9 + rec * 40 + e * 15)));
};
async function jget(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(url + " -> " + r.status); return r.json(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function domainBrand(u) { try { const d = new URL(u).hostname.replace(/^www\./, ""); if (/(news\.ycombinator|github\.com)/.test(d)) return null; return d.split(".")[0]; } catch (e) { return null; } }

async function github() {
  const out = []; const since = new Date(now - 45 * 864e5).toISOString().slice(0, 10);
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "enforcer-radar" };
  if (GH) headers.Authorization = "Bearer " + GH;
  for (const k of GH_TOPICS) {
    try {
      const j = await jget(`https://api.github.com/search/repositories?q=${encodeURIComponent(k.q + " pushed:>" + since)}&sort=updated&order=desc&per_page=30`, { headers });
      for (const it of j.items || []) {
        if (it.fork || it.archived) continue;
        if (OWNER_DENY.has(((it.owner && it.owner.login) || "").toLowerCase())) continue;
        const text = it.full_name + " " + (it.description || "");
        if (JUNK.test(text) || OFF.test(text) || TOOL.test(text) || CRACK.test(it.full_name) || DEMO.test(it.full_name) || VENDOR.test(it.full_name)) continue;
        const m = matchKW(it.description || "");
        out.push({ id: "gh_" + it.id, name: it.full_name, source: "GitHub", vertical: m ? m.v : k.v, term: m ? m.lab : k.q.replace("topic:", ""), w: Math.max(k.w, m ? m.w : 0), ms: new Date(it.pushed_at || it.updated_at).getTime(), eng: it.stargazers_count || 0, url: it.html_url, desc: it.description, author: it.owner && it.owner.login });
      }
    } catch (e) { console.log("gh", k.q, e.message); }
    await sleep(2500); // stay well under search rate limit
  }
  // Enrich with the org's REAL brand name + website (what LinkedIn knows it as). owner login != brand.
  const owners = [...new Set(out.filter((l) => l.author).map((l) => l.author))].slice(0, 150);
  for (const o of owners) {
    try {
      let r = await fetch(`https://api.github.com/orgs/${o}`, { headers });
      if (r.status === 404) r = await fetch(`https://api.github.com/users/${o}`, { headers });
      if (r.ok) { const d = await r.json(); for (const l of out) if (l.author === o) { l.company = d.name || l.company; l.website = d.blog || l.website || null; } }
    } catch (e) {}
    await sleep(90);
  }
  return out;
}
async function hn() {
  const out = [];
  try {
    const j = await jget("https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=100");
    for (const h of j.hits || []) { if (!h.title) continue; const m = matchKW(h.title); if (!m || NEWS.test(h.title)) continue;
      out.push({ id: "hn_" + h.objectID, name: h.title, source: "Show HN", company: domainBrand(h.url), vertical: m.v, term: m.lab, w: m.w + 1, ms: (h.created_at_i || 0) * 1000, eng: (h.points || 0) + (h.num_comments || 0) * 2, url: h.url || "https://news.ycombinator.com/item?id=" + h.objectID, author: h.author }); }
  } catch (e) { console.log("hn show", e.message); }
  for (const term of ["KYC", "identity verification", "verifiable credentials", "neobank", "compliance onboarding"]) {
    try { const j = await jget(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(term)}&tags=story&hitsPerPage=12`);
      for (const h of j.hits || []) { if (!h.title) continue; const m = matchKW(h.title); if (!m || NEWS.test(h.title)) continue;
        out.push({ id: "hn_" + h.objectID, name: h.title, source: "Hacker News", company: domainBrand(h.url), vertical: m.v, term: m.lab, w: m.w, ms: (h.created_at_i || 0) * 1000, eng: (h.points || 0) + (h.num_comments || 0) * 2, url: h.url || "https://news.ycombinator.com/item?id=" + h.objectID, author: h.author }); }
    } catch (e) { console.log("hn", term, e.message); }
  }
  return out;
}
async function hiring() {
  const out = [];
  for (const slug of ATS_GH) {
    try {
      const j = await jget(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      const roles = (j.jobs || []).filter((job) => HIRE.test(job.title || "")).sort((a, b) => (STRONG.test(b.title || "") ? 1 : 0) - (STRONG.test(a.title || "") ? 1 : 0)).slice(0, 4);
      if (!roles.length) continue;
      const latest = Math.max(...roles.map((r) => new Date(r.updated_at || now).getTime()));
      const company = slug.charAt(0).toUpperCase() + slug.slice(1);
      out.push({ id: "hire_" + slug, name: company, source: "Hiring", company: company, vertical: "identity", term: "hiring: " + roles[0].title, w: 4, ms: latest, eng: roles.length * 30, url: roles[0].absolute_url || ("https://boards.greenhouse.io/" + slug), desc: "Open roles: " + roles.map((r) => r.title).join(" · "), author: company });
    } catch (e) { console.log("ats", slug, e.message); }
  }
  return out;
}

// GitHub code search: find companies importing a competitor SDK in package.json (warmest "actively building" signal).
async function codesearch() {
  if (!GH) return [];
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "enforcer-radar", Authorization: "Bearer " + GH };
  const found = new Map(); // owner login -> candidate (deduped, first/strongest query wins)
  for (const s of SDK_QUERIES) {
    try {
      const j = await jget(`https://api.github.com/search/code?q=${encodeURIComponent(s.q)}&per_page=50`, { headers });
      for (const it of j.items || []) {
        const repo = it.repository; if (!repo || !repo.owner) continue;
        const login = (repo.owner.login || "").toLowerCase();
        if (!login || VENDOR_LOGINS.has(login)) continue;
        if (repo.fork) continue;
        if (DEMO.test(repo.full_name) || /(sdk-?ui|node-sdk|web-sdk)/i.test(repo.full_name)) continue;
        if (found.has(login)) continue; // one card per company even across multiple SDK matches
        found.set(login, { login, vendor: s.vendor, repo: repo.full_name, repoUrl: repo.html_url, v: s.v, w: s.w });
      }
    } catch (e) { console.log("code", s.vendor, e.message); }
    await sleep(7000); // code search caps at ~10 requests/minute
  }
  // Qualify + enrich each unique owner: drop archived/stale repos, pull stars + the org's real brand name + website.
  const out = [];
  for (const c of [...found.values()].slice(0, 80)) {
    let stars = 0, ms = now, ok = true;
    try {
      const rr = await fetch(`https://api.github.com/repos/${c.repo}`, { headers });
      if (rr.ok) { const rd = await rr.json();
        if (rd.archived) ok = false;
        stars = rd.stargazers_count || 0;
        ms = new Date(rd.pushed_at || now).getTime();
        if (now - ms > 540 * 864e5) ok = false; // dead repo, not an active build
      }
    } catch (e) {}
    if (!ok) { await sleep(80); continue; }
    let company = c.login, website = null;
    try {
      let r = await fetch(`https://api.github.com/orgs/${c.login}`, { headers });
      if (r.status === 404) r = await fetch(`https://api.github.com/users/${c.login}`, { headers });
      if (r.ok) { const d = await r.json(); company = d.name || c.login; website = d.blog || null; if (d.type === "User") c.w = Math.max(3, c.w - 2); }
    } catch (e) {}
    await sleep(80);
    out.push({ id: "code_" + c.login, name: c.repo, source: "Building with", vertical: c.v, term: "uses " + c.vendor, w: c.w, ms, eng: stars, url: c.repoUrl, desc: "Ships the " + c.vendor + " SDK in production code (" + c.repo + ")", company, website, author: c.login, vendor: c.vendor });
  }
  return out;
}

async function main() {
  const fresh = [...(await github()), ...(await hn()), ...(await hiring()), ...(await codesearch())];
  const store = new Map();
  if (existsSync("leads.json")) { try { for (const l of JSON.parse(readFileSync("leads.json", "utf8"))) store.set(l.id, l); } catch (e) {} }
  let added = 0, updated = 0;
  for (const l of fresh) {
    l.score = score(l.w, l.ms, l.eng);
    const prev = store.get(l.id);
    if (prev) { prev.last_seen = now; prev.score = l.score; prev.ms = l.ms; prev.eng = l.eng; prev.desc = l.desc || prev.desc; prev.company = l.company || prev.company; prev.website = l.website || prev.website; prev.vendor = l.vendor || prev.vendor; updated++; }
    else { l.first_seen = now; l.last_seen = now; store.set(l.id, l); added++; }
  }
  // drop anything not seen in 60 days, prune denied repo-farms (cleans previously-stored junk), cap any single owner, keep top 300 by score
  const cutoff = now - 60 * 864e5;
  let all = [...store.values()].filter((l) => (l.last_seen || now) > cutoff);
  all = all.filter((l) => !(l.author && OWNER_DENY.has(l.author.toLowerCase())));
  all = all.filter((l) => !(l.source === "GitHub" && TOOL.test((l.name || "") + " " + (l.desc || "")))); // prune already-stored AI-agent/MCP/tool junk
  all = all.filter((l) => !(l.source === "GitHub" && OFF.test((l.name || "") + " " + (l.desc || "")))); // prune already-stored off-domain junk (trading bots, expense trackers, adtech)
  all = all.filter((l) => !(l.source === "GitHub" && VENDOR.test(l.name || ""))); // prune already-stored identity-verification vendors (competitors, not buyers: Sumsub/SumSubstance, Innovatrics, etc.)

  all.sort((a, b) => b.score - a.score);
  const ownerSeen = {};
  all = all.filter((l) => { const o = l.author ? l.author.toLowerCase() : null; if (!o) return true; ownerSeen[o] = (ownerSeen[o] || 0) + 1; return ownerSeen[o] <= OWNER_CAP; });
  all = all.slice(0, 300);
  writeFileSync("leads.json", JSON.stringify({ updated_at: new Date().toISOString(), count: all.length, leads: all }, null, 0));
  console.log(`scan done: ${fresh.length} fresh, +${added} new, ~${updated} updated, ${all.length} stored`);
}
main();
