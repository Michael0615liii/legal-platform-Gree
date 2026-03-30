/**
 * 飞书多维表格 API 代理 v2
 * 修复：空字段过滤、日期格式、错误详情回传、开庭时间可选
 */

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_CONSULTS = process.env.TABLE_CONSULTS;
const TABLE_CASES = process.env.TABLE_CASES;
const TABLE_TIMELINE = process.env.TABLE_TIMELINE;
const WECHAT_WEBHOOK = process.env.WECHAT_WEBHOOK_URL;
const FEISHU_BASE = "https://open.feishu.cn/open-apis";

let tokenCache = { token: null, expires: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书认证失败: ${data.msg}`);
  tokenCache = { token: data.tenant_access_token, expires: Date.now() + 7000 * 1000 };
  return tokenCache.token;
}

async function feishuRequest(path, method = "GET", body = null) {
  const token = await getToken();
  const opts = { method, headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${FEISHU_BASE}${path}`, opts);
  const data = await res.json();
  if (data.code && data.code !== 0) {
    const err = new Error(`飞书API: ${data.msg || JSON.stringify(data)}`);
    err.detail = data;
    throw err;
  }
  return data;
}

// ====== 工具函数 ======
function toTs(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;
  try {
    const d = new Date(dateStr.replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d.getTime();
  } catch { return null; }
}

// 构建字段对象，跳过空值（飞书不接受空字符串作为单选/日期值）
function bf(map) {
  const f = {};
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined || v === "") continue;
    f[k] = v;
  }
  return f;
}

function ext(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return val.map(v => v?.name || v?.text || (typeof v === "string" ? v : "")).filter(Boolean).join("、");
  if (val?.text) return val.text;
  return "";
}

function extArr(val) {
  if (!val) return [];
  if (typeof val === "string") return val.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(val)) return val.map(v => v?.name || v?.text || (typeof v === "string" ? v : "")).filter(Boolean);
  return [];
}

function extDate(val) {
  if (!val) return "";
  try { const d = new Date(val); return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0]; } catch { return ""; }
}

function extDateTime(val) {
  if (!val) return "";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return "";
    const date = d.toISOString().split("T")[0];
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return (h === "00" && m === "00") ? date : `${date} ${h}:${m}`;
  } catch { return ""; }
}

function toConsult(r) {
  const f = r.fields || {};
  return { id: r.record_id, category: ext(f["法律领域"]), question: ext(f["问题摘要"]), answer: ext(f["我方回复"]), author: ext(f["回复人"]), date: extDate(f["录入日期"]) };
}

function toCase(r) {
  const f = r.fields || {};
  return {
    id: r.record_id, caseNo: ext(f["案件号"]), parties: ext(f["当事人"]), caseType: ext(f["案件类型"]) || "诉讼",
    judge: ext(f["法官/仲裁员"]), judgPhone: ext(f["联系电话"]), court: ext(f["审理机关"]), hearingPlace: ext(f["开庭地点"]),
    owner: ext(f["主办律师"]), assistants: extArr(f["协办律师"]), status: ext(f["案件状态"]) || "待立案",
    notes: ext(f["备注"]), acceptedDate: extDate(f["受案日期"]), hearingDate: extDateTime(f["开庭时间"]),
  };
}

function toNode(r) {
  const f = r.fields || {};
  let caseId = "";
  const linked = f["所属案件"];
  if (Array.isArray(linked)) caseId = typeof linked[0] === "string" ? linked[0] : linked[0]?.record_id || linked[0]?.text || "";
  else if (linked?.link_record_ids) caseId = linked.link_record_ids[0] || "";
  return { id: r.record_id, key: ext(f["节点类型"]), label: ext(f["节点名称"]), date: extDateTime(f["节点日期"]), status: ext(f["节点状态"]) || "待定", note: ext(f["备注"]), sortOrder: f["排序"] || 0, caseId };
}

const SM = { "已完成": "done", "即将到来": "upcoming", "待定": "pending" };
const SR = { "done": "已完成", "upcoming": "即将到来", "pending": "待定" };

