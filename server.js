const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = "mongodb+srv://fultulisupport_db_user:OwG92LJplK6l4cAD@entry-fultuli.ohp3ond.mongodb.net/milow?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

const bbySchema = new mongoose.Schema({
  question: { type: String, required: true, unique: true },
  answer: { type: String, required: true },
  teacher: { type: String, default: "Unknown" },
  importedAt: { type: Date, default: Date.now }
});

const BbyData = mongoose.model('BbyData', bbySchema);

let isImporting = false;
let importProgress = { total: 0, current: 0, imported: 0, skipped: 0, status: "idle", errorMsg: "" };

function toSafeString(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === 'object') return "";
    return String(val).trim();
}

function isValidReply(question, answer) {
    if (question === null || question === undefined) return false;
    if (answer === null || answer === undefined) return false;
    if (typeof question === 'object' || typeof answer === 'object') return false;

    const q = String(question).trim();
    const a = String(answer).trim();

    if (q.length < 4) return false;
    if (a.length === 0) return false;

    const numberRegex = /[0-9]/;
    if (numberRegex.test(q)) return false;

    return true;
}

// ---------- IMPORT ----------
app.post('/api/import-bby', async (req, res) => {
    if (isImporting) {
        return res.status(400).json({ error: "ইমপোর্ট ইতিমধ্যে চলছে, অপেক্ষা করুন..." });
    }

    isImporting = true;
    importProgress = { total: 0, current: 0, imported: 0, skipped: 0, status: "running", errorMsg: "" };
    res.status(200).json({ message: "ইমপোর্ট শুরু হয়েছে..." });

    try {
        const apiUrl = "https://noobs-api.top/dipto/baby?list=all";
        const response = await axios.get(apiUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const data = response.data;
        if (!data) throw new Error("API থেকে কোনো ডেটা পাওয়া যায়নি।");

        let teacherList = [];
        if (data.teacher && Array.isArray(data.teacher.teacherList)) {
            teacherList = data.teacher.teacherList;
        } else if (Array.isArray(data)) {
            teacherList = data;
        } else {
            throw new Error("API ডেটা ফরম্যাট অপ্রত্যাশিত।");
        }

        importProgress.total = teacherList.length;
        const teacherName = (data.teacher && data.teacher.name) ? data.teacher.name : "Unknown";

        for (let item of teacherList) {
            importProgress.current++;

            let question = "";
            let answer = "";

            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                const keys = Object.keys(item);
                if (keys.length > 0) {
                    question = keys[0];
                    const rawAnswer = item[question];
                    if (rawAnswer === null || rawAnswer === undefined || typeof rawAnswer === 'object') {
                        importProgress.skipped++;
                        continue;
                    }
                    answer = String(rawAnswer);
                }
            } else {
                importProgress.skipped++;
                continue;
            }

            if (!isValidReply(question, answer)) {
                importProgress.skipped++;
                continue;
            }

            const qTrim = String(question).trim();
            const aTrim = String(answer).trim();

            const exists = await BbyData.findOne({ question: qTrim });
            if (!exists) {
                try {
                    await new BbyData({ question: qTrim, answer: aTrim, teacher: teacherName }).save();
                    importProgress.imported++;
                } catch (e) {
                    importProgress.skipped++;
                }
            } else {
                importProgress.skipped++;
            }
        }
        importProgress.status = "completed";
    } catch (error) {
        console.error("Import Error:", error.message);
        importProgress.status = "error";
        importProgress.errorMsg = error.message || "Unknown Error";
    } finally {
        isImporting = false;
        setTimeout(() => { importProgress = { total: 0, current: 0, imported: 0, skipped: 0, status: "idle", errorMsg: "" }; }, 30000);
    }
});

app.get('/api/import-status', (req, res) => {
    res.status(200).json(importProgress);
});

