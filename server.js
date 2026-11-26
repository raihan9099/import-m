const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------- BULK FETCH ----------
let bulkState = { running: false, total: 0, done: 0, saved: 0, skipped: 0, failed: 0, status: "idle", errorMsg: "", lastQuestion: "" };

app.post('/api/bulk-fetch', async (req, res) => {
    if (bulkState.running) {
        return res.status(400).json({ error: "Bulk fetch ইতিমধ্যে চলছে, অপেক্ষা করুন..." });
    }

    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "questions অ্যারে দরকার" });
    }

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

    (async () => {
        try {
            for (const q of cleaned) {
                bulkState.lastQuestion = q;

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

// ---------- SINGLE SAVE ----------
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

// ---------- PERSONAL API ----------
app.get('/api/bby', async (req, res) => {
    try {
        const text = normalizeQ(req.query.text || "");
        if (!text) return res.status(400).json({ error: "text parameter দরকার" });

        let doc = await BbyData.findOne({ question: text });

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

        const reply = await fetchReplyFromDipto(text);
        if (reply) {
            try {
                await new BbyData({ question: text, answer: reply, teacher: "auto", source: "auto" }).save();
            } catch (e) { }
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
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
