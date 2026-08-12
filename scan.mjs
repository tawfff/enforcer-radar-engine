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
// plus retail-trading-tool / personal-finance-toy / adtech README-spam that rides topic:fintech (verified 2026-06-24: drops 6 such, zero real buyers). Extended 2026-08-04 with the CJK arm of the same class (Chinese/Korean stock-research + market-data tooling riding topic:fintech) plus the two English gaps stock-price / stock-screener; drops 6, zero real buyers.
const OFF = /(\b(acpi|uefi|bios|firmware|kernel|device driver|bootloader|rtos|microcontroller|fpga|verilog|opengl|vulkan|ray.?trac\w*|game engine|operating system|compiler|emulator|robotics|proxmox|kubevirt|hypervisor|virtualiz\w*|virtualis\w*|qemu|lxd|incus|containerd|podman|scalper|backtest\w*|quant\w*[ -]?trading|trading[ -]?bot|expense[ -]?tracker|recommendation system|stock[ -]?market data|anti.?spoof\w*|presentation.?attack|gitleaks|secret.?scann\w*|leaked.?(api[ -]?)?keys?|quantum.?financial.?system|qfs|pi.?network|forex|arbitrage|algorithmic[ -]?trading|trading[ -]?(system|nexus|algorithm\w*|marketplace|strateg\w*)|signal fusion|quantitative (investment|trading)|stock[ -]?portfolio|trade options|options trading|large.?cap stock|análisis de acciones|stock (analysis|sentiment)|tightvnc|lagofast|law.?corpus|crpgs?|reverse.?image.?search|link.?in.?bio|bio links?|linktree|invoice.?generator|fhir|stock[ -]?prices?|stock[ -]?(pre.?)?screen\w*)\b|投研|选股|量化|A股|港股|美股|종목|코스닥|공시)/i;
// Demo/test/template repos are not buyers, even when on-topic. Match on the repo name.
const DEMO = /\b(demo|sample|examples?|playground|starter|template|ui.?kit|testing|test.app|tutorial|workshop|clone|practice|assignment|quickstart|sandbox|awesome|boilerplate)\b/i;
const NEWS = /\b(awesome|list of|comparison|roundup|how to)\b/i;
// HN lanes only: a story ABOUT a company is not a company you can sell to. Kills press/newsletters/aggregators, docs+support+
// changelog+legal pages, government reports and archive.org mirrors; plus posts with no external URL (company parses to null, so
// there is nothing for Brooke to contact) and "no KYC" pages (advertising the ABSENCE of what Enforcer sells is an anti-signal).
// 2026-08-12: 10 of the 12 stored HN leads were this, incl. a competitor win ("Anthropic uses Persona") shown to Brooke as a lead.
// ponytail: a denylist, so a press outlet not listed here still gets one card through until added. Ceiling accepted because the
// alternative (a positive "is this a company homepage" test) needs a fetch per candidate. Upgrade path: add the host when seen.
const HNBAD = /\b(techcrunch|substack|medium|forbes|bloomberg|reuters|cnbc|coindesk|finextra|pymnts|prnewswire|businesswire|archive|wikipedia|reddit|quora|youtube|linkedin)\b|\.gov\b|^(support|help|docs?|developers?|changelog|status|news|blog|web|wiki|kb)\.|\/(changelog|release-notes|legal|privacy|terms|press-release)\//i;
const NOKYC = /\bno[ -]?(mandatory[ -])?(kyc|identity[ -]?verification|registration|id[ -]?check)/i;
const hostpath = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname; } catch (e) { return ""; } };
const hnJunk = (l) => !l.company || HNBAD.test(hostpath(l.url)) || NOKYC.test(l.name || "");
// Pirated-software / SEO-spam repos that tag popular topics to ride them (e.g. "AML Maple" karaoke crack tagged topic:aml).
const CRACK = /\b(crack|keygen|nulled|warez|repack|cracked|patch.?repo|aml.?maple|activation.?key|license.?key|serial.?key)\b/i;
// AI-agent / MCP / dev-tool / security-tool projects that mis-tag identity & fintech topics to ride them. NOT buyers (no compliance budget; mostly brand-new 0-star repos). Verified 2026-06-22 to remove 22 such leads and zero real buyers.
const TOOL = /\b(mcp server|model context protocol|coding agent|agent framework|agent skills|llm[ -]?agent|langgraph|langchain|prompt injection|burp suite|claude code|ai agents?|gpg|pgp key|keygen|skip-invite|behavioral assurance|paste.?ready prompts?)\b/i;
const VENDOR = /^(persona|plaid|privy|onfido|sumsub|sumsubstance|innovatrics|doubangotelecom|faceonlive|kby-ai|veriff|auth0|okta|workos|clerkinc|complycube|verifyblind|vouchsafe|microblink)\//i;
const HIRE = /\b(kyc|aml|compliance|identity|onboarding|verification|fraud|risk|trust and safety|payments? engineer)\b/i;
const STRONG = /\b(kyc|aml|pld|cdd|sanctions?|financial crime|money laundering|lavagem|compliance|fraud)\b/i; // rank these strongest-intent roles to the front so the card opener shows them, not generic "onboarding"
// `strict` = the topic is too broad to be a signal on its own, so the DESCRIPTION must also carry an in-domain keyword.
// topic:fintech is the only one: every other topic here is narrow and in-domain by construction. Verified 2026-08-08 on the
// live 300-lead board: topic:fintech with no KW match was 132 leads (44% of the whole board) and 134 of the 135 leads in the
// bottom 75-76 score tier, i.e. it was crowding the 300 cap with "any repo tagged fintech, pushed today, 0 stars".
// Sampled ~45 of them: HFT matching engines, Firefly-III personal-finance forks, an Israeli bank scraper, Algerian geodata,
// a BERT joke model, Helm charts, hedge-fund 13F trackers, a Chinese stock-data SDK, a grid trading bot. ~5% precision.
const GH_TOPICS = [
  { q: "topic:kyc", v: "identity", w: 5 }, { q: "topic:aml", v: "identity", w: 5 },
  { q: "topic:identity-verification", v: "identity", w: 5 }, { q: "topic:verifiable-credentials", v: "credential", w: 5 },
  { q: "topic:neobank", v: "fintech", w: 4 }, { q: "topic:fintech", v: "fintech", w: 4, strict: true },
  { q: "topic:ssi", v: "credential", w: 5 },
];
const SENIOR = /\b(chief|global head|head of|vp|director|principal|mlro)\b/i; // tiebreak WITHIN the strong roles, so the card opener shows "Director, Financial Crimes Compliance", not "Associate Compliance Manager, Complaints"
const ATS_GH = ["brex","mercury","gusto","chime","lithic","marqeta","alloy","affirm","stripe","checkr","monzo","sofi","nubank","robinhood","gemini","ripple","coinbase","bitpanda","n26","gocardless","solarisbank","block","blockchain","adyen","tide","sumup","thunes","c6bank","payoneer","ebury","bvnk","okx","luno","bybit","xendit","inter","tamara","truelayer","upstart","sezzle","moniepoint"];
// Lever boards, same keyless public endpoint as Greenhouse. Added because Greenhouse has been probed dry for ~30 consecutive runs (0 new qualifying
// slugs since 08-05), so it is no longer a growth path. Each slug below was verified at source to return MULTIPLE in-domain roles, not one:
// nium 39 postings / 8 in-domain (licensed cross-border B2B payments; VP Global Commercial Compliance, Director Regulatory Compliance & MLRO Malta ...),
// dlocal 57 / 10 (NASDAQ: DLO emerging-market payments; Compliance Officer / MLRO across Cameroon, Senegal, Saudi, Colombia, Indonesia),
// qonto 41 / 5 (French licensed business-banking; Junior AML Transaction Monitoring, Internal Control Officer Compliance, Fraud Analyst, onboarding officers).
// All three are textbook licensed buyers and were completely invisible to the engine.
// trustly added 2026-08-08: 21 postings / 3 in-domain, 2 STRONG and both dedicated KYC headcount (Consumer KYC Analyst +
// Senior KYC Analyst, Lisbon) plus Lead PM Risk. A licensed open-banking payments provider staffing a KYC function, so it clears
// the multi-match bar that got form3/betterment rejected on a single role.
// anchorage added 2026-08-09: 41 postings / 4 in-domain / 2 STRONG, and both STRONG are dedicated Compliance
// headcount in two jurisdictions (Member of Compliance Analytics US + Member of Compliance Singapore) plus two
// Global Risk Management reqs. Anchorage Digital holds a US OCC national trust bank charter, so it is a licensed
// custodian staffing a compliance function, not a vendor. Clears the multi-role bar that rejected form3/betterment.
// Worth noting for the compounding loop: the 08-06 run probed `anchorage` on GREENHOUSE and got no board, so it
// was written off. It has a Lever board. A slug being dry on one ATS says nothing about the other three.
const ATS_LEVER = ["nium","dlocal","qonto","trustly","anchorage"];
// Ashby, same keyless public posting API (api.ashbyhq.com/posting-api/job-board/<slug>), verified live this run:
// ramp 122 jobs / 7 in-domain (Money Laundering Reporting Officer AML, AML Operations Analyst, Software Engineer Fraud & Identity),
// column 23 / 5 (AML Analyst, Correspondent Banking Compliance, Digital Assets Compliance, Customer Risk Strategy) - a US nationally chartered bank.
// rain added 2026-08-08 and it is the strongest hiring board found in ~30 runs: 44 jobs / 9 in-domain / 8 STRONG, an entire
// Compliance department (Compliance Manager / Associate / Analyst / Engineer, Financial Crimes & Risk Data Analyst) PLUS
// "Software Engineer - Compliance" and two fraud-risk ML/DS roles. rain.xyz is an enterprise stablecoin payments platform,
// not a vendor, and it is hiring engineers to BUILD compliance in-house, which is the warmest signal this radar can detect.
// airwallex added 2026-08-10 and it displaces rain as the strongest hiring board this radar has found: 630 postings /
// 543 unique titles / 63 in-domain / 29 STRONG. SIX MLRO reqs across separate jurisdictions (Compliance Manager & MLRO
// South Korea, Compliance Director & MLRO US, Senior Compliance Manager & MLRO, + 3 more), "Senior Director, AML &
// Sanctions, Governance & Policy", "Financial Crime Transformation Lead", Regulatory Compliance Managers in Japan, NZ,
// Mexico, Indonesia, Australia and China, and critically TWO "Engineering Lead / Manager, KYC" reqs, i.e. it is hiring
// engineers to BUILD KYC in-house rather than buying a bureau. Airwallex is a licensed global payments company (its own
// board carries Global Payments engineers, Card Schemes PM, mid-market AEs), so a buyer and not a vendor.
const ATS_ASHBY = ["ramp","column","rain","airwallex"];
// THREE MORE KEYLESS ATS LANES, proposed on 08-08/08-09/08-10 and built now because Greenhouse/Lever/Ashby SLUG growth is
// finally, provably exhausted: 42 fresh candidates probed against all three on 2026-08-11 (moderntreasury, increase, synctera,
// treasuryprime, highnote, middesk, dwolla, zerohash, mural, conduit, airtm, lemon, koibanx, minka, alviere, fordefi, zodia,
// amina, sygnum, taurus, hex-trust, cobo, matrixport, nexo, wirex, uphold, method, argyle, pinwheel, atomic, parafin, pipe,
// capchase + 9 board orgs) returned ZERO qualifying boards. So a new ENDPOINT, not a new slug, is now the only hiring growth
// path left. Each lane is the same shape as the three above (keyless GET, map to {title,url,ms}, reuse pickRoles/push) and each
// seed below was verified live at source this run, not read about:
// SmartRecruiters `wise` = 405 postings total / 26 in-domain / 19 STRONG on page 1 alone (Outsourcing Project Manager KYC,
//   FinCrime Investigator - AML Investigations, Senior Product Compliance Manager - Financial Crime, KYC Operations Team Lead,
//   Lead Data Scientist - KYC & Onboarding, KYC Operations Senior Analyst). Wise is a licensed money transmitter and was
//   invisible to all three existing lanes: 08-10 probed it on Greenhouse AND Lever AND Ashby and got no board at all.
// Recruitee `bunq` = 18 / 8 / 6 STRONG, and the shape is the tell: AML Branch Manager in Romania, Czechia AND Austria plus a
//   Deputy AML Branch Manager in Belgium. A licensed EU neobank staffing AML management across four jurisdictions at once.
// Workable `payabl` = 65 / 2 / 2 STRONG (AML Officer - Policies & Procedures, Senior Governance Risk and Compliance Analyst),
//   a licensed EU payment institution. Thin but it clears the same multi-role bar trustly/anchorage cleared, and it replaces
//   08-09's `yapily` seed for this lane, which re-probed at only 1 in-domain today and so would not qualify.
// ponytail: SmartRecruiters caps a page at 100 of 405, and we take page 1 only. That page is the 100 most recently released
// postings (the API returns releasedDate descending), which is the half we want, and it already yields 19 STRONG roles.
// Upgrade path if a board's in-domain roles ever look truncated: add &offset= paging.
const ATS_SR = ["wise"];
const ATS_RC = ["bunq"];
const ATS_WK = ["payabl", "viva"]; // viva = Viva.com/Viva Wallet, Bank of Greece licensed credit institution + EMI in 22 EU countries; verified 2026-08-12: 40 jobs / 4 in-domain / 3 STRONG (AML/CFT Investigator, Senior AML/CFT Investigator, Anti-Fraud Investigator)
// Teams importing a competitor's SDK in package.json = actively building = the warmest buyers. Each lead carries its own outreach hook (the vendor they shipped).
// ORDER MATTERS and used to silently cost this lane 5 of its 10 vendors: candidates are collected into one insertion-ordered
// Map and then qualified with `.slice(0, N)`, so whichever queries run first eat the whole budget. With N=80, Onfido and Sumsub
// alone filled it (they return ~45 unique owners each) and Veriff, Alloy and Unit NEVER reached qualification. Verified on the
// 2026-08-08 board: all 11 "Building with" leads were Onfido or Sumsub, and zero came from the other eight queries.
// The five below are the high-precision identity/KYC lane: shipping one of these SDKs means a team is doing real KYC.
const SDK_QUERIES = [
  { q: '"onfido-sdk-ui" filename:package.json', vendor: "Onfido", v: "identity", w: 6 },
  { q: '"@sumsub/websdk" filename:package.json', vendor: "Sumsub", v: "identity", w: 6 },
  { q: '"@veriff/incontext-sdk" filename:package.json', vendor: "Veriff", v: "identity", w: 6 },
  { q: '"@alloyidentity/web-sdk" filename:package.json', vendor: "Alloy", v: "identity", w: 6 },
  { q: '"@unit-finance/unit-node-sdk" filename:package.json', vendor: "Unit", v: "fintech", w: 5 },
  // PARKED, not deleted: these three are miscalibrated for Enforcer and, because of the budget bug above, have produced zero
  // leads for their whole life, so parking them changes nothing today. Sampled the live top 30 of each on 2026-08-08:
  //   { q: '"@workos-inc/node" ...', vendor: "WorkOS" }  -> mastra, continue, unkey, convex, openstatus, digger, MCPJam:
  //     dev-tool SaaS wiring up enterprise SSO. WorkOS is an SSO vendor, not a KYC vendor, so the import proves nothing in-domain.
  //   { q: '"react-plaid-link" ...' } and { q: '"plaid-node" ...' }, vendor "Plaid" -> ExpenseTracker, finance-saas-expense-tracker,
  //     jsmastery-pro/bankify, next-banking-app: tutorial/personal-finance projects (the class OFF already bans, and codesearch()
  //     never applies OFF). Re-enable only behind a text filter on this lane.
  //   { q: '"@privy-io/react-auth" ...' } x2, vendor "Privy" -> genuinely mixed (dydxprotocol/v4-web, NeurProjects/neur-app are
  //     real) but ~2/3 crypto starter kits and toy dapps, which would land at score 85+ ABOVE every hiring lead. Same gate needed.
];
// Vendor / SDK-mirror orgs to never surface as "buyers" (their own repos, demos, type stubs).
const VENDOR_LOGINS = new Set(["privy-io","plaid","onfido","sumsub","veriff","getveriff","workos","workos-inc","unit-finance","alloy","alloy-samples","usealloy","alloyidentity","lithic","lithic-com","persona","withpersona","marqeta","definitelytyped","scalablytyped","cdnjs","ootbdev"]);
// Repo-farm / directory accounts that mass-publish single-purpose repos tagged with our topics. NOT buyers:
// api-evangelist = 10k-repo public API directory (Kin Lane research dumps); cognis-digital = 376-repo MCP-tool farm building KYC/AML toolkits (a tool vendor, not a buyer).
// qinisolabs = week-old "labs" org mass-publishing single-purpose "for AI agents" micro-tools (sanctionwise/companieswise/localecheck), a tool vendor not a buyer; ariannamethod = off-domain weightless-neural-network research project that mis-tags topic:aml.
// shaostoul = off-domain personal "Humanity" civilizational/philosophy project (10 stars) that self-tags verifiable-credentials/decentralized-identity to ride those topics; not a buyer (flagged junk 06-19, was sitting at score 86).
// smileidentity = Smile ID (smile.id), African KYC/identity-verification VENDOR (Enforcer competitor) publishing its own SDK/API-reference repos; zhu-j-faceonlive = FaceOnLive affiliate account (blog faceonlive.com), biometric ID-verification vendor's product/demo repos. Both are anchored-VENDOR-regex misses (like SumSubstance 06-25): vendors, never buyers. Added 2026-07-07, drop 6 stored leads.
// ghostfolio = Ghostfolio (8987 stars, Org), "Open Source Wealth Management Software" = a self-hosted personal-finance/portfolio TRACKER riding topic:fintech, never a KYC buyer (same off-domain-single-flagship class as xbbg-org). Owner-banned not text-filtered because `wealth management` would false-negative a real wealthtech/robo-advisor buyer. abolfazltafakori = AbolfazlTafakori/Phonix (2 stars, User), "Self-hosted storefront and back office for digital goods" = an e-commerce storefront riding topic:kyc, not a buyer. Added 2026-07-20, drop 2 stored leads.
// jumbojett = jumbojett/OpenID-Connect-PHP (732 stars, User), "Minimalist OpenID Connect client" = a generic OIDC auth-protocol client LIBRARY riding topic:identity-verification, sat at score 100 ABOVE real buyers. Auth plumbing, never a KYC/AML buyer (same flagship-library-riding-topic class as ghostfolio/xbbg-org). Owner-banned not text-filtered because topic:identity-verification is legitimately in-domain (pulls walt.id etc) and no clean text term separates an OIDC library from a real identity buyer without false-negative risk. Added 2026-07-22, drop 1 stored lead.
// faceplugin-ltd = FacePlugIn Ltd (Org, faceplugin.com/identity-verification-solutions), publishing its own face-recognition / ID-card-recognition / liveness-detection SDKs = a textbook biometric ID-verification VENDOR (Enforcer competitor, never a buyer), same class as faceonlive/smileidentity/verifyblind/vouchsafe. Sat at score 96 (Open-Source-Face-Recognition-SDK) ABOVE real buyers, plus 2 more at 85 (ID-Card-Recognition, Face-Recognition-SDK). Owner-banned (org login, not a clean short VENDOR-regex token) matching the smileidentity/zhu-j-faceonlive vendor-org precedent; owner-anchored, zero false-negative risk. Added 2026-07-27, drop 3 stored leads.
// hkuds = Data Intelligence Lab @ HKU (Org, 27920 stars on Vibe-Trading), a prolific university AI-research lab publishing off-domain frameworks (LightRAG/MiniRAG/VideoRAG/agents and now Vibe-Trading "Your Personal Trading Agent", topics ai-agent/algorithmic-trading/fintech) that ride topic:fintech. An algo-trading LLM agent, never a KYC/identity buyer; the lab publishes only AI research, never a compliance buyer, so an owner ban carries zero false-negative risk (same prolific-off-domain-publisher class as yeasy). Text-filter risk: `trading agent` could catch a real payments buyer, so owner-ban is the safe choice. Sat at score 91. Added 2026-07-27, drop 1 stored lead.
// rcbj = Iya CyberSecurity Solutions (Org, iyasec.io), whose 173-star oauth2-oidc-debugger ("An OAuth2 and OpenID Connect Debugger") sat at score 96,
// the 10th slot on the whole board. A generic auth-protocol DEBUGGING TOOL riding topic:identity-verification, exactly the jumbojett precedent from 07-22;
// the owner's whole repo list is dev tooling (Apigee proxy, CloudFront action, mock STS, VoIP), never a compliance buyer, so zero false-negative risk.
// getyoti = Yoti Ltd (Org, yoti.com, self-described "digital identity platform ... verify who people are"), publishing its own SDKs = a commercial
// identity-verification VENDOR and Enforcer competitor, same class as smileidentity/faceplugin-ltd. VENDOR regex misses it because the login is getyoti/, not yoti/.
// sherlock-tg-bot = a User account created 2026-08-06 that already holds 216 repos, all Russian-language OSINT people-search / "Глаз бога" Telegram-bot SEO
// guides (alternativa-glaz-boga, bot-poisk-po-niku, asint-bot ...). Same off-domain people-search class as the denied faceseek.online, but it publishes NO
// website so SITE_DENY cannot reach it and OWNER_CAP only trimmed it to 3 leads at score 85. Owner-anchored for now; the durable fix is the fresh-User penalty below.
// carrismetropolitana = Carris Metropolitana (Org), the Lisbon metropolitan-area public bus operator. Pure acronym collision: its "Dados georeferenciados
// sobre a AML" open-data repo is tagged topic:aml where AML = Area Metropolitana de Lisboa, not anti-money-laundering. Sat at 85 above real buyers.
// All four verified against the GitHub API and, for Yoti, the company's own site. Added 2026-08-07, drop 6 stored leads.
const OWNER_DENY = new Set(["api-evangelist","cognis-digital","qinisolabs","ariannamethod","shaostoul","xbbg-org","cccpan","smileidentity","zhu-j-faceonlive","remoprinz","karbine98kz","ghostfolio","abolfazltafakori","jumbojett","burnssa","yeasy","faceplugin-ltd","hkuds","wordstotech-design","rcbj","getyoti","sherlock-tg-bot","carrismetropolitana"]);
const OWNER_CAP = 3; // no single GitHub owner may flood the board (guards against future repo-farms)
// Building-with only: a PERSONAL GitHub account shipping a KYC SDK with no traction is a student/hobby project, not a buyer.
// codesearch() already penalised User-owned candidates (w-2), and the 2026-08-11 board proved that penalty is not enough:
// 37 of the lane's 70 leads were User-owned and ALL 37 were personal projects, zero plausible buyers. hrms, Party-Picks,
// braida-beauty-marketplace, Fsd200projects, satoshi_web, open-source-contribution-backup, mafiono/wow, cruiser-app,
// Vantage_legal_brain, ggzwld/dub (a hand-copy of dubinc/dub), plus BuyOwnEx (31 stars, a white-label exchange template).
// The penalty only pushed them DOWN the board, it never removed them, so with the per-lane quota now guaranteeing this lane
// 80 slots the quota had started PROTECTING those 37 from eviction, which is the 08-10 watch item firing exactly as predicted.
// A star floor rather than a blanket User ban, so a genuinely notable solo project can still qualify: today's whole User-owned
// cohort tops out at 31 stars, so 50 drops all 37 with zero false negatives while leaving the door open. Org-owned leads are
// untouched (all 33 keep their slots: Expensify, dub, Superteam, Consensys, DFXswiss, Entrust, HDRUK, OnlyDust, saasquatch).
const BW_USER_STARS = 50;
// SEO backlink farms: template repos cloned across MANY throwaway User accounts (each capped at OWNER_CAP, so the cap can't see the campaign),
// all keyword-stuffed with our topics and all pointing their homepage at one commercial site. The backlink IS the product, so the DOMAIN is the
// only durable anchor (owner bans regenerate daily, and the text morphs: faceseek shipped "reverse image search" prose on 07-31 and KYC-onboarding
// prose by 08-05). Both denied domains are verified vendors/tools, never buyers, so this is the VENDOR class applied to the website field:
// finauth.io = "KYC Identity Verification & Biometric Authentication API" (face biometrics/liveness/doc OCR/AML screening) = an Enforcer competitor;
// faceseek.online = reverse-face-search OSINT tool, off-domain. Added 2026-08-05, drops 39 stored leads across 20 throwaway owners.
// Same operation, 2 more properties confirmed the same day by walking one owner's repo list (EmeraldCentipede published across all four):
// faceonlive.com = "On-Premises Face Recognition & ID Verification (eKYC) SDKs" = a competitor ALREADY owner-banned once as zhu-j-faceonlive on 07-07,
// which is precisely the whack-a-mole this domain anchor ends; payrollflow.io = freelancer invoicing/payout site, off-domain. 153 farm repos across
// these 4 domains from just 8 of the ~21 owners. Rule applied: an entity running a GitHub SEO backlink farm is disqualified as a lead whatever it sells.
// NOTE the anchor is strong because github() enriches `website` from the OWNER PROFILE blog, so one domain drops every repo that owner ever publishes.
const SITE_DENY = new Set(["finauth.io", "faceseek.online", "faceonlive.com", "payrollflow.io"]);
const siteDenied = (u) => { if (!u) return false; const h = String(u).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase(); return [...SITE_DENY].some((d) => h === d || h.endsWith("." + d)); };

