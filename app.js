// 마감임박 채용 모아보기 - 화면 로직
(() => {
  const PAGE_SIZE = 20;
  const DAYS = 7;
  const FIELD_ORDER = ["연구·R&D", "품질관리(QA·QC)", "생산·제조", "바이오·제약", "화학·소재", "식품", "환경·안전", "농업·축산", "사무·관리"];
  const REGION_ORDER = ["서울", "경기", "인천", "대전", "세종", "충북", "충남", "광주·전남", "전북", "대구", "경북", "부산", "울산", "경남", "강원", "제주", "해외", "전국·기타"];
  const SOURCES = ["잡다", "자소설닷컴", "사람인", "잡코리아", "고용24", "잡알리오"];

  const $ = (id) => document.getElementById(id);
  const state = { q: "", fields: new Set(), regions: new Set(), page: 1 };
  let data = { jobs: [] };
  let base = []; // 접속일 기준 마감 7일 이내 공고

  // 한국 시간 기준 현재 시각 "YYYY-MM-DDTHH:mm"
  function nowKST() {
    return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16);
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dday(deadline, now) {
    const a = Date.parse(deadline.slice(0, 10) + "T00:00:00Z");
    const b = Date.parse(now.slice(0, 10) + "T00:00:00Z");
    return Math.round((a - b) / 86400e3);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const NA = '<span class="na">공고 원문 참조</span>';

  function textCell(t, extraHtml = "") {
    if (!t && !extraHtml) return NA;
    const body = t ? `<div class="txt clamp">${esc(t)}</div>` : "";
    return body + extraHtml;
  }

  function fmtDeadline(dl) {
    const [d, t] = dl.split("T");
    const [y, m, day] = d.split("-");
    const w = "일월화수목금토"[new Date(d + "T00:00:00Z").getUTCDay()];
    return `${+m}/${+day}(${w}) ${t === "23:59" ? "23:59" : t}`;
  }

  function row(j, now) {
    const dd = dday(j.deadline, now);
    const ddCls = dd <= 0 ? "d0" : dd <= 2 ? "d2" : "";
    const ddTxt = dd <= 0 ? "오늘 마감" : `D-${dd}`;
    const emp = j.empType ? esc(j.empType) + (j.contract ? ` (${esc(j.contract)})` : "") : '<span class="na">원문 참조</span>';
    const prob = j.probation ? `<span class="prob">${esc(j.probation)}</span>` : "";
    const must = j.must ? `<div class="subbox"><span class="sublabel">필수 조건</span><div class="txt">${esc(j.must)}</div></div>` : "";
    const links = (j.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.site)}</a>`).join("");
    return `<tr>
      <td><div class="co">${esc(j.company)}</div><div class="ttl">${esc(j.title)}</div></td>
      <td>${(j.fields || []).map((f) => `<span class="tag">${esc(f)}</span>`).join("")}</td>
      <td>${textCell(j.duty)}</td>
      <td>${textCell(j.req, must)}</td>
      <td>${textCell(j.pref)}</td>
      <td>${emp}${prob}</td>
      <td>${j.location ? esc(j.location) : esc((j.regions || []).join(", "))}</td>
      <td>${j.salary ? esc(j.salary) : '<span class="na">원문 참조</span>'}</td>
      <td><div class="dl">${fmtDeadline(j.deadline)}</div><span class="dday ${ddCls}">${ddTxt}</span></td>
      <td class="links">${links}</td>
    </tr>`;
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return base.filter((j) => {
      if (state.fields.size && !(j.fields || []).some((f) => state.fields.has(f))) return false;
      if (state.regions.size && !(j.regions || []).some((r) => state.regions.has(r))) return false;
      if (q) {
        const hay = [j.company, j.title, j.duty, j.req, j.pref, j.location, (j.fields || []).join(" ")].join(" ").toLowerCase();
        if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }

  function chips(el, order, key, counts) {
    el.innerHTML = order
      .filter((name) => counts[name])
      .map((name) => `<button type="button" class="chip" data-v="${esc(name)}" aria-pressed="${state[key].has(name)}">${esc(name)}<span class="n">${counts[name]}</span></button>`)
      .join("");
  }
  function countBy(list, prop) {
    const c = {};
    for (const j of list) for (const v of new Set(j[prop] || [])) c[v] = (c[v] || 0) + 1;
    return c;
  }

  function render() {
    const now = nowKST();
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    const slice = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

    $("rows").innerHTML = slice.map((j) => row(j, now)).join("");
    $("empty").hidden = list.length > 0;
    $("count").innerHTML = `마감 ${DAYS}일 이내 공고 <strong>${list.length.toLocaleString()}</strong>건`;

    chips($("fieldChips"), FIELD_ORDER, "fields", countBy(base, "fields"));
    chips($("regionChips"), REGION_ORDER, "regions", countBy(base, "regions"));
    pager(pages);

    // 더보기 버튼: 잘린 칸만
    document.querySelectorAll("#rows .clamp").forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 2) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "more";
        b.textContent = "더보기";
        b.onclick = () => {
          const open = el.classList.toggle("clamp");
          b.textContent = open ? "더보기" : "접기";
        };
        el.after(b);
      }
    });
  }

  function pager(pages) {
    const p = state.page;
    const start = Math.max(1, Math.min(p - 4, pages - 9));
    const end = Math.min(pages, start + 9);
    let html = `<button data-p="${p - 1}" ${p === 1 ? "disabled" : ""} aria-label="이전 페이지">‹</button>`;
    for (let i = start; i <= end; i++) html += `<button data-p="${i}" ${i === p ? 'aria-current="page"' : ""}>${i}</button>`;
    html += `<button data-p="${p + 1}" ${p === pages ? "disabled" : ""} aria-label="다음 페이지">›</button>`;
    $("pager").innerHTML = html;
  }

  function bind() {
    $("searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = $("q").value;
      state.page = 1;
      render();
    });
    $("reset").addEventListener("click", () => {
      state.q = "";
      $("q").value = "";
      state.fields.clear();
      state.regions.clear();
      state.page = 1;
      render();
    });
    const toggle = (key) => (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      const v = b.dataset.v;
      state[key].has(v) ? state[key].delete(v) : state[key].add(v);
      state.page = 1;
      render();
    };
    $("fieldChips").addEventListener("click", toggle("fields"));
    $("regionChips").addEventListener("click", toggle("regions"));
    $("pager").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-p]");
      if (!b || b.disabled) return;
      state.page = +b.dataset.p;
      render();
      document.querySelector(".bar").scrollIntoView({ behavior: "smooth" });
    });
  }

  async function load() {
    bind();
    try {
      const res = await fetch(`data/jobs.json?d=${nowKST().slice(0, 10)}`, { cache: "no-cache" });
      data = await res.json();
    } catch (e) {
      $("meta").textContent = "공고 데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.";
      return;
    }
    const now = nowKST();
    const limit = addDays(now.slice(0, 10), DAYS);
    base = (data.jobs || [])
      .filter((j) => j.deadline >= now && j.deadline.slice(0, 10) <= limit)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));

    const [d, t] = (data.collectedAt || "").split("T");
    const stale = d && d < now.slice(0, 10);
    $("meta").textContent = `공고 수집: ${d} ${t || ""} (한국시간) · 오늘 ${now.slice(0, 10)} 기준 마감 ${DAYS}일 이내` + (stale ? " · 오늘 수집 전이라 이전 데이터를 보여주고 있어요" : "");
    const st = data.status || {};
    $("sources").textContent =
      "수집 사이트: " +
      SOURCES.map((s) => `${s} ${st[s] ? st[s].count + "건" + (st[s].ok ? "" : "(이전 데이터)") : "-"}`).join(" · ") +
      " | 링크드인은 공고에 마감일이 없고, 잡플래닛은 자동 수집을 막고 있어 제외했어요.";
    render();
  }

  load();
})();
