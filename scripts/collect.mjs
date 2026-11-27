// 채용공고 수집 스크립트
// 실행: node scripts/collect.mjs  (GitHub Actions가 매일 한국시간 0시쯤 실행)
// 결과: data/jobs.json
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nowKST, addDaysKST, keepJob } from "./lib/util.mjs";
import * as S from "./lib/sources.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "jobs.json");
const DAYS = 7; // 접속일 기준 마감 7일 이내

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const SOURCES = [
  ["잡다", S.jobda],
  ["자소설닷컴", S.jasoseol],
  ["사람인", S.saramin],
  ["잡코리아", S.jobkorea],
  ["고용24", S.work24],
  ["잡알리오", S.alio],
  ["나라일터", S.gojobs],
  ["클린아이 잡플러스", S.cleaneye],
];

const normCo = (s) => s.replace(/\(주\)|㈜|주식회사|\(유\)|\(재\)|재단법인|사단법인|\s/g, "").toLowerCase();
const normTi = (s) => s.replace(/\[[^\]]*\]|\([^)]*\)|[^\p{L}\p{N}]/gu, "").toLowerCase();
const filled = (j) => ["duty", "req", "pref", "salary", "empType", "location", "probation"].filter((k) => j[k]).length;

export async function main() {
  const today = nowKST();
  const limitDate = addDaysKST(DAYS);
  log(`수집 시작: ${today.iso} (마감 ${limitDate}까지)`);

  let prev = { jobs: [] };
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

  const results = await Promise.all(
    SOURCES.map(async ([name, fn]) => {
      try {
        const jobs = await fn({ limitDate, log });
        log(`✔ ${name}: ${jobs.length}건`);
        return { name, ok: true, jobs };
      } catch (e) {
        log(`✘ ${name}: ${e.message}`);
        return { name, ok: false, jobs: [] };
      }
    }),
  );

  // 실패한 사이트는 이전 데이터 중 아직 마감 전인 것을 유지
  let all = [];
  const status = {};
  for (const r of results) {
    let jobs = r.jobs;
    if (!r.ok || jobs.length === 0) {
      const kept = (prev.jobs || []).filter((j) => (j.links || []).some((l) => l.site === r.name) && j.deadline >= today.iso);
      jobs = kept.map((j) => ({ ...j, source: r.name }));
      status[r.name] = { ok: false, count: jobs.length, note: "수집 실패 — 이전 데이터 유지" };
    } else status[r.name] = { ok: true, count: jobs.length };
    all.push(...jobs);
  }

  // 같은 회사·같은 제목 공고는 하나로 합치고 지원 링크를 모두 보여준다
  const map = new Map();
  for (const j of all) {
    const links = j.links || [{ site: j.source, url: j.url }];
    const key = normCo(j.company) + "|" + normTi(j.title);
    const ex = map.get(key);
    if (!ex) { map.set(key, { ...j, links: [...links] }); continue; }
    const base = filled(j) > filled(ex) ? { ...j, links: ex.links } : ex;
    for (const k of ["duty", "req", "must", "pref", "salary", "empType", "contract", "probation", "location"]) if (!base[k] && j[k]) base[k] = j[k];
    for (const l of links) if (!base.links.some((x) => x.site === l.site)) base.links.push(l);
    base.fields = [...new Set([...(ex.fields || []), ...(j.fields || [])])];
    base.regions = [...new Set([...(ex.regions || []), ...(j.regions || [])])].filter((r, _, a) => r !== "전국·기타" || a.length === 1);
    if (j.deadline < base.deadline) base.deadline = j.deadline;
    map.set(key, base);
  }
  const jobs = [...map.values()]
    .map(({ url, source, ...rest }) => rest)
    .filter(keepJob)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify({ collectedAt: today.iso, collectedDate: today.date, days: DAYS, status, count: jobs.length, jobs }, null, 1),
  );
  log(`저장 완료: ${jobs.length}건 → data/jobs.json`);
  return { count: jobs.length, status };
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) main().catch((e) => { console.error(e); process.exit(1); });
