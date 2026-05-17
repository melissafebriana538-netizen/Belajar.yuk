require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ====================== CORS ======================
// Izinkan semua origin untuk kemudahan (bisa disesuaikan dengan domain Anda)
app.use(cors({
  origin: true, // mengizinkan semua origin, atau ganti dengan "https://belajaryuk-production.up.railway.app"
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'FRONTEND')));
app.use('/uploads', express.static('uploads'));

// ====================== KONEKSI DATABASE ======================
const dbURI = process.env.MONGODB_URI;
if (!dbURI) {
  console.error('❌ MONGODB_URI environment variable not set');
  process.exit(1);
}
mongoose.connect(dbURI)
  .then(() => console.log('✅ Terhubung ke MongoDB Atlas'))
  .catch(err => console.log('❌ DB Error:', err));

// ====================== SCHEMA ======================
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, default: '' },
  nim: { type: String, default: '' },
  university: { type: String, default: '' },
  avatar: { type: String, default: '' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' }, // <-- role di root
  preferences: {
    darkMode: { type: Boolean, default: false },
    language: { type: String, default: 'id' },
    notifQuiz: { type: Boolean, default: true },
    notifSound: { type: Boolean, default: false }
  }
});
const User = mongoose.model('User', UserSchema);

const MateriSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: String,
  type: { type: String, enum: ['youtube', 'document'] },
  source: String,
  thumbnail: String,
  summary: String,
  quiz: [{
    text: String,
    options: [String],
    correct: Number
  }],
  quizResults: [{
    date: Date,
    score: Number,
    answers: [Number],
    feedbacks: [String]
  }],
  createdAt: { type: Date, default: Date.now }
});
const Materi = mongoose.model('Materi', MateriSchema);

const ChatQuizSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: String,
  mode: { type: String, enum: ['quiz', 'step'] },
  questions: [{
    text: String,
    options: [String],
    correct: Number,
    userAnswer: Number,
    isCorrect: Boolean,
    explanation: String
  }],
  score: Number,
  completedAt: { type: Date, default: Date.now }
});
const ChatQuiz = mongoose.model('ChatQuiz', ChatQuizSchema);

const QuizProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  materiId: { type: mongoose.Schema.Types.ObjectId, ref: 'Materi', required: true },
  answers: { type: Map, of: Number, default: {} },
  lastUpdated: { type: Date, default: Date.now }
});
const QuizProgress = mongoose.model('QuizProgress', QuizProgressSchema);

const ChatSchema = new mongoose.Schema({
  room: { type: String, default: 'general' },
  sender: String,
  text: String,
  time: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);
const RoomDocument = require('./models/roomDocument');

// ====================== JWT SECRET ======================
const JWT_SECRET = process.env.JWT_SECRET || 'SECRET_KEY';
if (JWT_SECRET === 'SECRET_KEY') {
  console.warn('⚠️ Gunakan JWT_SECRET environment variable di production');
}

// ====================== VERIFY TOKEN & ADMIN ======================
const verifyToken = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (!token) return res.status(401).json({ message: 'Akses ditolak' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(400).json({ message: 'Token tidak valid' });
  }
};

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Akses ditolak. Bukan admin.' });
  }
  next();
};

// ====================== FUNGSI BANTU ======================
function getVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\?\/]+)/,
    /youtube\.com\/watch\?.*v=([^&]+)/
  ];
  for (let p of patterns) {
    const match = url.match(p);
    if (match) return match[1];
  }
  return null;
}

async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.txt') {
    return fs.readFileSync(filePath, 'utf8');
  } else if (ext === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    return pdfData.text;
  } else if (ext === '.doc' || ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } else {
    throw new Error('Format file tidak didukung');
  }
}