// ---------- READ ----------
app.get('/api/bby-data', async (req, res) => {
    try {
        const allData = await BbyData.find().sort({ importedAt: -1 });
        res.status(200).json({ data: allData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------- STATS ----------
app.get('/api/stats', async (req, res) => {
    try {
        const total = await BbyData.countDocuments();
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const today = await BbyData.countDocuments({ importedAt: { $gte: startOfDay } });
        const teachers = await BbyData.distinct('teacher');
        res.json({ total, today, teachers: teachers.filter(t => t && t !== 'Unknown') });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- UPDATE ----------
app.put('/api/bby-data/:id', async (req, res) => {
    try {
        const { question, answer, teacher } = req.body;
        if (!question || !answer) return res.status(400).json({ error: "Question and Answer required" });

        const updated = await BbyData.findByIdAndUpdate(
            req.params.id,
            { question: String(question).trim(), answer: String(answer).trim(), teacher: teacher || "Unknown" },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json({ data: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- DELETE (single + bulk) ----------
app.delete('/api/bby-data/:id', async (req, res) => {
    try {
        await BbyData.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bby-data/bulk-delete', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "No ids" });
        const result = await BbyData.deleteMany({ _id: { $in: ids } });
        res.json({ deleted: result.deletedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- DASHBOARD ----------
app.get('/', (req, res) => {
  res.send([
'<!DOCTYPE html>',
'<html lang="bn">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>Bby API Dashboard</title>',
'<style>',
':root{--bg:#f0f2f5;--card:#fff;--text:#333;--muted:#666;--border:#ddd;--primary:#1a73e8;--primary-dark:#1557b0;--soft:#e8f0fe;--danger:#dc3545;--success:#28a745;}',
'body.dark{--bg:#121212;--card:#1e1e1e;--text:#e0e0e0;--muted:#999;--border:#333;--soft:#1a2a44;}',
'*{box-sizing:border-box;}',
'body{font-family:"Segoe UI",Tahoma,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:16px;transition:0.3s;}',
'.container{max-width:1000px;margin:auto;}',
'.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px;}',
'h1{color:var(--primary);margin:0;font-size:24px;}',
'.top-actions{display:flex;gap:8px;flex-wrap:wrap;}',
'.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;}',
'.stat-card{background:var(--card);border-radius:10px;padding:16px;border:1px solid var(--border);text-align:center;}',
'.stat-num{font-size:28px;font-weight:bold;color:var(--primary);}',
'.stat-label{font-size:13px;color:var(--muted);margin-top:4px;}',
'.card{background:var(--card);padding:20px;border-radius:10px;border:1px solid var(--border);margin-bottom:20px;}',
'.import-section{background:var(--soft);border:1px dashed var(--primary);text-align:center;}',
'.import-section h2{margin-top:0;color:var(--primary);font-size:18px;}',
'button{background:var(--primary);color:white;padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;transition:0.2s;}',
'button:hover{background:var(--primary-dark);}',
'button:disabled{background:#999;cursor:not-allowed;}',
'.btn-sm{padding:6px 12px;font-size:12px;}',
'.btn-danger{background:var(--danger);}',
'.btn-danger:hover{background:#c82333;}',
'.btn-success{background:var(--success);}',
'.btn-success:hover{background:#218838;}',
'.btn-ghost{background:transparent;color:var(--text);border:1px solid var(--border);}',
'.btn-ghost:hover{background:var(--soft);}',
'.status-box{margin-top:12px;font-weight:bold;color:var(--primary);font-size:14px;min-height:20px;}',
'.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;}',
'.toolbar input,.toolbar select{flex:1;min-width:150px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font-size:14px;}',
'.progress-bar{height:8px;background:var(--border);border-radius:4px;overflow:hidden;margin-top:10px;}',
'.progress-fill{height:100%;background:var(--primary);width:0%;transition:0.3s;}',
'.data-list{list-style:none;padding:0;margin:0;}',
'.data-item{background:var(--card);border:1px solid var(--border);padding:14px;margin-bottom:10px;border-radius:8px;transition:0.2s;}',
'.data-item:hover{border-color:var(--primary);}',
'.data-item.selected{border-color:var(--primary);background:var(--soft);}',
'.item-header{display:flex;justify-content:space-between;align-items:start;gap:10px;}',
'.item-body{flex:1;min-width:0;}',
'.question{font-weight:bold;color:var(--text);font-size:15px;margin-bottom:6px;word-break:break-word;}',
'.answer{color:var(--muted);font-size:13px;word-break:break-word;}',
'.badge{display:inline-block;background:var(--soft);color:var(--primary);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;font-weight:bold;}',
'.item-actions{display:flex;gap:6px;flex-shrink:0;}',
'.checkbox{width:18px;height:18px;cursor:pointer;margin-right:10px;flex-shrink:0;margin-top:2px;}',
'.empty{text-align:center;color:var(--muted);padding:30px;}',
'.pagination{display:flex;justify-content:center;gap:6px;margin-top:16px;flex-wrap:wrap;}',
'.pagination button{padding:8px 14px;font-size:13px;}',
'.toast{position:fixed;bottom:20px;right:20px;background:var(--success);color:white;padding:12px 20px;border-radius:8px;opacity:0;transition:0.3s;pointer-events:none;z-index:1000;}',
'.toast.show{opacity:1;}',
'.toast.error{background:var(--danger);}',
'@media(max-width:600px){.item-header{flex-direction:column;}.item-actions{width:100%;}.item-actions button{flex:1;}}',
'</style>',
'</head>',
'<body>',
'<div class="container">',
'  <div class="header">',
'    <h1>🤖 Bby Dashboard</h1>',
'    <div class="top-actions">',
'      <button class="btn-ghost btn-sm" onclick="toggleTheme()">🌓 Theme</button>',
'      <button class="btn-ghost btn-sm" onclick="exportJSON()">⬇️ Export</button>',
'    </div>',
'  </div>',
'',
'  <div class="stats">',
'    <div class="stat-card"><div class="stat-num" id="statTotal">-</div><div class="stat-label">Total Entries</div></div>',
'    <div class="stat-card"><div class="stat-num" id="statToday">-</div><div class="stat-label">Added Today</div></div>',
'    <div class="stat-card"><div class="stat-num" id="statTeachers">-</div><div class="stat-label">Teachers</div></div>',
'  </div>',
'',
'  <div class="card import-section">',
'    <h2>📥 Import Data</h2>',
'    <p style="font-size:13px;color:var(--muted);">৪ অক্ষরের বেশি এবং সংখ্যাবিহীন রিপ্লাই সেভ হবে।</p>',
'    <button id="importBtn" onclick="startImport()">Import Now</button>',
'    <div id="statusMessage" class="status-box"></div>',
'    <div class="progress-bar" id="progressWrap" style="display:none;"><div class="progress-fill" id="progressFill"></div></div>',
'  </div>',
'',
'  <div class="card">',
'    <div class="toolbar">',
'      <input type="text" id="searchInput" placeholder="🔍 Search question / answer..." oninput="applyFilters()">',
'      <select id="teacherFilter" onchange="applyFilters()"><option value="">👨‍🏫 All Teachers</option></select>',
'      <button class="btn-danger btn-sm" id="bulkDelBtn" onclick="bulkDelete()" style="display:none;">🗑️ Delete Selected</button>',
'    </div>',
'    <ul id="dataList" class="data-list"><li class="empty">Loading...</li></ul>',
'    <div class="pagination" id="pagination"></div>',
'  </div>',
'</div>',
'',
'<div class="toast" id="toast"></div>',
'',
'<script>',
'const API_BASE = "/api";',
'let allData = [];',
'let filteredData = [];',
'let currentPage = 1;',
'const PAGE_SIZE = 20;',
'let statusInterval = null;',
'let selectedIds = new Set();',
'',
'function escapeHtml(str){',
'  if(str===null||str===undefined)return "";',
'  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\x27/g,"&#39;");',
'}',
'',
'function toast(msg, isError){',
'  const t = document.getElementById("toast");',
'  t.textContent = msg;',
'  t.className = "toast show" + (isError ? " error" : "");',
'  setTimeout(()=>{t.className="toast";},2500);',
'}',
'',
'function toggleTheme(){',
'  document.body.classList.toggle("dark");',
'  localStorage.setItem("theme", document.body.classList.contains("dark") ? "dark" : "light");',
'}',
'',
'async function fetchData(){',
'  try{',
'    const r = await fetch(API_BASE+"/bby-data");',
'    const j = await r.json();',
'    allData = j.data || [];',
'    applyFilters();',
'  }catch(e){',
'    document.getElementById("dataList").innerHTML = \x27<li class="empty">Failed to load!</li>\x27;',
'  }',
'}',
'',
'async function fetchStats(){',
'  try{',
'    const r = await fetch(API_BASE+"/stats");',
'    const s = await r.json();',
'    document.getElementById("statTotal").textContent = s.total;',
'    document.getElementById("statToday").textContent = s.today;',
'    document.getElementById("statTeachers").textContent = (s.teachers||[]).length;',
'    const sel = document.getElementById("teacherFilter");',
'    const cur = sel.value;',
'    sel.innerHTML = \x27<option value="">👨‍🏫 All Teachers</option>\x27 + (s.teachers||[]).map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");',
'    sel.value = cur;',
'  }catch(e){ console.error(e); }',
'}',
'',
'function applyFilters(){',
'  const q = document.getElementById("searchInput").value.toLowerCase().trim();',
'  const teacher = document.getElementById("teacherFilter").value;',
'  filteredData = allData.filter(item=>{',
'    const matchQ = !q || String(item.question).toLowerCase().includes(q) || String(item.answer).toLowerCase().includes(q);',
'    const matchT = !teacher || item.teacher === teacher;',
'    return matchQ && matchT;',
'  });',
'  currentPage = 1;',
'  renderPage();',
'}',
'',
'function renderPage(){',
'  const list = document.getElementById("dataList");',
'  list.innerHTML = "";',
'  if(filteredData.length === 0){',
'    list.innerHTML = \x27<li class="empty">No data found.</li>\x27;',
'    document.getElementById("pagination").innerHTML = "";',
'    return;',
'  }',
'  const start = (currentPage-1)*PAGE_SIZE;',
'  const pageItems = filteredData.slice(start, start+PAGE_SIZE);',
'  pageItems.forEach(item=>{',
'    const li = document.createElement("li");',
'    li.className = "data-item" + (selectedIds.has(item._id) ? " selected" : "");',
'    li.innerHTML = `',
'      <div class="item-header">',
'        <input type="checkbox" class="checkbox" ${selectedIds.has(item._id)?"checked":""} onchange="toggleSelect(\x27${item._id}\x27)">',
'        <div class="item-body">',
'          <div class="question">Q: ${escapeHtml(item.question)} <span class="badge">👨‍🏫 ${escapeHtml(item.teacher)}</span></div>',
'          <div class="answer">A: ${escapeHtml(item.answer)}</div>',
'        </div>',
'        <div class="item-actions">',
'          <button class="btn-sm btn-ghost" onclick="editItem(\x27${item._id}\x27)">✏️</button>',
'          <button class="btn-sm btn-danger" onclick="deleteItem(\x27${item._id}\x27)">🗑️</button>',
'        </div>',
'      </div>`;',
'    list.appendChild(li);',
'  });',
'  renderPagination();',
'  updateBulkBtn();',
'}',
'',
'function renderPagination(){',
'  const total = Math.ceil(filteredData.length/PAGE_SIZE);',
'  const pg = document.getElementById("pagination");',
'  pg.innerHTML = "";',
'  if(total <= 1) return;',
'  if(currentPage > 1){',
'    const b = document.createElement("button");',
'    b.textContent = "← Prev";',
'    b.className = "btn-ghost btn-sm";',
'    b.onclick = ()=>{currentPage--; renderPage(); window.scrollTo({top:0,behavior:"smooth"});};',
'    pg.appendChild(b);',
'  }',
'  const info = document.createElement("span");',
'  info.textContent = ` Page ${currentPage} / ${total} `;',
'  info.style.padding = "8px";',
'  pg.appendChild(info);',
'  if(currentPage < total){',
'    const b = document.createElement("button");',
'    b.textContent = "Next →";',
'    b.className = "btn-ghost btn-sm";',
'    b.onclick = ()=>{currentPage++; renderPage(); window.scrollTo({top:0,behavior:"smooth"});};',
'    pg.appendChild(b);',
'  }',
'}',
'',
'function toggleSelect(id){',
'  if(selectedIds.has(id)) selectedIds.delete(id);',
'  else selectedIds.add(id);',
'  renderPage();',
'}',
'',
'function updateBulkBtn(){',
'  const btn = document.getElementById("bulkDelBtn");',
'  if(selectedIds.size > 0){',
'    btn.style.display = "inline-block";',
'    btn.textContent = `🗑️ Delete Selected (${selectedIds.size})`;',
'  } else {',
'    btn.style.display = "none";',
'  }',
'}',
'',
'async function bulkDelete(){',
'  if(!confirm(`Delete ${selectedIds.size} item(s)?`)) return;',
'  try{',
'    await fetch(API_BASE+"/bby-data/bulk-delete", {',
'      method:"POST", headers:{"Content-Type":"application/json"},',
'      body: JSON.stringify({ids: Array.from(selectedIds)})',
'    });',
'    toast("Deleted successfully");',
'    selectedIds.clear();',
'    await fetchData(); await fetchStats();',
'  }catch(e){ toast("Delete failed", true); }',
'}',
'',
'async function deleteItem(id){',
'  if(!confirm("Delete this item?")) return;',
'  try{',
'    await fetch(API_BASE+"/bby-data/"+id, {method:"DELETE"});',
'    toast("Deleted");',
'    await fetchData(); await fetchStats();',
'  }catch(e){ toast("Delete failed", true); }',
'}',
'',
'async function editItem(id){',
'  const item = allData.find(x=>x._id===id);',
'  if(!item) return;',
'  const q = prompt("Question:", item.question);',
'  if(q === null) return;',
'  const a = prompt("Answer:", item.answer);',
'  if(a === null) return;',
'  try{',
'    await fetch(API_BASE+"/bby-data/"+id, {',
'      method:"PUT", headers:{"Content-Type":"application/json"},',
'      body: JSON.stringify({question:q, answer:a, teacher: item.teacher})',
'    });',
'    toast("Updated");',
'    await fetchData();',
'  }catch(e){ toast("Update failed", true); }',
'}',
'',
'async function startImport(){',
'  const btn = document.getElementById("importBtn");',
'  btn.disabled = true; btn.textContent = "Starting...";',
'  try{',
'    const r = await fetch(API_BASE+"/import-bby", {method:"POST"});',
'    const j = await r.json();',
'    if(r.ok){',
'      if(statusInterval) clearInterval(statusInterval);',
'      statusInterval = setInterval(checkStatus, 1000);',
'      checkStatus();',
'    } else {',
'      document.getElementById("statusMessage").style.color = "red";',
'      document.getElementById("statusMessage").textContent = j.error;',
'      btn.disabled = false; btn.textContent = "Import Now";',
'    }',
'  }catch(e){',
'    document.getElementById("statusMessage").style.color = "red";',
'    document.getElementById("statusMessage").textContent = "Server error!";',
'    btn.disabled = false; btn.textContent = "Import Now";',
'  }',
'}',
'',
'async function checkStatus(){',
'  try{',
'    const r = await fetch(API_BASE+"/import-status");',
'    const s = await r.json();',
'    const msg = document.getElementById("statusMessage");',
'    const btn = document.getElementById("importBtn");',
'    const pw = document.getElementById("progressWrap");',
'    const pf = document.getElementById("progressFill");',
'    if(s.status === "running"){',
'      msg.style.color = "var(--primary)";',
'      msg.textContent = `⏳ Importing... ${s.current}/${s.total} | Saved: ${s.imported} | Skipped: ${s.skipped}`;',
'      pw.style.display = "block";',
'      pf.style.width = s.total > 0 ? ((s.current/s.total)*100) + "%" : "0%";',
'      btn.disabled = true; btn.textContent = "Importing...";',
'    } else if(s.status === "completed"){',
'      msg.style.color = "var(--success)";',
'      msg.textContent = `✅ Done! Saved: ${s.imported} | Skipped: ${s.skipped}`;',
'      pw.style.display = "none";',
'      btn.disabled = false; btn.textContent = "Import Now";',
'      clearInterval(statusInterval);',
'      fetchData(); fetchStats();',
'      toast("Import complete!");',
'    } else if(s.status === "error"){',
'      msg.style.color = "var(--danger)";',
'      msg.textContent = "❌ Import failed: " + s.errorMsg;',
'      pw.style.display = "none";',
'      btn.disabled = false; btn.textContent = "Import Now";',
'      clearInterval(statusInterval);',
'    }',
'  }catch(e){ console.error(e); }',
'}',
'',
'function exportJSON(){',
'  const blob = new Blob([JSON.stringify(allData, null, 2)], {type:"application/json"});',
'  const url = URL.createObjectURL(blob);',
'  const a = document.createElement("a");',
'  a.href = url; a.download = "bby-data-" + Date.now() + ".json";',
'  a.click(); URL.revokeObjectURL(url);',
'  toast("Exported!");',
'}',
'',
'window.onload = ()=>{',
'  if(localStorage.getItem("theme") === "dark") document.body.classList.add("dark");',
'  fetchData(); fetchStats();',
'  fetch(API_BASE+"/import-status").then(r=>r.json()).then(s=>{',
'    if(s.status === "running"){',
'      if(statusInterval) clearInterval(statusInterval);',
'      statusInterval = setInterval(checkStatus, 1000);',
'      checkStatus();',
'    }',
'  }).catch(()=>{});',
'};',
'</script>',
'</body>',
'</html>'
  ].join('\n'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
