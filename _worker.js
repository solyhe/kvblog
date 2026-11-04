// ============================================================
//  Cloudflare Workers 日志博客
//  KV 绑定名: BLOG
//  环境变量: ADMIN_USER（后台账号，默认 admin）
//           ADMIN_PASS（后台密码，默认 admin888）
//
//  路由说明：
//    GET  /                → 前台首页（文章列表）
//    GET  /post/:id        → 前台文章详情
//    GET  /attach/:id/:fn  → 附件/图片访问
//    GET  /admin/login     → 登录页
//    POST /admin/login     → 登录提交
//    POST /admin/logout    → 退出
//    GET  /admin           → 后台管理（需登录）
//    GET  /admin/edit      → 写/编辑文章（需登录）
//    POST /admin/save      → 保存文章（需登录）
//    POST /admin/delete    → 删除文章（需登录）
//    POST /admin/upload    → 上传附件（需登录）
//    POST /admin/attach-delete → 删除附件（需登录）
// ============================================================

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response("Internal Error: " + e.message, { status: 500 });
    }
  }
};

const DEFAULT_USER = "admin";
const DEFAULT_PASS = "admin888";

// ── 工具函数 ─────────────────────────────────────────────────

function adminUser(env) {
  return env.ADMIN_USER || DEFAULT_USER;
}

function adminPass(env) {
  return env.ADMIN_PASS || DEFAULT_PASS;
}

// 无状态 session token：由账号+密码派生，重启后不失效
function makeToken(env) {
  const raw = "blog:" + adminUser(env) + ":" + adminPass(env) + ":session";
  return btoa(raw).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function isAuthed(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)blog_sess=([^;]+)/);
  return !!m && m[1] === makeToken(env);
}

function redirectLogin(origin) {
  return new Response(null, { status: 302, headers: { Location: origin + "/admin/login" } });
}

function htmlResp(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", ...extraHeaders }
  });
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" }
  });
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── 服务端轻量 Markdown 渲染 ─────────────────────────────────
function renderMd(src) {
  if (!src) return '';
  let html = '';
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // 内联元素处理
  function inline(s) {
    return s
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_,text,href)=>{ const h=(/^[a-z][a-z\d+\-.]*:/i.test(href))?href:'https://'+href; return `<a href="${h}" target="_blank">${text}</a>`; })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
  }
  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      let code = '';
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code += lines[i] + '\n';
        i++;
      }
      const esc = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += `<pre style="position:relative;overflow-x:auto"><code class="language-${escHtml(lang)}">${esc}</code><button class="copy-btn" onclick="copyCode(this)">复制</button></pre>\n`;
      i++;
      continue;
    }
    // 标题
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) { const lv=hm[1].length; html+=`<h${lv}>${inline(hm[2])}</h${lv}>\n`; i++; continue; }
    // 水平线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { html+='<hr>\n'; i++; continue; }
    // 引用
    if (line.startsWith('> ')) {
      let q='';
      while (i<lines.length && lines[i].startsWith('> ')) { q+=inline(lines[i].slice(2))+' '; i++; }
      html+=`<blockquote><p>${q.trim()}</p></blockquote>\n`;
      continue;
    }
    // 无序列表
    if (/^[-*+]\s/.test(line)) {
      html+='<ul>\n';
      while (i<lines.length && /^[-*+]\s/.test(lines[i])) {
        html+=`<li>${inline(lines[i].replace(/^[-*+]\s/,''))}</li>\n`; i++;
      }
      html+='</ul>\n'; continue;
    }
    // 有序列表
    if (/^\d+\.\s/.test(line)) {
      html+='<ol>\n';
      while (i<lines.length && /^\d+\.\s/.test(lines[i])) {
        html+=`<li>${inline(lines[i].replace(/^\d+\.\s/,''))}</li>\n`; i++;
      }
      html+='</ol>\n'; continue;
    }
    // 表格
    if (/^\|/.test(line)) {
      const rows = [];
      while (i<lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const parseRow = r => r.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
      const isSep = r => /^\|[\s|:\-]+\|$/.test(r.trim());
      const sepIdx = rows.findIndex(r=>isSep(r));
      html += '<table>\n';
      if (sepIdx===1) {
        const alignCols = parseRow(rows[sepIdx]).map(c=>/^:-+:$/.test(c)?'center':/^-+:$/.test(c)?'right':'left');
        html += '<thead><tr>' + parseRow(rows[0]).map((c,ci)=>`<th style="text-align:${alignCols[ci]||'left'}">${inline(c)}</th>`).join('') + '</tr></thead>\n<tbody>\n';
        for (let ri=sepIdx+1;ri<rows.length;ri++) {
          html += '<tr>' + parseRow(rows[ri]).map((c,ci)=>`<td style="text-align:${alignCols[ci]||'left'}">${inline(c)}</td>`).join('') + '</tr>\n';
        }
        html += '</tbody>\n';
      } else {
        html += '<tbody>\n';
        rows.forEach(r=>{ if(isSep(r)) return; html+='<tr>'+parseRow(r).map(c=>`<td>${inline(c)}</td>`).join('')+'</tr>\n'; });
        html += '</tbody>\n';
      }
      html += '</table>\n'; continue;
    }
    // 空行
    if (line.trim()==='') { i++; continue; }
    // 普通段落
    html+=`<p>${inline(line)}</p>\n`;
    i++;
  }
  return html;
}

function randomId() {
  const t = Date.now().toString(36).slice(-4);
  const r = Math.random().toString(36).slice(2, 4);
  return t + r;
}

// ── KV 操作 ──────────────────────────────────────────────────

async function getIndex(env) {
  const raw = await env.BLOG.get("index");
  return raw ? JSON.parse(raw) : [];
}

async function saveIndex(env, ids) {
  await env.BLOG.put("index", JSON.stringify(ids));
}

async function addToIndex(env, id) {
  const ids = await getIndex(env);
  if (!ids.includes(id)) ids.unshift(id);
  await saveIndex(env, ids);
}

async function removeFromIndex(env, id) {
  const ids = await getIndex(env);
  await saveIndex(env, ids.filter(i => i !== id));
}

async function getPost(env, id) {
  const raw = await env.BLOG.get("post:" + id);
  return raw ? JSON.parse(raw) : null;
}

async function putPost(env, post) {
  await env.BLOG.put("post:" + post.id, JSON.stringify(post));
}

async function removePost(env, id) {
  await env.BLOG.delete("post:" + id);
  await removeFromIndex(env, id);
  const raw = await env.BLOG.get("attachments:" + id);
  if (raw) {
    for (const fname of JSON.parse(raw)) {
      await env.BLOG.delete("attach:" + id + ":" + fname);
    }
    await env.BLOG.delete("attachments:" + id);
  }
}

async function getAttachList(env, postId) {
  const raw = await env.BLOG.get("attachments:" + postId);
  return raw ? JSON.parse(raw) : [];
}

async function putAttachment(env, postId, filename, dataUrl) {
  await env.BLOG.put("attach:" + postId + ":" + filename, dataUrl);
  const list = await getAttachList(env, postId);
  if (!list.includes(filename)) list.push(filename);
  await env.BLOG.put("attachments:" + postId, JSON.stringify(list));
}

async function removeAttachment(env, postId, filename) {
  await env.BLOG.delete("attach:" + postId + ":" + filename);
  const list = await getAttachList(env, postId);
  await env.BLOG.put("attachments:" + postId, JSON.stringify(list.filter(f => f !== filename)));
}

// ── 主路由 ───────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname: path, origin } = url;
  const method = request.method;

  // ── 前台 ────────────────────────────────────────────────
  if (path === "/" && method === "GET")
    return frontIndex(env, url);

  const postM = path.match(/^\/post\/([a-z0-9]+)$/);
  if (postM && method === "GET")
    return frontPost(env, postM[1]);

  const attachM = path.match(/^\/attach\/([a-z0-9]+)\/(.+)$/);
  if (attachM && method === "GET")
    return serveAttach(env, attachM[1], decodeURIComponent(attachM[2]));

  // ── 登录 / 登出 ──────────────────────────────────────────
  if (path === "/admin/login") {
    if (method === "GET") {
      if (isAuthed(request, env)) return new Response(null, { status: 302, headers: { Location: "/admin" } });
      return htmlResp(loginPage());
    }
    if (method === "POST") return doLogin(request, env, origin);
  }

  if (path === "/admin/logout" && method === "POST")
    return doLogout();

  // ── 后台（需登录）───────────────────────────────────────
  if (path === "/admin" && method === "GET") {
    if (!isAuthed(request, env)) return redirectLogin(origin);
    return adminIndex(env);
  }

  if (path === "/admin/edit" && method === "GET") {
    if (!isAuthed(request, env)) return redirectLogin(origin);
    return adminEdit(env, url);
  }

  if (path === "/admin/save" && method === "POST") {
    if (!isAuthed(request, env)) return jsonResp({ error: "unauthorized" }, 403);
    return adminSave(request, env);
  }

  if (path === "/admin/delete" && method === "POST") {
    if (!isAuthed(request, env)) return jsonResp({ error: "unauthorized" }, 403);
    return adminDeletePost(request, env);
  }

  if (path === "/admin/upload" && method === "POST") {
    if (!isAuthed(request, env)) return jsonResp({ error: "unauthorized" }, 403);
    return adminUpload(request, env, url);
  }

  if (path === "/admin/attach-delete" && method === "POST") {
    if (!isAuthed(request, env)) return jsonResp({ error: "unauthorized" }, 403);
    return adminDeleteAttach(request, env);
  }

  return new Response("Not Found", { status: 404 });
}