// ====== 主路由 ======
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace("/api/feishu", "");
  const params = url.searchParams;

  try {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !BITABLE_APP_TOKEN) {
      return res.status(500).json({ error: "飞书配置缺失，请检查Vercel环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET, BITABLE_APP_TOKEN" });
    }

    // ====== 调试 ======
    if (path === "/debug") {
      try {
        const token = await getToken();
        return res.json({ ok: true, tables: { TABLE_CONSULTS, TABLE_CASES, TABLE_TIMELINE } });
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
    }
// ====== 调试字段 ======
    if (path === "/debug-fields") {
      try {
        const results = {};
        for (const [name, tableId] of [["consults", TABLE_CONSULTS], ["cases", TABLE_CASES], ["timeline", TABLE_TIMELINE]]) {
          if (!tableId) { results[name] = "未配置"; continue; }
          const r = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${tableId}/fields`);
          results[name] = (r.data?.items || []).map(f => ({ name: f.field_name, type: f.type }));
        }
        return res.json(results);
      } catch (e) {
        return res.json({ error: e.message });
      }
    }
    // ====== 咨询 ======
    if (path === "/consults" && req.method === "GET") {
      const category = params.get("category");
      const search = params.get("search");
      let filter = category ? `&filter=${encodeURIComponent(`CurrentValue.[法律领域]="${category}"`)}` : "";
      const result = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CONSULTS}/records?page_size=100${filter}`);
      let items = (result.data?.items || []).map(toConsult);
      if (search) { const s = search.toLowerCase(); items = items.filter(c => c.question.toLowerCase().includes(s) || c.answer.toLowerCase().includes(s)); }
      items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return res.json({ total: items.length, items });
    }

    if (path === "/consults" && req.method === "POST") {
      const { category, question, answer, author } = req.body;
      const result = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CONSULTS}/records`, "POST",
        { fields: bf({ "问题摘要": question, "法律领域": category, "我方回复": answer, "回复人": author }) });
      return res.json({ id: result.data?.record?.record_id, message: "已保存" });
    }

    if (path.startsWith("/consults/") && req.method === "DELETE") {
      await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CONSULTS}/records/${path.split("/")[2]}`, "DELETE");
      return res.json({ message: "已删除" });
    }

    // ====== 案件列表 ======
    if (path === "/cases" && req.method === "GET") {
      const status = params.get("status");
      let filter = status ? `&filter=${encodeURIComponent(`CurrentValue.[案件状态]="${status}"`)}` : "";
      const caseResult = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records?page_size=100${filter}`);
      const cases = (caseResult.data?.items || []).map(toCase);
      let allNodes = [];
      if (TABLE_TIMELINE) {
        try {
          const nr = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records?page_size=500`);
          allNodes = (nr.data?.items || []).map(toNode);
        } catch (e) { console.error("节点加载失败:", e.message); }
      }
      const result = cases.map(c => ({
        ...c, timeline: allNodes.filter(n => n.caseId === c.id).map(n => ({ ...n, status: SM[n.status] || n.status })).sort((a, b) => a.sortOrder - b.sortOrder)
      }));
      return res.json({ cases: result });
    }

    // ====== 创建案件 ======
    if (path === "/cases" && req.method === "POST") {
      const d = req.body;

      // 案件主记录 - 只发有值的字段
      const caseFields = bf({
        "案件号": d.caseNo,
        "当事人": d.parties,
        "案件类型": d.caseType || null,
        "法官/仲裁员": d.judge || null,
        "联系电话": d.judgPhone || null,
        "审理机关": d.court || null,
        "开庭地点": d.hearingPlace || null,
        "主办律师": d.owner,
        "协办律师": (d.assistants || []).length > 0 ? d.assistants.join("、") : null,
        "案件状态": d.status || "待立案",
        "备注": d.notes || null,
        "受案日期": toTs(d.acceptedDate),
        "开庭时间": toTs(d.hearingDate),
      });

      console.log("[创建案件]", JSON.stringify(caseFields));
      const caseRes = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records`, "POST", { fields: caseFields });
      const caseId = caseRes.data?.record?.record_id;
      if (!caseId) return res.status(500).json({ error: "案件记录创建失败", detail: caseRes });

      // 创建时间节点
      let nodeErrors = [];
      if (TABLE_TIMELINE) {
        const addDays = (ds, n) => {
          if (!ds) return null;
          try { const dt = new Date(ds.replace(" ", "T")); if (isNaN(dt.getTime())) return null; dt.setDate(dt.getDate() + n); return dt.getTime(); } catch { return null; }
        };
        const aTs = toTs(d.acceptedDate);
        const hTs = toTs(d.hearingDate);
        const nodes = [
          { name: "受案/立案", type: "受案/立案", date: aTs, status: aTs ? "已完成" : "待定", sort: 1 },
          { name: "举证期限", type: "举证期限", date: addDays(d.acceptedDate, 15), status: aTs ? "即将到来" : "待定", sort: 2, note: "立案后15日" },
          { name: "证据交换", type: "证据交换", date: null, status: "待定", sort: 3 },
          { name: "开庭", type: "开庭", date: hTs, status: hTs ? "即将到来" : "待定", sort: 4, note: d.hearingPlace || null },
          { name: "庭后补充材料", type: "庭后补充材料", date: addDays(d.hearingDate, 3), status: "待定", sort: 5, note: hTs ? "庭后3日内" : null },
          { name: "裁判/裁决", type: "裁判/裁决", date: null, status: "待定", sort: 6 },
        ];
        for (const n of nodes) {
          try {
            const nf = bf({ "节点名称": n.name, "节点类型": n.type, "节点状态": n.status, "排序": n.sort, "所属案件": [caseId], "节点日期": n.date, "备注": n.note });
            await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records`, "POST", { fields: nf });
          } catch (e) {
            console.error(`[节点失败] ${n.name}:`, e.message);
            nodeErrors.push({ node: n.name, error: e.message });
          }
        }
      }
      return res.json({ id: caseId, message: "案件已创建", nodeErrors: nodeErrors.length > 0 ? nodeErrors : undefined });
    }

    // ====== 更新案件 ======
    if (path.startsWith("/cases/") && req.method === "PUT" && !path.includes("/timeline/")) {
      const rid = path.split("/")[2];
      const d = req.body;
      const fields = bf({
        "案件状态": d.status || null, "备注": d.notes !== undefined ? (d.notes || " ") : null,
        "法官/仲裁员": d.judge || null, "联系电话": d.judgPhone || null,
        "开庭时间": toTs(d.hearingDate), "开庭地点": d.hearingPlace || null,
      });
      if (Object.keys(fields).length === 0) return res.json({ message: "无需更新" });
      await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records/${rid}`, "PUT", { fields });
      return res.json({ message: "已更新" });
    }

    // ====== 更新节点 ======
    if (path.includes("/timeline/") && req.method === "PUT") {
      const nid = path.split("/").pop();
      const d = req.body;
      const fields = bf({ "节点状态": d.status ? (SR[d.status] || d.status) : null, "节点日期": toTs(d.date), "备注": d.note !== undefined ? d.note : null });
      if (Object.keys(fields).length === 0) return res.json({ message: "无需更新" });
      await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records/${nid}`, "PUT", { fields });
      return res.json({ message: "节点已更新" });
    }

    // ====== 看板 ======
    if (path === "/dashboard") {
      const cr = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records?page_size=100`);
      const cases = (cr.data?.items || []).map(toCase);
      let nodes = [];
      if (TABLE_TIMELINE) { try { const nr = await feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records?page_size=500`); nodes = (nr.data?.items || []).map(toNode); } catch {} }
      const today = new Date(); today.setHours(0,0,0,0);
      const sc = {}; cases.forEach(c => { sc[c.status] = (sc[c.status] || 0) + 1; });
      const upcoming = [];
      nodes.forEach(n => {
        if (n.status !== "即将到来" || !n.date) return;
        try { const nd = new Date(n.date.split(" ")[0]); if (isNaN(nd.getTime())) return; const days = Math.ceil((nd - today) / 86400000); if (days < 0) return; const c = cases.find(c => c.id === n.caseId); if (!c || c.status === "已结案" || c.status === "中止/终止") return; upcoming.push({ event: n.label, date: n.date, days, caseId: c.id, caseNo: c.caseNo, parties: c.parties, owner: c.owner, nodeKey: n.key }); } catch {}
      });
      upcoming.sort((a, b) => a.days - b.days);
      const members = {};
      cases.filter(c => c.status !== "已结案" && c.status !== "中止/终止").forEach(c => {
        if (c.owner) { if (!members[c.owner]) members[c.owner] = { name: c.owner, owned: 0, assisted: 0, total: 0 }; members[c.owner].owned++; members[c.owner].total++; }
        (c.assistants || []).forEach(a => { if (!members[a]) members[a] = { name: a, owned: 0, assisted: 0, total: 0 }; members[a].assisted++; members[a].total++; });
      });
      return res.json({ statusCounts: sc, upcoming: upcoming.slice(0, 15), workload: Object.values(members).sort((a, b) => b.total - a.total), totalActive: cases.filter(c => c.status !== "已结案" && c.status !== "中止/终止").length });
    }

    // ====== 通知 ======
    if (path === "/notify/test" && req.method === "POST") {
      if (!WECHAT_WEBHOOK) return res.json({ success: false, message: "WECHAT_WEBHOOK_URL 未配置" });
      const r = await fetch(WECHAT_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "markdown", markdown: { content: "✅ 观韬团队工作平台通知测试成功！" } }) });
      return res.json({ success: (await r.json()).errcode === 0 });
    }

    return res.status(404).json({ error: "未找到接口", path });
  } catch (err) {
    console.error("[ERROR]", err);
    return res.status(500).json({ error: err.message, detail: err.detail || null });
  }
};
