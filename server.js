const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());

const CATALOG_URL = process.env.CATALOG_URL || "http://localhost:5000";
const client = new MongoClient(process.env.MONGO_URL || "mongodb://localhost:27017");
let db;

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

async function getCourse(id) {
  const r = await fetch(`${CATALOG_URL}/courses/${id}`);
  return r.ok ? r.json() : null;
}

app.get("/health", (_, res) => res.json({ status: "UP" }));

// Command: create quiz (calls Catalog Service to verify the course)
app.post("/quizzes", wrap(async (req, res) => {
  const { courseId, title, questions } = req.body;
  if (!courseId || !Array.isArray(questions) || !questions.length)
    return res.status(400).json({ error: "courseId and questions are required" });
  const course = await getCourse(courseId);
  if (!course) return res.status(404).json({ error: "course not found in catalog" });
  const r = await db.collection("quizzes").insertOne({ courseId, title, questions });
  res.status(201).json({ id: r.insertedId, courseId, title, totalQuestions: questions.length });
}));

// Query: get quiz (answers hidden)
app.get("/quizzes/:id", wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "invalid id" });
  const q = await db.collection("quizzes").findOne({ _id: new ObjectId(req.params.id) });
  if (!q) return res.status(404).json({ error: "quiz not found" });
  q.questions = q.questions.map(({ text, options }) => ({ text, options }));
  res.json(q);
}));

// Command: submit quiz and grade
app.post("/submissions", wrap(async (req, res) => {
  const { studentId, quizId, answers } = req.body;
  if (!studentId || !ObjectId.isValid(quizId) || !Array.isArray(answers))
    return res.status(400).json({ error: "studentId, quizId and answers are required" });
  const quiz = await db.collection("quizzes").findOne({ _id: new ObjectId(quizId) });
  if (!quiz) return res.status(404).json({ error: "quiz not found" });
  const course = await getCourse(quiz.courseId);
  if (!course) return res.status(502).json({ error: "catalog service unavailable or course missing" });
  let score = 0;
  quiz.questions.forEach((q, i) => { if (answers[i] === q.answer) score++; });
  const percent = Math.round((score / quiz.questions.length) * 100);
  const doc = { studentId, quizId, courseId: quiz.courseId, score,
                total: quiz.questions.length, percent, passed: percent >= 50,
                submittedAt: new Date() };
  await db.collection("submissions").insertOne(doc);
  res.status(201).json(doc);
}));

// Query: transcript (composes data from Catalog Service)
app.get("/students/:id/transcript", wrap(async (req, res) => {
  const subs = await db.collection("submissions").find({ studentId: req.params.id }).toArray();
  const out = [];
  for (const s of subs) {
    const c = await getCourse(s.courseId).catch(() => null);
    out.push({ courseTitle: c ? c.title : "unknown", quizId: s.quizId,
               score: s.score, total: s.total, percent: s.percent, passed: s.passed });
  }
  res.json({ studentId: req.params.id, results: out });
}));

client.connect().then(() => {
  db = client.db("assessment");
  app.listen(3000, () => console.log("assessment-service on 3000"));
});