const matchKW = (t) => { t = t || ""; for (const k of KW) if (k.re.test(t)) return k; return null; };
// `hold` = this signal's intent does NOT decay on the 30-day repo-push curve, so floor its recency term.
// Used by the hiring lane only. A GitHub push is a moment; an ATS posting that is STILL OPEN is a standing
// condition, and if anything an older open req is the STRONGER signal (the role is still unfilled and the
// compliance budget is still live). Scoring it on push-recency ranked the lane almost purely by posting age:
// measured on the 2026-08-09 board, Nium ("Director - Regulatory Compliance & MLRO Malta", "Global Head of
// Commercial Compliance", 111d) scored 45 and Dlocal (MLRO reqs across 4 countries) 45, while SoFi's 1-day-old
// "Fraud Model Developer" scored 84. With the board back at 294/300 and `slice(0, 300)` acting as a live
// eviction queue, that put 17 of 45 hiring leads below the GitHub lane's floor of 71, i.e. licensed money
// transmitters staffing MLRO roles were about to be evicted by 0-star topic repos pushed today. Same
// crowding-out mechanism as the 08-08 topic:fintech finding, one lane over.
// 0.7 floors the lane at ~69-73 rather than flattening it: a genuinely fresh posting still keeps its full
// recency bonus, so ordering WITHIN the lane is preserved and only the stale tail is lifted off the cut line.
const score = (w, ms, eng, hold) => {
  const rec = Math.max(0, 1 - (now - ms) / (30 * 864e5), hold ? 0.7 : 0);
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
        if (k.strict && !m) continue; // broad topic + nothing in-domain in the description = not a signal (see GH_TOPICS)
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
  return out.filter((l) => !hnJunk(l));
}
// Dedupe by title first: multi-location postings repeat, so a card used to read "Compliance Analyst · Compliance Analyst · Fraud Operations Analyst ·
// Fraud Operations Analyst". Then rank strongest-intent first and seniority within that, because the sort is what picks the card's opener.
const pickRoles = (rs) => [...new Map(rs.filter((r) => HIRE.test(r.title)).map((r) => [r.title, r])).values()]
  .sort((a, b) => (STRONG.test(b.title) - STRONG.test(a.title)) || (SENIOR.test(b.title) - SENIOR.test(a.title))).slice(0, 4);

