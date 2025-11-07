import express from "express";
import multer from "multer";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { PDFDocument } from "pdf-lib";
import { spawnSync } from "child_process";

const app = express();
app.locals.lastAgentPing = null;

const allowedOrigins = [
  "https://webprintrdbi.siunand.my.id",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // non-browser / curl
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// pastikan folder uploads ada
const UPLOAD_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
// folder khusus untuk file preview
const PREVIEW_DIR = path.join(UPLOAD_DIR, "previews");
if (!fs.existsSync(PREVIEW_DIR)) {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });

// storage untuk preview
const previewStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PREVIEW_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const previewUpload = multer({ storage: previewStorage });

function pickImageConvertCmd() {
  const candidates = process.platform === "win32" ? ["magick"] : ["convert", "magick"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-version"]);
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

// Reusable conversion helper: returns path to a PDF (original if already PDF or conversion failed)
function resolveLibreOffice() {
  const envPath = process.env.LIBREOFFICE_CMD;
  if (envPath) return envPath;
  // Common Windows install paths
  const candidates = process.platform === "win32"
    ? [
        "C:/Program Files/LibreOffice/program/soffice.com",
        "C:/Program Files/LibreOffice/program/soffice.exe",
        "C:/Program Files (x86)/LibreOffice/program/soffice.com",
        "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
        "soffice.com",
        "soffice",
      ]
    : ["soffice"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { timeout: 5000, windowsHide: true, stdio: "ignore" });
      if (r.status === 0) return c;
    } catch {}
  }
  return "soffice"; // fallback; may still fail
}

function convertToPdf(originalPath, outDir = UPLOAD_DIR) {
  const result = { outputPath: originalPath, converted: false, error: null };
  try {
    const ext = path.extname(originalPath).toLowerCase();
    if (ext === ".pdf") return { ...result, converted: false };

    const base = path.basename(originalPath, ext);
    const targetPdf = path.join(outDir, `${base}.pdf`);
    const altTargetPdfUpper = path.join(outDir, `${base}.PDF`);
    const isImage = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tiff"].includes(ext);
    const isDoc = [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt"].includes(ext);

    if (isImage) {
      const imgCmd = pickImageConvertCmd();
      if (imgCmd) {
        const r = spawnSync(imgCmd, [originalPath, targetPdf], { timeout: 30000, stdio: "ignore", windowsHide: true });
        if (r.status === 0 && fs.existsSync(targetPdf)) {
          try { fs.unlinkSync(originalPath); } catch {}
          return { ...result, outputPath: targetPdf, converted: true };
        }
        result.error = `ImageMagick gagal`;
      } else {
        result.error = "ImageMagick tidak ditemukan";
      }
    } else if (isDoc) {
      const soffice = resolveLibreOffice();
      // Tambahkan flags headless penuh, dan sembunyikan window
      const args = [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--norestore",
        "--nodefault",
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        outDir,
        originalPath,
      ];
      const r = spawnSync(soffice, args, { timeout: 120000, stdio: "ignore", windowsHide: true });
      if (r.status === 0) {
        const produced = fs.existsSync(targetPdf) ? targetPdf : (fs.existsSync(altTargetPdfUpper) ? altTargetPdfUpper : null);
        if (produced) {
          try { fs.unlinkSync(originalPath); } catch {}
          return { ...result, outputPath: produced, converted: true };
        }
        result.error = "LibreOffice selesai tapi file PDF tidak ditemukan";
      } else {
        result.error = `LibreOffice gagal status=${r.status}`;
      }
    }
  } catch (e) {
    result.error = e?.message || String(e);
  }
  return result;
}

app.use("/uploads", express.static(UPLOAD_DIR));

let printQueue = [];
// health & agent heartbeat
app.get("/api/health", (req, res) => {
  const last = app.locals.lastAgentPing;
  const now = Date.now();
  const agentOnline = last ? (now - last < 20000) : false; // 20s threshold
  const pending = printQueue.filter((j) => j.status === "pending").length;
  res.json({ ok: true, time: new Date().toISOString(), agentOnline, lastAgentPing: last, queueLength: pending });
});

app.post("/api/agent/ping", (req, res) => {
  app.locals.lastAgentPing = Date.now();
  res.json({ message: "pong" });
});

// helper simple validasi halaman (format: "1,3-5")
const isValidPages = (pages, total) => {
  if (!pages) return true;
  const trimmed = pages.trim();
  const pattern = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;
  if (!pattern.test(trimmed)) return false;
  if (!total) return true;
  const tokens = trimmed.split(",").map((t) => t.trim());
  for (const t of tokens) {
    if (t.includes("-")) {
      const [a, b] = t.split("-").map((x) => parseInt(x.trim(), 10));
      if (!a || !b || a < 1 || b < 1 || a > b || b > total) return false;
    } else {
      const n = parseInt(t, 10);
      if (!n || n < 1 || n > total) return false;
    }
  }
  return true;
};

// tambah helper parsePages
const parsePages = (pages, total) => {
  if (!pages) return null;
  const trimmed = pages.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(",").map(t => t.trim());
  const set = new Set();
  for (const t of tokens) {
    if (t.includes("-")) {
      const [aS, bS] = t.split("-").map(x => x.trim());
      const a = parseInt(aS, 10);
      const b = parseInt(bS, 10);
      if (Number.isNaN(a) || Number.isNaN(b) || a > b) continue;
      for (let i = a; i <= b; i++) {
        if (total && (i < 1 || i > total)) continue;
        set.add(i);
      }
    } else {
      const n = parseInt(t, 10);
      if (Number.isNaN(n)) continue;
      if (total && (n < 1 || n > total)) continue;
      set.add(n);
    }
  }
  return Array.from(set).sort((x, y) => x - y);
};

app.post("/api/preview", previewUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "File tidak ditemukan" });

  const originalExt = path.extname(req.file.originalname).toLowerCase();
  const isPdf = originalExt === ".pdf";
  const isImage = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tiff"].includes(originalExt);
  const isDoc = [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt"].includes(originalExt);

  const conv = convertToPdf(req.file.path, PREVIEW_DIR);
  const fileName = path.basename(conv.outputPath);
  const previewUrl = `/uploads/previews/${fileName}`;

  if (!conv.converted && isDoc) {
    // Dokumen tidak bisa dipreview jika gagal konversi → kirim 422 dan hapus file original
    try {
      if (conv.outputPath && fs.existsSync(conv.outputPath)) fs.unlinkSync(conv.outputPath);
    } catch {}
    console.warn("❌ Preview gagal dikonversi (dokumen):", req.file.originalname, "error:", conv.error);
    return res.status(422).json({
      message: "Konversi dokumen gagal. Pastikan LibreOffice terpasang dan LIBREOFFICE_CMD diset ke path 'soffice'.",
      converted: false,
      conversionError: conv.error || "LibreOffice tidak ditemukan / gagal berjalan",
      needLibreOffice: true,
    });
  }

  console.log("🔍 Preview dibuat:", req.file.originalname, "->", fileName, conv.converted ? "(converted)" : "(original)");
  return res.json({
    message: conv.converted ? "Preview siap" : (isImage ? "Preview file gambar asli" : "Preview file asli"),
    previewUrl,
    fileName,
    converted: conv.converted,
    conversionError: conv.error,
    originalExt,
  });
});

