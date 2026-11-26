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
  question: { type: String, required: true },
  answer: { type: String, required: true },
  teacher: { type: String, default: "Unknown" },
  importedAt: { type: Date, default: Date.now }
});

const BbyData = mongoose.model('BbyData', bbySchema);

// গ্লোবাল ভ্যারিয়েবল যা ব্যাকগ্রাউন্ড স্টেট ট্র্যাক করবে
let isImporting = false;
let importProgress = { total: 0, current: 0, imported: 0, skipped: 0, status: "idle" };

// ডেটা ফিল্টার করার ফাংশন (শুধু ৪ অক্ষরের বেশি এবং সংখ্যা ছাড়া)
function isValidReply(question, answer) {
    if (!question || !answer) return false;
    const q = question.trim();
    const a = answer.trim();
    
    // ৪ অক্ষরের কম হলে বাদ
    if (q.length < 4) return false;

    // সংখ্যা থাকলে বাদ (যেমন: 1928, 28)
    const numberRegex = /[0-9]/;
    if (numberRegex.test(q)) return false;

    return true;
}

app.post('/api/import-bby', async (req, res) => {
    if (isImporting) {
        return res.status(400).json({ error: "ইমপোর্ট ইতিমধ্যে চলছে, অপেক্ষা করুন..." });
    }

    isImporting = true;
    importProgress = { total: 0, current: 0, imported: 0, skipped: 0, status: "running" };

    // রেসপন্স সাথে সাথে পাঠিয়ে দেওয়া হচ্ছে যাতে ইউজার পেজ রিফ্রেশ করলেও সমস্যা না হয়
    res.status(200).json({ message: "ইমপোর্ট ব্যাকগ্রাউন্ডে শুরু হয়েছে..." });

    // ব্যাকগ্রাউন্ডে ইমপোর্ট প্রসেস
    try {
        const apiUrl = "https://noobs-api.top/dipto/baby?list=all";
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data || !data.teacher || !data.teacher.teacherList) {
            throw new Error("API ডেটা ফরম্যাট সঠিক নয়।");
        }

        const teacherList = data.teacher.teacherList;
        importProgress.total = teacherList.length;

        for (let item of teacherList) {
            importProgress.current++;
            const question = Object.keys(item)[0];
            const answer = item[question];

            // ফিল্টার চেক
            if (!isValidReply(question, answer)) {
                importProgress.skipped++;
                continue;
            }

            // ডুপ্লিকেট চেক
            const exists = await BbyData.findOne({ question: question });
            if (!exists) {
                const newData = new BbyData({
                    question: question,
                    answer: answer,
                    teacher: data.teacher.name || "Unknown"
                });
                await newData.save();
                importProgress.imported++;
            } else {
                importProgress.skipped++;
            }
        }
        importProgress.status = "completed";
    } catch (error) {
        console.error("Import Error:", error.message);
        importProgress.status = "error";
    } finally {
        isImporting = false;
        // ৩০ সেকেন্ড পর স্টেট রিসেট হবে
        setTimeout(() => { importProgress = { total: 0, current: 0, imported: 0, skipped: 0, status: "idle" }; }, 30000);
    }
});

// ইমপোর্টের বর্তমান অবস্থা জানার API
app.get('/api/import-status', (req, res) => {
    res.status(200).json(importProgress);
});

