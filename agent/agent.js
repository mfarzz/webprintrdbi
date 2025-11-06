import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { exec, spawn, spawnSync } from "child_process";

const SERVER = "http://localhost:5000";

const runCmd = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout?.trim());
    });
  });

const runProc = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false });
    let stderr = "";
    p.on("error", (err) => reject(err)); // handle spawn ENOENT, etc.
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Exit code ${code}`));
    });
  });

function resolveGhostscript() {
  // 1) Env var override
  if (process.env.GHOSTSCRIPT_CMD && fs.existsSync(process.env.GHOSTSCRIPT_CMD)) {
    return process.env.GHOSTSCRIPT_CMD;
  }
  // 2) Try binaries in PATH (synchronously)
  const candidates = ["gswin64c", "gswin32c", "gs"];
  for (const c of candidates) {
    try {
      const result = spawnSync(c, ["--version"], { stdio: "ignore" });
      if (result && result.status === 0) return c;
    } catch {}
  }
  // 3) Probe common install locations on Windows
  const roots = [
    "C:\\\\Program Files\\\\gs",
    "C:\\\\Program Files (x86)\\\\gs",
  ];
  for (const root of roots) {
    try {
      const dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("gs"))
        .map((d) => d.name)
        .sort()
        .reverse(); // newest first
      for (const dir of dirs) {
        const base = path.join(root, dir, "bin");
        const x64 = path.join(base, "gswin64c.exe");
        const x86 = path.join(base, "gswin32c.exe");
        if (fs.existsSync(x64)) return x64;
        if (fs.existsSync(x86)) return x86;
      }
    } catch {}
  }
  return null;
}

async function checkQueue() {
  try {
    const { data: jobs } = await axios.get(`${SERVER}/api/queue`);
    for (const job of jobs) {
      console.log(`📥 Mengambil file (subset jika ada): ${job.originalName}`);

      // ambil subset PDF dari server (hanya halaman terpilih)
      const fileUrl = `${SERVER}/api/print-file/${job.id}`;
      const localPath = `./${job.id}.pdf`;
      const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
      fs.writeFileSync(localPath, fileRes.data);

      console.log("🖨️ Mempersiapkan cetak...");

      // Grayscale (opsional)
      let fileToPrint = localPath;
      let grayPath = null;
      try {
        if (job.settings?.color === "bw") {
          const gsCmd = resolveGhostscript();
          if (!gsCmd) {
            console.warn(
              "⚠️ Ghostscript tidak ditemukan. Set GHOSTSCRIPT_CMD ke path gswin64c.exe atau install Ghostscript. Mencetak berwarna."
            );
          } else {
            grayPath = `./${job.id}-gray.pdf`;
            console.log(`🎨 Konversi ke grayscale via Ghostscript: ${gsCmd}`);
            const args = [
              "-dSAFER",
              "-dBATCH",
              "-dNOPAUSE",
              "-sDEVICE=pdfwrite",
              "-sProcessColorModel=DeviceGray",
              "-sColorConversionStrategy=Gray",
              "-dOverrideICC",
              "-o",
              grayPath,
              localPath,
            ];
            await runProc(gsCmd, args);
            fileToPrint = grayPath;
          }
        }
      } catch (e) {
        console.warn("⚠️ Gagal konversi grayscale. Mencetak berwarna:", e.message);
        fileToPrint = localPath;
      }

      const printer = job.settings?.printer?.trim();
      const copies = Math.max(1, parseInt(job.settings?.copies || 1, 10));

      // cetak sesuai jumlah copy (loop)
      for (let i = 0; i < copies; i++) {
        const cmd = printer
          ? `SumatraPDF.exe -silent -print-to "${printer}" "${fileToPrint}"`
          : `SumatraPDF.exe -silent -print-to-default "${fileToPrint}"`;
        await runCmd(cmd);
      }

      console.log("✅ Selesai mencetak:", job.originalName);
      await axios.post(`${SERVER}/api/queue/${job.id}/done`);

      try {
        if (fs.existsSync(localPath)) fs.removeSync(localPath);
      } catch {}
      if (grayPath) {
        try {
          if (fs.existsSync(grayPath)) fs.removeSync(grayPath);
        } catch {}
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

setInterval(checkQueue, 5000);