// hapus file preview tertentu (manual cleanup)
app.post("/api/preview/cleanup", express.json(), (req, res) => {
  const { fileName } = req.body || {};
  if (!fileName || typeof fileName !== "string") return res.status(400).json({ message: "fileName diperlukan" });
  const target = path.join(PREVIEW_DIR, path.basename(fileName));
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return res.json({ message: "Preview dihapus" });
    }
    return res.status(404).json({ message: "File preview tidak ditemukan" });
  } catch (e) {
    return res.status(500).json({ message: "Gagal menghapus preview", error: String(e) });
  }
});

// pembersihan berkala: hapus preview lebih tua dari 1 jam
function cleanupOldFiles(dir, maxAgeMs) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(full);
          console.log("🧹 Preview lama dihapus:", full);
        }
      } catch {}
    }
  } catch {}
}
setInterval(() => cleanupOldFiles(PREVIEW_DIR, 60 * 60 * 1000), 10 * 60 * 1000);

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "File tidak ditemukan" });
  }

  // ambil settings dari form-data
  const {
    copies = "1",
    color = "bw",
    paperSize = "A4",
    orientation = "portrait",
    printer = "",
    pages = "",
    numPages = null,
  } = req.body;

  const copiesNum = parseInt(copies, 10) || 1;
  const totalPages = numPages ? parseInt(numPages, 10) : null;

  // validasi pages jika total halaman diketahui dikirim frontend (opsional)
  if (pages && totalPages && !isValidPages(pages, totalPages)) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ message: "Format halaman tidak valid atau di luar rentang" });
  }

  const pagesArray = parsePages(pages, totalPages);

  // unified conversion
  const conv = convertToPdf(req.file.path);
  const storedPath = conv.outputPath;

  const job = {
    id: uuidv4(),
    originalName: req.file.originalname,
    fileName: path.basename(storedPath),
    filePath: storedPath,
    status: "pending",
    createdAt: new Date(),
    settings: {
      copies: copiesNum,
      color,
      paperSize,
      orientation,
      printer,
      pages: pages ? pages.trim() : "",
      pagesArray, // array halaman yang akan dicetak (atau null)
    },
    totalPages,
  };

  printQueue.push(job);
  console.log("📄 File masuk antrian:", job.originalName, "| settings:", job.settings);

  res.json({ message: "File berhasil diunggah dan masuk antrian", job });
});

app.get("/api/queue", (req, res) => {
  const pendingJobs = printQueue.filter((job) => job.status === "pending");
  res.json(pendingJobs);
});

