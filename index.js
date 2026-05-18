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

// MIDDLEWARE
app.use(cors({
    origin: "https://belajaryuk-production.up.railway.app"
}));
app.use(express.static(path.join(__dirname, 'FRONTEND')));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// KONEKSI DATABASE
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

  role: {
    type: String,
    enum: ['admin', 'student'],
    default: 'student'
  },

  name: { type: String, default: '' },
  nim: { type: String, default: '' },
  university: { type: String, default: '' },
  avatar: { type: String, default: '' },

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
  level: String,
  formula: String,
  explanation: String,
  userAnswer: Number,
  isCorrect: Boolean
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

// VERIFY TOKEN
const verifyToken = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (!token) return res.status(401).json({ message: 'Akses ditolak' });
  const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      message: 'Akses admin ditolak'
    });
  }

  next();
};
  try {
    const decoded = jwt.verify(token, 'SECRET_KEY');
    req.user = decoded;
    next();
  } catch (err) {
    res.status(400).json({ message: 'Token tidak valid' });
  }
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

  const prompt = `Buat ${estimatedQuestions} soal pilihan ganda dari materi berikut dengan distribusi level: 30% easy, 40% medium, 30% hard. Setiap soal sertakan rumus (jika relevan) dan penjelasan cara kerja. Output JSON: { "questions": [ { "text": "...", "options": [...], "correct": 0, "level": "easy/medium/hard", "formula": "...", "explanation": "..." } ] }`;

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
  let parsed;

try {
   parsed = JSON.parse(cleaned);
} catch(err) {
   console.error("JSON Parse Error:", err);
   throw new Error("AI menghasilkan format invalid");
}
  let questions = parsed.questions || (Array.isArray(parsed) ? parsed : []);
  return questions.filter(q => q.text && Array.isArray(q.options) && q.options.length === 4 && typeof q.correct === 'number');
}

// ====================== MULTER UPLOAD ======================
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

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung'));
    }
  }
});
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/avatars';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },

  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },

  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/jpg',
      'image/webp'
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format avatar tidak didukung'));
    }
  }
});
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
    const userBaru = new User({email, password: hashedPassword, name: userName, role: 'student'});
    await userBaru.save();
    const token = jwt.sign({ userId: userBaru._id, email: userBaru.email, name: userBaru.name }, 'SECRET_KEY', { expiresIn: '7d' });
    res.json({ message: 'Registrasi berhasil', token, user: { email: userBaru.email, name: userBaru.name } });
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
    const token = jwt.sign({userId: user._id, email: user.email, name: user.name, role: user.role}, 'SECRET_KEY', { expiresIn: '7d' });
    res.json({message: 'Login berhasil', token, user: { email: user.email, name: user.name, role: user.role}});
  } catch (error) {
    res.status(500).json({ message: 'Terjadi error', error: error.message });
  }
});

