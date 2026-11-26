const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const connectDB = require('./config/db');
const config = require('./config.json');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

connectDB();

const bbySchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  teacher: { type: String, default: "Unknown" },
  importedAt: { type: Date, default: Date.now }
});

const BbyData = mongoose.model('BbyData', bbySchema);

app.post('/api/import-bby', async (req, res) => {
  try {
    const apiUrl = "https://noobs-api.top/dipto/baby?list=all";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (!data || !data.teacher || !data.teacher.teacherList) {
        return res.status(400).json({ error: "API থেকে সঠিক ডেটা পাওয়া যায়নি।" });
    }

    const teacherList = data.teacher.teacherList;
    let importedCount = 0;

    for (let item of teacherList) {
        const question = Object.keys(item)[0];
        const answer = item[question];
        
        const exists = await BbyData.findOne({ question: question });
        if (!exists) {
            const newData = new BbyData({
                question: question,
                answer: answer,
                teacher: data.teacher.name || "Unknown"
            });
            await newData.save();
            importedCount++;
        }
    }

    res.status(200).json({ message: `${importedCount} টি নতুন রিপ্লাই সফলভাবে ইমপোর্ট হয়েছে!` });

  } catch (error) {
    res.status(500).json({ error: "ইমপোর্ট করতে সমস্যা হয়েছে: " + error.message });
  }
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
    res.status(200).json({ message: "ডিলিট সফল হয়েছে" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || config.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
