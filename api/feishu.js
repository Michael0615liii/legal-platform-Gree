/**
 * 飞书多维表格 API 代理
 * Vercel Serverless Function
 * 
 * 处理前端的所有数据请求，转发到飞书 Bitable API
 */

// ==================== 配置 ====================
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const TABLE_CONSULTS = process.env.TABLE_CONSULTS;     // 咨询知识库表ID
const TABLE_CASES = process.env.TABLE_CASES;           // 案件总表ID
const TABLE_TIMELINE = process.env.TABLE_TIMELINE;     // 案件节点表ID
const WECHAT_WEBHOOK = process.env.WECHAT_WEBHOOK_URL; // 企业微信Webhook（可选）

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

// ==================== Token 缓存 ====================
let tokenCache = { token: null, expires: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) {
    return tokenCache.token;
  }
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书认证失败: ${data.msg}`);
  tokenCache = { token: data.tenant_access_token, expires: Date.now() + 7000 * 1000 };
  return tokenCache.token;
}

// ==================== 飞书 API 请求 ====================
async function feishuRequest(path, method = "GET", body = null) {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${FEISHU_BASE}${path}`, opts);
  return res.json();
}

// ==================== 数据转换 ====================
// 飞书记录 → 前端格式（咨询）
function toConsult(record) {
  const f = record.fields;
  return {
    id: record.record_id,
    category: f["法律领域"] || "",
    question: f["问题摘要"] || "",
    answer: f["我方回复"] || "",
    author: f["回复人"]?.[0]?.name || f["回复人"] || "",
    date: f["录入日期"] ? new Date(f["录入日期"]).toISOString().split("T")[0] : "",
  };
}

// 飞书记录 → 前端格式（案件）
function toCase(record) {
  const f = record.fields;
  return {
    id: record.record_id,
    caseNo: f["案件号"] || "",
    parties: f["当事人"] || "",
    caseType: f["案件类型"] || "诉讼",
    judge: f["法官/仲裁员"] || "",
    judgPhone: f["联系电话"] || "",
    court: f["审理机关"] || "",
    hearingPlace: f["开庭地点"] || "",
    owner: f["主办律师"]?.[0]?.name || f["主办律师"] || "",
    assistants: (f["协办律师"] || []).map(a => a.name || a),
    status: f["案件状态"] || "待立案",
    notes: f["备注"] || "",
    acceptedDate: f["受案日期"] ? new Date(f["受案日期"]).toISOString().split("T")[0] : "",
    hearingDate: formatFeishuDate(f["开庭时间"]),
    evidenceDeadline: f["举证期限"] ? new Date(f["举证期限"]).toISOString().split("T")[0] : "",
    supplementDeadline: f["庭后补充截止"] ? new Date(f["庭后补充截止"]).toISOString().split("T")[0] : "",
  };
}

function formatFeishuDate(val) {
  if (!val) return "";
  const d = new Date(val);
  const date = d.toISOString().split("T")[0];
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return h === "00" && m === "00" ? date : `${date} ${h}:${m}`;
}

// 飞书记录 → 前端格式（节点）
function toNode(record) {
  const f = record.fields;
  return {
    id: record.record_id,
    key: f["节点类型"] || "",
    label: f["节点名称"] || "",
    date: formatFeishuDate(f["节点日期"]),
    status: f["节点状态"] || "待定",
    note: f["备注"] || "",
    sortOrder: f["排序"] || 0,
    caseId: f["所属案件"]?.link_record_ids?.[0] || "",
  };
}

// 状态映射
const STATUS_MAP = { "已完成": "done", "即将到来": "upcoming", "待定": "pending" };
const STATUS_REVERSE = { "done": "已完成", "upcoming": "即将到来", "pending": "待定" };

