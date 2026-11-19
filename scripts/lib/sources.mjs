// 사이트별 수집기. 각 함수는 공통 형식의 공고 배열을 돌려준다.
import {
  http, sleep, htmlToText, clean, clip, kst, inferYear, nowKST,
  extractSections, findProbation, findContract, findSalary, normEmpType, classify, toRegions,
} from "./util.mjs";

// 사이트 검색어 (모집분야: 연구·R&D, 사무, 제조·생산(QA/QC), 바이오, 제약 + 생물·환경·화학·농업·식품 전공 관련)
export const KEYWORDS = [
  "품질관리", "QC", "QA", "연구원", "연구개발", "바이오", "제약", "생산관리",
  "화학", "식품", "환경", "미생물", "분석", "GMP", "사무직", "농업",
];

const DELAY = 250;

function make(p) {
  const text = p.fullText || "";
  const sec = text ? extractSections(text) : { duty: "", req: "", must: "", pref: "", reqAll: "" };
  const fields = classify({ title: p.title, category: p.category || "", body: text, requirement: sec.reqAll + " " + (p.req || "") });
  if (!fields) return null;
  const emp = normEmpType(p.empType || "");
  const contract = p.contract || (/계약|인턴|기간제|파견/.test(emp) ? findContract(`${p.title}\n${p.empType || ""}\n${text}`) : "");
  return {
    id: `${p.source}-${p.sid}`,
    source: p.source,
    company: clean(p.company),
    title: clean(p.title),
    fields,
    duty: p.duty || sec.duty,
    req: p.req || sec.req,
    must: p.must || sec.must,
    pref: p.pref || sec.pref,
    empType: emp,
    contract,
    probation: p.probation || findProbation(`${p.empType || ""}\n${text}`),
    location: clean(p.location || ""),
    regions: toRegions(p.location || ""),
    salary: clean(p.salary || findSalary(text) || ""),
    deadline: p.deadline, // "YYYY-MM-DDTHH:mm" (KST)
    url: p.url,
  };
}
const within = (deadline, limitDate) => deadline && deadline.slice(0, 10) <= limitDate && deadline >= nowKST().iso;

// ======================= 잡다 (API) =======================
export async function jobda({ limitDate, log }) {
  const titles = [1, 2, 3, 4, 11, 13, 14, 53, 54, 21, 22, 45, 47, 48, 40, 110].join(",");
  const out = [];
  for (let page = 0; page < 15; page++) {
    const url = `https://api.jobda.im/v2/position?page=${page}&size=60&jobTitles=${titles}&recruitments=&locations=&orderType=DEADLINE`;
    const data = await http(url, { json: true });
    const list = data.positions || [];
    if (!list.length) break;
    let over = false;
    for (const p of list) {
      const deadline = (p.closingDateTime || "").slice(0, 16);
      if (deadline.slice(0, 10) > limitDate) { over = true; break; }
      if (!within(deadline, limitDate)) continue;
      out.push(p);
    }
    if (over) break;
    await sleep(DELAY);
  }
  log(`잡다 목록 ${out.length}건`);
  const res = [];
  for (const p of out) {
    let d = {};
    try { d = await http(`https://api.jobda.im/v2/position/${p.positionSn}`, { json: true }); } catch {}
    await sleep(DELAY);
    const b = d.basicInfo || {};
    const text = htmlToText(b.jobDescription || "");
    const sal = b.minSalary || b.maxSalary ? `${b.minSalary ? b.minSalary + "만원" : ""}${b.maxSalary ? " ~ " + b.maxSalary + "만원" : ""}`.trim() : "";
    const typeMap = { NEW: "신입", CAREER: "경력", NEWORCAREER: "신입·경력", INTERN: "인턴" };
    const r = make({
      source: "잡다", sid: p.positionSn,
      company: p.companyName,
      title: p.jobPosting?.jobPostingName ? `${p.jobPosting.jobPostingName} - ${p.positionName}` : p.positionName,
      category: `${p.jobGroupName || ""} ${(p.jobTitleNames || []).join(" ")}`,
      fullText: text,
      empType: /계약/.test(p.positionName + (p.jobPosting?.jobPostingName || "")) ? "계약직" : /인턴/.test(p.positionName + (p.jobPosting?.jobPostingName || "")) ? "인턴" : (findEmp(text) || typeMap[p.recruitmentType] || ""),
      location: [b.address, p.locationName !== "전체" ? p.locationName : ""].filter(Boolean).join(" ") || "전국",
      salary: sal,
      deadline: (p.closingDateTime || "").slice(0, 16),
      url: `https://www.jobda.im/position/${p.positionSn}/jd`,
    });
    if (r) res.push(r);
  }
  return res;
}
function findEmp(text) {
  const m = text.match(/(정규직|계약직|인턴|파견직|기간제|무기계약직|전환형\s*인턴)/);
  return m ? m[1] : "";
}