async function generateQuizFromText(text, title) {
  const maxLength = 10000;
  const truncatedText = text.length > maxLength ? text.substring(0, maxLength) : text;
  if (truncatedText.trim().length < 50) throw new Error('Teks terlalu pendek');
  let estimatedQuestions = Math.floor(truncatedText.length / 500);
  if (estimatedQuestions < 5) estimatedQuestions = 5;
  if (estimatedQuestions > 20) estimatedQuestions = 20;

  const prompt = `Buat soal pilihan ganda dari teks berikut. Jumlah soal target sekitar ${estimatedQuestions} soal. Setiap soal 4 opsi (A,B,C,D) dan jawaban benar (indeks 0-3). Output JSON: { "questions": [ { "text": "...", "options": ["...","...","...","..."], "correct": 0 } ] } JANGAN tambahkan teks lain. Teks: "${truncatedText}"`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) throw new Error('Gagal generate quiz');
  const data = await response.json();
  const aiMessage = data.choices[0].message.content;
  let cleaned = aiMessage.trim().replace(/```json/g, '').replace(/```/g, '');
  const parsed = JSON.parse(cleaned);
  let questions = parsed.questions || (Array.isArray(parsed) ? parsed : []);
  return questions.filter(q => q.text && Array.isArray(q.options) && q.options.length === 4 && typeof q.correct === 'number');
}

// ====================== MULTER UPLOAD ======================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/avatars';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 2 * 1024 * 1024 } });

// ====================== AUTH ROUTES ======================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'FRONTEND', 'index.html'));
});