// ── 登录 / 登出 ──────────────────────────────────────────────

async function doLogin(request, env, origin) {
  const form = await request.formData();
  const user = (form.get("username") || "").trim();
  const pass = form.get("password") || "";
  if (user === adminUser(env) && pass === adminPass(env)) {
    const token = makeToken(env);
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/admin",
        "Set-Cookie": `blog_sess=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
      }
    });
  }
  return htmlResp(loginPage("账号或密码错误，请重试"));
}

function doLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin/login",
      "Set-Cookie": "blog_sess=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    }
  });
}

// ── 后台操作 ─────────────────────────────────────────────────

async function adminSave(request, env) {
  const body = await request.json();
  const { id, title, content, tags, published } = body;
  if (!title || !content) return jsonResp({ error: "标题和内容不能为空" }, 400);

  const now = Date.now();
  if (id) {
    const post = await getPost(env, id);
    if (!post) return jsonResp({ error: "文章不存在" }, 404);
    Object.assign(post, { title, content, tags: tags || [], published: !!published, updatedAt: now });
    await putPost(env, post);
    return jsonResp({ success: true, id: post.id });
  } else {
    const newId = randomId();
    const post = { id: newId, title, content, tags: tags || [], published: !!published, createdAt: now, updatedAt: now, views: 0 };
    await putPost(env, post);
    await addToIndex(env, newId);
    return jsonResp({ success: true, id: newId });
  }
}

async function adminDeletePost(request, env) {
  const { id } = await request.json();
  if (!id) return jsonResp({ error: "缺少id" }, 400);
  await removePost(env, id);
  return jsonResp({ success: true });
}

async function adminUpload(request, env, url) {
  const postId = url.searchParams.get("postId") || "temp";
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file) return jsonResp({ error: "no file" }, 400);

  const filename = file.name;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const dataUrl = `data:${file.type};base64,${btoa(bin)}`;
  await putAttachment(env, postId, filename, dataUrl);

  return jsonResp({ success: true, url: `/attach/${postId}/${encodeURIComponent(filename)}`, filename });
}

async function adminDeleteAttach(request, env) {
  const { postId, filename } = await request.json();
  if (!postId || !filename) return jsonResp({ error: "参数缺失" }, 400);
  await removeAttachment(env, postId, filename);
  return jsonResp({ success: true });
}

// ── 附件访问 ─────────────────────────────────────────────────

async function serveAttach(env, postId, filename) {
  const dataUrl = await env.BLOG.get("attach:" + postId + ":" + filename);
  if (!dataUrl) return new Response("Not Found", { status: 404 });

  const comma = dataUrl.indexOf(",");
  const mimeType = dataUrl.slice(5, comma).split(";")[0];
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { "content-type": mimeType } });
}

// ── 前台页面 ─────────────────────────────────────────────────

async function frontIndex(env, url) {
  const ids = await getIndex(env);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const filterTag = url.searchParams.get("tag") || "";
  const pageSize = 10;

  // 只取已发布文章
  const pubPosts = [];
  for (const id of ids) {
    const p = await getPost(env, id);
    if (p && p.published) pubPosts.push(p);
  }

  // 收集所有标签
  const tagSet = new Set();
  for (const p of pubPosts) (p.tags || []).forEach(t => tagSet.add(t));
  const allTags = [...tagSet];

  // 标签过滤
  const filtered = filterTag
    ? pubPosts.filter(p => (p.tags || []).includes(filterTag))
    : pubPosts;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pagePosts = filtered.slice((page - 1) * pageSize, page * pageSize);

  const tagBarHtml = allTags.length > 0 ? `
    <div class="tag-bar">
      <a href="/" class="tag-pill${!filterTag ? " active" : ""}">全部</a>
      ${allTags.map(t => `<a href="/?tag=${encodeURIComponent(t)}" class="tag-pill${filterTag === t ? " active" : ""}">${escHtml(t)}</a>`).join("")}
    </div>` : "";

  const cardsHtml = pagePosts.length === 0
    ? `<div class="empty">📭 暂无文章${filterTag ? `（标签「${escHtml(filterTag)}」）` : ""}</div>`
    : pagePosts.map(p => {
        const rawExcerpt = p.content
          .replace(/!\[.*?\]\(.*?\)/g, "")
          .replace(/```[\s\S]*?```/g, "")
          .replace(/`[^`]*`/g, "")
          .replace(/[#*>\[\]~_\-=|]/g, "")
          .replace(/\s+/g, " ").trim();
        const excerpt = rawExcerpt.slice(0, 140);
        const dateStr = new Date(p.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" });
        const tagHtml = (p.tags || []).map(t =>
          `<a href="/?tag=${encodeURIComponent(t)}" class="tag">${escHtml(t)}</a>`).join("");
        return `
        <article class="card">
          <div class="card-meta">
            <time class="date">📅 ${dateStr}</time>
            ${tagHtml}
            <span class="views-badge">👁 ${p.views || 0}</span>
          </div>
          <h2 class="card-title"><a href="/post/${p.id}">${escHtml(p.title)}</a></h2>
          <p class="excerpt">${escHtml(excerpt)}${rawExcerpt.length > 140 ? "…" : ""}</p>
          <div class="card-footer">
            <a href="/post/${p.id}" class="read-more">阅读全文 <span class="arrow">→</span></a>
          </div>
        </article>`;
      }).join("");

  const pagerHtml = totalPages > 1 ? `
    <nav class="pager">
      ${page > 1
        ? `<a href="/?page=${page - 1}${filterTag ? "&tag=" + encodeURIComponent(filterTag) : ""}" class="pager-btn">« 上一页</a>`
        : `<span class="pager-btn disabled">« 上一页</span>`}
      <span class="pg-info">第 <strong>${page}</strong> / ${totalPages} 页 · 共 ${total} 篇</span>
      ${page < totalPages
        ? `<a href="/?page=${page + 1}${filterTag ? "&tag=" + encodeURIComponent(filterTag) : ""}" class="pager-btn">下一页 »</a>`
        : `<span class="pager-btn disabled">下一页 »</span>`}
    </nav>` : `<p class="total-hint">共 ${total} 篇文章</p>`;

  return htmlResp(`<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>日志博客</title>
${baseStyle()}
<style>
/* ── 首页横幅 ── */
.hero{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:48px 16px 44px;text-align:center;margin-bottom:0}
.hero-title{font-size:32px;font-weight:800;letter-spacing:.5px;margin-bottom:8px}
.hero-sub{font-size:15px;opacity:.85;margin-bottom:20px}
.hero-search{display:flex;justify-content:center;gap:0}
.hero-search input{width:320px;padding:11px 16px;border:none;border-radius:10px 0 0 10px;font-size:14px;outline:none;background:rgba(255,255,255,.95)}
.hero-search button{padding:11px 18px;background:#fff;color:#5c6bc0;border:none;border-radius:0 10px 10px 0;font-size:14px;font-weight:600;cursor:pointer}
.hero-search button:hover{background:#eff2ff}
/* ── 标签栏 ── */
.tag-bar{display:flex;flex-wrap:wrap;gap:8px;padding:18px 0 4px}
.tag-pill{padding:5px 14px;border-radius:20px;font-size:13px;text-decoration:none;background:#fff;color:#666;border:1.5px solid #e0e0e0;transition:all .15s}
.tag-pill:hover{border-color:#5c6bc0;color:#5c6bc0}
.tag-pill.active{background:#5c6bc0;color:#fff;border-color:#5c6bc0}
/* ── 卡片 ── */
.card{background:#fff;border-radius:14px;padding:26px 30px;margin-bottom:18px;box-shadow:0 2px 12px rgba(0,0,0,0.06);transition:box-shadow .2s,transform .2s;border:1.5px solid transparent}
.card:hover{box-shadow:0 8px 28px rgba(92,107,192,0.13);transform:translateY(-2px);border-color:#e8ecff}
.card-meta{font-size:13px;color:#aaa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.date{color:#bbb}
.tag{background:#eff2ff;color:#5c6bc0;padding:2px 9px;border-radius:20px;font-size:12px;text-decoration:none;transition:background .15s}
.tag:hover{background:#dde4ff}
.views-badge{margin-left:auto;font-size:12px;color:#ccc}
.card-title{margin:0 0 10px;font-size:20px;font-weight:700;line-height:1.4}
.card-title a{color:#1a1a2e;text-decoration:none}
.card-title a:hover{color:#5c6bc0}
.excerpt{color:#777;line-height:1.8;margin:0 0 16px;font-size:14.5px}
.card-footer{display:flex;align-items:center}
.read-more{color:#5c6bc0;text-decoration:none;font-size:13.5px;font-weight:600;display:inline-flex;align-items:center;gap:4px}
.read-more .arrow{transition:transform .18s}
.read-more:hover .arrow{transform:translateX(4px)}
/* ── 空 & 分页 ── */
.empty{text-align:center;color:#bbb;padding:80px 0;font-size:17px}
.pager{display:flex;justify-content:space-between;align-items:center;margin-top:28px;padding:0 2px}
.pager-btn{color:#5c6bc0;text-decoration:none;padding:9px 20px;border:1.5px solid #c5cae9;border-radius:9px;font-size:14px;font-weight:500;transition:all .15s;background:#fff}
.pager-btn:hover{background:#eff2ff;border-color:#5c6bc0}
.pager-btn.disabled{color:#ccc;border-color:#eee;cursor:default;pointer-events:none}
.pg-info{color:#aaa;font-size:14px}
.pg-info strong{color:#5c6bc0}
.total-hint{text-align:center;color:#bbb;font-size:13px;margin-top:20px}
@media(max-width:600px){.hero-title{font-size:22px}.hero-search input{width:200px}.card{padding:18px 16px}.card-title{font-size:17px}}
</style>
</head><body>
${topBar(false)}
<div class="hero">
  <div class="hero-title">📝 日志博客</div>
  <div class="hero-sub">记录每一个值得留下的瞬间</div>
  <div class="hero-search">
    <input id="sch-input" type="text" placeholder="搜索文章标题…" onkeydown="if(event.key==='Enter')doSearch()">
    <button onclick="doSearch()">搜索</button>
  </div>
</div>
<div class="wrap">
  ${tagBarHtml}
  <div id="card-list">
    ${cardsHtml}
  </div>
  ${pagerHtml}
</div>
<script>
function doSearch(){
  const q=document.getElementById('sch-input').value.trim();
  if(!q)return;
  const cards=document.querySelectorAll('#card-list .card');
  cards.forEach(c=>{
    const title=c.querySelector('.card-title').textContent.toLowerCase();
    const ex=c.querySelector('.excerpt').textContent.toLowerCase();
    c.style.display=(title.includes(q.toLowerCase())||ex.includes(q.toLowerCase()))?'':'none';
  });
}
</script>
</body></html>`);
}

async function frontPost(env, id) {
  const post = await getPost(env, id);
  if (!post || !post.published) return htmlResp(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>文章不存在</title>${baseStyle()}</head><body>
${topBar(false)}
<div class="wrap" style="text-align:center;padding-top:80px">
  <div style="font-size:64px;margin-bottom:20px">📭</div>
  <h2 style="color:#aaa;font-weight:400;font-size:20px">文章不存在或尚未发布</h2>
  <a href="/" style="display:inline-block;margin-top:24px;color:#5c6bc0;text-decoration:none;font-size:15px">← 返回首页</a>
</div></body></html>`, 404);

  post.views = (post.views || 0) + 1;
  await putPost(env, post);

  const attachments = await getAttachList(env, id);
  const attachHtml = attachments.length > 0 ? `
    <div class="attach-block">
      <div class="attach-title">📎 附件</div>
      <div class="attach-list">
        ${attachments.map(f =>
          `<a href="/attach/${id}/${encodeURIComponent(f)}" target="_blank" download="${escHtml(f)}">${escHtml(f)}</a>`
        ).join("")}
      </div>
    </div>` : "";

  const dateStr = new Date(post.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const updateStr = post.updatedAt > post.createdAt
    ? `<span class="meta-item">✏️ 更新于 ${new Date(post.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>` : "";
  const tagHtml = (post.tags || []).map(t =>
    `<a href="/?tag=${encodeURIComponent(t)}" class="tag">${escHtml(t)}</a>`).join("");

  return htmlResp(`<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(post.title)} - 日志博客</title>
${baseStyle()}
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
<style>
/* ── 阅读进度条 ── */
#prog{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#667eea,#764ba2);width:0%;z-index:999;transition:width .1s}
/* ── 文章头 ── */
.post-hd{background:#fff;border-radius:14px;padding:34px 40px 28px;margin-bottom:20px;box-shadow:0 2px 12px rgba(0,0,0,0.07)}
.post-title{margin:0 0 16px;font-size:28px;color:#1a1a2e;font-weight:800;line-height:1.4}
.post-meta{font-size:13px;color:#aaa;display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.meta-item{display:flex;align-items:center;gap:4px}
.tag{background:#eff2ff;color:#5c6bc0;padding:2px 9px;border-radius:20px;font-size:12px;text-decoration:none}
.tag:hover{background:#dde4ff}
.views-num{margin-left:auto;font-size:12px;color:#ccc}
/* ── 布局：目录侧栏 + 正文 ── */
.post-layout{display:grid;grid-template-columns:1fr;gap:24px;align-items:start}
.post-layout.has-toc{grid-template-columns:220px 1fr}
.toc-sidebar{position:sticky;top:72px;background:#fff;border-radius:12px;padding:18px 16px;box-shadow:0 2px 10px rgba(0,0,0,0.06);font-size:13px;max-height:calc(100vh - 100px);overflow-y:auto}
.toc-sidebar h4{margin:0 0 12px;color:#5c6bc0;font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}
.toc-sidebar a{color:#777;text-decoration:none;display:block;padding:3px 0;line-height:1.5;transition:color .15s;border-left:2px solid transparent;padding-left:8px}
.toc-sidebar a:hover{color:#5c6bc0}
.toc-sidebar a.toc-active{color:#5c6bc0;font-weight:600;border-left-color:#5c6bc0}
/* ── 正文 ── */
.markdown-body{background:#fff;border-radius:14px;padding:34px 40px;box-shadow:0 2px 12px rgba(0,0,0,0.07);font-size:15.5px;line-height:1.9;max-width:none!important;width:100%!important}
/* Markdown 基础排版 */
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{margin:1.4em 0 .6em;font-weight:700;line-height:1.3;color:#1a1a2e}
.markdown-body h1{font-size:1.9em;border-bottom:2px solid #eef0ff;padding-bottom:.3em}
.markdown-body h2{font-size:1.5em;border-bottom:1px solid #f0f0f0;padding-bottom:.25em}
.markdown-body h3{font-size:1.25em}
.markdown-body p{margin:.8em 0}
.markdown-body ul,.markdown-body ol{margin:.6em 0;padding-left:2em}
.markdown-body li{margin:.3em 0}
.markdown-body blockquote{margin:.8em 0;padding:.4em 1em;border-left:4px solid #c5cae9;background:#f8f9ff;color:#666;border-radius:0 8px 8px 0}
.markdown-body code{background:#f3f4ff;color:#c0392b;padding:2px 6px;border-radius:4px;font-size:.88em;font-family:'Cascadia Code','Fira Code',Consolas,monospace}
.markdown-body pre{background:#f8f9fa;border-radius:8px;overflow-x:auto;margin:.8em 0;max-width:100%}
.markdown-body pre code{background:none;color:inherit;padding:0;font-size:.9em;white-space:pre}
.markdown-body table{border-collapse:collapse;width:100%;margin:.8em 0}
.markdown-body table th,.markdown-body table td{border:1px solid #e0e0e0;padding:8px 14px;text-align:left}
.markdown-body table th{background:#f3f4ff;font-weight:600}
.markdown-body table tr:nth-child(even){background:#fafafa}
.markdown-body img{max-width:100%;border-radius:8px}
.markdown-body a{color:#5c6bc0;text-decoration:none}
.markdown-body a:hover{text-decoration:underline}
.markdown-body hr{border:none;border-top:2px solid #eef0ff;margin:1.5em 0}
/* ── 附件 ── */
.attach-block{margin-top:20px;background:#fff;border-radius:12px;padding:20px 24px;box-shadow:0 2px 10px rgba(0,0,0,0.06)}
.attach-title{font-size:14px;font-weight:600;color:#555;margin-bottom:12px}
.attach-list{display:flex;flex-wrap:wrap;gap:8px}
.attach-list a{padding:6px 14px;background:#f8f9ff;border:1.5px solid #c5cae9;border-radius:8px;color:#5c6bc0;text-decoration:none;font-size:13px;transition:all .15s}
.attach-list a:hover{background:#eff2ff;border-color:#5c6bc0}
/* ── 底部导航 ── */
.post-nav{display:flex;justify-content:space-between;align-items:center;margin-top:28px;gap:12px}
.post-nav a{flex:1;text-align:center;padding:13px 10px;background:#fff;border-radius:12px;color:#5c6bc0;text-decoration:none;font-size:14px;font-weight:500;box-shadow:0 2px 10px rgba(0,0,0,0.06);transition:all .18s;border:1.5px solid transparent}
.post-nav a:hover{border-color:#c5cae9;transform:translateY(-2px)}
/* ── 返回顶部 ── */
#back-top{position:fixed;right:24px;bottom:32px;width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;font-size:18px;cursor:pointer;box-shadow:0 4px 16px rgba(102,126,234,.4);opacity:0;transition:opacity .3s,transform .3s;transform:translateY(16px);z-index:200}
#back-top.show{opacity:1;transform:translateY(0)}
#back-top:hover{transform:scale(1.08)}
/* ── 复制按钮 ── */
.copy-btn{position:absolute;top:8px;right:10px;padding:3px 11px;background:rgba(240,240,240,.9);border:1px solid #ddd;border-radius:5px;font-size:12px;cursor:pointer;opacity:.75;transition:opacity .15s}
.copy-btn:hover{opacity:1}
@media(max-width:800px){.post-layout{grid-template-columns:1fr}.toc-sidebar{display:none}.post-hd{padding:22px 18px}.markdown-body{padding:22px 18px}}
</style>
</head><body>
<div id="prog"></div>
${topBar(false)}
<div class="wrap">
  <div class="post-hd">
    <h1 class="post-title">${escHtml(post.title)}</h1>
    <div class="post-meta">
      <span class="meta-item">📅 ${dateStr}</span>
      ${updateStr}
      ${tagHtml}
      <span class="views-num">👁 ${post.views}</span>
    </div>
  </div>

  <div class="post-layout">
    <aside id="toc-sidebar" class="toc-sidebar" style="display:none">
      <h4>目录</h4>
      <div id="toc-links"></div>
    </aside>
    <div>
      <div class="markdown-body" id="content">${renderMd(post.content)}</div>
      ${attachHtml}
      <div class="post-nav">
        <a href="/">← 返回首页</a>
        <a href="/admin/login">进入后台</a>
      </div>
    </div>
  </div>
</div>

<button id="back-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="返回顶部">↑</button>

<script>
// 目录
const hs = document.querySelectorAll('#content h1,#content h2,#content h3');
if (hs.length >= 2) {
  const sidebar = document.getElementById('toc-sidebar');
  const links = document.getElementById('toc-links');
  sidebar.style.display = '';
  document.querySelector('.post-layout').classList.add('has-toc');
  hs.forEach((h, i) => {
    h.id = 'h' + i;
    const lv = parseInt(h.tagName[1]);
    const a = document.createElement('a');
    a.href = '#h' + i;
    a.textContent = h.textContent;
    a.style.paddingLeft = (lv - 1) * 12 + 8 + 'px';
    a.dataset.idx = i;
    a.addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('h' + i).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    links.appendChild(a);
  });

  // 高亮当前目录项
  const tocLinks = links.querySelectorAll('a');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        tocLinks.forEach(a => a.classList.remove('toc-active'));
        const idx = [...hs].indexOf(entry.target);
        if (idx >= 0) tocLinks[idx].classList.add('toc-active');
      }
    });
  }, { rootMargin: '-10% 0px -80% 0px' });
  hs.forEach(h => observer.observe(h));
}

// 复制代码
function copyCode(btn) {
  const code = btn.parentElement.querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '已复制 ✓';
    setTimeout(() => btn.textContent = '复制', 1800);
  });
}

// 阅读进度条
const prog = document.getElementById('prog');
const backTop = document.getElementById('back-top');
window.addEventListener('scroll', () => {
  const doc = document.documentElement;
  const pct = (doc.scrollTop / (doc.scrollHeight - doc.clientHeight)) * 100;
  prog.style.width = Math.min(pct, 100) + '%';
  backTop.classList.toggle('show', doc.scrollTop > 400);
}, { passive: true });
</script>
</body></html>`);
}

// ── 后台页面 ─────────────────────────────────────────────────

function loginPage(errMsg) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理员登录 - 日志博客</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);font-family:'Segoe UI',Arial,sans-serif;
  padding:16px}
/* 背景装饰圆 */
body::before,body::after{content:'';position:fixed;border-radius:50%;opacity:.12;pointer-events:none}
body::before{width:500px;height:500px;background:#fff;top:-160px;right:-120px}
body::after{width:380px;height:380px;background:#fff;bottom:-100px;left:-100px}
.login-card{background:#fff;border-radius:22px;padding:48px 44px 40px;width:100%;max-width:400px;
  box-shadow:0 30px 80px rgba(0,0,0,0.25);position:relative;z-index:1}
.login-logo{text-align:center;font-size:44px;margin-bottom:6px;line-height:1}
.login-title{text-align:center;font-size:24px;color:#1a1a2e;margin-bottom:4px;font-weight:800;letter-spacing:.3px}
.login-sub{text-align:center;font-size:13px;color:#aaa;margin-bottom:32px}
.field-label{display:block;font-size:13px;color:#555;margin-bottom:8px;font-weight:500}
.pwd-wrap{position:relative}
input[type=password],input[type=text].pwd-txt{width:100%;padding:13px 46px 13px 16px;
  border:1.5px solid #e0e0e0;border-radius:11px;font-size:15px;outline:none;
  transition:border-color .2s,box-shadow .2s;background:#fafafa}
input[type=password]:focus,input[type=text].pwd-txt:focus{border-color:#667eea;background:#fff;
  box-shadow:0 0 0 3px rgba(102,126,234,.12)}
.eye-btn{position:absolute;right:14px;top:50%;transform:translateY(-50%);background:none;
  border:none;cursor:pointer;color:#bbb;font-size:18px;padding:0;transition:color .15s;width:auto;margin:0}
.eye-btn:hover{color:#667eea}
.err-box{background:#fff0f0;color:#c0392b;border:1px solid #fcc;border-radius:9px;
  padding:10px 14px;font-size:13px;margin-top:14px;
  display:${errMsg ? "flex" : "none"};align-items:center;gap:7px}
.login-btn{width:100%;margin-top:22px;padding:14px;
  background:linear-gradient(135deg,#667eea,#764ba2);
  color:#fff;border:none;border-radius:11px;font-size:15px;font-weight:700;
  cursor:pointer;transition:opacity .15s,transform .12s;letter-spacing:.5px}
.login-btn:hover{opacity:.92;transform:translateY(-1px)}
.login-btn:active{transform:translateY(0)}
.login-footer{text-align:center;margin-top:18px;font-size:12px;color:#ccc}
.login-footer a{color:#999;text-decoration:none}
.login-footer a:hover{color:#667eea}
</style>
</head><body>
<div class="login-card">
  <div class="login-logo">📝</div>
  <h1 class="login-title">日志博客</h1>
  <p class="login-sub">后台管理系统</p>
  <form method="POST" action="/admin/login" autocomplete="off">
    <label class="field-label" for="uname">管理员账号</label>
    <input type="text" id="uname" name="username" placeholder="请输入账号" autofocus autocomplete="username"
      style="width:100%;padding:13px 16px;border:1.5px solid #e0e0e0;border-radius:11px;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;background:#fafafa;margin-bottom:16px">
    <label class="field-label" for="pwd">管理员密码</label>
    <div class="pwd-wrap">
      <input type="password" id="pwd" name="password" placeholder="请输入密码" autocomplete="current-password">
      <button type="button" class="eye-btn" onclick="togglePwd()" id="eye-btn" title="显示/隐藏密码">👁</button>
    </div>
    <div class="err-box">⚠️ ${escHtml(errMsg || "")}</div>
    <button type="submit" class="login-btn">登 录</button>
  </form>
  <p class="login-footer">默认账号 <code>admin</code> 密码 <code>admin888</code> · <a href="/">访问前台 →</a></p>
</div>
<script>
function togglePwd(){
  const i=document.getElementById('pwd');
  const b=document.getElementById('eye-btn');
  if(i.type==='password'){i.type='text';i.className='pwd-txt';b.style.opacity='1';}
  else{i.type='password';i.className='';b.style.opacity='.5';}
}
</script>
</body></html>`;
}

async function adminIndex(env) {
  const ids = await getIndex(env);
  const posts = [];
  for (const id of ids) {
    const p = await getPost(env, id);
    if (p) posts.push(p);
  }

  const totalViews = posts.reduce((s, p) => s + (p.views || 0), 0);
  const pubCount = posts.filter(p => p.published).length;
  const draftCount = posts.length - pubCount;

  const rows = posts.length === 0
    ? `<tr class="empty-row"><td colspan="6">📭 暂无文章，点击右上角「写新文章」开始创作</td></tr>`
    : posts.map(p => {
        const titleEsc = escHtml(p.title).replace(/'/g, "&#39;");
        return `
    <tr>
      <td class="td-date">${new Date(p.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</td>
      <td class="td-title">
        <a href="/post/${p.id}" target="_blank" class="post-link">${escHtml(p.title)}</a>
      </td>
      <td class="td-tags">
        ${(p.tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join("") || `<span class="no-tag">-</span>`}
      </td>
      <td>
        <span class="badge ${p.published ? "pub" : "draft"}">${p.published ? "✓ 已发布" : "草稿"}</span>
      </td>
      <td class="td-views">${p.views || 0}</td>
      <td class="td-actions">
        <a href="/post/${p.id}" target="_blank" class="act-btn view" title="查看">查看</a>
        <a href="/admin/edit?id=${p.id}" class="act-btn edit" title="编辑">编辑</a>
        <button class="act-btn del" onclick="confirmDelete('${p.id}','${titleEsc}')" title="删除">删除</button>
      </td>
    </tr>`;
      }).join("");

  return htmlResp(`<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>后台管理 - 日志博客</title>
${baseStyle()}
<style>
/* ── 统计卡片 ── */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px}
.stat{background:#fff;border-radius:14px;padding:22px 18px;text-align:center;
  box-shadow:0 2px 12px rgba(0,0,0,0.06);border-top:3px solid transparent;transition:transform .2s}
.stat:hover{transform:translateY(-2px)}
.stat.s1{border-top-color:#667eea}.stat.s2{border-top-color:#43a047}
.stat.s3{border-top-color:#fb8c00}.stat.s4{border-top-color:#e53935}
.stat .num{font-size:32px;font-weight:800;color:#1a1a2e;line-height:1.1}
.stat .lbl{font-size:12px;color:#aaa;margin-top:6px;font-weight:500;letter-spacing:.3px}
/* ── 管理栏 ── */
.admin-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:10px}
.admin-bar h2{font-size:20px;color:#1a1a2e;font-weight:700}
.bar-right{display:flex;align-items:center;gap:10px}
.search-input{padding:9px 14px;border:1.5px solid #e0e0e0;border-radius:9px;font-size:13px;outline:none;width:200px;transition:border-color .2s}
.search-input:focus{border-color:#667eea}
.new-btn{padding:10px 22px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;
  border:none;border-radius:9px;font-size:14px;font-weight:600;text-decoration:none;
  cursor:pointer;transition:opacity .15s,transform .12s;white-space:nowrap}
.new-btn:hover{opacity:.9;transform:translateY(-1px)}
/* ── 表格 ── */
.tbl-wrap{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)}
table{width:100%;border-collapse:collapse}
th{background:#f8f9ff;padding:13px 16px;text-align:left;font-size:12px;color:#999;
  font-weight:700;border-bottom:2px solid #eef0ff;letter-spacing:.4px;text-transform:uppercase}
td{padding:14px 16px;border-bottom:1px solid #f4f4f8;vertical-align:middle;font-size:14px}
tr:last-child td{border:none}
tbody tr{transition:background .12s}
tbody tr:hover td{background:#fafbff}
.td-date{color:#bbb;font-size:12px;white-space:nowrap;width:90px}
.td-title{max-width:260px}
.post-link{color:#1a1a2e;text-decoration:none;font-weight:500;display:block;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.post-link:hover{color:#5c6bc0}
.td-tags{max-width:150px}
.tag{background:#eff2ff;color:#5c6bc0;padding:2px 8px;border-radius:20px;
  font-size:11px;margin:1px 2px;display:inline-block;white-space:nowrap}
.no-tag{color:#ddd;font-size:13px}
.badge{padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.pub{background:#e8f5e9;color:#2e7d32}
.badge.draft{background:#fff8e1;color:#f57f17}
.td-views{color:#bbb;font-size:13px;text-align:center;width:60px}
.td-actions{white-space:nowrap;width:160px}
.act-btn{display:inline-block;padding:4px 12px;border-radius:6px;font-size:12px;
  text-decoration:none;cursor:pointer;border:none;margin-right:3px;font-weight:600;
  transition:opacity .15s;background:none}
.act-btn.view{background:#f5f5f5;color:#555}
.act-btn.view:hover{background:#e8e8e8}
.act-btn.edit{background:#eff2ff;color:#5c6bc0}
.act-btn.edit:hover{background:#dde4ff}
.act-btn.del{background:#fff0f0;color:#e53935}
.act-btn.del:hover{background:#ffe0e0}
.empty-row td{text-align:center;color:#ccc;padding:60px;font-size:15px}
/* ── 删除弹窗 ── */
.modal-mask{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);
  z-index:999;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.modal-mask.show{display:flex}
.modal-box{background:#fff;border-radius:18px;padding:36px 40px;width:360px;
  box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center;animation:popIn .2s ease}
@keyframes popIn{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}
.modal-icon{font-size:40px;margin-bottom:12px}
.modal-ttl{font-size:18px;font-weight:700;color:#1a1a2e;margin-bottom:8px}
.modal-sub{color:#888;font-size:14px;margin-bottom:26px;word-break:break-all}
.modal-btns{display:flex;gap:12px}
.modal-cancel{flex:1;padding:12px;border:1.5px solid #e0e0e0;background:#fff;
  border-radius:10px;font-size:14px;cursor:pointer;color:#666;font-weight:500;transition:all .15s}
.modal-cancel:hover{border-color:#bbb;color:#333}
.modal-confirm{flex:1;padding:12px;background:#e53935;color:#fff;
  border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s}
.modal-confirm:hover{opacity:.88}
/* 响应式 */
@media(max-width:700px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .td-tags,.td-views{display:none}
  .search-input{width:130px}
}
</style>
</head><body>
${topBar(true)}
<div class="wrap">
  <div class="stats">
    <div class="stat s1">
      <div class="num">${posts.length}</div>
      <div class="lbl">全部文章</div>
    </div>
    <div class="stat s2">
      <div class="num">${pubCount}</div>
      <div class="lbl">已发布</div>
    </div>
    <div class="stat s3">
      <div class="num">${draftCount}</div>
      <div class="lbl">草稿</div>
    </div>
    <div class="stat s4">
      <div class="num">${totalViews}</div>
      <div class="lbl">总浏览量</div>
    </div>
  </div>

  <div class="admin-bar">
    <h2>文章管理</h2>
    <div class="bar-right">
      <input class="search-input" id="sch" type="text" placeholder="搜索标题…" oninput="filterTable()">
      <a href="/admin/edit" class="new-btn">+ 写新文章</a>
    </div>
  </div>

  <div class="tbl-wrap">
    <table id="post-table">
      <thead><tr>
        <th>日期</th>
        <th>标题</th>
        <th>标签</th>
        <th>状态</th>
        <th style="text-align:center">浏览</th>
        <th>操作</th>
      </tr></thead>
      <tbody id="post-tbody">${rows}</tbody>
    </table>
  </div>
</div>

<!-- 删除确认弹窗 -->
<div class="modal-mask" id="del-modal">
  <div class="modal-box">
    <div class="modal-icon">🗑️</div>
    <div class="modal-ttl">确认删除</div>
    <div class="modal-sub" id="del-title"></div>
    <div class="modal-btns">
      <button class="modal-cancel" onclick="closeModal()">取消</button>
      <button class="modal-confirm" id="del-confirm-btn">确认删除</button>
    </div>
  </div>
</div>

<script>
// 搜索过滤
function filterTable() {
  const q = document.getElementById('sch').value.toLowerCase();
  document.querySelectorAll('#post-tbody tr:not(.empty-row)').forEach(tr => {
    const title = tr.querySelector('.post-link')?.textContent.toLowerCase() || '';
    tr.style.display = title.includes(q) ? '' : 'none';
  });
}

// 删除弹窗
let delId = null;
function confirmDelete(id, title) {
  delId = id;
  document.getElementById('del-title').textContent = '删除后无法恢复："' + title + '"';
  document.getElementById('del-modal').classList.add('show');
}
function closeModal() {
  document.getElementById('del-modal').classList.remove('show');
  delId = null;
}
document.getElementById('del-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('del-modal')) closeModal();
});
document.getElementById('del-confirm-btn').onclick = async function() {
  if (!delId) return;
  this.textContent = '删除中…';
  this.disabled = true;
  const res = await fetch('/admin/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: delId })
  });
  const d = await res.json();
  if (d.success) {
    location.reload();
  } else {
    alert('删除失败: ' + d.error);
    this.textContent = '确认删除';
    this.disabled = false;
    closeModal();
  }
};
</script>
</body></html>`);
}

// 客户端预览用的 Markdown 渲染函数（作为普通 JS 函数定义，通过 toString() 注入页面）
function renderMdClientFn() {
  var BT = String.fromCharCode(96);
  var FENCE = BT+BT+BT;
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function inline(s) {
    return s
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_,text,href){ var h=(/^[a-z][a-z\d+\-.]*:/i.test(href))?href:'https://'+href; return '<a href="'+h+'" target="_blank">'+text+'</a>'; })
      .replace(new RegExp(BT+'([^'+BT+']+)'+BT), '<code>$1</code>')
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
  }
  window.renderMdClient = function(src) {
    if (!src) return '';
    var html = '';
    var lines = src.replace(/\r\n|\r/g, '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (line.startsWith(FENCE)) {
        var lang = esc(line.slice(3).trim());
        var code = '';
        i++;
        while (i < lines.length && !lines[i].startsWith(FENCE)) { code += lines[i] + '\n'; i++; }
        html += '<div class="code-wrap"><button class="preview-copy" onclick="pvCopy(this)">复制</button><pre><code' + (lang ? ' class="language-'+lang+'"' : '') + '>' + esc(code) + '</code></pre></div>\n';
        i++; continue;
      }
      var hm = line.match(/^(#{1,6})\s+(.+)/);
      if (hm) { var lv=hm[1].length; html+='<h'+lv+'>'+inline(hm[2])+'</h'+lv+'>\n'; i++; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { html+='<hr>\n'; i++; continue; }
      if (line.startsWith('> ')) {
        var q='';
        while (i<lines.length && lines[i].startsWith('> ')) { q+=inline(lines[i].slice(2))+' '; i++; }
        html+='<blockquote><p>'+q.trim()+'</p></blockquote>\n'; continue;
      }
      if (/^[-*+]\s/.test(line)) {
        html+='<ul>\n';
        while (i<lines.length && /^[-*+]\s/.test(lines[i])) { html+='<li>'+inline(lines[i].replace(/^[-*+]\s/,''))+'</li>\n'; i++; }
        html+='</ul>\n'; continue;
      }
      if (/^\d+\.\s/.test(line)) {
        html+='<ol>\n';
        while (i<lines.length && /^\d+\.\s/.test(lines[i])) { html+='<li>'+inline(lines[i].replace(/^\d+\.\s/,''))+'</li>\n'; i++; }
        html+='</ol>\n'; continue;
      }
      if (/^\|/.test(line)) {
        var rows = [];
        while (i<lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        var parseRow = function(r){ return r.replace(/^\||\|$/g,'').split('|').map(function(c){return c.trim();}); };
        var isSep = function(r){ return /^\|[\s|:\-]+\|$/.test(r.trim()); };
        var sepIdx = -1;
        for (var ri=0;ri<rows.length;ri++){ if(isSep(rows[ri])){ sepIdx=ri; break; } }
        html+='<table>\n';
        if (sepIdx===1 && rows.length>=1) {
          var sepRow = rows[sepIdx];
          var alignCols = parseRow(sepRow).map(function(c){
            if (/^:-+:$/.test(c)) return 'center';
            if (/^-+:$/.test(c)) return 'right';
            return 'left';
          });
          html+='<thead><tr>';
          parseRow(rows[0]).forEach(function(c,ci){ html+='<th style="text-align:'+( alignCols[ci]||'left')+'">'+inline(c)+'</th>'; });
          html+='</tr></thead>\n<tbody>\n';
          for (var ri2=sepIdx+1;ri2<rows.length;ri2++){
            html+='<tr>';
            parseRow(rows[ri2]).forEach(function(c,ci){ html+='<td style="text-align:'+(alignCols[ci]||'left')+'">'+inline(c)+'</td>'; });
            html+='</tr>\n';
          }
          html+='</tbody>\n';
        } else {
          html+='<tbody>\n';
          rows.forEach(function(r){
            if(isSep(r)) return;
            html+='<tr>'; parseRow(r).forEach(function(c){ html+='<td>'+inline(c)+'</td>'; }); html+='</tr>\n';
          });
          html+='</tbody>\n';
        }
        html+='</table>\n'; continue;
      }
      if (line.trim()==='') { i++; continue; }
      html+='<p>'+inline(line)+'</p>\n'; i++;
    }
    return html;
  };
}

async function adminEdit(env, url) {
  const id = url.searchParams.get("id") || "";
  let post = null;
  let attachments = [];
  if (id) {
    post = await getPost(env, id);
    attachments = await getAttachList(env, id);
  }

  const pId = post ? post.id : "";
  const pTitle = post ? post.title : "";
  const pContent = post ? post.content : "";
  const pTags = post ? (post.tags || []).join(", ") : "";
  const pPublished = post ? post.published : false;
  const isEdit = !!post;

  const attachHtml = attachments.map(f =>
    `<div class="atch-item" id="atch-${escHtml(f).replace(/[^a-z0-9]/gi, "_")}">
      <a href="/attach/${pId}/${encodeURIComponent(f)}" target="_blank" title="${escHtml(f)}">📎 ${escHtml(f)}</a>
      <button class="atch-del" onclick="delAttach('${escHtml(pId)}','${escHtml(f).replace(/'/g, "&#39;")}')">×</button>
    </div>`).join("");

  return htmlResp(`<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isEdit ? "编辑文章" : "写新文章"} - 日志博客</title>
${baseStyle()}
<style>
/* ── 整体布局：全屏编辑器 ── */
html,body{height:100%;overflow:hidden}
body{background:#f0f2f9}
.edit-root{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── 顶部操作栏 ── */
.edit-topbar{
  background:#fff;border-bottom:1.5px solid #eef0ff;
  padding:0 16px;height:56px;
  display:flex;align-items:center;gap:10px;
  flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.07);
  position:relative;z-index:10
}
.tb-back{color:#5c6bc0;text-decoration:none;font-size:13px;font-weight:500;
  padding:6px 10px;border-radius:7px;transition:background .15s;white-space:nowrap;
  display:flex;align-items:center;gap:4px}
.tb-back:hover{background:#eff2ff}
.tb-divider{width:1px;height:28px;background:#eee;flex-shrink:0}
#inp-title{flex:1;min-width:0;padding:9px 13px;border:1.5px solid #e0e0e0;
  border-radius:9px;font-size:15px;font-weight:600;outline:none;transition:border-color .2s}
#inp-title:focus{border-color:#667eea;background:#fff}
#inp-tags{width:170px;flex-shrink:0;padding:9px 13px;border:1.5px solid #e0e0e0;
  border-radius:9px;font-size:13px;outline:none;transition:border-color .2s}
#inp-tags:focus{border-color:#667eea}
.pub-wrap{display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer;
  font-size:13px;color:#555;flex-shrink:0}
/* 开关样式 */
.toggle{position:relative;display:inline-block;width:36px;height:20px}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:#ccc;border-radius:20px;
  cursor:pointer;transition:.2s}
.toggle-slider:before{content:'';position:absolute;width:14px;height:14px;
  left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked + .toggle-slider{background:#43a047}
.toggle input:checked + .toggle-slider:before{transform:translateX(16px)}
.save-btn{padding:9px 22px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;
  border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;
  white-space:nowrap;transition:opacity .15s,transform .12s;flex-shrink:0}
.save-btn:hover{opacity:.9;transform:translateY(-1px)}
.save-btn:disabled{opacity:.55;cursor:default;transform:none}
#save-msg{font-size:13px;white-space:nowrap;padding:5px 12px;border-radius:7px;flex-shrink:0;min-width:80px;text-align:center}
.msg-ok{background:#e8f5e9;color:#2e7d32}
.msg-err{background:#ffebee;color:#c62828}
.msg-loading{background:#f3f4ff;color:#5c6bc0}

/* ── 编辑区域 ── */
.edit-body{display:flex;flex:1;min-height:0;height:0}

/* ── 左侧：编辑面板 ── */
.editor-panel{display:flex;flex-direction:column;flex:1;min-width:0;
  border-right:1.5px solid #eef0ff;overflow:hidden;background:#fff}

/* 工具栏 */
.md-toolbar{display:flex;align-items:center;gap:3px;padding:7px 12px;
  background:#f8f9ff;border-bottom:1px solid #eef0ff;flex-shrink:0;flex-wrap:wrap}
.tb-group{display:flex;gap:2px}
.tb-sep{width:1px;height:22px;background:#e0e0e0;margin:0 4px;flex-shrink:0}
.tb{padding:4px 8px;border:1px solid transparent;background:none;border-radius:5px;
  cursor:pointer;font-size:13px;line-height:1.4;transition:background .12s,border-color .12s;
  color:#444;min-width:28px;text-align:center}
.tb:hover{background:#eff2ff;border-color:#c5cae9;color:#5c6bc0}
.tb.active{background:#eff2ff;border-color:#c5cae9;color:#5c6bc0}
/* 字数统计 */
.word-count{margin-left:auto;font-size:12px;color:#bbb;white-space:nowrap;flex-shrink:0}

/* Markdown 输入区 */
#md-area{flex:1;padding:20px 22px;border:none;outline:none;resize:none;
  font-family:'Cascadia Code','Fira Code','Consolas',monospace;
  font-size:14px;line-height:1.9;color:#1a1a2e;
  background:#fff;overflow-y:auto;tab-size:2}

/* 附件栏 */
.attach-bar{padding:8px 14px;background:#f8f9ff;border-top:1px solid #eef0ff;
  flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:40px}
.attach-bar-lbl{font-size:12px;color:#bbb;white-space:nowrap}
.atch-item{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
  background:#eff2ff;border-radius:20px;font-size:12px;max-width:200px}
.atch-item a{color:#5c6bc0;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atch-del{background:none;border:none;cursor:pointer;color:#e53935;
  font-size:14px;line-height:1;padding:0 1px;flex-shrink:0}
.atch-del:hover{color:#c62828}

/* ── 右侧：预览面板 ── */
.preview-panel{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;background:#fafbff;position:relative}
.preview-hd{padding:10px 16px;background:#f8f9ff;border-bottom:1px solid #eef0ff;
  font-size:12px;color:#bbb;letter-spacing:.3px;font-weight:500;position:sticky;top:0;z-index:1}
.markdown-body#preview{padding:28px 32px;font-size:14.5px;line-height:1.9;background:#fafbff;border-radius:0;box-shadow:none;max-width:none!important;width:100%!important;display:block}
.markdown-body#preview .code-wrap{position:relative;margin:.8em 0}
.markdown-body#preview .code-wrap pre{max-width:100%;overflow-x:auto;background:#f3f4f6;border-radius:6px;padding:12px 16px;margin:0;box-sizing:border-box;word-break:normal}
.markdown-body#preview .code-wrap pre code{white-space:pre;background:none;padding:0;font-size:.9em;display:block}
.markdown-body#preview pre{max-width:100%;overflow-x:auto;background:#f3f4f6;border-radius:6px;padding:12px 16px;margin:.8em 0;box-sizing:border-box;word-break:normal}
.markdown-body#preview pre code{white-space:pre;background:none;padding:0;font-size:.9em;display:block}
.markdown-body#preview table{border-collapse:collapse;width:100%;margin:.8em 0;font-size:14px}
.markdown-body#preview table th,.markdown-body#preview table td{border:1px solid #dde1f0;padding:7px 12px;line-height:1.6}
.markdown-body#preview table th{background:#f0f2ff;font-weight:600;color:#3d4a7a}
.markdown-body#preview table tr:nth-child(even) td{background:#f8f9ff}

/* ── 拖拽上传提示 ── */
.drop-overlay{display:none;position:fixed;inset:0;background:rgba(102,126,234,.18);
  z-index:500;border:3px dashed #667eea;border-radius:12px;
  align-items:center;justify-content:center;font-size:24px;color:#667eea;font-weight:700}
.drop-overlay.active{display:flex}

/* ── 响应式 ── */
@media(max-width:760px){
  html,body{height:auto;overflow:auto}
  .edit-root{height:auto}
  .edit-body{flex-direction:column}
  .preview-panel{display:none}
  .editor-panel{border-right:none;height:60vh}
  #inp-tags{display:none}
}
</style>
</head><body>
<div class="edit-root">
  <!-- 顶部操作栏 -->
  <div class="edit-topbar">
    <a href="/admin" class="tb-back">← 后台</a>
    <div class="tb-divider"></div>
    <input type="text" id="inp-title" placeholder="文章标题（必填）" value="${escHtml(pTitle)}">
    <input type="text" id="inp-tags" placeholder="标签，逗号分隔" value="${escHtml(pTags)}">
    <label class="pub-wrap" title="发布后前台可见">
      <span class="toggle">
        <input type="checkbox" id="chk-pub" ${pPublished ? "checked" : ""}>
        <span class="toggle-slider"></span>
      </span>
      <span id="pub-lbl">${pPublished ? "已发布" : "草稿"}</span>
    </label>
    <div class="tb-divider"></div>
    <span id="save-msg"></span>
    <button class="save-btn" id="save-btn" onclick="savePost()">💾 保存</button>
  </div>

  <!-- 编辑 + 预览 -->
  <div class="edit-body">
    <!-- 左：编辑器 -->
    <div class="editor-panel">
      <div class="md-toolbar">
        <div class="tb-group">
          <button class="tb" onclick="wrapSel('**','**')" title="粗体 Ctrl+B"><b>B</b></button>
          <button class="tb" onclick="wrapSel('*','*')" title="斜体 Ctrl+I"><i>I</i></button>
          <button class="tb" onclick="wrapSel('~~','~~')" title="删除线"><s>S</s></button>
          <button class="tb" onclick="wrapSel('\`','\`')" title="行内代码">\`\`</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group">
          <button class="tb" onclick="linePrefix('# ')" title="标题 H1">H1</button>
          <button class="tb" onclick="linePrefix('## ')" title="标题 H2">H2</button>
          <button class="tb" onclick="linePrefix('### ')" title="标题 H3">H3</button>
          <button class="tb" onclick="linePrefix('#### ')" title="标题 H4">H4</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group">
          <button class="tb" onclick="linePrefix('> ')" title="引用块">❝</button>
          <button class="tb" onclick="linePrefix('- ')" title="无序列表">•</button>
          <button class="tb" onclick="linePrefix('1. ')" title="有序列表">1.</button>
          <button class="tb" onclick="insertHr()" title="分隔线">—</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group">
          <button class="tb" onclick="insertCodeBlock()" title="代码块">&lt;/&gt;</button>
          <button class="tb" onclick="insertTable()" title="插入表格">⊞</button>
          <button class="tb" onclick="insertLink()" title="插入链接">🔗</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group">
          <button class="tb" onclick="triggerImg()" title="上传图片（支持拖拽）">🖼</button>
          <button class="tb" onclick="triggerFile()" title="上传附件">📎</button>
        </div>
        <input type="file" id="img-picker" accept="image/*" style="display:none" multiple>
        <input type="file" id="file-picker" style="display:none" multiple>
        <span class="word-count" id="word-count">0 字</span>
      </div>

      <textarea id="md-area" placeholder="在这里用 Markdown 写作…&#10;&#10;支持拖拽图片上传、Ctrl+S 保存、Tab 缩进">${escHtml(pContent)}</textarea>

      <div class="attach-bar">
        <span class="attach-bar-lbl">附件：</span>
        <div id="atch-list">${attachHtml}</div>
      </div>
    </div>

    <!-- 右：实时预览 -->
    <div class="preview-panel">
      <div class="preview-hd">PREVIEW · 实时预览</div>
      <div class="markdown-body" id="preview"></div>
    </div>
  </div>
</div>

<!-- 拖拽上传覆盖层 -->
<div class="drop-overlay" id="drop-overlay">📎 松开鼠标上传文件</div>

<script>
// 注入客户端渲染函数（从服务端函数体直接提取，无转义问题）
(${renderMdClientFn.toString()})();


let curId = ${JSON.stringify(pId)};
const ta = document.getElementById('md-area');
const pv = document.getElementById('preview');
let renderTimer = null;

function render() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    pv.innerHTML = renderMdClient(ta.value || '');
    const wc = ta.value.replace(/\\s/g, '').length;
    document.getElementById('word-count').textContent = wc + ' 字';
  }, 80);
}
ta.addEventListener('input', render);
render();

// 发布开关更新文字
document.getElementById('chk-pub').addEventListener('change', function() {
  document.getElementById('pub-lbl').textContent = this.checked ? '已发布' : '草稿';
});

// ── 工具栏操作 ──
function wrapSel(b, a) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || '文字';
  ta.setRangeText(b + sel + a, s, e, 'select');
  ta.focus(); render();
}
function linePrefix(p) {
  const s = ta.selectionStart;
  const ls = ta.value.lastIndexOf('\\n', s - 1) + 1;
  const lineEnd = ta.value.indexOf('\\n', s);
  const end = lineEnd === -1 ? ta.value.length : lineEnd;
  const cur = ta.value.slice(ls, end);
  if (cur.startsWith(p)) ta.setRangeText(cur.slice(p.length), ls, end, 'end');
  else ta.setRangeText(p + cur, ls, end, 'end');
  ta.focus(); render();
}
function insertCodeBlock() {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  const lang = sel ? '' : 'js';
  ta.setRangeText('\\n\`\`\`' + lang + '\\n' + (sel || '// code here') + '\\n\`\`\`\\n', s, e, 'end');
  ta.focus(); render();
}
function insertTable() {
  const tbl = '\\n| 列1 | 列2 | 列3 |\\n| :-- | :--: | --: |\\n| 左对齐 | 居中 | 右对齐 |\\n';
  const s = ta.selectionStart;
  ta.setRangeText(tbl, s, s, 'end');
  ta.focus(); render();
}
function insertHr() {
  const s = ta.selectionStart;
  ta.setRangeText('\\n\\n---\\n\\n', s, s, 'end');
  ta.focus(); render();
}
function insertLink() {
  const u = prompt('链接地址（URL）：');
  if (!u) return;
  const t = prompt('链接文字：', '链接') || '链接';
  const s = ta.selectionStart;
  ta.setRangeText('[' + t + '](' + u + ')', s, s, 'end');
  ta.focus(); render();
}
function triggerImg() { document.getElementById('img-picker').click(); }
function triggerFile() { document.getElementById('file-picker').click(); }

// ── 文件上传 ──
document.getElementById('img-picker').addEventListener('change', async e => {
  for (const f of e.target.files) await uploadFile(f, f.type.startsWith('image/'));
  e.target.value = '';
});
document.getElementById('file-picker').addEventListener('change', async e => {
  for (const f of e.target.files) await uploadFile(f, false);
  e.target.value = '';
});

// 拖拽上传
const dropOverlay = document.getElementById('drop-overlay');
let dragCnt = 0;
document.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragCnt++; dropOverlay.classList.add('active'); } });
document.addEventListener('dragleave', () => { dragCnt--; if (dragCnt <= 0) { dragCnt = 0; dropOverlay.classList.remove('active'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  dragCnt = 0;
  dropOverlay.classList.remove('active');
  const files = [...e.dataTransfer.files];
  for (const f of files) await uploadFile(f, f.type.startsWith('image/'));
});

async function uploadFile(file, isImg) {
  if (!curId) {
    const saved = await doSave(false);
    if (!saved) return;
  }
  showMsg('上传中…', 'loading');
  // 截图粘贴时文件名均为 image.png，随机化避免覆盖
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
  const baseName = file.name.slice(0, file.name.length - ext.length);
  const uniqueName = baseName + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5) + ext;
  const renamedFile = new File([file], uniqueName, { type: file.type });
  const fd = new FormData();
  fd.append('file', renamedFile);
  let res;
  try {
    res = await fetch('/admin/upload?postId=' + curId, { method: 'POST', body: fd });
  } catch(err) {
    showMsg('网络错误', 'err'); return;
  }
  const d = await res.json();
  if (!d.success) { showMsg('上传失败：' + d.error, 'err'); return; }

  const fname = renamedFile.name;
  const s = ta.selectionStart;
  const md = isImg
    ? '![' + fname + '](' + d.url + ')'
    : '[' + fname + '](' + d.url + ')';
  ta.setRangeText(md, s, s, 'end');
  ta.focus(); render();

  // 添加到附件栏（用唯一文件名作 id，不会再重复）
  const safeId = 'atch-' + fname.replace(/[^a-z0-9]/gi, '_');
  if (!document.getElementById(safeId)) {
    const div = document.createElement('div');
    div.className = 'atch-item';
    div.id = safeId;
    div.innerHTML = '<a href="' + d.url + '" target="_blank" title="' + fname + '">📎 ' + fname + '</a>' +
      '<button class="atch-del" onclick="delAttach(' + JSON.stringify(curId) + ',' + JSON.stringify(fname) + ')">×</button>';
    document.getElementById('atch-list').appendChild(div);
  }
  showMsg('上传成功 ✓', 'ok');
}

async function delAttach(postId, filename) {
  if (!confirm('确认删除附件 "' + filename + '"？')) return;
  const res = await fetch('/admin/attach-delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postId, filename })
  });
  const d = await res.json();
  if (d.success) {
    const safeId = 'atch-' + filename.replace(/[^a-z0-9]/gi, '_');
    const el = document.getElementById(safeId);
    if (el) el.remove();
  } else {
    alert('删除失败：' + d.error);
  }
}

// ── 保存 ──
async function savePost() { await doSave(true); }

async function doSave(notify) {
  const title = document.getElementById('inp-title').value.trim();
  const content = ta.value;
  if (!title) { showMsg('标题不能为空', 'err'); document.getElementById('inp-title').focus(); return null; }
  if (!content.trim()) { showMsg('内容不能为空', 'err'); return null; }

  const tags = document.getElementById('inp-tags').value
    .split(',').map(t => t.trim()).filter(Boolean);
  const published = document.getElementById('chk-pub').checked;
  const body = { title, content, tags, published };
  if (curId) body.id = curId;

  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.innerHTML = '保存中…';
  showMsg('保存中…', 'loading');

  let res, d;
  try {
    res = await fetch('/admin/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    d = await res.json();
  } catch(err) {
    btn.disabled = false; btn.innerHTML = '💾 保存';
    showMsg('网络错误', 'err');
    return null;
  }

  btn.disabled = false; btn.innerHTML = '💾 保存';
  if (d.success) {
    curId = d.id;
    history.replaceState({}, '', '/admin/edit?id=' + curId);
    if (notify) showMsg('已保存 ✓', 'ok');
    return d.id;
  } else {
    if (notify) showMsg(d.error || '保存失败', 'err');
    return null;
  }
}

function showMsg(t, type) {
  const el = document.getElementById('save-msg');
  el.className = type === 'ok' ? 'msg-ok' : type === 'err' ? 'msg-err' : type === 'loading' ? 'msg-loading' : '';
  el.textContent = t;
  if (type === 'ok') setTimeout(() => { el.textContent = ''; el.className = ''; }, 2500);
}

// 预览区复制代码
function pvCopy(btn) {
  const code = btn.parentElement.querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '已复制 ✓';
    setTimeout(() => btn.textContent = '复制', 1800);
  });
}

// ── 快捷键 ──
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); savePost(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); wrapSel('**','**'); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); wrapSel('*','*'); }
});

// Tab 缩进 / Shift+Tab 反缩进
ta.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s === end) {
      ta.setRangeText('  ', s, s, 'end');
    } else {
      // 多行缩进
      const lines = ta.value.slice(s, end).split('\\n');
      const indented = e.shiftKey
        ? lines.map(l => l.startsWith('  ') ? l.slice(2) : l)
        : lines.map(l => '  ' + l);
      ta.setRangeText(indented.join('\\n'), s, end, 'select');
    }
    render();
  }
  // Enter 自动继续列表
  if (e.key === 'Enter') {
    const s = ta.selectionStart;
    const ls = ta.value.lastIndexOf('\\n', s - 1) + 1;
    const line = ta.value.slice(ls, s);
    const m = line.match(/^(\\s*)([-*+]|\\d+\\.) /);
    if (m) {
      e.preventDefault();
      ta.setRangeText('\\n' + m[1] + m[2].replace(/\\d+/, n => parseInt(n) + 1) + ' ', s, s, 'end');
      render();
    }
  }
});

// 粘贴图片（全局监听，任意位置粘贴均可上传）
document.addEventListener('paste', async e => {
  const items = [...(e.clipboardData?.items || [])];
  const imgItems = items.filter(i => i.type.startsWith('image/'));
  if (imgItems.length === 0) return;
  e.preventDefault();
  // 必须在任何 await 之前同步取出所有 File，否则 DataTransferItemList 异步后失效
  const files = imgItems.map(i => i.getAsFile()).filter(Boolean);
  for (const file of files) await uploadFile(file, true);
});

// 粘贴提示
(function() {
  const hint = document.createElement('div');
  hint.id = 'paste-hint';
  hint.textContent = '📋 Ctrl+V 粘贴图片可直接上传';
  hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(8px);' +
    'background:rgba(92,107,192,0.92);color:#fff;padding:7px 18px;border-radius:20px;' +
    'font-size:13px;pointer-events:none;opacity:0;transition:opacity .3s,transform .3s;z-index:600;white-space:nowrap;';
  document.body.appendChild(hint);

  let hintTimer = null;
  function showPasteHint() {
    clearTimeout(hintTimer);
    hint.style.opacity = '1';
    hint.style.transform = 'translateX(-50%) translateY(0)';
    hintTimer = setTimeout(() => {
      hint.style.opacity = '0';
      hint.style.transform = 'translateX(-50%) translateY(8px)';
    }, 2500);
  }

  // 检测到剪贴板中有图片时显示提示
  document.addEventListener('copy', () => showPasteHint());

  // 截图后（clipboardchange 不通用，用 focus 轮询方式）
  window.addEventListener('focus', async () => {
    try {
      const clipItems = await navigator.clipboard.read().catch(() => null);
      if (!clipItems) return;
      for (const ci of clipItems) {
        if (ci.types.some(t => t.startsWith('image/'))) { showPasteHint(); break; }
      }
    } catch(e) { /* 权限不足时静默忽略 */ }
  });
})();
</script>
<style>
.preview-copy{position:absolute;top:8px;right:10px;padding:3px 10px;
  background:rgba(240,240,240,.9);border:1px solid #ddd;border-radius:5px;
  font-size:12px;cursor:pointer;opacity:.7;transition:opacity .15s;z-index:1}
.preview-copy:hover{opacity:1}
</style>
</body></html>`);
}

// ── 公共样式 & 顶栏 ──────────────────────────────────────────

function baseStyle() {
  return `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f0f2f9;font-family:'Segoe UI',Arial,sans-serif;color:#333;line-height:1.6}
.wrap{width:90%;max-width:1400px;margin:0 auto;padding:28px 20px}
.topbar{background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.08);position:sticky;top:0;z-index:100}
.topbar-inner{width:90%;max-width:1400px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:14px}
.site-logo{font-size:19px;font-weight:700;color:#5c6bc0;text-decoration:none;display:flex;align-items:center;gap:6px}
.site-logo:hover{opacity:.85}
.topbar-nav{margin-left:auto;display:flex;align-items:center;gap:14px}
.topbar-nav a{color:#777;text-decoration:none;font-size:14px;transition:color .15s}
.topbar-nav a:hover{color:#5c6bc0}
.topbar-nav .active{color:#5c6bc0;font-weight:600}
.logout-btn{padding:6px 14px;border:1.5px solid #ddd;background:#fff;border-radius:7px;font-size:13px;color:#888;cursor:pointer;transition:border-color .15s}
.logout-btn:hover{border-color:#e53935;color:#e53935}
</style>`;
}

function topBar(isAdmin) {
  if (isAdmin) {
    return `<header class="topbar">
  <div class="topbar-inner">
    <a href="/" class="site-logo">📝 日志博客</a>
    <nav class="topbar-nav">
      <a href="/" target="_blank">前台</a>
      <a href="/admin" class="active">后台管理</a>
      <a href="/admin/edit">写文章</a>
      <form method="POST" action="/admin/logout" style="margin:0">
        <button type="submit" class="logout-btn">退出登录</button>
      </form>
    </nav>
  </div>
</header>`;
  }
  return `<header class="topbar">
  <div class="topbar-inner">
    <a href="/" class="site-logo">📝 日志博客</a>
    <nav class="topbar-nav">
      <a href="/">首页</a>
      <a href="/admin/login">后台</a>
    </nav>
  </div>
</header>`;
}