app.post("/api/queue/:id/done", (req, res) => {
  const job = printQueue.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ message: "Job tidak ditemukan" });
  job.status = "done";

  // hapus file upload setelah job ditandai selesai
  try {
    if (job.filePath && fs.existsSync(job.filePath)) {
      fs.unlinkSync(job.filePath);
      console.log("Uploaded file dihapus (done):", job.filePath);
    }
  } catch (e) {
    console.warn("Gagal menghapus uploaded file saat done:", e);
  }

  res.json({ message: "Job selesai dicetak & file dihapus" });
});

// helper: extract selected pages into a temporary PDF file
const extractPagesToTemp = async (originalPath, pagesArray) => {
  if (!pagesArray || pagesArray.length === 0) return originalPath;
  try {
    const data = fs.readFileSync(originalPath);
    const srcPdf = await PDFDocument.load(data);
    const outPdf = await PDFDocument.create();

    // convert to zero-based indexes and filter
    const zeroBased = pagesArray.map(p => p - 1).filter(i => i >= 0 && i < srcPdf.getPageCount());
    if (zeroBased.length === 0) return originalPath;

    const copied = await outPdf.copyPages(srcPdf, zeroBased);
    copied.forEach(pg => outPdf.addPage(pg));

    const bytes = await outPdf.save();
    const tmpName = `${uuidv4()}.pdf`;
    const tmpPath = path.join(UPLOAD_DIR, tmpName);
    fs.writeFileSync(tmpPath, bytes);
    return tmpPath;
  } catch (err) {
    console.error("extractPagesToTemp error:", err);
    return originalPath;
  }
};

// endpoint: trigger printing of a queued job and delete uploaded files afterwards
app.post("/api/print/:id", async (req, res) => {
  const job = printQueue.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ message: "Job tidak ditemukan" });
  if (job.status !== "pending") return res.status(400).json({ message: "Job sudah diproses atau sedang diproses" });

  job.status = "printing";
  let fileToPrint = job.filePath;
  let tmpCreated = false;

  try {
    const pagesArray = job.settings?.pagesArray || null;
    if (pagesArray && Array.isArray(pagesArray) && pagesArray.length > 0) {
      // buat PDF sementara yang hanya memuat halaman yang diminta
      const tmp = await extractPagesToTemp(job.filePath, pagesArray);
      if (tmp && tmp !== job.filePath) {
        fileToPrint = tmp;
        tmpCreated = true;
      }
    }

    // === Tempatkan logika printing riil Anda di sini ===
    // Contoh placeholder: log dan tunggu 1s untuk simulasi
    console.log(`Mencetak job ${job.id} -> file: ${fileToPrint} copies: ${job.settings.copies}`);
    await new Promise(r => setTimeout(r, 1000));

    // tandai selesai
    job.status = "done";
    job.completedAt = new Date();

    res.json({ message: "Job dicetak (simulasi)", jobId: job.id });
  } catch (err) {
    console.error("Error saat mencetak:", err);
    job.status = "error";
    return res.status(500).json({ message: "Gagal mencetak", error: String(err) });
  } finally {
    // hapus temporary jika dibuat (uploaded file akan dihapus saat client menandai done)
    if (tmpCreated && fileToPrint && fileToPrint !== job.filePath) {
      try {
        if (fs.existsSync(fileToPrint)) {
          fs.unlinkSync(fileToPrint);
          console.log("Temporary file dihapus:", fileToPrint);
        }
      } catch (e) {
        console.warn("Gagal menghapus temporary file:", e);
      }
    }
  }
});

// endpoint: stream-kan file hasil subset halaman (tanpa menyimpan file sementara di server)
app.get("/api/print-file/:id", async (req, res) => {
  const job = printQueue.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ message: "Job tidak ditemukan" });
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(410).json({ message: "File tidak tersedia" });
  }

  try {
    const pagesArray = job.settings?.pagesArray;
    if (pagesArray && Array.isArray(pagesArray) && pagesArray.length > 0) {
      // generate subset PDF in-memory
      const data = fs.readFileSync(job.filePath);
      const srcPdf = await PDFDocument.load(data);
      const outPdf = await PDFDocument.create();
      const zeroBased = pagesArray.map(p => p - 1).filter(i => i >= 0 && i < srcPdf.getPageCount());
      if (zeroBased.length === 0) {
        // jika range tidak valid, kirim file asli
        return res.sendFile(job.filePath);
      }
      const copied = await outPdf.copyPages(srcPdf, zeroBased);
      copied.forEach(pg => outPdf.addPage(pg));
      const bytes = await outPdf.save();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="subset-${job.originalName || job.fileName}"`);
      return res.end(Buffer.from(bytes));
    }
    // jika tidak ada pagesArray, kirim file asli
    return res.sendFile(job.filePath);
  } catch (err) {
    console.error("Gagal membuat subset PDF:", err);
    // fallback kirim file asli
    try { return res.sendFile(job.filePath); } catch (e) {}
    return res.status(500).json({ message: "Gagal menyiapkan file untuk cetak" });
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Backend berjalan di http://localhost:${PORT}`));