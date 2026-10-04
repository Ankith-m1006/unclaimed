// Unclaimed: finds open-source issues nobody has taken yet.
// Hard facts (assignee, linked PRs, "not ready" banners) come from the GitHub API.
// The fuzzy part (who asked for the issue, who says they are working on it, what the
// maintainer answered, what the work actually is) is read by Gemma, an open-weight
// model served by our own Ollama instance.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const MODEL = process.env.GEMMA_MODEL || "gemma3:4b";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 15);
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

// ---------- GitHub ----------

let rate = { remaining: null, reset: null };

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "unclaimed-issue-scout",
      ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });
  rate = { remaining: res.headers.get("x-ratelimit-remaining"), reset: res.headers.get("x-ratelimit-reset") };
  if (res.status === 403 || res.status === 429) throw new UserError("GitHub's rate limit is used up. Try again in a few minutes.");
  if (res.status === 404) throw new UserError("That repository or issue doesn't exist, or it's private.");
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

class UserError extends Error {}

function parseTarget(input) {
  const s = String(input || "").trim();
  const issue = s.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i);
  if (issue) return { owner: issue[1], repo: issue[2], number: Number(issue[3]) };
  const repo = s.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "").match(/^([\w.-]+)\/([\w.-]+)$/);
  if (repo) return { owner: repo[1], repo: repo[2] };
  throw new UserError('Enter a repository like "kestra-io/kestra" or an issue link.');
}

const NOT_READY = /kestra-bot:not-ready|not ready for contributions/i;

async function collectFacts(owner, repo, issue) {
  const [comments, timeline] = await Promise.all([
    issue.comments ? gh(`/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`) : [],
    gh(`/repos/${owner}/${repo}/issues/${issue.number}/timeline?per_page=100`),
  ]);
  const prs = new Map();
  // Many maintainers keep their org membership private, so GitHub reports them as
  // CONTRIBUTOR. Anyone who labelled, assigned, closed or milestoned this issue has
  // triage rights, so treat them as a maintainer too.
  const triagers = new Set();
  for (const ev of timeline) {
    if (["labeled", "unlabeled", "assigned", "unassigned", "milestoned", "closed", "reopened"].includes(ev.event) && ev.actor?.login) {
      triagers.add(ev.actor.login.toLowerCase());
    }
    const src = ev.event === "cross-referenced" ? ev.source?.issue : null;
    if (src?.pull_request) {
      prs.set(src.html_url, {
        number: src.number,
        url: src.html_url,
        author: src.user?.login,
        state: src.pull_request.merged_at ? "merged" : src.state,
        repo: src.repository?.full_name,
      });
    }
  }
  return {
    comments: comments.map((c) => ({
      user: c.user?.login,
      // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE...; upgraded when the timeline shows triage rights
      role: triagers.has(c.user?.login?.toLowerCase()) && !MAINTAINER_ROLES.has(c.author_association) ? "TRIAGER" : c.author_association,
      date: c.created_at.slice(0, 10),
      body: c.body || "",
      url: c.html_url,
    })),
    prs: [...prs.values()],
  };
}

// ---------- Gemma ----------

const SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          user: { type: "string" },
          kind: { type: "string", enum: ["asked_to_be_assigned", "says_working_on_it", "opened_a_pr"] },
        },
        required: ["user", "kind"],
      },
    },
    maintainer_said: { type: "string" },
    summary: { type: "string" },
    difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
  },
  required: ["claims", "maintainer_said", "summary", "difficulty"],
};

const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR", "TRIAGER"]);

function threadText(issue, comments) {
  const lines = comments.slice(-15).map((c) => {
    const who = MAINTAINER_ROLES.has(c.role) ? "maintainer" : "contributor";
    return `[${c.date}] @${c.user} (${who}): ${c.body.replace(/\s+/g, " ").slice(0, 400)}`;
  });
  return [
    `ISSUE TITLE: ${issue.title}`,
    `ISSUE BODY: ${(issue.body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").slice(0, 1200)}`,
    "COMMENTS:",
    lines.length ? lines.join("\n") : "(no comments)",
  ].join("\n");
}

