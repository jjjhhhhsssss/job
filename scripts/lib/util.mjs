// 공통 유틸: HTTP 요청, HTML→텍스트, 날짜(KST) 처리, 항목 추출
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function http(url, opt = {}) {
  const { method = "GET", headers = {}, body, json = false, retries = 2, timeout = 20000 } = opt;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ctrl.signal,
        headers: { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9", ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", middot: "·" };
export function decode(s = "") {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, k) => ENT[k] ?? m);
}

// 머리글 행이 있는 표를 "머리글\n값" 형태로 풀어준다 (채용부문 | 자격요건 | 담당업무 … 형태의 공고 대응)
const TABLE_HEAD = /업무|자격|우대|요건|부문|분야|직무|근무지|인원|고용|형태|급여|연봉/;
function flattenTables(html) {
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (whole, inner) => {
    if (/<table/i.test(inner)) return whole;
    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t([hd])([^>]*)>([\s\S]*?)<\/t[hd]>/gi)].map((c) => ({ th: c[1].toLowerCase() === "h", attrs: c[2], html: c[3] })),
    );
    if (rows.length < 2) return whole;
    const head = rows[0].map((c) => clean(c.html));
    const hits = head.filter((h) => h.length <= 12 && TABLE_HEAD.test(h)).length;
    if (hits < 2 || rows[0].some((c) => /colspan|rowspan/i.test(c.attrs))) return whole;
    let out = "\n";
    for (const r of rows.slice(1)) {
      if (r.length !== head.length) { out += r.map((c) => c.html).join("\n") + "\n"; continue; }
      r.forEach((c, i) => { out += `\n${head[i]}\n${c.html}\n`; });
      out += "\n";
    }
    return out;
  });
}