async function hiring() {
  const out = [];
  // one lead shape for both ATS lanes; `pre` keeps ids distinct so a slug present on both boards can never silently merge into one card
  const push = (pre, slug, roles, fallbackUrl) => {
    if (!roles.length) return;
    const company = slug.charAt(0).toUpperCase() + slug.slice(1);
    out.push({ id: pre + slug, name: company, source: "Hiring", company: company, vertical: "identity", term: "hiring: " + roles[0].title, w: 4, ms: Math.max(...roles.map((r) => r.ms)), eng: roles.length * 30, url: roles[0].url || fallbackUrl, desc: "Open roles: " + roles.map((r) => r.title).join(" · "), author: company });
  };
  for (const slug of ATS_GH) {
    try {
      const j = await jget(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      push("hire_", slug, pickRoles((j.jobs || []).map((x) => ({ title: x.title || "", url: x.absolute_url, ms: new Date(x.updated_at || now).getTime() }))), "https://boards.greenhouse.io/" + slug);
    } catch (e) { console.log("ats", slug, e.message); }
  }
  for (const slug of ATS_LEVER) {
    try {
      const j = await jget(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      push("hirelv_", slug, pickRoles((Array.isArray(j) ? j : []).map((x) => ({ title: x.text || "", url: x.hostedUrl, ms: x.createdAt || now }))), "https://jobs.lever.co/" + slug);
    } catch (e) { console.log("lever", slug, e.message); }
  }
  for (const slug of ATS_ASHBY) {
    try {
      const j = await jget(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      push("hireab_", slug, pickRoles((j.jobs || []).map((x) => ({ title: x.title || "", url: x.jobUrl, ms: new Date(x.publishedAt || now).getTime() }))), "https://jobs.ashbyhq.com/" + slug);
    } catch (e) { console.log("ashby", slug, e.message); }
  }
  for (const slug of ATS_SR) {
    try {
      const j = await jget(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
      push("hiresr_", slug, pickRoles((j.content || []).map((x) => ({ title: x.name || "", url: `https://jobs.smartrecruiters.com/${slug}/${x.id}`, ms: new Date(x.releasedDate || now).getTime() }))), "https://jobs.smartrecruiters.com/" + slug);
    } catch (e) { console.log("smartrecruiters", slug, e.message); }
  }
  for (const slug of ATS_RC) {
    try {
      const j = await jget(`https://${slug}.recruitee.com/api/offers/`);
      push("hirerc_", slug, pickRoles((j.offers || []).map((x) => ({ title: x.title || "", url: x.careers_url, ms: new Date((x.published_at || x.created_at || "").replace(" UTC", "Z").replace(" ", "T") || now).getTime() }))), `https://careers.${slug}.com/`);
    } catch (e) { console.log("recruitee", slug, e.message); }
  }
  for (const slug of ATS_WK) {
    try {
      const j = await jget(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
      push("hirewk_", slug, pickRoles((j.jobs || []).map((x) => ({ title: x.title || "", url: x.url || x.shortlink, ms: new Date(x.published_on || x.created_at || now).getTime() }))), "https://apply.workable.com/" + slug);
    } catch (e) { console.log("workable", slug, e.message); }
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
  // 160, not 80: the five queries above return ~150 unique owners between them, so the budget now covers every vendor instead of
  // being exhausted by the first two. Costs ~2 cheap REST calls per extra candidate, well inside the scan's runtime.
  for (const c of [...found.values()].slice(0, 160)) {
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
    let company = c.login, website = null, personal = false;
    try {
      let r = await fetch(`https://api.github.com/orgs/${c.login}`, { headers });
      if (r.status === 404) r = await fetch(`https://api.github.com/users/${c.login}`, { headers });
      if (r.ok) { const d = await r.json(); company = d.name || c.login; website = d.blog || null; if (d.type === "User") { personal = true; c.w = Math.max(3, c.w - 2); } }
    } catch (e) {}
    await sleep(80);
    if (personal && stars < BW_USER_STARS) continue; // personal account + no traction = hobby project, not a buyer (see BW_USER_STARS)
    out.push({ id: "code_" + c.login, name: c.repo, source: "Building with", vertical: c.v, term: "uses " + c.vendor, w: c.w, ms, eng: stars, url: c.repoUrl, desc: "Ships the " + c.vendor + " SDK in production code (" + c.repo + ")", company, website, author: c.login, vendor: c.vendor });
  }
  return out;
}

async function main() {
  const fresh = [...(await github()), ...(await hn()), ...(await hiring()), ...(await codesearch())];
  const store = new Map();
  // leads.json is written as { updated_at, count, leads: [...] }, so iterating the parsed object directly threw and the catch swallowed it:
  // the store loaded 0 every run and the board was silently rebuilt from scratch each hour (first_seen reset, nothing accumulated,
  // and every "prune already-stored junk" filter below was a no-op). Accept both shapes. Fixed 2026-08-06.
  if (existsSync("leads.json")) { try { const p = JSON.parse(readFileSync("leads.json", "utf8")); for (const l of (Array.isArray(p) ? p : p.leads || [])) store.set(l.id, l); } catch (e) {} }
  let added = 0, updated = 0;
  for (const l of fresh) {
    l.score = score(l.w, l.ms, l.eng, l.source === "Hiring");
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
  all = all.filter((l) => !(/^(Hacker News|Show HN)$/.test(l.source) && hnJunk(l))); // prune already-stored HN press/docs/no-company cards (drops 10 of 12 on the 2026-08-12 board)
  // Prune the already-stored half of the strict-topic change above. `term` is set to the raw topic slug only when matchKW found
  // nothing, so term === "fintech" is exactly the "tagged fintech, description says nothing in-domain" cohort and nothing else
  // (a real KW hit stores term "fintech / payments"). Drops 132 of 300 on the 2026-08-08 board.
  all = all.filter((l) => !(l.source === "GitHub" && l.term === "fintech"));
  // Prune the already-stored half of the BW_USER_STARS change above, otherwise the 37 sit in the store (unre-seen, so never
  // refreshed) until the 60-day cutoff while the quota keeps protecting them. `w <= 4` is EXACTLY the User-owned cohort and
  // nothing else: codesearch() is the only writer of this source and it sets w to 6 (identity SDKs) or 5 (Unit) for an Org and
  // then knocks 2 off for a User, so Org leads are w5/w6 and User leads are w3/w4. Verified on the 08-11 board: 37 match, all 37
  // are the personal projects listed above, and all 33 Org-owned leads are untouched.
  all = all.filter((l) => !(l.source === "Building with" && l.w <= 4 && (l.eng || 0) < BW_USER_STARS));
  all = all.filter((l) => !siteDenied(l.website)); // drop SEO backlink farms + vendor-owned repos by homepage domain (source-agnostic: github() and codesearch() both enrich website). Runs post-merge so it covers fresh AND stored leads in one place.

  // Recompute every score, not just the fresh ones: now that the store actually loads, a lead that stops being re-seen would
  // otherwise keep the score it earned when it was new and outrank genuinely fresh leads until the 60-day cutoff.
  for (const l of all) l.score = score(l.w, l.ms, l.eng, l.source === "Hiring");
  all.sort((a, b) => b.score - a.score);
  const ownerSeen = {};
  all = all.filter((l) => { const o = l.author ? l.author.toLowerCase() : null; if (!o) return true; ownerSeen[o] = (ownerSeen[o] || 0) + 1; return ownerSeen[o] <= OWNER_CAP; });
  // Per-lane guarantee, then backfill the rest of the cap by score. `slice(0, CAP)` on a pure global score sort made the
  // ONE unbounded lane (GitHub topics) the sole decider of what the other three lanes get to keep, and cross-lane scores are
  // not comparable: the score fn was calibrated per-signal, never across signals, so a 0-star topic repo pushed today (71)
  // outranks a licensed money transmitter hiring an MLRO (69) and a Consensys Onfido integration (56). This was diagnosed
  // twice as a filter problem (08-08 topic:fintech chaff) and once as a scoring problem (08-09 hiring push-decay); both were
  // real, but both were symptoms of this. MEASURED on the 08-10 board, 300/300 saturated: 40 leads sat below the GitHub
  // lane's floor of 70 while GitHub grew ~31/day, so the queue cleared in ~31h, and it held 3 Hiring leads at 69
  // (Gocardless Financial Crime, Xendit Regulatory Compliance, Checkr), 8 of the 10 Hacker News leads, and the org-owned
  // half of Building-with (Consensys, OnlyDust, WSO2/Asgardeo, holonym-foundation, 0xkyc, TPF Payments Factory, dacade).
  // The 22h before that had already evicted 24 Building-with + 1 HN lead, replaced by 27 fresh GitHub topic hits.
  // The three quotas below are ABOVE what each lane can currently produce (Hiring is bounded by 49 ATS slugs, Building-with
  // by codesearch's 160-owner budget, HN by its query set), so today they are simply "never evict these", and GitHub still
  // takes every slot the others leave unused (46+10+46 used today -> GitHub keeps all 198). They only start to bite if a
  // bounded lane grows past its guarantee, which is the point: growth in one lane can then no longer silently delete another.
  const QUOTA = { Hiring: 60, "Hacker News": 25, "Building with": 80 };
  const laneSeen = {}, guaranteed = [], overflow = [];
  for (const l of all) { laneSeen[l.source] = (laneSeen[l.source] || 0) + 1; (laneSeen[l.source] <= (QUOTA[l.source] || 0) ? guaranteed : overflow).push(l); }
  all = guaranteed.concat(overflow).slice(0, 300).sort((a, b) => b.score - a.score); // re-sort so the written order stays pure score, as the site expects
  writeFileSync("leads.json", JSON.stringify({ updated_at: new Date().toISOString(), count: all.length, leads: all }, null, 0));
  console.log(`scan done: ${fresh.length} fresh, +${added} new, ~${updated} updated, ${all.length} stored`);
}
main();