// ======================= 자소설닷컴 (API) =======================
export async function jasoseol({ limitDate, log }) {
  const groups = await http("https://jasoseol.com/api/v1/duty-groups", { json: true });
  const byId = new Map(groups.map((g) => [g.id, g]));
  const pathName = (id) => {
    const names = [];
    let g = byId.get(id);
    while (g) { names.unshift(g.name); g = g.group_id ? byId.get(g.group_id) : null; }
    return names.join(" ");
  };
  const n = nowKST();
  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(`${limitDate}T23:59:59+09:00`).toISOString();
  const data = await http("https://jasoseol.com/employment/calendar_list.json", {
    method: "POST", json: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ start_time: start, end_time: end }),
  });
  const res = [];
  for (const e of data.employment || []) {
    const deadline = (e.end_time || "").slice(0, 16);
    if (!within(deadline, limitDate)) continue;
    const cats = (e.employments || []).flatMap((x) => (x.duty_groups || []).map((g) => pathName(g.group_id)));
    const div = (e.employments || []).map((x) => x.division);
    const r = make({
      source: "자소설닷컴", sid: e.id,
      company: e.name, title: e.title,
      category: [...new Set(cats)].join(" "),
      empType: e.recruit_type === 2 ? "인턴" : div.includes(1) && div.includes(2) ? "신입·경력" : div.includes(1) ? "신입" : div.includes(2) ? "경력" : "",
      location: "", deadline,
      url: `https://jasoseol.com/recruit/${e.id}`,
    });
    if (r) res.push(r);
  }
  log(`자소설닷컴 ${res.length}건`);
  return res;
}

