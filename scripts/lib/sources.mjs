// 사이트별 수집기. 각 함수는 공통 형식의 공고 배열을 돌려준다.
import {
  http, sleep, htmlToText, clean, clip, kst, inferYear, nowKST, addDaysKST,
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
  const fields = p.fields !== undefined ? p.fields : classify({ title: p.title, category: p.category || "", body: text, requirement: sec.reqAll + " " + (p.req || "") });
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

// 합격자 발표·시험 일정 등 채용 공고가 아닌 안내문
const NOTICE_ONLY = /합격자|합격\s*\(?예정|발표|결과\s*(공고|안내|알림)|(면접|필기|실기|서류)\s*(시험|전형)?\s*(일정|장소|실시|시행|안내)|시험\s*(일정|장소|시행|실시)|응시\s*현황|경쟁률|취소\s*공고|채용\s*취소/;

// 기관장·임원·고위직 모집 (취업준비생 대상이 아님)
const EXEC_ONLY = /임원|비상임|비상근|기관장|상임이사|고위공무원|개방형\s*직위|사무처장|본부장|(원장|이사장|사장|감사|이사|소장|단장)\s*\)?\s*(공개)?\s*(모집|채용|초빙|공모)|선임직/;

// 공공기관 공고 전용: 대상 분야가 아닌 직종 (조리원·집배원·시설관리원 등)
const PUB_EXCLUDE = /조리원|조리실무|집배원|배달원|시설관리원|미화원|환경미화|안전요원|주차관리|단속|지도원|지킴이|안내원|안내도우미|민원안내|선거지원단|체육지도|수영강사|영양사|사회복지사|보육교사|청원경찰|방호원|운전원|당직|경비원|환경관리\s*경비|청사방호|환경관리[원사]|환경실무사|변호사|진료의사|의무사무관|진료|사서/;
// 공공기관 공고의 상투어가 분야로 잘못 잡히지 않게 지운다 ('공무직'의 공무→생산, '임용시험'의 시험→연구 등)
const PUB_NOISE = /사무소|사무처|사무국|공무직|공무원|임기제|(임용|채용|선발|경쟁|공개|경력)*\s*시험|공정선거|개방형/g;
function pubClassify({ title = "", org = "", category = "", body = "" }) {
  const t = (org ? title.split(org).join(" ") : title).replace(PUB_NOISE, " ");
  return classify({ title: t, category: category.replace(PUB_NOISE, " "), body: body.replace(PUB_NOISE, " ") });
}
// 대상 밖 직종만 뽑는 공고인지 (예: "사무원, 환경관리사"처럼 대상 직종이 함께 있으면 남긴다)
const PUB_EXCLUDE_G = new RegExp(PUB_EXCLUDE.source, "g");
const onlyExcluded = (s = "", org = "") => PUB_EXCLUDE.test(s) && !pubClassify({ title: s.replace(PUB_EXCLUDE_G, " "), org });
const pubSkip = (title, org = "") => NOTICE_ONLY.test(title) || EXEC_ONLY.test(title) || onlyExcluded(title, org);

// ======================= 나라일터 (중앙부처·지자체·교육청·공공기관) =======================
export async function gojobs({ limitDate, log }) {
  // '마감일순' 정렬은 오늘 게시된 공고 안에서만 정렬돼서 쓸 수 없다.
  // 최신 게시순으로 최근 30일치를 훑으며 마감 7일 이내인 공고를 고른다.
  const since = addDaysKST(-30);
  const seen = new Map();
  for (let page = 1; page <= 400; page++) {
    const url = `https://www.gojobs.go.kr/apmList.do?menuNo=401&searchJobsecode=020&pageIndex=${page}`;
    let html;
    try { html = await http(url); } catch (e) { if (page === 1) throw e; log(`나라일터 ${page}쪽 실패: ${e.message}`); break; }
    const rows = html.split(/<tr[ >]/).filter((r) => /fn_apmView\(/.test(r));
    if (!rows.length) break;
    let old = 0;
    for (const row of rows) {
      const m = row.match(/fn_apmView\('(\w+)',\s*'(\d+)'\)"?[^>]*>([\s\S]*?)<\/a>/);
      if (!m) continue;
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => clean(x[1]));
      const dates = tds.map((x) => x.match(/^(\d{4})-(\d{2})-(\d{2})$/)).filter(Boolean);
      if (dates.length < 2) continue;
      if (dates[0][0] < since) { old++; continue; }
      const dm = dates[dates.length - 1];
      const deadline = kst(+dm[1], +dm[2], +dm[3]);
      const title = clean(m[3]);
      if (!within(deadline, limitDate) || seen.has(m[2]) || pubSkip(title, tds[2])) continue;
      seen.set(m[2], { code: m[1], sn: m[2], title, company: tds[2] || "", deadline });
    }
    if (old === rows.length) break;
    await sleep(150);
  }
  log(`나라일터 목록 ${seen.size}건`);
  const res = [];
  for (const p of seen.values()) {
    const view = p.code === "060" ? "smbView.do" : p.code === "INJAE" ? "apmViewNew.do" : "apmView.do";
    const url = `https://www.gojobs.go.kr/${view}?menuNo=401&searchJobsecode=${p.code}&empmnsn=${p.sn}`;
    let html = "";
    try { html = await http(url); } catch {}
    await sleep(DELAY);
    const pairs = {};
    for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
      const k = clean(m[1]);
      if (k && !pairs[k]) pairs[k] = htmlToText(m[2]);
    }
    const grade = (pairs["채용직급"] || "").replace(/\n/g, ", ");
    if (onlyExcluded(grade) || EXEC_ONLY.test(grade)) continue;
    const empText = `${p.title} ${grade}`;
    const r = make({
      source: "나라일터", sid: p.sn,
      company: pairs["기관명"] || p.company, title: p.title,
      fields: pubClassify({ title: p.title, org: pairs["기관명"] || p.company, category: grade }),
      category: grade,
      duty: grade ? `채용직급: ${grade}` : "",
      empType: empText + (/공무직/.test(empText) ? " 무기계약직" : "") + (/임기제/.test(empText) ? " 계약직" : ""),
      location: pairs["근무지역"] || "",
      salary: "공고문 참조",
      deadline: p.deadline, url,
    });
    if (r) res.push(r);
  }
  return res;
}

// ======================= 클린아이 잡플러스 (지방공기업·지방 출자출연기관: 문화재단, 진흥원 등) =======================
const CE_FIELD = {
  700001: "사업관리 기획", 700002: "경영·회계·사무", 700003: "금융·보험", 700004: "교육·자연·사회과학", 700005: "법률·경찰·소방·교도·국방",
  700007: "사회복지·종교", 700008: "문화·예술·디자인·방송", 700016: "재료 소재", 700017: "화학", 700018: "섬유·의복", 700021: "식품가공",
  700022: "인쇄·목재·가구·공예", 700023: "환경·에너지·안전", 700024: "농림어업 농업", 700025: "연구", 700026: "기타",
};
// 대상이 아닌 모집분야: 보건·의료, 운전·운송, 영업판매, 경비·청소, 이용·숙박·여행·오락·스포츠, 음식서비스, 건설, 기계, 전기·전자, 정보통신
// 사이트 모집분야 코드가 대상 분야와 바로 맞는 경우
const CE_FIELDS = {
  700002: ["사무·관리"], 700016: ["화학·소재"], 700017: ["화학·소재"], 700021: ["식품"],
  700023: ["환경·안전"], 700024: ["농업·축산"], 700025: ["연구·R&D"],
};
const CE_SKIP = new Set(["700006", "700009", "700010", "700011", "700012", "700013", "700014", "700015", "700019", "700020"]);
const CE_JOB = { 702001: "정규직", 702002: "무기계약직", 702003: "기간제", 702004: "계약직(전문)", 702005: "인턴", 702006: "계약직", 702007: "비상임" };
const CE_CAREER = { 703001: "신입", 703002: "경력", 703003: "신입·경력" };
const CE_PLACE = {
  704001: "서울특별시", 704002: "부산광역시", 704003: "대구광역시", 704004: "인천광역시", 704005: "광주광역시", 704006: "대전광역시",
  704007: "울산광역시", 704008: "세종특별자치시", 704009: "경기도", 704010: "강원특별자치도", 704011: "충청북도", 704012: "충청남도",
  704013: "전북특별자치도", 704014: "전라남도", 704015: "경상북도", 704016: "경상남도", 704017: "제주특별자치도", 704018: "해외", 704019: "전남광주통합특별시",
};
const CE_PAY = {
  706001: "1200만원 이하", 706002: "1200만원 이상", 706003: "1400만원 이상", 706004: "1600만원 이상", 706005: "1800만원 이상", 706006: "2000만원 이상",
  706007: "2200만원 이상", 706008: "2600만원 이상", 706009: "2800만원 이상", 706010: "3000만원 이상", 706011: "3200만원 이상", 706012: "3400만원 이상",
  706013: "3600만원 이상", 706014: "3800만원 이상", 706015: "4000만원 이상", 706016: "5000만원 이상", 706017: "6000만원 이상", 706018: "7000만원 이상",
  706019: "8000만원 이상", 706020: "9000만원 이상", 706021: "1억원 이상",
};
export async function cleaneye({ limitDate, log }) {
  const list = [];
  for (let page = 1; page <= 60; page++) {
    // status=709001: 모집중, pubEndDate: 접수마감일이 이 날짜 이전인 공고
    const body = new URLSearchParams({ status: "709001", pubEndDate: limitDate, pageIndex: page }).toString();
    let data;
    try {
      data = await http("https://job.cleaneye.go.kr/user/selectYpRecruitment.do", {
        method: "POST", json: true, body,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      });
    } catch (e) { if (page === 1) throw e; log(`클린아이 ${page}쪽 실패: ${e.message}`); break; }
    const rows = data.list || [];
    if (!rows.length) break;
    list.push(...rows);
    if (page * 10 >= (data.cnt || 0)) break;
    await sleep(DELAY);
  }
  const seen = new Map();
  for (const e of list) {
    const m = (e.pubEndDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const deadline = kst(+m[1], +m[2], +m[3]);
    const key = `${e.empyear}-${e.ypEntId}-${e.entSeq}`;
    if (!within(deadline, limitDate) || seen.has(key) || pubSkip(e.entTitle || "", e.entName)) continue;
    seen.set(key, { ...e, key, deadline });
  }
  log(`클린아이 목록 ${seen.size}건`);
  const res = [];
  for (const p of seen.values()) {
    const url = `https://job.cleaneye.go.kr/user/ypCareersData.do?empyear=${p.empyear}&ypEntId=${p.ypEntId}&entSeq=${p.entSeq}`;
    let html = "";
    try { html = await http(url); } catch {}
    await sleep(DELAY);
    const v = (k) => (html.match(new RegExp(`var ${k} = '([^']*)'`)) || [])[1] || "";
    const dd = (id) => { const t = htmlToText((html.match(new RegExp(`<dd id="${id}"[^>]*>([\\s\\S]*?)<\\/dd>`)) || [])[1] || ""); return t === "-" ? "" : t; };
    const fieldCode = v("entRecruit");
    const jobCode = v("jobType") || p.jobType;
    const duty = dd("dutyDetail");
    const position = dd("position");
    if (CE_SKIP.has(fieldCode) || jobCode === "702007" || onlyExcluded(position) || EXEC_ONLY.test(position)) continue;
    const lic = dd("entLicense");
    const sido = CE_PLACE[v("workPlace")] || "";
    const place = p.localName && p.localName.startsWith(sido) ? p.localName : [sido, p.localName || ""].filter(Boolean).join(" ");
    const career = CE_CAREER[v("employGb") || p.employGb] || "";
    // 사이트 모집분야 코드로 먼저 분류하고, 안 되면 기관명(○○도시개발공사 등)을 뺀 제목으로 분류한다
    const r = make({
      source: "클린아이 잡플러스", sid: p.key,
      company: p.entName, title: p.entTitle,
      fields: CE_FIELDS[fieldCode] || pubClassify({ title: p.entTitle || "", org: p.entName, category: CE_FIELD[fieldCode] || "", body: [position, duty].join("\n") }),
      category: CE_FIELD[fieldCode] || "",
      fullText: [position, duty].filter(Boolean).join("\n"),
      duty: clip([position && `직위: ${position}`, duty].filter(Boolean).join("\n"), 450),
      req: [career && `채용구분: ${career}`, p.localYn === "Y" && p.localName ? `지역제한: ${p.localName}` : ""].filter(Boolean).join("\n"),
      must: lic ? `자격증: ${lic}` : "",
      empType: CE_JOB[v("jobType") || p.jobType] || "",
      location: place,
      salary: CE_PAY[v("yearincome")] ? `연 ${CE_PAY[v("yearincome")]}` : "공고문 참조",
      deadline: p.deadline, url,
    });
    if (r) res.push(r);
  }
  return res;
}
