// ...existing code...
import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { exec, spawn, spawnSync } from "child_process";

const SERVER = "https://apiwebprintrdbi.siunand.my.id";

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

async function checkQueue() {
  try {
    const { data: jobs } = await axios.get(`${SERVER}/api/queue`, { timeout: 15000 });
    for (const job of jobs) {
      console.log(`📥 Mengambil file (subset jika ada): ${job.originalName}`);

      // unduh file subset (atau asli) dan simpan dengan ekstensi yang benar
      const fileUrl = `${SERVER}/api/print-file/${job.id}`;
      const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 60000 });
      const ct = (fileRes.headers["content-type"] || "").toLowerCase();
      let ext = contentTypeToExt(ct);
      if (!ext) {
        const n = (job.fileName || job.originalName || "").toLowerCase();
        ext = path.extname(n) || ".pdf";
      }
      const localPath = `./${job.id}${ext}`;
      fs.writeFileSync(localPath, fileRes.data);

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
      await axios.post(`${SERVER}/api/queue/${job.id}/done`, {}, { timeout: 15000 });

      // bersihkan file lokal
      try { if (fs.existsSync(localPath)) fs.removeSync(localPath); } catch {}
      if (grayTmp) { try { if (fs.existsSync(grayTmp)) fs.removeSync(grayTmp); } catch {} }
    }
  } catch (error) {
    console.error("Loop error:", error.message);
  }
}

setInterval(checkQueue, 5000);
// ...existing code...