// ====================== MATERI & QUIZ PROGRESS ======================
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
  // Tentukan level berdasarkan stepIndex
  let level = '';
  if (stepIndex <= 3) level = 'easy';
  else if (stepIndex <= 10) level = 'medium';
  else level = 'hard';

  const levelDesc = {
    easy: 'Dasar – konsep fundamental, soal sederhana',
    medium: 'Menengah – penerapan rumus, analisis sederhana',
    hard: 'Lanjutan – pemecahan masalah kompleks, multi-langkah'
  };

  let prompt = `Anda adalah AI tutor profesional.
Topik: "${topic}"
Ini adalah langkah ${stepIndex} dari ${totalSteps} (level: ${level} - ${levelDesc[level]}).

TUGAS:
1. Berikan penjelasan mendalam tentang satu aspek spesifik dari topik ini, sesuai level.
2. Jika topik eksakta (matematika/fisika/statistika): sertakan rumus, arti simbol, contoh perhitungan, langkah pengerjaan.
3. Jika topik non-eksakta: jelaskan konsep, berikan contoh konkret, aplikasi sederhana.
4. Setelah penjelasan, buat 1 soal pilihan ganda yang menguji pemahaman langkah ini.
   - Soal harus ORISINAL, tidak berulang dengan langkah sebelumnya.
   - Sesuaikan tingkat kesulitan dengan level.
5. Sertakan pembahasan singkat untuk jawaban benar.
Setiap options HARUS berupa teks polos tanpa awalan A., B., C., atau D.
Frontend yang akan menampilkan label huruf.
FORMAT JSON (WAJIB, tanpa teks lain):
{
  "type": "step",
  "stepIndex": ${stepIndex},
  "totalSteps": ${totalSteps},
  "explanation": "Penjelasan detail...",
  "formula": "Rumus (jika ada, string kosong jika tidak)",
  "formulaExplanation": "Penjelasan rumus",
  "example": "Contoh konkret (bisa hitungan atau ilustrasi)",
  "question": {
    "text": "Soal pilihan ganda...",
    "level": "${level}",
    "options": ["...", "...", "...", "..."],
    "correct": 0,
    "explanation": "Pembahasan singkat jawaban benar"
  }
}`;

  if (previousAnswer) {
    prompt = `Jawaban siswa untuk langkah sebelumnya: "${previousAnswer}". Berikan feedback singkat (1-2 kalimat) apakah jawabannya tepat, lalu lanjutkan ke langkah ${stepIndex}.\n\n${prompt}`;
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error('Gagal generate step');
    const data = await response.json();
    let content = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(content);
  } catch (error) {
    console.error('Error generateStep:', error);
    return {
      type: 'step',
      stepIndex,
      totalSteps,
      explanation: `Penjelasan untuk langkah ${stepIndex} dari topik "${topic}". (AI sedang sibuk)`,
      formula: '',
      formulaExplanation: '',
      example: '',
      question: {
        text: `Apa poin penting dari langkah ${stepIndex}?`,
        level: level,
        options: ['Pilihan 1', 'Pilihan 2', 'Pilihan 3', 'Pilihan 4'],
        correct: 0,
        explanation: 'Jawaban yang benar adalah A.'
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
  const { messages, selectedOption, topic, stepState } = req.body;

  try {

    // ================= STEP MODE =================
    // ================= STEP MODE =================
if (selectedOption === 'step') {
  const currentStep = stepState?.stepIndex || 1;
  const totalSteps = stepState?.totalSteps || 16;  // <-- default 16 langkah
  const currentTopic = topic || messages.find(m => m.role === 'user')?.content || 'belajar';

  if (currentStep <= totalSteps) {
    const stepData = await generateStep(currentTopic, currentStep, totalSteps);
    return res.json(stepData);
  } else {
    return res.json({ type: 'step_complete', message: `🎉 Selamat! Anda telah menyelesaikan ${totalSteps} langkah.` });
  }
}

    // ================= HANDLE JAWABAN STEP =================
    const lastUserMsg = messages
      .filter(m => m.role === 'user')
      .pop();

    if (
      lastUserMsg &&
      lastUserMsg.content.toLowerCase().startsWith('jawaban:')
    ) {

      const match = lastUserMsg.content.match(/jawaban:\s*([A-D])/i);

      const userAnswerLetter = match
        ? match[1].toUpperCase()
        : null;

      const currentStepIndex = stepState?.stepIndex || 1;
      const totalSteps = stepState?.totalSteps || 5;
      const currentTopic = topic || 'belajar';

      if (currentStepIndex >= totalSteps) {

        return res.json({
          type: 'step_complete',
          message:
            `✅ Jawaban diterima. Anda telah menyelesaikan ` +
            `${totalSteps} langkah.`
        });

      } else {

        const nextStepIndex = currentStepIndex + 1;

        const nextStep = await generateStep(
          currentTopic,
          nextStepIndex,
          totalSteps,
          userAnswerLetter
        );

        return res.json(nextStep);
      }
    }

    // ================= SYSTEM PROMPT =================
const systemPrompt = `
Anda adalah AI tutor profesional berbasis kurikulum akademik.

1. SUBTOPIC
Jika user minta topik baru:
Output:
{
  "type": "subtopics",
  "message": "...",
  "options": [...]
}

2. PENJELASAN + OPSI
Jika user pilih subtopik (diawali "Pilih:")
Output:
{
  "type": "explanation_with_options",
  "content": "...",
  "topic": "...",
  "message": "...",
  "options": ["Quiz","Pemahaman Step by Step"]
  }


3. QUIZ
Jika user pilih Quiz:
Output:
{
  "type": "quiz",
  "questions": [...],
  "topic": "..."
}

4. STEP
Jika user pilih Step:
Frontend akan handle sendiri.

HANYA JSON.

ATURAN KHUSUS SUBTOPIK:
- Saat output "type" adalah "subtopics", buat JUMLAH sub topik MAKSIMAL 20.
- Jika model ingin memberikan lebih dari 20, potong menjadi 20 (prioritaskan sub topik paling relevan dan berurutan logis).
`;





    // ================= USER PROMPT =================
    const lastUserMsg2 = messages
      .filter(m => m.role === 'user')
      .pop();

    let userPrompt = "";

    // ===== QUIZ =====
    if (selectedOption === 'quiz') {

      userPrompt = `
User memilih QUIZ untuk topik "${topic}"

Buat 10 soal pilihan ganda dengan level:

1-3 easy
4-7 medium
8-10 hard

Setiap soal memiliki:
- text
- level
- formula
- explanation
- options
- correct

HANYA JSON.
`;

    }
    // ===== SUBTOPIC =====
    else if (
      lastUserMsg2 &&
      lastUserMsg2.content.toLowerCase().startsWith('pilih:')
    ) {

      const subtopicName = lastUserMsg2.content
        .replace(/^pilih:\s*/i, '')
        .trim();

      userPrompt =
        `User memilih subtopik "${subtopicName}". ` +
        `Berikan penjelasan mendalam dan opsi Quiz & Step.`;

    }
    // ===== DEFAULT =====
    else {

      userPrompt = lastUserMsg2
        ? lastUserMsg2.content
        : "Halo";
    }

    // ================= FULL PROMPT =================
    const fullPrompt = `
${systemPrompt}

Riwayat:
${JSON.stringify(messages)}

Instruksi:
${userPrompt}
`;

    // ================= CALL AI =================
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'user',
              content: fullPrompt
            }
          ],
          temperature: 0.6,
          response_format: {
            type: "json_object"
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error('AI gagal');
    }

    const data = await response.json();

    let aiMessage =
      data.choices[0].message.content;

    aiMessage = aiMessage
      .replace(/```json|```/g, '')
      .trim();

    let parsed = JSON.parse(aiMessage);

    // ================= NORMALIZE OPTIONS =================
    if (
      parsed.options &&
      Array.isArray(parsed.options)
    ) {

      parsed.options = parsed.options.map(opt =>
        typeof opt === 'object'
          ? (opt.name || opt.text || String(opt))
          : opt
      );
    }

    // ================= FALLBACK QUIZ =================
    if (
      selectedOption === 'quiz' &&
      (
        parsed.type !== 'quiz' ||
        !parsed.questions ||
        parsed.questions.length === 0
      )
    ) {

      const levels = [
        'easy',
        'easy',
        'easy',
        'medium',
        'medium',
        'medium',
        'medium',
        'hard',
        'hard',
        'hard'
      ];

      const fallbackQuestions = [];

      for (let i = 0; i < 10; i++) {

        fallbackQuestions.push({
          text:
            `Soal ${i + 1} tentang ${topic}`,

          options: [
            'Jawaban A',
            'Jawaban B',
            'Jawaban C',
            'Jawaban D'
          ],

          correct: 0,

          level: levels[i],

          formula:
            levels[i] === 'easy'
              ? 'Rumus Dasar'
              : 'Rumus Lanjutan',

          explanation:
            `Penjelasan soal ${i + 1}`
        });
      }

      parsed = {
        type: 'quiz',
        topic: topic || 'topik',
        questions: fallbackQuestions
      };
    }

    // ================= RETURN =================
    return res.json(parsed);

  } catch (err) {

    console.error("❌ AI Error:", err);

    return res.status(500).json({
      type: 'text',
      content: 'AI sedang sibuk, coba lagi.'
    });
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
    const newToken = jwt.sign({userId: user._id, email: user.email, name: user.name, role: user.role}, 'SECRET_KEY', { expiresIn: '7d' });
    res.json({ message: 'Profil diperbarui', token: newToken, user: { email: user.email, name: user.name, role: user.role}});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/profile/avatar', verifyToken, uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Tidak ada file yang diupload' });
  const avatarPath = `/uploads/avatars/${req.file.filename}`;
  try {
    await User.findByIdAndUpdate(req.user.userId, { avatar: avatarPath });
    res.json({ avatarUrl: `https://belajaryuk-production.up.railway.app/${avatarPath}` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ====================== CHAT HISTORY (DENGAN ROOM) ======================
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
    // Auto-share to room if roomCode provided
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

// ====================== SOCKET.IO (DENGAN PRIVATE ROOM) ======================
let onlineUsers = {};
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('user online', (userName) => {
    onlineUsers[socket.id] = userName;
    io.emit('update online users', Object.values(onlineUsers));
  });

  // Event untuk bergabung ke room tertentu (private room)
  socket.on('join-room', (roomCode) => {
    if (socket.room) {
      socket.leave(socket.room);
    }
    socket.join(roomCode);
    socket.room = roomCode;
    console.log(`Socket ${socket.id} joined room ${roomCode}`);
    socket.emit('joined-room', roomCode);
  });

  // Event chat message dikirim ke room yang sudah disimpan
  socket.on('chat message', async (msg) => {
    try {
      const room = socket.room || 'general';
      const newMsg = new Chat({ room: room, sender: msg.sender, text: msg.text });
      await newMsg.save();
      io.to(room).emit('chat message', newMsg);
    } catch (err) { console.error(err); }
  });

  // Shared document events
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

  // Collaborative quiz events
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

// ====================== ADMIN ROUTES ======================

// Ambil semua user
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Hapus user
app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        message: 'User tidak ditemukan'
      });
    }

    // jangan hapus admin
    if (user.role === 'admin') {
      return res.status(403).json({
        message: 'Admin tidak bisa dihapus'
      });
    }

    // hapus materi user
    await Materi.deleteMany({
      userId: user._id
    });

    // hapus user
    await User.findByIdAndDelete(req.params.id);

    res.json({
      message: 'User berhasil dihapus'
    });

  } catch (err) {
    res.status(500).json({
      message: err.message
    });
  }
});

// Ambil semua materi
app.get('/api/admin/materi', verifyToken, verifyAdmin, async (req, res) => {
  try {

    const materi = await Materi.find()
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

    res.json(materi);

  } catch (err) {
    res.status(500).json({
      message: err.message
    });
  }
});

// Hapus materi
app.delete('/api/admin/materi/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {

    const materi = await Materi.findById(req.params.id);

    if (!materi) {
      return res.status(404).json({
        message: 'Materi tidak ditemukan'
      });
    }

    await Materi.findByIdAndDelete(req.params.id);

    res.json({
      message: 'Materi berhasil dihapus'
    });

  } catch (err) {
    res.status(500).json({
      message: err.message
    });
  }
});

// ====================== START SERVER ======================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server jalan di port ${PORT}`);
});