// ======================= 사람인 (검색 결과 HTML) =======================
function saraminDeadline(s) {
  const n = nowKST();
  s = clean(s);
  let m;
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})/))) return kst(inferYear(+m[1]), +m[1], +m[2], +m[3], +m[4]);
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})/))) return kst(inferYear(+m[1]), +m[1], +m[2]);
  if ((m = s.match(/(\d{1,2})시\s*마감/))) return kst(n.y, n.m, n.d, +m[1], 0);
  if (/오늘\s*마감/.test(s)) return kst(n.y, n.m, n.d);
  if (/내일\s*마감/.test(s)) { const t = new Date(Date.now() + 9 * 3600e3 + 86400e3); return kst(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  if ((m = s.match(/D-(\d+)/))) { const t = new Date(Date.now() + 9 * 3600e3 + +m[1] * 86400e3); return kst(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  return "";
}
export async function saramin({ limitDate, log }) {
  const seen = new Map();
  for (const kw of KEYWORDS) {
    log(`  · 검색어 ${kw}`);
    for (let page = 1; page <= 4; page++) {
      const url = `https://www.saramin.co.kr/zf_user/search/recruit?searchword=${encodeURIComponent(kw)}&recruitSort=closing_dt&recruitPageCount=40&recruitPage=${page}`;
      let html;
      try { html = await http(url); } catch (e) { log(`사람인 ${kw} 실패: ${e.message}`); break; }
      const blocks = html.split('<div class="item_recruit"').slice(1);
      if (!blocks.length) break;
      let over = false;
      for (const b of blocks) {
        const id = (b.match(/^\s*value="(\d+)"/) || [])[1];
        if (!id) continue;
        const deadline = saraminDeadline((b.match(/<span class="date">([\s\S]*?)<\/span>/) || [])[1] || "");
        if (deadline && deadline.slice(0, 10) > limitDate) { over = true; continue; }
        if (!within(deadline, limitDate) || seen.has(id)) continue;
        const cond = [...((b.match(/<div class="job_condition">([\s\S]*?)<\/div>/) || [])[1] || "").matchAll(/<span>([\s\S]*?)<\/span>/g)].map((x) => clean(x[1]));
        seen.set(id, {
          id,
          title: (b.match(/<h2 class="job_tit">[\s\S]*?title="([^"]*)"/) || [])[1] || "",
          company: clean((b.match(/<strong class="corp_name">([\s\S]*?)<\/strong>/) || [])[1] || ""),
          location: cond[0] || "",
          career: cond[1] || "",
          empType: cond[3] || "",
          category: clean(((b.match(/<div class="job_sector">([\s\S]*?)<span class="job_day/) || [])[1] || "")),
          deadline,
        });
      }
      if (over) break;
      await sleep(DELAY);
    }
  }
  log(`사람인 목록 ${seen.size}건`);
  const res = [];
  for (const p of seen.values()) {
    // 제목·분야로 먼저 거른 뒤에만 상세를 읽는다
    if (!classify({ title: p.title, category: p.category })) continue;
    let text = "";
    try {
      const h = await http(`https://www.saramin.co.kr/zf_user/jobs/relay/view-detail?rec_idx=${p.id}&rec_seq=0`);
      text = htmlToText((h.match(/<div class="user_content">([\s\S]*?)<script/) || [])[1] || "");
    } catch {}
    await sleep(DELAY);
    const r = make({
      source: "사람인", sid: p.id,
      company: p.company, title: p.title, category: p.category,
      fullText: text, empType: p.empType, location: p.location, deadline: p.deadline,
      url: `https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${p.id}`,
    });
    if (r) res.push(r);
  }
  return res;
}

// ======================= 잡코리아 (검색 → 상세) =======================
function labelVal(text, label, stops) {
  const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*\\n?([\\s\\S]{0,300}?)(?=\\n\\s*(?:${stops})|$)`);
  const m = text.match(re);
  return m ? m[1].replace(/\n/g, " ").replace(/\s+/g, " ").trim() : "";
}
export async function jobkorea({ limitDate, log }) {
  const ids = new Set();
  for (const kw of KEYWORDS) {
    log(`  · 검색어 ${kw}`);
    for (let page = 1; page <= 2; page++) {
      const url = `https://www.jobkorea.co.kr/Search/?stext=${encodeURIComponent(kw)}&tabType=recruit&Ord=EndAsc&Page_No=${page}`;
      let html;
      try { html = await http(url); } catch (e) { log(`잡코리아 ${kw} 실패: ${e.message}`); break; }
      const found = [...html.matchAll(/GI_Read\/(\d+)/g)].map((m) => m[1]);
      if (!found.length) break;
      found.forEach((x) => ids.add(x));
      await sleep(DELAY);
    }
  }
  log(`잡코리아 후보 ${ids.size}건`);
  const res = [];
  for (const id of ids) {
    let html;
    try { html = await http(`https://www.jobkorea.co.kr/Recruit/GI_Read/${id}`); } catch { continue; }
    await sleep(DELAY);
    const t = htmlToText(html);
    const dm = t.match(/마감일\s*\n?\s*(\d{4})\.(\d{2})\.(\d{2})(?:\([^)]*\))?\s*(\d{1,2}:\d{2})?/);
    if (!dm) continue;
    const [hh, mm] = dm[4] ? dm[4].split(":").map(Number) : [23, 59];
    const deadline = kst(+dm[1], +dm[2], +dm[3], hh, mm);
    if (!within(deadline, limitDate)) continue;
    const titleTag = clean((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const tm = titleTag.match(/^(.*?)\s*채용\s*-\s*(.*?)\s*\|\s*잡코리아/);
    const company = tm ? tm[1] : "";
    const title = tm ? tm[2] : titleTag;
    const stops = "모집인원|고용형태|급여|근무지주소|인근지하철|지원자격|경력|학력|스킬|우대조건|자격증|로그인|TOP|접수기간|모집분야|직무|기업 정보";
    const empType = labelVal(t, "고용형태", stops);
    const salary = labelVal(t, "급여", stops);
    const location = labelVal(t, "근무지주소", stops).replace(/지도보기/, "").trim();
    const pref = labelVal(t, "우대조건", stops).replace(/^기본우대\s*/, "");
    const career = labelVal(t, "경력", stops);
    const edu = labelVal(t, "학력", stops);
    const lic = labelVal(t, "자격증", stops);
    if (!classify({ title, category: "" })) continue;
    let body = "";
    try { body = htmlToText(await http(`https://www.jobkorea.co.kr/Recruit/GI_Read_Comt_Ifrm?Gno=${id}`)); } catch {}
    await sleep(DELAY);
    const sec = extractSections(body);
    const reqBase = [career && `경력: ${career}`, edu && `학력: ${edu}`].filter(Boolean).join("\n");
    const r = make({
      source: "잡코리아", sid: id, company, title, fullText: body,
      req: sec.req ? `${reqBase}\n${sec.req}` : reqBase,
      must: sec.must || [lic && lic !== "" ? `자격증: ${lic}` : ""].filter(Boolean).join(""),
      pref: sec.pref || pref,
      empType, salary, location, deadline,
      url: `https://www.jobkorea.co.kr/Recruit/GI_Read/${id}`,
    });
    if (r) res.push(r);
  }
  return res;
}

// ======================= 고용24 (검색 → 상세) =======================
export async function work24({ limitDate, log }) {
  const seen = new Map();
  for (const kw of KEYWORDS) {
    log(`  · 검색어 ${kw}`);
    for (let page = 1; page <= 3; page++) {
      const url = `https://www.work24.go.kr/wk/a/b/1200/retriveDtlEmpSrchList.do?keyword=${encodeURIComponent(kw)}&sortField=receiptCloseDt&sortOrderBy=ASC&resultCnt=50&pageIndex=${page}`;
      let html;
      try { html = await http(url); } catch (e) { log(`고용24 ${kw} 실패: ${e.message}`); break; }
      const rows = html.split(/<tr id="list\d+">/).slice(1);
      if (!rows.length) break;
      let over = false;
      for (const row of rows) {
        const no = (row.match(/wantedAuthNo=([A-Za-z0-9]+)&amp;infoTypeCd=([A-Z]+)&amp;infoTypeGroup=([a-z_]+)/) || row.match(/wantedAuthNo=([A-Za-z0-9]+)&infoTypeCd=([A-Z]+)&infoTypeGroup=([a-z_]+)/));
        if (!no) continue;
        const t = htmlToText(row);
        const dm = t.match(/마감일\s*:\s*(\d{4})-(\d{2})-(\d{2})/);
        if (!dm) continue;
        const deadline = kst(+dm[1], +dm[2], +dm[3]);
        if (deadline.slice(0, 10) > limitDate) { over = true; continue; }
        if (!within(deadline, limitDate) || seen.has(no[1])) continue;
        const company = clean((row.match(/class="cp_name[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
        const title = clean((row.match(/class="t3_sb[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
        seen.set(no[1], { no: no[1], cd: no[2], grp: no[3], company, title, deadline });
      }
      if (over) break;
      await sleep(DELAY);
    }
  }
  log(`고용24 목록 ${seen.size}건`);
  const res = [];
  for (const p of seen.values()) {
    if (!classify({ title: p.title })) continue;
    const url = `https://www.work24.go.kr/wk/a/b/1500/empDetailAuthView.do?wantedAuthNo=${p.no}&infoTypeCd=${p.cd}&infoTypeGroup=${p.grp}`;
    let t = "";
    try { t = htmlToText(await http(url)); } catch { continue; }
    await sleep(DELAY);
    const after = (label, n = 200) => {
      const i = t.indexOf(`\n${label}\n`);
      if (i < 0) return "";
      return t.slice(i + label.length + 2, i + label.length + 2 + n).split("\n")[0].trim();
    };
    const duty = (t.match(/직무내용\s*\n([\s\S]*?)\n\s*더보기/) || [])[1] || "";
    const job = after("모집 직종");
    const career = after("경력");
    const edu = after("학력");
    const lic = after("자격 면허");
    const major = after("전공");
    const prefEtc = (t.match(/기타 우대사항\s*\n([\s\S]*?)\n\s*기타사항/) || [])[1] || "";
    const prefCond = after("우대조건");
    const empType = after("고용 형태") || after("고용형태");
    const r = make({
      source: "고용24", sid: p.no,
      company: p.company, title: p.title, category: job,
      fullText: t.slice(t.indexOf("모집요강"), t.indexOf("전형방법") > 0 ? t.indexOf("전형방법") : undefined),
      duty: clip(duty, 450),
      req: [career && `경력: ${career}`, edu && `학력: ${edu}`].filter(Boolean).join("\n"),
      must: lic && lic !== "관계없음" && lic !== "-" ? `자격면허: ${lic}` : "",
      pref: clip([major && major !== "-" ? `전공: ${major}` : "", prefCond && prefCond !== "-" ? prefCond : "", prefEtc.trim() !== "-" ? prefEtc.trim() : ""].filter(Boolean).join("\n"), 400),
      empType, salary: after("임금 조건"), location: after("근무 예정지"), deadline: p.deadline, url,
    });
    if (r) res.push(r);
  }
  return res;
}

// ======================= 잡알리오 (공공기관) =======================
const ALIO_NCS = ["R600002", "R600004", "R600017", "R600021", "R600023", "R600024", "R600025"];
export async function alio({ limitDate, log }) {
  const seen = new Map();
  for (let page = 1; page <= 10; page++) {
    const q = new URLSearchParams({ pageNo: page, order: "TERM_END", sort: "ASC", pageSet: "20", ing: "2" });
    ALIO_NCS.forEach((c) => q.append("detail_code", c));
    let html;
    try { html = await http(`https://job.alio.go.kr/recruit.do?${q}`); } catch (e) { log(`잡알리오 실패: ${e.message}`); break; }
    const rows = [...html.matchAll(/<tr>\s*<td[^>]*><label><input type="checkbox" class="ckbox idxs" name="idxs" value="(\d+)"[\s\S]*?<\/tr>/g)];
    if (!rows.length) break;
    let over = false;
    for (const [row, idx] of rows) {
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const dm = clean(tds[7] || "").match(/(\d{2})\.(\d{2})\.(\d{2})/);
      if (!dm) continue;
      const deadline = kst(2000 + +dm[1], +dm[2], +dm[3]);
      if (deadline.slice(0, 10) > limitDate) { over = true; continue; }
      if (!within(deadline, limitDate) || seen.has(idx)) continue;
      seen.set(idx, { idx, title: clean(tds[2]), company: clean(tds[3]), location: clean(tds[4]), empType: clean(tds[5]), deadline });
    }
    if (over) break;
    await sleep(DELAY);
  }
  log(`잡알리오 목록 ${seen.size}건`);
  const res = [];
  for (const p of seen.values()) {
    const url = `https://job.alio.go.kr/recruitview.do?idx=${p.idx}`;
    let html = "";
    try { html = await http(url); } catch {}
    await sleep(DELAY);
    const pairs = {};
    for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
      const k = clean(m[1]);
      if (k && !pairs[k]) pairs[k] = htmlToText(m[2]);
    }
    const get = (...ks) => { for (const k of ks) for (const [kk, v] of Object.entries(pairs)) if (kk.includes(k) && v) return v; return ""; };
    const ncs = get("NCS");
    const all = htmlToText(html);
    const block = (label) => {
      const m = all.match(new RegExp(`\\n${label}\\s*\\n([\\s\\S]{1,1200}?)\\n\\s*(?:결격사유|우대내용|전형절차|공고문|응시자격|자격요건|근무조건|선발인원)`));
      return m ? m[1].trim() : "";
    };
    const qual = block("응시자격") || block("자격요건");
    const emp = get("고용형태") || p.empType;
    const sal = get("급여정보", "보수", "급여");
    const r = make({
      source: "잡알리오", sid: p.idx,
      company: p.company, title: p.title, category: `${ncs} ${get("근무분야")}`,
      duty: get("근무분야") ? `근무분야: ${get("근무분야")}` : "",
      req: clip([get("학력정보") && `학력: ${get("학력정보")}`, get("채용구분") && `구분: ${get("채용구분")}`, qual].filter(Boolean).join("\n"), 450),
      must: clip(qual.split("\n").filter((l) => /필수|반드시|소지자|이상인 자/.test(l)).join("\n"), 250),
      pref: clip(get("우대조건") || block("우대내용"), 400),
      empType: emp,
      probation: findProbation(all),
      contract: /계약|인턴|비정규/.test(emp) ? findContract(all) : "",
      location: p.location || get("근무지"),
      salary: /\d/.test(sal) ? sal : "공고문 참조",
      deadline: p.deadline, url,
    });
    if (r) res.push(r);
  }
  return res;
}
