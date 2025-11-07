import express from "express";
import multer from "multer";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { PDFDocument } from "pdf-lib";
import { spawnSync } from "child_process";

const app = express();

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });

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

app.use("/uploads", express.static(UPLOAD_DIR));

let printQueue = [];

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

  // convert non-PDF uploads to PDF when possible (images via ImageMagick, docs via LibreOffice)
  let storedPath = req.file.path;
 try {
    const ext = path.extname(storedPath).toLowerCase();
    if (ext !== ".pdf") {
      const base = path.basename(storedPath, ext);
      const targetPdf = path.join(UPLOAD_DIR, `${base}.pdf`);
      const isImage = [".png",".jpg",".jpeg",".bmp",".gif",".webp",".tiff"].includes(ext);
      const isDoc = [".doc",".docx",".ppt",".pptx",".xls",".xlsx",".odt"].includes(ext);

      if (isImage) {
        const imgCmd = pickImageConvertCmd();
        if (imgCmd) {
          const r = spawnSync(imgCmd, [storedPath, targetPdf], { stdio: "ignore", timeout: 30000 });
          if (r.status === 0 && fs.existsSync(targetPdf)) {
            try { fs.unlinkSync(storedPath); } catch {}
            storedPath = targetPdf;
          } else {
            console.warn("Konversi gambar gagal. Lanjutkan file asli.");
          }
        } else {
          console.warn("ImageMagick tidak ditemukan di server. Lewati konversi gambar.");
        }
      } else if (isDoc) {
        const soffice = process.env.LIBREOFFICE_CMD || "soffice";
        const r = spawnSync(soffice, ["--headless","--convert-to","pdf","--outdir",UPLOAD_DIR,storedPath], { stdio: "ignore", timeout: 90000 });
        if (r.status === 0 && fs.existsSync(targetPdf)) {
          try { fs.unlinkSync(storedPath); } catch {}
          storedPath = targetPdf;
        } else {
          console.warn("Konversi dokumen gagal. Lanjutkan file asli.");
        }
      }
    }
  } catch (e) {
    console.warn("Konversi otomatis ke PDF gagal, lanjutkan dengan file asli:", e?.message || e);
  }

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