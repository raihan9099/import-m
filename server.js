const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const MONGO_URI = "mongodb+srv://fultulisupport_db_user:OwG92LJplK6l4cAD@entry-fultuli.ohp3ond.mongodb.net/milow?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err.message));

const bbySchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  teacher: { type: String, default: "Unknown" },
  source: { type: String, default: "bulk" },
  importedAt: { type: Date, default: Date.now }
});

bbySchema.index({ question: 1, answer: 1 }, { unique: true });
bbySchema.index({ question: 1 });

const BbyData = mongoose.model('BbyData', bbySchema);

const DIPTO_API = "https://noobs-api.top/dipto/baby";

// ---------- helper ----------
function normalizeQ(q) {
    return String(q || "").trim().toLowerCase();
}

async function fetchReplyFromDipto(question) {
    try {
        const url = `${DIPTO_API}?text=${encodeURIComponent(question)}&font=0`;
        const r = await axios.get(url, {
            timeout: 12000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const reply = r.data && r.data.reply;
        if (!reply || typeof reply !== 'string') return null;
        return reply.trim();
    } catch (e) {
        return null;
    }
}

// ---------- BULK FETCH (ওয়েবসাইট থেকে প্রশ্নের লিস্ট দিয়ে) ----------
let bulkState = { running: false, total: 0, done: 0, saved: 0, skipped: 0, failed: 0, status: "idle", errorMsg: "", lastQuestion: "" };

app.post('/api/bulk-fetch', async (req, res) => {
    if (bulkState.running) {
        return res.status(400).json({ error: "Bulk fetch ইতিমধ্যে চলছে, অপেক্ষা করুন..." });
    }

    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "questions অ্যারে দরকার" });
    }

    // ডুপ্লিকেট বাদ + ৪ অক্ষরের কম বাদ
    const cleaned = [];
    const seen = new Set();
    for (const q of questions) {
        const nq = normalizeQ(q);
        if (nq.length < 4) continue;
        if (seen.has(nq)) continue;
        seen.add(nq);
        cleaned.push(nq);
    }

    if (cleaned.length === 0) {
        return res.status(400).json({ error: "কোনো বৈধ প্রশ্ন নেই (সব ৪ অক্ষরের কম বা ডুপ্লিকেট)" });
    }

    bulkState = { running: true, total: cleaned.length, done: 0, saved: 0, skipped: 0, failed: 0, status: "running", errorMsg: "", lastQuestion: "" };
    res.json({ message: "Bulk fetch শুরু হয়েছে", total: cleaned.length });

    // ব্যাকগ্রাউন্ডে চালান
    (async () => {
        try {
            for (const q of cleaned) {
                bulkState.lastQuestion = q;

                // আগে থেকে আছে কি না
                const exists = await BbyData.findOne({ question: q });
                if (exists) {
                    bulkState.skipped++;
                    bulkState.done++;
                    continue;
                }

                const reply = await fetchReplyFromDipto(q);

                if (!reply || reply.length < 1) {
                    bulkState.failed++;
                    bulkState.done++;
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }

                try {
                    await new BbyData({
                        question: q,
                        answer: reply,
                        teacher: "dipto-api",
                        source: "bulk"
                    }).save();
                    bulkState.saved++;
                } catch (e) {
                    if (e.code === 11000) bulkState.skipped++;
                    else bulkState.failed++;
                }
                bulkState.done++;

                // rate limit এড়াতে একটু দেরি
                await new Promise(r => setTimeout(r, 400));
            }
            bulkState.status = "completed";
        } catch (e) {
            bulkState.status = "error";
            bulkState.errorMsg = e.message || "Unknown";
        } finally {
            bulkState.running = false;
            setTimeout(() => {
                if (bulkState.status !== "running") {
                    bulkState = { running: false, total: 0, done: 0, saved: 0, skipped: 0, failed: 0, status: "idle", errorMsg: "", lastQuestion: "" };
                }
            }, 60000);
        }
    })();
});

app.get('/api/bulk-status', (req, res) => {
    res.json(bulkState);
});