app.post('/api/register', async (req, res) => {
  const { email, password, konfirmasiPassword, name } = req.body;
  if (!email || !password || !konfirmasiPassword) return res.status(400).json({ message: 'Semua field wajib diisi' });
  if (password !== konfirmasiPassword) return res.status(400).json({ message: 'Password tidak sama' });
  try {
    const userExist = await User.findOne({ email });
    if (userExist) return res.status(400).json({ message: 'Email sudah terdaftar' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const userName = name && name.trim() ? name : email.split('@')[0];
    const userBaru = new User({ email, password: hashedPassword, name: userName, role: 'user' });
    await userBaru.save();
    const token = jwt.sign(
      { userId: userBaru._id, email: userBaru.email, name: userBaru.name, role: userBaru.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ message: 'Registrasi berhasil', token, user: { email: userBaru.email, name: userBaru.name, role: userBaru.role } });
  } catch (error) {
    res.status(500).json({ message: 'Terjadi error', error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email dan password wajib diisi' });
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Password salah' });
    const token = jwt.sign(
      { userId: user._id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ message: 'Login berhasil', token, user: { email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: 'Terjadi error', error: error.message });
  }
});

// ====================== ADMIN ROUTES ======================
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/materi', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const allMateri = await Materi.find().populate('userId', 'name email');
    res.json(allMateri);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/admin/materi/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await Materi.findByIdAndDelete(req.params.id);
    res.json({ message: 'Materi berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ====================== MATERI & QUIZ PROGRESS (user routes) ======================
app.get('/api/materi', verifyToken, async (req, res) => {
  try {
    const materi = await Materi.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    res.json(materi);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/materi', verifyToken, async (req, res) => {
  try {
    const { title, type, source, thumbnail, summary, quiz } = req.body;
    const newMateri = new Materi({
      userId: req.user.userId,
      title,
      type,
      source,
      thumbnail: thumbnail || '',
      summary: summary || 'Ringkasan akan segera tersedia.',
      quiz: quiz || [
        { text: "Apa topik utama materi ini?", options: ["Pendahuluan", "Konsep Inti", "Studi Kasus", "Semua Benar"], correct: 3 },
        { text: "Langkah terbaik setelah belajar?", options: ["Mencatat", "Mengerjakan kuis", "Diskusi", "Semua di atas"], correct: 3 }
      ],
      quizResults: []
    });
    await newMateri.save();
    res.status(201).json(newMateri);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/materi/:id', verifyToken, async (req, res) => {
  try {
    const materi = await Materi.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!materi) return res.status(404).json({ message: 'Materi tidak ditemukan' });
    if (req.body.quizResults) {
      materi.quizResults = req.body.quizResults;
    }
    await materi.save();
    res.json(materi);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Quiz Progress endpoints
app.post('/api/quiz-progress/:materiId', verifyToken, async (req, res) => {
  try {
    const { materiId } = req.params;
    const { answers } = req.body;
    let progress = await QuizProgress.findOne({ userId: req.user.userId, materiId });
    if (!progress) {
      progress = new QuizProgress({ userId: req.user.userId, materiId, answers: new Map() });
    }
    for (const [key, value] of Object.entries(answers)) {
      progress.answers.set(key, value);
    }
    progress.lastUpdated = new Date();
    await progress.save();
    res.json({ message: 'Progress tersimpan', progress: Object.fromEntries(progress.answers) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/quiz-progress/:materiId', verifyToken, async (req, res) => {
  try {
    const { materiId } = req.params;
    const progress = await QuizProgress.findOne({ userId: req.user.userId, materiId });
    if (!progress) return res.json({ answers: {} });
    res.json({ answers: Object.fromEntries(progress.answers) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/quiz-progress/:materiId', verifyToken, async (req, res) => {
  try {
    await QuizProgress.findOneAndDelete({ userId: req.user.userId, materiId: req.params.materiId });
    res.json({ message: 'Progress dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// UPLOAD DOKUMEN
app.post('/api/upload', verifyToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
  const filePath = req.file.path;
  const originalName = req.file.originalname;
  try {
    const extractedText = await extractTextFromFile(filePath, originalName);
    const aiQuiz = await generateQuizFromText(extractedText, originalName);
    const summary = `Ringkasan dari dokumen "${originalName}". ${extractedText.substring(0, 300)}...`;
    const newMateri = new Materi({
      userId: req.user.userId,
      title: originalName,
      type: 'document',
      source: `/uploads/${req.file.filename}`,
      summary: summary,
      quiz: aiQuiz,
      quizResults: []
    });
    await newMateri.save();
    res.json({ message: 'Dokumen berhasil diproses dengan AI', materi: newMateri });
  } catch (err) {
    console.error(err);
    const defaultQuiz = [
      { text: `Apa topik utama dari "${originalName}"?`, options: ["Pendahuluan", "Konsep Inti", "Studi Kasus", "Semua Benar"], correct: 3 },
      { text: "Aksi terbaik setelah membaca dokumen?", options: ["Mencatat", "Diskusi", "Kuis", "Semua di atas"], correct: 3 }
    ];
    const newMateri = new Materi({
      userId: req.user.userId,
      title: originalName,
      type: 'document',
      source: `/uploads/${req.file.filename}`,
      summary: `Dokumen: ${originalName}. Silakan baca untuk memahami.`,
      quiz: defaultQuiz,
      quizResults: []
    });
    await newMateri.save();
    res.json({ message: 'Dokumen berhasil diupload (quiz default karena AI error)', materi: newMateri });
  }
});

// ====================== AI CHAT (Step & Quiz) ======================
async function generateStep(topic, stepIndex, totalSteps, previousAnswer = null) {
  // ... (fungsi ini tetap sama seperti kode Anda, tidak perlu diubah)
  let prompt = `Anda adalah AI tutor yang membantu siswa memahami topik "${topic}" secara bertahap.
Sesi ini memiliki ${totalSteps} langkah.
`;
  if (previousAnswer !== null) {
    prompt += `
Siswa baru saja menjawab soal langkah ke-${stepIndex - 1} dengan jawaban: "${previousAnswer}".
Berikan feedback singkat (1 kalimat) apakah jawabannya tepat atau tidak (gunakan pengetahuan Anda tentang topik ini).
Kemudian LANJUTKAN ke langkah ke-${stepIndex} dengan materi yang lebih mendalam.
Jangan ulang materi langkah sebelumnya.
`;
  } else {
    prompt += `
Siswa akan memulai langkah ke-${stepIndex} dari ${totalSteps}.
Buat penjelasan mendalam untuk langkah ke-${stepIndex} (materi baru, tidak mengulang langkah sebelumnya).
Setelah penjelasan, berikan satu soal pilihan ganda dengan 4 opsi (A, B, C, D) untuk menguji pemahaman.
`;
  }
  prompt += `
Output HARUS berupa JSON murni, tanpa teks tambahan, dengan format:
{
  "type": "step",
  "stepIndex": ${stepIndex},
  "totalSteps": ${totalSteps},
  "explanation": "Penjelasan detail...",
  "question": {
    "text": "Teks soal pilihan ganda...",
    "options": ["Opsi A", "Opsi B", "Opsi C", "Opsi D"],
    "correct": 0
  }
}
`;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error('Gagal generate step dari AI');
    const data = await response.json();
    let content = data.choices[0].message.content;
    content = content.replace(/```json|```/g, '').trim();
    return JSON.parse(content);
  } catch (error) {
    console.error('Error generateStep:', error);
    return {
      type: 'step',
      stepIndex,
      totalSteps,
      explanation: `Penjelasan untuk langkah ${stepIndex} dari topik "${topic}". (AI sedang sibuk, ini konten sementara)`,
      question: {
        text: `Apa yang dipelajari pada langkah ${stepIndex}?`,
        options: ["Pilihan A", "Pilihan B", "Pilihan C", "Pilihan D"],
        correct: 0
      }
    };
  }
}

async function completeStep(topic, totalSteps) {
  return {
    type: 'step_complete',
    message: ` Selamat! Anda telah menyelesaikan ${totalSteps} langkah pemahaman untuk topik "${topic}". Teruslah berlatih!`
  };
}

app.post('/api/chat-ai', async (req, res) => {
  // ... (fungsi chat-ai tetap sama seperti kode Anda, tidak perlu diubah)
  const { messages, selectedOption, topic, stepState } = req.body;

  if (selectedOption === 'step') {
    let currentStep = stepState?.stepIndex || 1;
    let totalSteps = stepState?.totalSteps || 5;
    let currentTopic = topic || (messages.find(m => m.role === 'user')?.content || 'belajar');
    try {
      if (currentStep <= totalSteps) {
        const stepData = await generateStep(currentTopic, currentStep, totalSteps);
        return res.json(stepData);
      } else {
        const completeData = await completeStep(currentTopic, totalSteps);
        return res.json(completeData);
      }
    } catch (err) {
      console.error("Error handling step:", err);
      return res.status(500).json({ type: 'text', content: 'Maaf, terjadi kesalahan. Silakan coba lagi.' });
    }
  }

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (lastUserMsg && lastUserMsg.content.toLowerCase().startsWith('jawaban:')) {
    const match = lastUserMsg.content.match(/jawaban:\s*([A-D])/i);
    const userAnswerLetter = match ? match[1].toUpperCase() : null;
    const currentStepIndex = stepState?.stepIndex || 1;
    const totalSteps = stepState?.totalSteps || 5;
    const currentTopic = topic || 'belajar';
    if (currentStepIndex >= totalSteps) {
      return res.json({ type: 'step_complete', message: `✅ Jawaban diterima. Anda telah menyelesaikan semua ${totalSteps} langkah. Selamat!` });
    } else {
      const nextStepIndex = currentStepIndex + 1;
      try {
        const nextStep = await generateStep(currentTopic, nextStepIndex, totalSteps, userAnswerLetter);
        return res.json(nextStep);
      } catch (err) {
        console.error("Error generate next step:", err);
        return res.json({
          type: 'step',
          stepIndex: nextStepIndex,
          totalSteps,
          explanation: `Lanjutan materi ${currentTopic} - langkah ${nextStepIndex}.`,
          question: { text: `Soal untuk langkah ${nextStepIndex}: Apa inti dari bagian ini?`, options: ["Opsi A", "Opsi B", "Opsi C", "Opsi D"], correct: 0 }
        });
      }
    }
  }

  const systemPrompt = `Anda adalah AI tutor profesional berbasis kurikulum akademik.
1. SUBTOPIC: jika user minta topik baru, buat subtopik lengkap minimal 6 maksimal 12, output { "type": "subtopics", "message": "...", "options": [...] }
2. PENJELASAN+OPSI: jika user pilih subtopik (diawali "Pilih:"), berikan penjelasan mendalam lalu langsung beri opsi Quiz dan Step, output { "type": "explanation_with_options", "content": "...", "topic": "...", "message": "...", "options": ["Quiz","Pemahaman Step by Step"] }
3. QUIZ: jika user pilih Quiz, langsung beri 5 soal pilihan ganda yang relevan dengan topik, output { "type": "quiz", "questions": [...], "topic": "..." }
4. STEP BY STEP: jika user pilih Step, frontend akan menangani selectedOption='step' (tidak usah dihasilkan di sini).
Hanya output JSON, tidak ada teks lain.`;

  try {
    const lastUserMsg2 = messages.filter(m => m.role === 'user').pop();
    let userPrompt = "";

    if (selectedOption === 'quiz') {
      userPrompt = `INSTRUKSI WAJIB: User memilih QUIZ untuk topik "${topic}". 
- JANGAN berikan penjelasan apapun.
- JANGAN tawarkan pilihan lagi.
- LANGSUNG buat 5 soal pilihan ganda tentang "${topic}".
- Setiap soal harus memiliki 4 opsi (A,B,C,D) dan satu jawaban benar (indeks 0-3).
- Pastikan soal dan opsi relevan dengan topik "${topic}".
- Output HARUS JSON dengan format:
{
  "type": "quiz",
  "questions": [
    { "text": "Soal 1", "options": ["A1","B1","C1","D1"], "correct": 0 },
    ...
  ],
  "topic": "${topic}"
}
HANYA JSON, TIDAK ADA TEKS LAIN.`;
    } 
    else if (lastUserMsg2 && lastUserMsg2.content.toLowerCase().startsWith('pilih:')) {
      const subtopicName = lastUserMsg2.content.replace(/^pilih:\s*/i, '').trim();
      userPrompt = `User memilih subtopik "${subtopicName}". Berikan penjelasan mendalam dan LANGSUNG berikan opsi Quiz dan Step (type "explanation_with_options").`;
    } 
    else {
      userPrompt = lastUserMsg2 ? lastUserMsg2.content : "Halo";
    }

    const fullPrompt = `${systemPrompt}\n\nRiwayat:\n${JSON.stringify(messages)}\n\nInstruksi:\n${userPrompt}`;
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: 'llama-3.3-70b-versatile', 
        messages: [{ role: 'user', content: fullPrompt }], 
        temperature: 0.6, 
        response_format: { type: "json_object" } 
      })
    });
    if (!response.ok) throw new Error('AI gagal');
    const data = await response.json();
    let aiMessage = data.choices[0].message.content;
    aiMessage = aiMessage.replace(/```json|```/g, '').trim();
    let parsed = JSON.parse(aiMessage);
    
    if (parsed.options && Array.isArray(parsed.options)) {
      parsed.options = parsed.options.map(opt => typeof opt === 'object' ? (opt.name || opt.text || String(opt)) : opt);
    }

    if (selectedOption === 'quiz' && (parsed.type !== 'quiz' || !parsed.questions || parsed.questions.length === 0)) {
      console.warn("⚠️ AI gagal menghasilkan quiz, gunakan fallback manual");
      let quizTopic = topic;
      if (!quizTopic || quizTopic === '') {
        const lastUser = messages.filter(m => m.role === 'user').pop();
        if (lastUser && lastUser.content.toLowerCase().startsWith('pilih:')) {
          quizTopic = lastUser.content.replace(/^pilih:\s*/i, '').trim();
        } else if (messages.length >= 2) {
          const prevMsg = messages.slice(-2).find(m => m.role === 'user' && !m.content.toLowerCase().startsWith('pilih:'));
          if (prevMsg) quizTopic = prevMsg.content.substring(0, 50);
        }
        if (!quizTopic) quizTopic = 'topik ini';
      }
      parsed = {
        type: 'quiz',
        questions: [
          { text: `Apa yang dimaksud dengan ${quizTopic}?`, options: [`Pengertian ${quizTopic} yang benar`, `Definisi keliru`, `Konsep lain`, `Tidak ada yang benar`], correct: 0 },
          { text: `Manakah contoh dari ${quizTopic}?`, options: [`Contoh A (relevan)`, `Contoh B (tidak relevan)`, `Contoh C (kurang tepat)`, `Contoh D (salah)`], correct: 0 },
          { text: `Apa fungsi utama ${quizTopic} dalam pembelajaran?`, options: [`Fungsi A`, `Fungsi B`, `Fungsi C`, `Fungsi D`], correct: 0 },
          { text: `Bagaimana cara mengidentifikasi ${quizTopic} dalam suatu kasus?`, options: [`Cara A`, `Cara B`, `Cara C`, `Cara D`], correct: 0 },
          { text: `Kesimpulan penting tentang ${quizTopic} adalah?`, options: [`Kesimpulan A`, `Kesimpulan B`, `Kesimpulan C`, `Kesimpulan D`], correct: 0 }
        ],
        topic: quizTopic
      };
    }

    res.json(parsed);
  } catch (err) {
    console.error("❌ AI Error:", err.message);
    if (selectedOption === 'quiz') {
      let quizTopic = topic || 'topik';
      if (!quizTopic || quizTopic === '') {
        const lastUser = messages.filter(m => m.role === 'user').pop();
        if (lastUser && lastUser.content.toLowerCase().startsWith('pilih:')) {
          quizTopic = lastUser.content.replace(/^pilih:\s*/i, '').trim();
        }
        if (!quizTopic) quizTopic = 'topik';
      }
      res.json({
        type: 'quiz',
        questions: [
          { text: `Apa yang dimaksud dengan ${quizTopic}?`, options: [`Pengertian ${quizTopic}`, `Pilihan B`, `Pilihan C`, `Pilihan D`], correct: 0 },
          { text: `Manakah contoh ${quizTopic}?`, options: [`Contoh 1`, `Contoh 2`, `Contoh 3`, `Contoh 4`], correct: 0 },
          { text: `Apa fungsi utama ${quizTopic}?`, options: [`Fungsi A`, `Fungsi B`, `Fungsi C`, `Fungsi D`], correct: 0 },
          { text: `Apa hubungan ${quizTopic} dengan topik lain?`, options: [`Hubungan A`, `Hubungan B`, `Hubungan C`, `Hubungan D`], correct: 0 },
          { text: `Kesimpulan tentang ${quizTopic}?`, options: [`Kesimpulan A`, `Kesimpulan B`, `Kesimpulan C`, `Kesimpulan D`], correct: 0 }
        ],
        topic: quizTopic
      });
    } else {
      res.status(500).json({ type: 'text', content: 'AI sedang sibuk, coba lagi.' });
    }
  }
});

// ====================== OTHER ROUTES ======================
app.get('/api/stats', verifyToken, async (req, res) => {
  try {
    const materiList = await Materi.find({ userId: req.user.userId });
    const chatQuizList = await ChatQuiz.find({ userId: req.user.userId });
    let totalMateri = materiList.length;
    let totalQuizzes = 0, totalScore = 0;
    materiList.forEach(m => {
      if (m.quizResults && m.quizResults.length) {
        totalQuizzes += m.quizResults.length;
        totalScore += m.quizResults.reduce((sum, qr) => sum + qr.score, 0);
      }
    });
    chatQuizList.forEach(cq => { if (cq.score !== undefined) { totalQuizzes += 1; totalScore += cq.score; } });
    const avgScore = totalQuizzes > 0 ? Math.round(totalScore / totalQuizzes) : 0;
    res.json({ totalMateri, totalQuizzes, avgScore });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
    res.json({ name: user.name, email: user.email, nim: user.nim, university: user.university, preferences: user.preferences, avatar: user.avatar || '' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/profile', verifyToken, async (req, res) => {
  try {
    const { name, nim, university, preferences } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
    if (name !== undefined) user.name = name;
    if (nim !== undefined) user.nim = nim;
    if (university !== undefined) user.university = university;
    if (preferences) user.preferences = { ...user.preferences, ...preferences };
    await user.save();
    const newToken = jwt.sign({ userId: user._id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Profil diperbarui', token: newToken, user: { email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/profile/avatar', verifyToken, uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
  const avatarPath = `/uploads/avatars/${req.file.filename}`;
  try {
    await User.findByIdAndUpdate(req.user.userId, { avatar: avatarPath });
    res.json({ avatarUrl: `https://belajaryuk-production.up.railway.app${avatarPath}` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ====================== CHAT HISTORY ======================
app.get('/api/chat/history', verifyToken, async (req, res) => {
  try {
    const room = req.query.room || 'general';
    const messages = await Chat.find({ room }).sort({ time: 1 }).limit(100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ====================== AI FEEDBACK ======================
app.post('/api/ai-feedback', verifyToken, async (req, res) => {
  try {
    const { question, options, userAnswer, correctIndex } = req.body;
    const correctAnswer = options[correctIndex];
    const prompt = `Anda adalah tutor AI. Berikan penjelasan edukatif yang mendetail.
Pertanyaan: "${question}"
Pilihan: A.${options[0]} B.${options[1]} C.${options[2]} D.${options[3]}
Jawaban siswa: "${userAnswer}"
Jawaban benar: "${correctAnswer}"
Tugas: tentukan benar/salah, beri penjelasan panjang (min 3 kalimat, maks 8 kalimat) menggunakan contoh/analogi.
Output JSON: { "isCorrect": true/false, "explanation": "..." }`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.7, response_format: { type: "json_object" } })
    });
    if (!response.ok) throw new Error('Gagal memanggil AI');
    const data = await response.json();
    let aiMessage = data.choices[0].message.content;
    aiMessage = aiMessage.replace(/```json|```/g, '').trim();
    let feedback = JSON.parse(aiMessage);
    res.json(feedback);
  } catch (err) {
    res.status(500).json({ isCorrect: false, explanation: 'Maaf, AI sedang sibuk.' });
  }
});

// ====================== ROOM DOCUMENTS (SHARED DOCS) ======================
app.post('/api/room-document', verifyToken, async (req, res) => {
  try {
    const { roomCode, materiId } = req.body;
    if (!roomCode || !materiId) return res.status(400).json({ message: 'roomCode dan materiId wajib diisi' });
    const materi = await Materi.findById(materiId);
    if (!materi) return res.status(404).json({ message: 'Materi tidak ditemukan' });
    const existing = await RoomDocument.findOne({ roomCode, materiId });
    if (existing) return res.json({ message: 'Dokumen sudah dibagikan', doc: existing });
    const roomDoc = new RoomDocument({
      roomCode,
      materiId,
      sharedBy: req.user.userId,
      sharedByName: req.user.name || '',
      title: materi.title,
      source: materi.source,
      type: materi.type
    });
    await roomDoc.save();
    res.json({ message: 'Dokumen dibagikan ke ruang', doc: roomDoc });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/room-documents', verifyToken, async (req, res) => {
  try {
    const room = req.query.room || 'general';
    const docs = await RoomDocument.find({ roomCode: room }).sort({ sharedAt: -1 });
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/room-document/upload', verifyToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
  const { roomCode } = req.body;
  const filePath = req.file.path;
  const originalName = req.file.originalname;
  try {
    const extractedText = await extractTextFromFile(filePath, originalName);
    const aiQuiz = await generateQuizFromText(extractedText, originalName);
    const summary = `Ringkasan dari dokumen "${originalName}". ${extractedText.substring(0, 300)}...`;
    const newMateri = new Materi({
      userId: req.user.userId,
      title: originalName,
      type: 'document',
      source: `/uploads/${req.file.filename}`,
      summary: summary,
      quiz: aiQuiz,
      quizResults: []
    });
    await newMateri.save();
    if (roomCode) {
      const roomDoc = new RoomDocument({
        roomCode,
        materiId: newMateri._id,
        sharedBy: req.user.userId,
        sharedByName: req.user.name || '',
        title: newMateri.title,
        source: newMateri.source,
        type: newMateri.type
      });
      await roomDoc.save();
    }
    res.json({ message: 'Dokumen berhasil diproses & dibagikan', materi: newMateri });
  } catch (err) {
    console.error(err);
    const defaultQuiz = [
      { text: `Apa topik utama dari "${originalName}"?`, options: ["Pendahuluan", "Konsep Inti", "Studi Kasus", "Semua Benar"], correct: 3 },
      { text: "Aksi terbaik setelah membaca dokumen?", options: ["Mencatat", "Diskusi", "Kuis", "Semua di atas"], correct: 3 }
    ];
    const newMateri = new Materi({
      userId: req.user.userId,
      title: originalName,
      type: 'document',
      source: `/uploads/${req.file.filename}`,
      summary: `Dokumen: ${originalName}. Silakan baca untuk memahami.`,
      quiz: defaultQuiz,
      quizResults: []
    });
    await newMateri.save();
    if (roomCode) {
      const roomDoc = new RoomDocument({
        roomCode,
        materiId: newMateri._id,
        sharedBy: req.user.userId,
        sharedByName: req.user.name || '',
        title: newMateri.title,
        source: newMateri.source,
        type: newMateri.type
      });
      await roomDoc.save();
    }
    res.json({ message: 'Dokumen diupload & dibagikan (quiz default)', materi: newMateri });
  }
});

// ====================== SOCKET.IO ======================
let onlineUsers = {};
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('user online', (userName) => {
    onlineUsers[socket.id] = userName;
    io.emit('update online users', Object.values(onlineUsers));
  });

  socket.on('join-room', (roomCode) => {
    if (socket.room) {
      socket.leave(socket.room);
    }
    socket.join(roomCode);
    socket.room = roomCode;
    console.log(`Socket ${socket.id} joined room ${roomCode}`);
    socket.emit('joined-room', roomCode);
  });

  socket.on('chat message', async (msg) => {
    try {
      const room = socket.room || 'general';
      const newMsg = new Chat({ room, sender: msg.sender, text: msg.text });
      await newMsg.save();
      io.to(room).emit('chat message', newMsg);
    } catch (err) { console.error(err); }
  });

  socket.on('share-document', async (data) => {
    try {
      const room = socket.room || data.roomCode || 'general';
      const { materiId, title, source, sharedByName } = data;
      io.to(room).emit('room-documents-updated', { materiId, title, source, sharedByName, room });
    } catch (err) { console.error(err); }
  });

  socket.on('get-room-documents', async (roomCode) => {
    try {
      const room = roomCode || socket.room || 'general';
      const docs = await RoomDocument.find({ roomCode: room }).sort({ sharedAt: -1 });
      socket.emit('room-documents-list', docs);
    } catch (err) { console.error(err); }
  });

  socket.on('start-shared-quiz', (data) => {
    const room = socket.room || data.roomCode || 'general';
    io.to(room).emit('shared-quiz-started', data);
  });

  socket.on('shared-quiz-answer', (data) => {
    const room = socket.room || data.roomCode || 'general';
    io.to(room).emit('member-answered', { ...data, room });
  });

  socket.on('request-online-users', () => {
    socket.emit('update online users', Object.values(onlineUsers));
  });

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    io.emit('update online users', Object.values(onlineUsers));
  });
});

// ====================== START SERVER ======================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server jalan di port ${PORT}`);
});