async function askGemma(issue, comments) {
  const prompt = `You help open-source contributors find issues that nobody has taken yet.
Read the GitHub issue thread below and answer in JSON.

claims: every contributor (not maintainer) who asked to be assigned, said they are working on it, or said they opened a pull request. Use their exact @username without the @. Ignore contributors who only asked a question or reported the bug.
maintainer_said: one short sentence on what a maintainer decided about who works on it (for example "assigned @x" or "told @y to finish another issue first"), or "" if no maintainer said anything about it.
summary: one plain sentence saying what work the issue needs.
difficulty: easy, medium or hard for a first-time contributor.

${threadText(issue, comments)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        prompt,
        format: SCHEMA,
        stream: false,
        // A short, capped answer keeps a small model from rambling until the timeout.
        options: { temperature: 0, num_predict: 350, num_ctx: 4096, num_thread: Number(process.env.GEMMA_THREADS || 8) },
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const sec = (ns) => (ns / 1e9).toFixed(1);
    console.log(`gemma #${issue.number}: prompt ${data.prompt_eval_count} tok in ${sec(data.prompt_eval_duration)}s, answer ${data.eval_count} tok in ${sec(data.eval_duration)}s, done=${data.done_reason}`);
    return JSON.parse(data.response);
  } finally {
    clearTimeout(timer);
  }
}

