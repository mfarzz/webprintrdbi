const { exec, spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");


// const SERVER = "https://apiwebprintrdbi.siunand.my.id";
const SERVER = "http://localhost:5000";

// --- fetch helpers (Node 18+ has global fetch) ---
function _withTimeout(timeout) {
  if (!timeout) return { signal: undefined, clear: () => {} };
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error("Timeout")), timeout);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}

async function fetchOk(url, { timeout, ...options } = {}) {
  const { signal, clear } = _withTimeout(timeout);
  try {
    const res = await fetch(url, { ...options, signal });
    if (!res.ok) {
      const err = new Error(`Request failed with status ${res.status}`);
      err.status = res.status;
      try { err.body = await res.text(); } catch {}
      throw err;
    }
    return res;
  } finally {
    clear();
  }
}

async function fetchJson(url, { method = "GET", headers = {}, body, timeout } = {}) {
  const res = await fetchOk(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeout,
  });
  return res.json();
}

const runCmd = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim()));
      resolve(stdout?.toString().trim());
    });
  });

const runProc = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false });
    let stderr = "";
    p.on("error", (err) => reject(err));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Exit code ${code}`));
    });
  });

function resolveGhostscript() {
  if (process.env.GHOSTSCRIPT_CMD && fs.existsSync(process.env.GHOSTSCRIPT_CMD)) return process.env.GHOSTSCRIPT_CMD;
  for (const c of ["gswin64c", "gswin32c", "gs"]) {
    try {
      const r = spawnSync(c, ["--version"]);
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

function resolveMagick() {
  if (process.env.IMAGEMAGICK_CMD && fs.existsSync(process.env.IMAGEMAGICK_CMD)) return process.env.IMAGEMAGICK_CMD;
  for (const c of ["magick", "convert"]) {
    try {
      const r = spawnSync(c, ["-version"]);
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

const contentTypeToExt = (ct) => {
  if (!ct) return "";
  const t = ct.toLowerCase();
  if (t.includes("application/pdf")) return ".pdf";
  if (t.includes("image/png")) return ".png";
  if (t.includes("image/jpeg")) return ".jpg";
  if (t.includes("image/webp")) return ".webp";
  if (t.includes("image/bmp")) return ".bmp";
  if (t.includes("image/gif")) return ".gif";
  return "";
};

let _checking = false;
const _recentProcessed = new Map();

async function checkQueue() {
   if (_checking) return; 
  _checking = true;
  try {
    const now = Date.now();
    for (const [k, exp] of _recentProcessed) {
      if (exp <= now) _recentProcessed.delete(k);
    }
    // heartbeat: inform server the agent is alive
    try { await fetchOk(`${SERVER}/api/agent/ping`, { method: "POST", timeout: 5000, headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); } catch {}

    const jobsRaw = await fetchJson(`${SERVER}/api/queue`, { timeout: 15000 });
    const jobsCount = Array.isArray(jobsRaw) ? jobsRaw.length : typeof jobsRaw;
    console.log("jobs received:", jobsCount);
    const jobs = (Array.isArray(jobsRaw) ? jobsRaw : []).filter(j => !_recentProcessed.has(j.id));
    for (const job of jobs) {
      console.log(`📥 Mengambil file (subset jika ada): ${job.originalName}`, "copies:", job.settings?.copies);
      _recentProcessed.set(job.id, Date.now() + 60_000);
      // unduh file subset (atau asli) dan simpan dengan ekstensi yang benar
      const fileUrl = `${SERVER}/api/print-file/${job.id}`;
      let fileRes;
      try {
        fileRes = await fetchOk(fileUrl, { timeout: 60000 });
      } catch (err) {
        const status = err?.status;
        if (status === 410) {
          console.warn(`⚠️ File untuk job ${job.id} sudah tidak tersedia (410). Mengabaikan job.`);
          continue;
        }
        throw err;
      }
      const ct = (fileRes.headers.get("content-type") || "").toLowerCase();
      let ext = contentTypeToExt(ct);
      if (!ext) {
        const n = (job.fileName || job.originalName || "").toLowerCase();
        ext = path.extname(n) || ".pdf";
      }
      const localPath = `./${job.id}${ext}`;
      {
        const buf = Buffer.from(await fileRes.arrayBuffer());
        fs.writeFileSync(localPath, buf);
      }

      console.log("🖨️ Mempersiapkan cetak...");
      const printer = job.settings?.printer?.trim();
      const copies = Math.max(1, parseInt(job.settings?.copies || 1, 10));

      const isPdf = ext === ".pdf";
      const isImage = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"].includes(ext);

      let fileToPrint = localPath;
      let grayTmp = null;

      try {
        if (job.settings?.color === "bw") {
          if (isPdf) {
            const gsCmd = resolveGhostscript();
            if (gsCmd) {
              console.log(`🎨 Konversi ke grayscale via Ghostscript: ${gsCmd}`);
              grayTmp = `./${job.id}-gray.pdf`;
              await runProc(gsCmd, [
                "-dSAFER",
                "-dBATCH",
                "-dNOPAUSE",
                "-sDEVICE=pdfwrite",
                "-sProcessColorModel=DeviceGray",
                "-sColorConversionStrategy=Gray",
                "-dOverrideICC",
                "-o",
                grayTmp,
                localPath,
              ]);
              fileToPrint = grayTmp;
            } else {
              console.warn("⚠️ Ghostscript tidak ditemukan. Cetak berwarna.");
            }
          } else if (isImage) {
            const magick = resolveMagick();
            if (magick) {
              console.log(`🎨 Konversi gambar ke grayscale via ImageMagick: ${magick}`);
              grayTmp = `./${job.id}-gray${ext}`;
              await runProc(magick, [localPath, "-colorspace", "Gray", grayTmp]);
              fileToPrint = grayTmp;
            } else {
              console.warn("⚠️ ImageMagick tidak ditemukan. Cetak berwarna.");
            }
          }
        }
      } catch (e) {
        console.warn("⚠️ Grayscale gagal. Mencetak berwarna:", e.message);
        fileToPrint = localPath;
      }
      // cetak sesuai tipe
      for (let i = 0; i < copies; i++) {
        if (isPdf) {
          const cmd = printer
            ? `SumatraPDF.exe -silent -print-to "${printer}" "${fileToPrint}"`
            : `SumatraPDF.exe -silent -print-to-default "${fileToPrint}"`;
          await runCmd(cmd);
        } else if (isImage) {
          // mspaint print to (default or specific printer)
          const cmd = printer
            ? `mspaint.exe /pt "${fileToPrint}" "${printer}"`
            : `mspaint.exe /pt "${fileToPrint}"`;
          await runCmd(cmd);
        } else {
          // fallback lewat handler default Windows
          await runCmd(`cmd /c start /min "" /wait "${fileToPrint}" /print`);
        }
      }

      console.log("✅ Selesai mencetak:", job.originalName);
      try {
        await fetchOk(`${SERVER}/api/queue/${job.id}/done`, { method: "POST", timeout: 15000, headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      } catch (e) {
        console.warn("⚠️ Gagal mengirim done ke server:", e.message);
      }

      // bersihkan file lokal
      try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch {}
      if (grayTmp) { try { if (fs.existsSync(grayTmp)) fs.unlinkSync(grayTmp); } catch {} }
    }
  } catch (error) {
    console.error("Loop error:", error.message);
  } finally {
    _checking = false;
  }
}

setInterval(checkQueue, 5000);
// ...existing code...