export function htmlToText(html = "") {
  return decode(
    flattenTables(html.replace(/\r/g, ""))
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|dt|dd|th|td|table|ul|ol|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ​]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export const clean = (s = "") => decode(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function clip(s, n = 400) {
  if (!s) return "";
  s = s.replace(/\n{2,}/g, "\n").trim();
  return s.length > n ? s.slice(0, n).trim() + "…" : s;
}

// ---------- 날짜 (모두 한국 시간 기준 문자열 "YYYY-MM-DDTHH:mm") ----------
export function nowKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    iso: d.toISOString().slice(0, 16),
    date: d.toISOString().slice(0, 10),
  };
}
const pad = (n) => String(n).padStart(2, "0");
export const kst = (y, m, d, hh = 23, mm = 59) => `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
export function addDaysKST(days) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + days * 86400000);
  return d.toISOString().slice(0, 10);
}
// 월/일만 있을 때 연도 추정
export function inferYear(m) {
  const n = nowKST();
  return m < n.m - 6 ? n.y + 1 : m > n.m + 6 ? n.y - 1 : n.y;
}

// ---------- 지역(시/도) ----------
const REGIONS = [
  ["서울", /서울/],
  ["경기", /경기/],
  ["인천", /인천/],
  ["대전", /대전/],
  ["세종", /세종/],
  ["충북", /충북|충청북/],
  ["충남", /충남|충청남/],
  ["광주·전남", /전남광주|광주|전남|전라남/],
  ["전북", /전북|전라북/],
  ["대구", /대구/],
  ["경북", /경북|경상북/],
  ["부산", /부산/],
  ["울산", /울산/],
  ["경남", /경남|경상남/],
  ["강원", /강원/],
  ["제주", /제주/],
  ["해외", /해외|미국|중국|일본|베트남|싱가포르|유럽/],
];
export function toRegions(loc = "") {
  const out = [];
  for (const [name, re] of REGIONS) if (re.test(loc)) out.push(name);
  return out.length ? out : ["전국·기타"];
}

// ---------- 모집분야 분류 ----------
export const FIELDS = [
  ["품질관리(QA·QC)", /품질|\bQ[AC]\b|QA\/QC|QC\/QA|품보|밸리데이션|validation|GMP|시험검사|검사원|인증/i],
  ["연구·R&D", /연구|R&D|R\s?&\s?D|개발|실험|분석|시험|연구원|RA\b|허가/i],
  ["생산·제조", /생산|제조|공정|오퍼레이터|operator|양산|포장|생산관리|공무/i],
  ["바이오·제약", /바이오|제약|의약|약품|임상|세포|미생물|생명|진단|백신|항체|배양|헬스케어|약사|CRA|CRC/i],
  ["화학·소재", /화학|화장품|고분자|소재|도료|코팅|이차전지|배터리 소재|정밀화학|석유화학/i],
  ["식품", /식품|HACCP|해썹|음료|제과|제빵|육가공|유가공|식음료/i],
  ["환경·안전", /환경|안전|보건관리|수질|대기|폐기물|EHS|ESH|SHE|산업위생|탄소|에너지관리/i],
  ["농업·축산", /농업|농장|축산|원예|작물|양돈|양계|수산|산림|조경|종자|비료|사료/i],
  ["사무·관리", /사무|총무|경리|회계|재무|세무|인사|노무|행정|비서|구매|자재|경영지원|기획|사업지원|문서|서무|영업관리|무역/i],
];
// IT·전기·전자·기계·컴퓨터 전공 지식이 필요한 공고 제외
const EXCLUDE_TITLE =
  /개발자|소프트웨어|\bS\/?W\b|프로그래머|프론트엔드|백엔드|풀스택|웹\s?개발|앱\s?개발|데이터\s?엔지니어|정보보안|네트워크|서버|IT\s?(개발|운영|인프라)|전산|전기|전자(?!상거래|문서|결재|계약)|회로|반도체\s?장비|기계|설비\s?보전|PLC|임베디드|펌웨어|제어|자동화|CNC|머시닝|\bMCT\b|응용\s?프로그램|프로그램\s?개발|AI\s?엔지니어|용접|\bCAD\b|하드웨어|\bH\/?W\b|자동차|조선|금형|사출|배관|가공원|정비|장비|설비|\bMaint|A\/S|플랜트|건축|토목|인테리어|Burn-?In/i;
const EXCLUDE_MAJOR = /(전기|전자|기계|컴퓨터|정보통신|소프트웨어|IT|메카트로닉스|제어)[^\n]{0,12}(전공|공학|계열|학과)/;
// 대상 직무와 무관한 직종 제외 (사무 키워드로 섞여 들어오는 것)
const EXCLUDE_OTHER = /요양보호사|간호사|간호조무|물리치료|방사선사|경비원|미화|청소|운전기사|배송기사|택배|조리사|주방|홀서빙|상담원|텔레마케|보험설계|강사|교사|헤어|네일|피부관리/;

export function classify({ title = "", category = "", body = "", requirement = "" }) {
  const head = `${title} ${category}`;
  if (EXCLUDE_TITLE.test(head) || EXCLUDE_OTHER.test(head)) return null;
  if (EXCLUDE_MAJOR.test(requirement)) return null;
  const fields = FIELDS.filter(([, re]) => re.test(head)).map(([n]) => n);
  if (!fields.length) {
    // 제목·분야로 판단이 안 되면 본문 앞부분으로 한 번 더
    const f2 = FIELDS.filter(([, re]) => re.test(body.slice(0, 400))).map(([n]) => n);
    if (!f2.length) return null;
    return f2.slice(0, 2);
  }
  return fields.slice(0, 3);
}

// ---------- 본문에서 항목 추출 ----------
const HEADS = {
  duty: /^[\s\-•·▶■□◆◇○●※\[\(<【\d.)]*(담당\s*업무|주요\s*업무|업무\s*내용|직무\s*내용|수행\s*업무|하는\s*일|주요\s*역할|직무\s*소개|모집\s*업무|Job\s*Description|Responsibilities|What you)/i,
  req: /^[\s\-•·▶■□◆◇○●※\[\(<【\d.)]*(자격\s*요건|지원\s*자격|응시\s*자격|자격\s*조건|필수\s*요건|필수\s*자격|자격\s*사항|지원\s*요건|Qualifications|Requirements)/i,
  pref: /^[\s\-•·▶■□◆◇○●※\[\(<【\d.)]*(우대\s*사항|우대\s*조건|우대\s*요건|우대\s*내용|Preferred)/i,
  stop: /^[\s\-•·▶■□◆◇○●※\[\(<【\d.)]*(근무\s*조건|근무\s*환경|복리\s*후생|복지|혜택|전형\s*절차|채용\s*절차|전형\s*방법|접수\s*(기간|방법)|제출\s*서류|근무\s*지|근무\s*형태|고용\s*형태|급여|연봉|기타\s*사항|유의\s*사항|문의|채용\s*일정|모집\s*인원|근무\s*시간|기업\s*소개|회사\s*소개)/i,
};
export function extractSections(text = "") {
  const out = { duty: [], req: [], pref: [] };
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^(및|&|\/)\s*(우대|자격|담당)/.test(line) && line.length < 14) continue;
    let matched = false;
    for (const k of ["duty", "req", "pref"]) {
      const m = line.match(HEADS[k]);
      if (m && line.length < 60) {
        cur = k;
        matched = true;
        const rest = line
          .slice(m[0].length)
          .replace(/^\s*(및|&|\/)\s*(우대\s*(사항|조건|요건)|자격\s*요건|담당\s*업무|필수\s*요건)/, "")
          .replace(/^[\s\]\)>】:：\-]+/, "");
        if (rest.length > 1) out[k].push(rest);
        break;
      }
    }
    if (matched) continue;
    if (HEADS.stop.test(line) && line.length < 40) {
      cur = null;
      continue;
    }
    if (cur && out[cur].length < 12) out[cur].push(line);
  }
  const join = (a) => clip(a.join("\n"), 450);
  const reqAll = out.req.join("\n");
  const must = out.req.filter((l) => /필수|반드시|이상인 자|소지자|가능자|졸업/.test(l));
  return { duty: join(out.duty), req: join(out.req), must: clip(must.join("\n"), 250), pref: join(out.pref), reqAll };
}

export function findProbation(text = "") {
  const m = text.match(/수습\s*(?:기간)?\s*[:：]?\s*(?:있음)?\s*\(?\s*(\d+\s*(?:개월|주|일))/) || text.match(/(\d+\s*개월)\s*(?:간)?\s*수습/);
  if (m) return `수습 ${m[1].replace(/\s/g, "")}`;
  if (/수습\s*(?:기간)?\s*[:：]?\s*없음/.test(text)) return "수습 없음";
  if (/수습/.test(text)) return "수습 있음";
  return "";
}
export function findContract(text = "") {
  const m =
    text.match(/계약\s*기간\s*[:：]?\s*(\d+\s*(?:년|개월))/) ||
    text.match(/(\d+\s*(?:년|개월))\s*(?:단위\s*)?(?:계약|근무\s*후)/) ||
    text.match(/계약직\s*\(?\s*(\d+\s*(?:년|개월))/);
  return m ? m[1].replace(/\s/g, "") : "";
}
export function findSalary(text = "") {
  const m = text.match(/(?:연봉|급여|임금|월급|보수)\s*(?:조건)?\s*[:：]?\s*([^\n]{2,40})/);
  if (!m) return "";
  const v = m[1].trim();
  return /\d|내규|협의|면접/.test(v) ? clip(v, 40) : "";
}
// 채용 형태만 남긴다 (신입/경력, 직급 등은 제거)
const EMP_WORDS = ["정규직", "무기계약직", "계약직", "기간제", "인턴", "파견직", "위촉직", "프리랜서", "일용직", "시간제", "아르바이트", "전환형"];
export function normEmpType(s = "") {
  if (/기간의 정함이 없는/.test(s)) s += " 정규직";
  if (/기간의 정함이 있는|비정규/.test(s)) s += " 계약직";
  if (/파견/.test(s)) s += " 파견직";
  const found = EMP_WORDS.filter((w) => s.includes(w));
  const out = found.filter((w) => !(w === "계약직" && found.includes("무기계약직")));
  if (out.includes("전환형") && out.length > 1) return out.filter((w) => w !== "전환형").join("·") + "(정규직 전환형)";
  return out.join("·");
}
// 마지막 단계 필터: 대상이 아닌 직무 제거 (영업·마케팅·면허직 등)
const EXCLUDE_FINAL = /영업|마케팅|\bMD\b|바이럴|홈쇼핑|광고|디자이너|약사|판매|매장|\bCS\b|콜센터|컨설턴트|퍼포먼스|임상병리|방사선|물리치료|간호|요양/;
export function keepJob(j) {
  return !EXCLUDE_FINAL.test(j.title) && !EXCLUDE_TITLE.test(j.title) && !EXCLUDE_OTHER.test(j.title);
}
