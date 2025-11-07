import { useEffect, useState } from "react";
import axios from "axios";
import { CloudArrowUpIcon } from "@heroicons/react/24/solid";
import { Worker, Viewer, SpecialZoomLevel, type DocumentLoadEvent } from "@react-pdf-viewer/core";
import "@react-pdf-viewer/core/lib/styles/index.css";
import { defaultLayoutPlugin } from "@react-pdf-viewer/default-layout";
import "@react-pdf-viewer/default-layout/lib/styles/index.css";

import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";

interface PrintSettings {
  copies: number;
  color: "color" | "bw";
  paperSize: "A4" | "A3" | "Legal";
  orientation: "portrait" | "landscape";
  printer: string;
  pages: string; // e.g. "1,3-5"
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewReady, setPreviewReady] = useState<boolean>(false); // tampilkan preview + setting hanya kalau true
  const [isPreviewLoading, setIsPreviewLoading] = useState<boolean>(false); // indikator konversi dokumen
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isPrinting, setIsPrinting] = useState<boolean>(false);
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);
  const defaultLayout = defaultLayoutPlugin();
  const [settings, setSettings] = useState<PrintSettings>({
    copies: 1,
    color: "color",
    paperSize: "A4",
    orientation: "portrait",
    printer: "",
    pages: "",
  });
  const [backendOk, setBackendOk] = useState<boolean>(true);
  const [agentOnline, setAgentOnline] = useState<boolean>(true);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploaded = e.target.files?.[0];
    if (!uploaded) return;
    const name = uploaded.name.toLowerCase();
    const ext = name.split('.')?.pop() || '';

    const isPdf = uploaded.type === 'application/pdf' || ext === 'pdf';
    const isImage = uploaded.type.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','tiff'].includes(ext);
    const isDoc = ['doc','docx','ppt','pptx','xls','xlsx','odt'].includes(ext);

    if (!isPdf && !isImage && !isDoc) {
      alert('Tipe file tidak didukung. Gunakan PDF, Gambar, atau Dokumen Office.');
      return;
    }

  setFile(uploaded);
  setNumPages(null);
  setPreviewUrl("");
  setPreviewReady(false);

    if (isPdf || isImage) {
      setPreviewUrl(URL.createObjectURL(uploaded));
      setPreviewReady(true); // langsung siap
      return;
    }

    // Dokumen Office: kirim ke /api/preview untuk konversi server-side
    showToast('Mengonversi dokumen untuk preview...', 'info');
    setIsPreviewLoading(true);
    const formData = new FormData();
    formData.append('file', uploaded);
    try {
      const resp = await axios.post('/api/preview', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (resp.data?.previewUrl) {
        setPreviewUrl(resp.data.previewUrl);
        setPreviewReady(true);
        showToast('Preview siap', 'success');
      } else {
        setPreviewUrl('');
        setPreviewReady(false);
        showToast('Preview gagal', 'error');
      }
    } catch (err) {
  interface AxiosErrShape { response?: { data?: { message?: string; conversionError?: string } } }
  const axErr = err as AxiosErrShape;
  const msg = axErr.response?.data?.message || 'Konversi preview gagal';
  const detail = axErr.response?.data?.conversionError;
  console.error('Preview conversion error', detail || msg);
      setPreviewUrl('');
      setPreviewReady(false);
      showToast(detail ? `${msg}: ${detail}` : msg, 'error');
    }
    setIsPreviewLoading(false);
  };

  // poll backend health & agent status
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const { data } = await axios.get('/api/health', { timeout: 5000 });
        if (!active) return;
        setBackendOk(true);
        setAgentOnline(!!data?.agentOnline);
      } catch {
        if (!active) return;
        setBackendOk(false);
        setAgentOnline(false);
      }
      setTimeout(poll, 8000);
    };
    poll();
    return () => { active = false; };
  }, []);

  // react-pdf-viewer will update numPages via onDocumentLoad

  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    if (name === 'copies') {
      const parsed = parseInt(value, 10);
      setSettings({ ...settings, copies: isNaN(parsed) ? 1 : Math.max(1, parsed) });
    } else if (['color','paperSize','orientation','printer','pages'].includes(name)) {
      setSettings({ ...settings, [name]: value } as PrintSettings);
    }
  };

  const isValidPages = (pages: string, total: number) => {
    const trimmed = pages.trim();
    if (!trimmed) return true; // empty means print all
    const pattern = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;
    if (!pattern.test(trimmed)) return false;
    const tokens = trimmed.split(',').map(t => t.trim());
    for (const t of tokens) {
      if (t.includes('-')) {
        const [a, b] = t.split('-').map(x => parseInt(x.trim(), 10));
        if (!a || !b || a < 1 || b < 1 || a > b || b > total) return false;
      } else {
        const n = parseInt(t, 10);
        if (!n || n < 1 || n > total) return false;
      }
    }
    return true;
  };

  const handlePrint = async () => {
    if (!file) return alert("Upload file terlebih dahulu!");

    if (settings.pages && numPages && !isValidPages(settings.pages, numPages)) {
      alert("Format halaman tidak valid. Contoh: 1,3-5 dan harus dalam rentang jumlah halaman.");
      return;
    }

    setIsSubmitting(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("copies", settings.copies.toString());
    formData.append("color", settings.color);
    formData.append("paperSize", settings.paperSize);
    formData.append("orientation", settings.orientation);
    formData.append("printer", settings.printer);
    if (settings.pages.trim()) {
      formData.append("pages", settings.pages.trim());
    }

    try {
      // const res = await axios.post("/api/upload", formData, {
      //   headers: { "Content-Type": "multipart/form-data" },
      // });
  const res = await axios.post("/api/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const job = res.data?.job;
      if (!job?.id) {
        showToast("File terkirim, tapi tidak mendapat ID job", "error");
        return;
      }

      showToast("📨 Dikirim. Menunggu printer...", "info");

      // Poll status: job dianggap selesai saat tidak lagi berada di antrian pending
      setIsSubmitting(false);
      setIsPrinting(true);
      const jobId: string = job.id;
      let printed = false;
      for (let i = 0; i < 60; i++) { // ~2 menit @ 2s
        try {
          // const { data: pending } = await axios.get("https://apiwebprintrdbi.siunand.my.id/api/queue");
          const { data: pending } = await axios.get("/api/queue");
          const stillPending = Array.isArray(pending) && pending.some((j: { id: string }) => j.id === jobId);
          if (!stillPending) {
            printed = true;
            break;
          }
        } catch {
          // abaikan satu-dua kegagalan polling
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (printed) {
        showToast("✅ Berhasil dicetak", "success");
      } else {
        showToast("⌛ Waktu tunggu habis. Cek antrian printer.", "info");
      }
    } catch (err) {
      console.error(err);
      showToast("❌ Gagal mengirim ke server", "error");
    } finally {
      setIsSubmitting(false);
      setIsPrinting(false);
    }
  };

  // No custom width calculations needed; viewer handles responsive scaling

  return (
    <div className="min-h-screen bg-white flex flex-col items-center py-10 px-4">
      {/* Backend down overlay */}
      {!backendOk && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white/95 backdrop-blur-sm">
          <div className="text-center max-w-md px-6">
            <h2 className="text-2xl font-bold text-red-600 mb-4">Sistem Tidak Bisa Digunakan</h2>
            <p className="text-gray-700 mb-6">Frontend tidak dapat terhubung ke backend. Periksa server atau koneksi jaringan.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700"
            >Coba Reload</button>
          </div>
        </div>
      )}
      {/* Agent offline banner (only if backend ok) */}
      {backendOk && !agentOnline && (
        <div className="fixed top-0 left-0 right-0 z-40 bg-yellow-500 text-black text-sm font-medium py-2 text-center">
          Agent printer tidak terhubung. Cetak akan tertunda sampai agent aktif kembali.
        </div>
      )}
      <div className="p-8 w-full max-w-5xl">
        <h1 className="text-3xl font-bold text-center text-blue-600 mb-8">WebPrint RDBI</h1>

        {/* Upload / Loading / Preview */}
        {!file || !previewReady ? (
          <label className="block border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-gray-50 cursor-pointer">
            <CloudArrowUpIcon className="w-12 h-12 text-gray-400 mb-3 mx-auto" />
            {!file && (
              <>
                <p className="text-gray-700 font-medium mb-1">Upload file kamu di sini</p>
                <p className="text-sm text-gray-500 mb-3">PDF, Gambar (PNG/JPG), atau Dokumen Office (DOCX/PPTX/XLSX)</p>
              </>
            )}
            {file && !previewReady && (
              <div className="mt-2">
                <p className="text-gray-700 font-medium mb-1">{file.name}</p>
                {isPreviewLoading ? (
                  <p className="text-sm text-blue-600 flex items-center justify-center gap-2">
                    <span className="inline-block h-5 w-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    Mengonversi ke PDF...
                  </p>
                ) : (
                  <p className="text-sm text-red-600">Preview belum siap. Silakan ganti file atau tunggu.</p>
                )}
              </div>
            )}
            <input
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            {file && !previewReady && (
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setPreviewUrl("");
                  setPreviewReady(false);
                  setIsPreviewLoading(false);
                }}
                className="mt-4 inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
              >Ganti file</button>
            )}
          </label>
        ) : (
          <>
            <div className="mt-2 text-sm text-gray-600">📎 {file?.name}</div>
            {/* Preview area: PDF via viewer, Image via <img>, Docs show placeholder */}
            <div className="mt-4 border border-black/5 rounded-2xl p-2 sm:p-4 bg-black/5">
              <div className="h-[75vh]">
                {previewUrl && previewUrl.toLowerCase().endsWith('.pdf') && (
                  <Worker workerUrl={workerUrl}>
                    <Viewer
                      fileUrl={previewUrl}
                      defaultScale={SpecialZoomLevel.PageWidth}
                      onDocumentLoad={(e: DocumentLoadEvent) => setNumPages(e.doc.numPages)}
                      plugins={[defaultLayout]}
                    />
                  </Worker>
                )}
                {previewUrl && file.type.startsWith("image/") && (
                  <img src={previewUrl} alt={file.name} className="mx-auto max-w-full max-h-[72vh] object-contain rounded" />
                )}
                {!previewUrl && (
                  <div className="h-full flex items-center justify-center text-sm text-gray-600">
                    Dokumen tidak dapat dipreview di browser. Akan dikonversi ke PDF di server saat dicetak.
                  </div>
                )}
              </div>
            </div>
              <div className="flex justify-center mt-10">
                <button
                  className="px-3 py-1 font-semibold text-white border-2 bg-blue-600 rounded-lg hover:bg-white hover:border-blue-600 hover:text-blue-600 hover:ease-in-out duration-200 w-32 h-12"
                  onClick={() => {
                    setFile(null);
                    setPreviewUrl("");
                    setPreviewReady(false);
                    setNumPages(null);
                  }}
                >
                  Ganti file
                </button>
              </div>

            {/* Print Settings */}
            <div className="mt-8">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">Pengaturan Cetak</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-medium text-gray-700 text-sm mb-1">Jumlah Copy</label>
                  <input
                    type="number"
                    name="copies"
                    value={settings.copies}
                    onChange={handleChange}
                    min="1"
                    className="w-full border border-gray-300 rounded-lg p-2 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-medium text-gray-700 text-sm mb-1">Warna</label>
                  <select
                    name="color"
                    value={settings.color}
                    onChange={handleChange}
                    className="w-full border border-gray-300 rounded-lg p-2 focus:border-blue-500 focus:outline-none bg-white"
                  >
                    <option value="color">Berwarna</option>
                    <option value="bw">Hitam Putih</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-gray-700 text-sm mb-1">Ukuran Kertas</label>
                  <select
                    name="paperSize"
                    value={settings.paperSize}
                    onChange={handleChange}
                    className="w-full border border-gray-300 rounded-lg p-2 focus:border-blue-500 focus:outline-none bg-white"
                  >
                    <option value="A4">A4</option>
                    <option value="A3">A3</option>
                    <option value="Legal">Legal</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-gray-700 text-sm mb-1">Orientasi</label>
                  <select
                    name="orientation"
                    value={settings.orientation}
                    onChange={handleChange}
                    className="w-full border border-gray-300 rounded-lg p-2 focus:border-blue-500 focus:outline-none bg-white"
                  >
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium text-gray-700 text-sm mb-1">Halaman</label>
                  <input
                    type="text"
                    name="pages"
                    value={settings.pages}
                    onChange={handleChange}
                    placeholder="Contoh: 1,3-5 (kosongkan untuk semua halaman)"
                    className="w-full border border-gray-300 rounded-lg p-2 focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Gunakan koma untuk beberapa halaman dan tanda minus untuk rentang. Misal: 1,3-5
                    {numPages ? ` • Total halaman: ${numPages}` : ""}
                  </p>
                </div>
              </div>
              <button
                onClick={handlePrint}
                disabled={!file || isSubmitting || isPrinting}
                className="mt-6 w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-semibold text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title={isPrinting ? "Sedang mencetak..." : "Cetak sekarang"}
              >
                {(isSubmitting || isPrinting) && (
                  <span className="inline-block h-5 w-5 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                )}
                {isSubmitting ? "Mengirim ke server..." : isPrinting ? "Sedang mencetak..." : "Cetak Sekarang"}
              </button>
            </div>
          </>
        )}
        
      </div>
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 rounded-lg shadow px-4 py-3 text-sm text-white ${
            toast.type === "success" ? "bg-green-600" : toast.type === "error" ? "bg-red-600" : "bg-blue-600"
          }`}
        >
          {toast.message}
        </div>
      )}
      {/* Fullscreen handled by default layout plugin if needed */}
    </div>
  );
}