app.get('/api/bby-data', async (req, res) => {
    try {
        const allData = await BbyData.find().sort({ importedAt: -1 });
        res.status(200).json({ data: allData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/bby-data/:id', async (req, res) => {
    try {
        await BbyData.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "Deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bby API Dashboard</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5; margin: 0; padding: 20px; }
        .container { max-width: 900px; margin: auto; background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        h1 { text-align: center; color: #1a73e8; margin-bottom: 30px; }
        .import-section { background: #e8f0fe; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 30px; border: 1px dashed #1a73e8; }
        .import-section h2 { margin-top: 0; color: #174ea6; font-size: 20px; }
        button { background-color: #1a73e8; color: white; padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: bold; transition: 0.3s; }
        button:hover { background-color: #1557b0; }
        button:disabled { background-color: #999; cursor: not-allowed; }
        .status-box { margin-top: 15px; font-weight: bold; color: #1a73e8; font-size: 15px; }
        .data-list { list-style-type: none; padding: 0; }
        .data-item { background: #fff; border: 1px solid #ddd; padding: 15px; margin-bottom: 10px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
        .data-content { flex-grow: 1; }
        .question { font-weight: bold; color: #333; font-size: 16px; margin-bottom: 5px; }
        .answer { color: #555; font-size: 14px; }
        .teacher-badge { background: #e8f0fe; color: #1a73e8; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; }
        .btn-delete { background-color: #dc3545; padding: 8px 16px; font-size: 14px; }
        .btn-delete:hover { background-color: #c82333; }
        .search-box { width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
    </style>
</head>
<body>
<div class="container">
    <h1>🤖 Bby API Data Importer</h1>
    
    <div class="import-section">
        <h2>📥 Import Data</h2>
        <p>৪ অক্ষরের বেশি এবং সংখ্যাবিহীন রিপ্লাইগুলো সেভ হবে।</p>
        <button id="importBtn" onclick="startImport()">Import Now</button>
        <div id="statusMessage" class="status-box"></div>
    </div>

    <input type="text" id="searchInput" class="search-box" placeholder="🔍 Search..." onkeyup="filterData()">
    
    <ul id="dataList" class="data-list">
        <li style="text-align: center; color: #888;">Loading data...</li>
    </ul>
</div>

<script>
    const API_BASE = '/api';
    let allData = [];
    let statusInterval = null;

    // ডেটা লোড করা
    async function fetchData() {
        try {
            const response = await fetch(\`\${API_BASE}/bby-data\`);
            const result = await response.json();
            allData = result.data || [];
            renderData(allData);
        } catch (error) {
            document.getElementById('dataList').innerHTML = '<li style="color:red; text-align:center;">Failed to load data!</li>';
        }
    }

    // ডেটা রেন্ডার করা
    function renderData(dataArray) {
        const list = document.getElementById('dataList');
        list.innerHTML = '';
        if (dataArray.length === 0) {
            list.innerHTML = '<li style="text-align:center; color:#888;">No data found.</li>';
            return;
        }
        dataArray.forEach(item => {
            const li = document.createElement('li');
            li.className = 'data-item';
            li.innerHTML = \`
                <div class="data-content">
                    <div class="question">Q: \${item.question} <span class="teacher-badge">👨‍🏫 \${item.teacher}</span></div>
                    <div class="answer">A: \${item.answer}</div>
                </div>
                <button class="btn-delete" onclick="deleteData('\${item._id}')">Delete</button>
            \`;
            list.appendChild(li);
        });
    }

    // ইমপোর্ট শুরু করা এবং স্ট্যাটাস চেক করা
    async function startImport() {
        const btn = document.getElementById('importBtn');
        btn.disabled = true;
        btn.innerText = "Starting...";
        
        try {
            const response = await fetch(\`\${API_BASE}/import-bby\`, { method: 'POST' });
            const result = await response.json();
            
            if (response.ok) {
                // স্ট্যাটাস চেক করা শুরু করা
                if(statusInterval) clearInterval(statusInterval);
                statusInterval = setInterval(checkImportStatus, 1000);
                checkImportStatus(); // সাথে সাথে একবার চেক করা
            } else {
                document.getElementById('statusMessage').style.color = "red";
                document.getElementById('statusMessage').innerText = result.error;
                btn.disabled = false;
                btn.innerText = "Import Now";
            }
        } catch (error) {
            document.getElementById('statusMessage').style.color = "red";
            document.getElementById('statusMessage').innerText = "Server error!";
            btn.disabled = false;
            btn.innerText = "Import Now";
        }
    }

    // স্ট্যাটাস চেক করার লজিক
    async function checkImportStatus() {
        try {
            const response = await fetch(\`\${API_BASE}/import-status\`);
            const status = await response.json();
            const msgBox = document.getElementById('statusMessage');
            const btn = document.getElementById('importBtn');

            if (status.status === "running") {
                msgBox.style.color = "#1a73e8";
                msgBox.innerText = \`⏳ ইমপোর্ট চলছে... (Total: \${status.total} | Done: \${status.current} | Saved: \${status.imported} | Skipped: \${status.skipped})\`;
                btn.disabled = true;
                btn.innerText = "Importing...";
                fetchData(); // লাইভ ডেটা আপডেট দেখানোর জন্য
            } 
            else if (status.status === "completed") {
                msgBox.style.color = "green";
                msgBox.innerText = \`✅ ইমপোর্ট সম্পন্ন! Total: \${status.total} | Saved: \${status.imported} | Skipped: \${status.skipped}\`;
                btn.disabled = false;
                btn.innerText = "Import Now";
                clearInterval(statusInterval);
                fetchData(); // ফাইনাল ডেটা লোড
            } 
            else if (status.status === "error") {
                msgBox.style.color = "red";
                msgBox.innerText = "❌ ইমপোর্ট করতে সমস্যা হয়েছে!";
                btn.disabled = false;
                btn.innerText = "Import Now";
                clearInterval(statusInterval);
            }
        } catch (error) {
            console.error("Status check error");
        }
    }

    // ডিলিট করা
    async function deleteData(id) {
        if(!confirm("Are you sure you want to delete?")) return;
        try {
            await fetch(\`\${API_BASE}/bby-data/\${id}\`, { method: 'DELETE' });
            fetchData();
        } catch (error) {
            alert("Delete failed!");
        }
    }

    // সার্চ ফিল্টার
    function filterData() {
        const query = document.getElementById('searchInput').value.toLowerCase();
        const filtered = allData.filter(item => 
            item.question.toLowerCase().includes(query) || 
            item.answer.toLowerCase().includes(query)
        );
        renderData(filtered);
    }

    // পেজ লোড হলে চেক করবে ইমপোর্ট চলছে কিনা, এবং ডেটা লোড করবে
    window.onload = () => {
        fetchData();
        // যদি পেজ রিফ্রেশ করার পরও ইমপোর্ট চলতে থাকে, স্ট্যাটাস চেক করা শুরু করবে
        fetch(\`\${API_BASE}/import-status\`)
            .then(res => res.json())
            .then(status => {
                if(status.status === "running") {
                    if(statusInterval) clearInterval(statusInterval);
                    statusInterval = setInterval(checkImportStatus, 1000);
                    checkImportStatus();
                }
            }).catch(err => console.log(err));
    };
</script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
