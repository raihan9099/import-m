const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const config = require('./config.json');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Frontend ফাইল Serve করার জন্য

connectDB();

// মেইন ডাটাবেসের স্কিমা
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// ১. ডেটা অ্যাড করা (POST)
app.post('/api/users', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ message: "Name and email required" });
    const newUser = new User({ name, email });
    const savedUser = await newUser.save();
    res.status(201).json({ data: savedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ২. ডেটা দেখা (GET)
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find();
    res.status(200).json({ data: users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ৩. ডেটা ডিলিট করা (DELETE)
app.delete('/api/users/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ৪. অন্য লিংক থেকে ডেটা ইমপোর্ট করা (POST)
app.post('/api/import', async (req, res) => {
  const { externalUri } = req.body;
  if (!externalUri) return res.status(400).json({ message: "External URI required" });

  try {
    // টেম্পোরারি কানেকশন তৈরি করা
    const tempConnection = await mongoose.createConnection(externalUri).asPromise();
    
    // ইমপোর্ট করার জন্য একটি ডামি স্কিমা (ইউজার)
    const TempUser = tempConnection.model('User', userSchema);
    
    // এক্সটার্নাল ডাটাবেস থেকে ডেটা আনা
    const externalData = await TempUser.find();
    
    // আমাদের মেইন ডাটাবেসে সেভ করা
    if (externalData.length > 0) {
      const formattedData = externalData.map(item => ({
        name: item.name || "Unknown",
        email: item.email || "No Email"
      }));
      await User.insertMany(formattedData);
    }

    // টেম্পোরারি কানেকশন বন্ধ করা
    await tempConnection.close();

    res.status(200).json({ message: `${externalData.length} data imported successfully!` });
  } catch (error) {
    res.status(500).json({ error: "Import failed. Check your external link or IP whitelist. " + error.message });
  }
});

// সার্ভার চালু করা
const PORT = process.env.PORT || config.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