// ---------- SINGLE SAVE (ম্যানুয়াল বা বট থেকে) ----------
app.post('/api/save-teach', async (req, res) => {
    try {
        const { question, answer, teacher, senderID } = req.body;
        if (!question || !answer) return res.status(400).json({ error: "question ও answer দরকার" });

        const q = normalizeQ(question);
        const a = String(answer).trim();
        if (q.length < 4 || a.length < 1) return res.json({ skipped: true, message: "Too short" });

        const exists = await BbyData.findOne({ question: q, answer: a });
        if (exists) return res.json({ skipped: true, message: "Already exists" });

        const saved = await new BbyData({
            question: q,
            answer: a,
            teacher: teacher || senderID || "manual",
            source: "manual"
        }).save();

        res.json({ saved: true, id: saved._id });
    } catch (e) {
        if (e.code === 11000) return res.json({ skipped: true, message: "Duplicate" });
        res.status(500).json({ error: e.message });
    }
});

// ---------- PERSONAL API (আপনার নিজের bby API) ----------
app.get('/api/bby', async (req, res) => {
    try {
        const text = normalizeQ(req.query.text || "");
        if (!text) return res.status(400).json({ error: "text parameter দরকার" });

        // exact match
        let doc = await BbyData.findOne({ question: text });

        // exact না পেলে partial match
        if (!doc) {
            doc = await BbyData.findOne({ question: { $regex: text, $options: 'i' } });
        }

        if (doc) {
            return res.json({
                reply: doc.answer,
                question: doc.question,
                teacher: doc.teacher,
                match: "found"
            });
        }

        // DB-তে না থাকলে dipto API থেকে এনে সেভ করুন (auto-learn)
        const reply = await fetchReplyFromDipto(text);
        if (reply) {
            try {
                await new BbyData({ question: text, answer: reply, teacher: "auto", source: "auto" }).save();
            } catch (e) { /* ignore dup */ }
            return res.json({ reply, question: text, teacher: "auto", match: "fetched" });
        }

        res.json({ reply: "দুঃখিত, এই প্রশ্নের উত্তর আমার জানা নেই।", match: "not_found" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- READ ----------
app.get('/api/bby-data', async (req, res) => {
    try {
        const all = await BbyData.find().sort({ importedAt: -1 });
        res.json({ data: all });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- STATS ----------
app.get('/api/stats', async (req, res) => {
    try {
        const total = await BbyData.countDocuments();
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
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
        if (!question || !answer) return res.status(400).json({ error: "question ও answer দরকার" });
        const updated = await BbyData.findByIdAndUpdate(
            req.params.id,
            { question: normalizeQ(question), answer: String(answer).trim(), teacher: teacher || "Unknown" },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json({ data: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- DELETE ----------
app.delete('/api/bby-data/:id', async (req, res) => {
    try {
        await BbyData.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bby-data/bulk-delete', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "No ids" });
        const r = await BbyData.deleteMany({ _id: { $in: ids } });
        res.json({ deleted: r.deletedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- DASHBOARD ----------
app.get('/', (req, res) => {
  const html = [
'<!DOCTYPE html>',
'<html lang="bn">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>Bby Bulk Importer</title>',
'<style>',
':root{--bg:#f0f2f5;--card:#fff;--text:#333;--muted:#666;--border:#ddd;--primary:#1a73e8;--primary-dark:#1557b0;--soft:#e8f0fe;--danger:#dc3545;--success:#28a745;--warning:#ff9800;}',
'body.dark{--bg:#121212;--card:#1e1e1e;--text:#e0e0e0;--muted:#999;--border:#333;--soft:#1a2a44;}',
'*{box-sizing:border-box;}',
'body{font-family:"Segoe UI",Tahoma,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:16px;transition:0.3s;}',
'.container{max-width:1050px;margin:auto;}',
'.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px;}',
'h1{color:var(--primary);margin:0;font-size:24px;}',
'.top-actions{display:flex;gap:8px;flex-wrap:wrap;}',
'.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;}',
'.stat-card{background:var(--card);border-radius:10px;padding:16px;border:1px solid var(--border);text-align:center;}',
'.stat-num{font-size:28px;font-weight:bold;color:var(--primary);}',
'.stat-label{font-size:13px;color:var(--muted);margin-top:4px;}',
'.card{background:var(--card);padding:20px;border-radius:10px;border:1px solid var(--border);margin-bottom:20px;}',
'.card h2{margin-top:0;font-size:18px;color:var(--primary);}',
'textarea{width:100%;min-height:140px;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font-family:monospace;font-size:14px;resize:vertical;}',
'button{background:var(--primary);color:white;padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;transition:0.2s;}',
'button:hover{background:var(--primary-dark);}',
'button:disabled{background:#999;cursor:not-allowed;}',
'.btn-sm{padding:6px 12px;font-size:12px;}',
'.btn-danger{background:var(--danger);}',
'.btn-danger:hover{background:#c82333;}',
'.btn-ghost{background:transparent;color:var(--text);border:1px solid var(--border);}',
'.btn-ghost:hover{background:var(--soft);}',
'.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;}',
'.toolbar input,.toolbar select{flex:1;min-width:150px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font-size:14px;}',
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
'.progress-bar{height:10px;background:var(--border);border-radius:5px;overflow:hidden;margin:12px 0;}',
'.progress-fill{height:100%;background:var(--primary);width:0%;transition:0.3s;}',
'.bulk-status{font-size:14px;color:var(--primary);font-weight:bold;min-height:20px;margin-top:10px;}',
'.api-demo{background:var(--soft);padding:12px;border-radius:6px;font-family:monospace;font-size:13px;word-break:break-all;}',
'@media(max-width:600px){.item-header{flex-direction:column;}.item-actions{width:100%;}.item-actions button{flex:1;}}',
'</style>',
'</head>',
'<body>',
'<div class="container">',
'  <div class="header">',
'    <h1>🤖 Bby Bulk Importer</h1>',
'    <div class="top-actions">',
'      <button class="btn-ghost btn-sm" onclick="toggleTheme()">🌓 Theme</button>',
'      <button class="btn-ghost btn-sm" onclick="exportJSON()">⬇️ Export</button>',
'      <button class="btn-ghost btn-sm" onclick="fetchAll()">🔄 Refresh</button>',
'    </div>',
'  </div>',
'',
'  <div class="stats">',
'    <div class="stat-card"><div class="stat-num" id="statTotal">-</div><div class="stat-label">Total Entries</div></div>',
'    <div class="stat-card"><div class="stat-num" id="statToday">-</div><div class="stat-label">Added Today</div></div>',
'    <div class="stat-card"><div class="stat-num" id="statTeachers">-</div><div class="stat-label">Sources</div></div>',
'  </div>',
'',
'  <div class="card">',
'    <h2>📥 Bulk Fetch (প্রশ্নের লিস্ট দিয়ে)</h2>',
'    <p style="font-size:13px;color:var(--muted);">প্রতি লাইনে একটা প্রশ্ন লিখুন। ৪ অক্ষরের কম বা ডুপ্লিকেট বাদ যাবে। প্রতিটার উত্তর API থেকে এনে সেভ হবে।</p>',
'    <textarea id="bulkInput" placeholder="hi&#10;kemon acho&#10;tomar nam ki&#10;good morning"></textarea>',
'    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;align-items:center;">',
'      <button id="bulkBtn" onclick="startBulk()">🚀 Fetch All</button>',
'      <span id="bulkCount" style="font-size:13px;color:var(--muted);"></span>',
'    </div>',
'    <div class="progress-bar" id="bulkProgressWrap" style="display:none;"><div class="progress-fill" id="bulkProgressFill"></div></div>',
'    <div class="bulk-status" id="bulkStatus"></div>',
'  </div>',
'',
'  <div class="card">',
'    <h2>🔌 আপনার Personal API</h2>',
'    <p style="font-size:13px;color:var(--muted);">এই endpoint পরে আপনার বটে ব্যবহার করবেন।</p>',
'    <div class="api-demo">GET <b>/api/bby?text=hi</b> → DB থেকে উত্তর দেবে (না থাকলে dipto API থেকে এনে সেভ করবে)</div>',
'  </div>',
'',
'  <div class="card">',
'    <h2>📚 Saved Data</h2>',
'    <div class="toolbar">',
'      <input type="text" id="searchInput" placeholder="🔍 Search question / answer..." oninput="applyFilters()">',
'      <select id="teacherFilter" onchange="applyFilters()"><option value="">All Sources</option></select>',
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
'let selectedIds = new Set();',
'let bulkInterval = null;',
'',
'function escapeHtml(s){if(s===null||s===undefined)return "";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\x27/g,"&#39;");}',
'function toast(m,err){const t=document.getElementById("toast");t.textContent=m;t.className="toast show"+(err?" error":"");setTimeout(()=>t.className="toast",2500);}',
'function toggleTheme(){document.body.classList.toggle("dark");localStorage.setItem("theme",document.body.classList.contains("dark")?"dark":"light");}',
'',
'async function fetchAll(){await Promise.all([fetchData(),fetchStats()]);}',
'async function fetchData(){try{const r=await fetch(API_BASE+"/bby-data");const j=await r.json();allData=j.data||[];applyFilters();}catch(e){document.getElementById("dataList").innerHTML=\x27<li class="empty">Failed!</li>\x27;}}',
'async function fetchStats(){try{const r=await fetch(API_BASE+"/stats");const s=await r.json();document.getElementById("statTotal").textContent=s.total;document.getElementById("statToday").textContent=s.today;document.getElementById("statTeachers").textContent=(s.teachers||[]).length;const sel=document.getElementById("teacherFilter");const cur=sel.value;sel.innerHTML=\x27<option value="">All Sources</option>\x27+(s.teachers||[]).map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");sel.value=cur;}catch(e){}}',
'',
'function applyFilters(){const q=document.getElementById("searchInput").value.toLowerCase().trim();const t=document.getElementById("teacherFilter").value;filteredData=allData.filter(it=>{const mq=!q||String(it.question).toLowerCase().includes(q)||String(it.answer).toLowerCase().includes(q);const mt=!t||it.teacher===t;return mq&&mt;});currentPage=1;renderPage();}',
'',
'function renderPage(){const list=document.getElementById("dataList");list.innerHTML="";if(filteredData.length===0){list.innerHTML=\x27<li class="empty">No data. উপরে Bulk Fetch করুন।</li>\x27;document.getElementById("pagination").innerHTML="";return;}const start=(currentPage-1)*PAGE_SIZE;filteredData.slice(start,start+PAGE_SIZE).forEach(item=>{const li=document.createElement("li");li.className="data-item"+(selectedIds.has(item._id)?" selected":"");li.innerHTML=`<div class="item-header"><input type="checkbox" class="checkbox" ${selectedIds.has(item._id)?"checked":""} onchange="toggleSelect(\x27${item._id}\x27)"><div class="item-body"><div class="question">Q: ${escapeHtml(item.question)} <span class="badge">${escapeHtml(item.teacher)}</span></div><div class="answer">A: ${escapeHtml(item.answer)}</div></div><div class="item-actions"><button class="btn-sm btn-ghost" onclick="editItem(\x27${item._id}\x27)">✏️</button><button class="btn-sm btn-danger" onclick="deleteItem(\x27${item._id}\x27)">🗑️</button></div></div>`;list.appendChild(li);});renderPagination();updateBulkBtn();}',
'',
'function renderPagination(){const total=Math.ceil(filteredData.length/PAGE_SIZE);const pg=document.getElementById("pagination");pg.innerHTML="";if(total<=1)return;if(currentPage>1){const b=document.createElement("button");b.textContent="← Prev";b.className="btn-ghost btn-sm";b.onclick=()=>{currentPage--;renderPage();window.scrollTo({top:0,behavior:"smooth"});};pg.appendChild(b);}const info=document.createElement("span");info.textContent=` Page ${currentPage} / ${total} `;info.style.padding="8px";pg.appendChild(info);if(currentPage<total){const b=document.createElement("button");b.textContent="Next →";b.className="btn-ghost btn-sm";b.onclick=()=>{currentPage++;renderPage();window.scrollTo({top:0,behavior:"smooth"});};pg.appendChild(b);}}',
'',
'function toggleSelect(id){if(selectedIds.has(id))selectedIds.delete(id);else selectedIds.add(id);renderPage();}',
'function updateBulkBtn(){const b=document.getElementById("bulkDelBtn");if(selectedIds.size>0){b.style.display="inline-block";b.textContent=`🗑️ Delete Selected (${selectedIds.size})`;}else{b.style.display="none";}}',
'async function bulkDelete(){if(!confirm(`Delete ${selectedIds.size}?`))return;try{await fetch(API_BASE+"/bby-data/bulk-delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:Array.from(selectedIds)})});toast("Deleted");selectedIds.clear();await fetchAll();}catch(e){toast("Failed",true);}}',
'async function deleteItem(id){if(!confirm("Delete?"))return;try{await fetch(API_BASE+"/bby-data/"+id,{method:"DELETE"});toast("Deleted");await fetchAll();}catch(e){toast("Failed",true);}}',
'async function editItem(id){const it=allData.find(x=>x._id===id);if(!it)return;const q=prompt("Question:",it.question);if(q===null)return;const a=prompt("Answer:",it.answer);if(a===null)return;try{await fetch(API_BASE+"/bby-data/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:q,answer:a,teacher:it.teacher})});toast("Updated");await fetchData();}catch(e){toast("Failed",true);}}',
'',
'async function startBulk(){const text=document.getElementById("bulkInput").value;const lines=text.split("\\n").map(x=>x.trim()).filter(x=>x.length>=4);if(lines.length===0){toast("কোনো বৈধ প্রশ্ন নেই (৪ অক্ষরের কম)",true);return;}const btn=document.getElementById("bulkBtn");btn.disabled=true;btn.textContent="Starting...";try{const r=await fetch(API_BASE+"/bulk-fetch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({questions:lines})});const j=await r.json();if(r.ok){if(bulkInterval)clearInterval(bulkInterval);bulkInterval=setInterval(checkBulkStatus,1000);checkBulkStatus();}else{document.getElementById("bulkStatus").style.color="var(--danger)";document.getElementById("bulkStatus").textContent=j.error;btn.disabled=false;btn.textContent="🚀 Fetch All";}}catch(e){toast("Server error",true);btn.disabled=false;btn.textContent="🚀 Fetch All";}}',
'',
'async function checkBulkStatus(){try{const r=await fetch(API_BASE+"/bulk-status");const s=await r.json();const btn=document.getElementById("bulkBtn");const st=document.getElementById("bulkStatus");const pw=document.getElementById("bulkProgressWrap");const pf=document.getElementById("bulkProgressFill");const cnt=document.getElementById("bulkCount");if(s.status==="running"){st.style.color="var(--primary)";st.textContent=`⏳ চলছে: ${s.done}/${s.total} | Saved: ${s.saved} | Skipped: ${s.skipped} | Failed: ${s.failed} | এখন: "${s.lastQuestion}"`;pw.style.display="block";pf.style.width=s.total>0?((s.done/s.total)*100)+"%":"0%";btn.disabled=true;btn.textContent="Importing...";cnt.textContent=`${s.done}/${s.total}`;}else if(s.status==="completed"){st.style.color="var(--success)";st.textContent=`✅ সম্পন্ন! Saved: ${s.saved} | Skipped: ${s.skipped} | Failed: ${s.failed}`;pw.style.display="none";btn.disabled=false;btn.textContent="🚀 Fetch All";clearInterval(bulkInterval);fetchAll();toast("Bulk fetch complete!");}else if(s.status==="error"){st.style.color="var(--danger)";st.textContent="❌ ব্যর্থ: "+s.errorMsg;pw.style.display="none";btn.disabled=false;btn.textContent="🚀 Fetch All";clearInterval(bulkInterval);}}catch(e){}}',
'',
'function exportJSON(){const b=new Blob([JSON.stringify(allData,null,2)],{type:"application/json"});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download="bby-data-"+Date.now()+".json";a.click();URL.revokeObjectURL(u);toast("Exported!");}',
'',
'document.getElementById("bulkInput").addEventListener("input",()=>{const lines=document.getElementById("bulkInput").value.split("\\n").map(x=>x.trim()).filter(x=>x.length>=4);document.getElementById("bulkCount").textContent=lines.length>0?lines.length+" টি বৈধ প্রশ্ন":"";
});',
'',
'window.onload=()=>{if(localStorage.getItem("theme")==="dark")document.body.classList.add("dark");fetchAll();fetch(API_BASE+"/bulk-status").then(r=>r.json()).then(s=>{if(s.status==="running"){if(bulkInterval)clearInterval(bulkInterval);bulkInterval=setInterval(checkBulkStatus,1000);checkBulkStatus();}}).catch(()=>{});};',
'</script>',
'</body>',
'</html>'
  ].join('\n');
  res.send(html);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