// ==================== 路由处理 ====================
module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace("/api/feishu", "");
  const params = url.searchParams;

  try {
    // ====== 咨询知识库 ======
    if (path === "/consults" && req.method === "GET") {
      const category = params.get("category");
      const search = params.get("search");
      let filter = "";
      if (category) filter = `CurrentValue.[法律领域]="${category}"`;
      
      const result = await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CONSULTS}/records?page_size=100${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`
      );
      
      let items = (result.data?.items || []).map(toConsult);
      if (search) {
        const s = search.toLowerCase();
        items = items.filter(c => c.question.toLowerCase().includes(s) || c.answer.toLowerCase().includes(s));
      }
      items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return res.json({ total: items.length, items });
    }

    if (path === "/consults" && req.method === "POST") {
      const { category, question, answer, author } = req.body;
      const result = await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CONSULTS}/records`,
        "POST",
        { fields: { "问题摘要": question, "法律领域": category, "我方回复": answer, "回复人": author } }
      );
      return res.json({ id: result.data?.record?.record_id, message: "已保存" });
    }

    if (path.startsWith("/consults/") && req.method === "DELETE") {
      const recordId = path.split("/")[2];
      await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CONSULTS}/records/${recordId}`,
        "DELETE"
      );
      return res.json({ message: "已删除" });
    }

    // ====== 案件管理 ======
    if (path === "/cases" && req.method === "GET") {
      const status = params.get("status");
      let filter = "";
      if (status) filter = `CurrentValue.[案件状态]="${status}"`;

      const caseResult = await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records?page_size=100${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`
      );
      const cases = (caseResult.data?.items || []).map(toCase);

      // 获取所有节点
      const nodeResult = await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records?page_size=500`
      );
      const allNodes = (nodeResult.data?.items || []).map(toNode);

      // 组装：为每个案件挂上节点
      const result = cases.map(c => {
        const nodes = allNodes
          .filter(n => n.caseId === c.id)
          .map(n => ({ ...n, status: STATUS_MAP[n.status] || n.status }))
          .sort((a, b) => a.sortOrder - b.sortOrder);
        return { ...c, timeline: nodes };
      });

      return res.json({ cases: result });
    }

    if (path === "/cases" && req.method === "POST") {
      const d = req.body;
      const fields = {
        "案件号": d.caseNo, "当事人": d.parties, "案件类型": d.caseType || "诉讼",
        "法官/仲裁员": d.judge, "联系电话": d.judgPhone, "审理机关": d.court,
        "开庭地点": d.hearingPlace, "主办律师": d.owner, "案件状态": d.status || "待立案",
        "备注": d.notes,
      };
      if (d.acceptedDate) fields["受案日期"] = new Date(d.acceptedDate).getTime();
      if (d.hearingDate) fields["开庭时间"] = new Date(d.hearingDate.replace(" ", "T")).getTime();

      const caseRes = await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records`,
        "POST", { fields }
      );
      const caseId = caseRes.data?.record?.record_id;

      // 自动创建6个时间节点
      if (caseId) {
        const addDays = (dateStr, days) => {
          if (!dateStr) return null;
          const dt = new Date(dateStr.replace(" ", "T"));
          dt.setDate(dt.getDate() + days);
          return dt.getTime();
        };

        const nodes = [
          { name: "受案/立案", type: "受案/立案", date: d.acceptedDate ? new Date(d.acceptedDate).getTime() : null, status: d.acceptedDate ? "已完成" : "待定", sort: 1 },
          { name: "举证期限", type: "举证期限", date: addDays(d.acceptedDate, 15), status: d.acceptedDate ? "即将到来" : "待定", sort: 2, note: "立案后15日" },
          { name: "证据交换", type: "证据交换", date: null, status: "待定", sort: 3 },
          { name: "开庭", type: "开庭", date: d.hearingDate ? new Date(d.hearingDate.replace(" ", "T")).getTime() : null, status: d.hearingDate ? "即将到来" : "待定", sort: 4, note: d.hearingPlace },
          { name: "庭后补充材料", type: "庭后补充材料", date: addDays(d.hearingDate, 3), status: "待定", sort: 5, note: "庭后3日内" },
          { name: "裁判/裁决", type: "裁判/裁决", date: null, status: "待定", sort: 6 },
        ];

        for (const n of nodes) {
          const nodeFields = {
            "节点名称": n.name, "节点类型": n.type, "节点状态": n.status,
            "排序": n.sort, "所属案件": [caseId],
          };
          if (n.date) nodeFields["节点日期"] = n.date;
          if (n.note) nodeFields["备注"] = n.note;

          await feishuRequest(
            `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records`,
            "POST", { fields: nodeFields }
          );
        }
      }

      return res.json({ id: caseId, message: "案件已创建" });
    }

    if (path.startsWith("/cases/") && req.method === "PUT" && !path.includes("/timeline/")) {
      const recordId = path.split("/")[2];
      const d = req.body;
      const fields = {};
      if (d.status) fields["案件状态"] = d.status;
      if (d.notes !== undefined) fields["备注"] = d.notes;
      if (d.judge) fields["法官/仲裁员"] = d.judge;
      if (d.judgPhone) fields["联系电话"] = d.judgPhone;

      await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records/${recordId}`,
        "PUT", { fields }
      );
      return res.json({ message: "已更新" });
    }

    // ====== 时间节点 ======
    if (path.includes("/timeline/") && req.method === "PUT") {
      const parts = path.split("/");
      const nodeId = parts[parts.length - 1];
      const d = req.body;
      const fields = {};
      if (d.status) fields["节点状态"] = STATUS_REVERSE[d.status] || d.status;
      if (d.date) fields["节点日期"] = new Date(d.date.replace(" ", "T")).getTime();
      if (d.note !== undefined) fields["备注"] = d.note;

      await feishuRequest(
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records/${nodeId}`,
        "PUT", { fields }
      );
      return res.json({ message: "节点已更新" });
    }

    // ====== 看板 ======
    if (path === "/dashboard" && req.method === "GET") {
      const [caseResult, nodeResult] = await Promise.all([
        feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_CASES}/records?page_size=100`),
        feishuRequest(`/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_TIMELINE}/records?page_size=500`),
      ]);

      const cases = (caseResult.data?.items || []).map(toCase);
      const nodes = (nodeResult.data?.items || []).map(toNode);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 状态统计
      const statusCounts = {};
      cases.forEach(c => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1; });

      // 即将到来的节点
      const upcoming = [];
      nodes.forEach(n => {
        if (n.status !== "即将到来" || !n.date) return;
        const nd = new Date(n.date.split(" ")[0]);
        const days = Math.ceil((nd - today) / 86400000);
        if (days < 0) return;
        const c = cases.find(c => c.id === n.caseId);
        if (!c || c.status === "已结案" || c.status === "中止/终止") return;
        upcoming.push({
          event: n.label, date: n.date, days, caseId: c.id,
          caseNo: c.caseNo, parties: c.parties, owner: c.owner, nodeKey: n.key,
        });
      });
      upcoming.sort((a, b) => a.days - b.days);

      // 工作量
      const members = {};
      cases.filter(c => c.status !== "已结案" && c.status !== "中止/终止").forEach(c => {
        if (c.owner) {
          if (!members[c.owner]) members[c.owner] = { name: c.owner, owned: 0, assisted: 0, total: 0 };
          members[c.owner].owned++;
          members[c.owner].total++;
        }
        (c.assistants || []).forEach(a => {
          if (!members[a]) members[a] = { name: a, owned: 0, assisted: 0, total: 0 };
          members[a].assisted++;
          members[a].total++;
        });
      });

      return res.json({
        statusCounts, upcoming: upcoming.slice(0, 15),
        workload: Object.values(members).sort((a, b) => b.total - a.total),
        totalActive: cases.filter(c => c.status !== "已结案" && c.status !== "中止/终止").length,
      });
    }

    // ====== 通知测试 ======
    if (path === "/notify/test" && req.method === "POST") {
      if (!WECHAT_WEBHOOK) return res.json({ success: false, message: "WECHAT_WEBHOOK_URL 未配置" });
      const r = await fetch(WECHAT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { content: "✅ **观韬团队工作平台** 通知测试成功！" },
        }),
      });
      const data = await r.json();
      return res.json({ success: data.errcode === 0 });
    }

    return res.status(404).json({ error: "未找到接口" });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