// Used only when Gemma is unreachable, so the page still says something useful.
const CLAIM_RE = /(i('| a)?m working|i('| wi)?ll (work|take|pick)|can i (work|take|pick|get)|assign (it |this )?(to )?me|i('| woul)?d (like|love) to (work|take|contribute)|i want to work|working on (it|this)|please assign|could you assign|picking (this|it) up)/i;

function fallbackClaims(comments) {
  return comments
    .filter((c) => !MAINTAINER_ROLES.has(c.role) && CLAIM_RE.test(c.body))
    .map((c) => ({ user: c.user, kind: "asked_to_be_assigned" }));
}

// The comment a claim rests on, so people can check Gemma's verdict at a glance.
// Prefers the claimant's comment that reads like a claim; otherwise their first comment.
function evidence(comments, user) {
  const mine = comments.filter((c) => c.user?.toLowerCase() === user.toLowerCase());
  const c = mine.find((x) => CLAIM_RE.test(x.body)) || mine[0];
  if (!c) return {};
  const text = c.body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^>.*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(link)")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  const best = sentences.find((s) => CLAIM_RE.test(s)) || sentences[0] || "";
  const quote = best.trim().length > 160 ? best.trim().slice(0, 157).trimEnd() + "…" : best.trim();
  return { date: c.date, quote, url: c.url };
}

function onlyTalksAboutOthers(comments, user) {
  const mine = comments.filter((c) => c.user?.toLowerCase() === user.toLowerCase());
  if (!mine.length || mine.some((c) => CLAIM_RE.test(c.body))) return false;
  const aboutOther = /assign\w*\b[^.]*@(?!\s)([\w-]+)|@([\w-]+)[^.]*\bassign/i;
  return mine.every((c) => {
    const m = c.body.match(aboutOther);
    const other = m && (m[1] || m[2]);
    return other && other.toLowerCase() !== user.toLowerCase();
  });
}

// ---------- Verdict ----------

async function judge(owner, repo, issue, cache) {
  const key = `${owner}/${repo}#${issue.number}@${issue.updated_at}`;
  if (cache.has(key)) return cache.get(key);

  const base = {
    repo: `${owner}/${repo}`,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    created: issue.created_at.slice(0, 10),
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    comments: issue.comments,
  };
  const reasons = [];

  if (issue.state !== "open") return { ...base, verdict: "closed", reasons: ["The issue is closed."] };

  const assignees = (issue.assignees || []).map((a) => a.login);
  if (NOT_READY.test(issue.body || "")) {
    return { ...base, verdict: "not_ready", reasons: ["The maintainers marked it as not ready for contributions yet."] };
  }
  if (assignees.length) {
    return { ...base, verdict: "assigned", reasons: [`Assigned to ${assignees.map((a) => "@" + a).join(", ")}.`] };
  }

  const facts = await collectFacts(owner, repo, issue);
  const livePrs = facts.prs.filter((p) => p.state === "open" || p.state === "merged");
  if (livePrs.length) {
    return {
      ...base,
      verdict: "has_pr",
      reasons: livePrs.map((p) => `Pull request #${p.number} by @${p.author} is ${p.state}.`),
      prs: livePrs,
    };
  }

  // Nothing hard-blocks it, so the thread decides. This is Gemma's job.
  let ai = null;
  let source = "gemma";
  try {
    ai = await askGemma(issue, facts.comments);
  } catch (err) {
    console.error(`gemma #${issue.number} failed: ${err.message}`);
    source = "fallback";
  }

  const commenters = new Set(facts.comments.filter((c) => !MAINTAINER_ROLES.has(c.role)).map((c) => c.user?.toLowerCase()));
  const claims = (ai ? ai.claims : fallbackClaims(facts.comments))
    .map((c) => ({ ...c, user: String(c.user || "").replace(/^@/, "") }))
    // Only keep people who actually commented: a small model can invent names.
    .filter((c) => commenters.has(c.user.toLowerCase()))
    // Drop someone who only pointed at another person's assignment ("you missed assigning @x").
    .filter((c) => !onlyTalksAboutOthers(facts.comments, c.user));
  const unique = [...new Map(claims.map((c) => [c.user.toLowerCase(), c])).values()].map((c) => ({
    ...c,
    ...evidence(facts.comments, c.user),
  }));

  if (unique.length) {
    reasons.push(
      `${unique.length} ${unique.length === 1 ? "person has" : "people have"} claimed it: ${unique
        .map((c) => "@" + c.user + (c.kind === "says_working_on_it" ? " (working on it)" : c.kind === "opened_a_pr" ? " (says a PR is open)" : ""))
        .join(", ")}.`
    );
  } else if (facts.comments.length === 0) {
    reasons.push("No comments yet: nobody has asked for it.");
  } else {
    reasons.push("Nobody in the thread has asked for it or said they are working on it.");
  }
  if (ai?.maintainer_said) reasons.push(`Maintainer: ${ai.maintainer_said}`);

  const result = {
    ...base,
    verdict: unique.length ? "claimed" : "available",
    reasons,
    claims: unique,
    summary: ai?.summary || null,
    difficulty: ai?.difficulty || null,
    source,
  };
  cache.set(key, result);
  return result;
}

// ---------- Labels ----------
// Repos spell the same label differently: "good first issue", "good-first-issue",
// "Good First Issue", "first-timers-only"... Match the user's label to the repo's own.

const norm = (s) => String(s).toLowerCase().replace(/[\s_\-:]+/g, "");
const BEGINNER = ["goodfirstissue", "goodfirstissues", "goodfirstbug", "firsttimersonly", "beginnerfriendly", "beginner", "easy", "starter", "goodfirstcontribution"];

async function resolveLabel(owner, repo, wanted) {
  const labels = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/repos/${owner}/${repo}/labels?per_page=100&page=${page}`);
    labels.push(...batch.map((l) => l.name));
    if (batch.length < 100) break;
  }
  const w = norm(wanted);
  const exact = labels.find((l) => norm(l) === w);
  if (exact) return exact;
  if (BEGINNER.includes(w) || w.includes("firstissue")) {
    for (const candidate of BEGINNER) {
      const hit = labels.find((l) => norm(l) === candidate);
      if (hit) return hit;
    }
  }
  return labels.find((l) => norm(l).includes(w)) || null;
}

// ---------- HTTP ----------

const cache = new Map();

async function scan(req, res, url) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");
  try {
    const target = parseTarget(url.searchParams.get("target"));
    const asked = url.searchParams.has("label") ? url.searchParams.get("label").trim() : "good first issue";
    let label = asked;
    let issues;
    const list = async (lbl) => {
      const q = new URLSearchParams({ state: "open", sort: "created", direction: "desc", per_page: "50" });
      if (lbl) q.set("labels", lbl);
      return (await gh(`/repos/${target.owner}/${target.repo}/issues?${q}`)).filter((i) => !i.pull_request).slice(0, MAX_ISSUES);
    };
    if (target.number) {
      issues = [await gh(`/repos/${target.owner}/${target.repo}/issues/${target.number}`)];
      label = null;
    } else {
      issues = await list(label);
      if (!issues.length && label) {
        const match = await resolveLabel(target.owner, target.repo, label);
        if (match && match !== label) {
          label = match;
          issues = await list(label);
        }
      }
    }
    send({ type: "start", total: issues.length, model: MODEL, label, asked });
    for (const issue of issues) {
      try {
        send({ type: "issue", issue: await judge(target.owner, target.repo, issue, cache) });
      } catch (err) {
        send({ type: "issue_error", number: issue.number, title: issue.title, message: err instanceof UserError ? err.message : "Couldn't read this issue." });
        if (err instanceof UserError) break;
      }
    }
    send({ type: "done", rate });
  } catch (err) {
    send({ type: "error", message: err instanceof UserError ? err.message : "Something went wrong reading GitHub." });
    if (!(err instanceof UserError)) console.error(err);
  }
  res.end();
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/scan" && req.method === "GET") return scan(req, res, url);
  if (url.pathname === "/api/health") {
    let gemma = false;
    try {
      gemma = (await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, gemma, model: MODEL }));
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (file.includes("..")) return res.writeHead(400).end();
  try {
    const body = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(PORT, () => console.log(`Unclaimed on :${PORT}, model ${MODEL} at ${OLLAMA_URL}`));
