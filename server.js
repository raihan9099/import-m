require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');

const app = express();

app.use(cors());
app.use(express.json());

connectDB();

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

app.get('/', (req, res) => {
  res.send('Server is running perfectly!');
});

app.post('/api/users', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ message: "Name and email required" });
    }
    const newUser = new User({ name, email });
    const savedUser = await newUser.save();
    res.status(201).json({ data: savedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find();
    res.status(200).json({ data: users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
