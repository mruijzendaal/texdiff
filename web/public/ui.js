const oldZipInput = document.getElementById("oldZip");
const newZipInput = document.getElementById("newZip");
const oldZipLabel = document.getElementById("oldZipLabel");
const newZipLabel = document.getElementById("newZipLabel");
const oldZone = document.getElementById("oldZone");
const newZone = document.getElementById("newZone");
const uploadSection = document.getElementById("uploadSection");
const configSection = document.getElementById("configSection");
const runSection = document.getElementById("runSection");
const resultSection = document.getElementById("resultSection");
const uploadState = document.getElementById("uploadState");
const configState = document.getElementById("configState");
const runState = document.getElementById("runState");
const resultState = document.getElementById("resultState");

const mainFile = document.getElementById("mainFile");
const mainOldFile = document.getElementById("mainOldFile");
const mainNewFile = document.getElementById("mainNewFile");
const compileMode = document.getElementById("compileMode");
const latexEngine = document.getElementById("latexEngine");
const outputMode = document.getElementById("outputMode");
const outDir = document.getElementById("outDir");
const workDir = document.getElementById("workDir");
const dockerImage = document.getElementById("dockerImage");
const keepLog = document.getElementById("keepLog");
const latexdiffArgs = document.getElementById("latexdiffArgs");

const sourceToggle = document.getElementById("sourceToggle");
const repoError = document.getElementById("repoError");
const repoSelectWrap = document.getElementById("repoSelectWrap");
const repoSelect = document.getElementById("repoSelect");
const gitPanel = document.getElementById("gitPanel");
const zipPanel = document.getElementById("zipPanel");
const oldRef = document.getElementById("oldRef");
const newRef = document.getElementById("newRef");

const runBtn = document.getElementById("runBtn");
const statusBadge = document.getElementById("statusBadge");
const errorText = document.getElementById("errorText");
const logs = document.getElementById("logs");

const pdfLink = document.getElementById("pdfLink");
const downloadPdfLink = document.getElementById("downloadPdfLink");
const pdfPreview = document.getElementById("pdfPreview");

let currentJobId = null;
let currentSource = null;

function setPill(node, text, style) {
  node.textContent = text;
  node.className = `rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${style}`;
}

function setStatus(text, style) {
  statusBadge.textContent = text;
  statusBadge.className = `rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${style}`;
}

function setError(message) {
  if (!message) {
    errorText.textContent = "";
    errorText.classList.add("hidden");
    return;
  }
  errorText.textContent = message;
  errorText.classList.remove("hidden");
}

function setDisabledActionLinks() {
  pdfLink.href = "#";
  downloadPdfLink.href = "#";
  pdfPreview.src = "about:blank";

  pdfLink.className = "pointer-events-none rounded-lg bg-slate-300 px-4 py-2 text-sm font-bold text-slate-500";
  downloadPdfLink.className = "pointer-events-none rounded-lg bg-slate-300 px-4 py-2 text-sm font-bold text-slate-500";
}

function enableActionLinks(jobId) {
  const pdfHref = `/api/jobs/${jobId}/pdf`;
  const downloadHref = `/api/jobs/${jobId}/pdf?download=1`;

  pdfLink.href = pdfHref;
  downloadPdfLink.href = downloadHref;
  pdfPreview.src = pdfHref;

  pdfLink.className = "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-500";
  downloadPdfLink.className = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-700";
}

function appendLog(text) {
  logs.textContent += text;
  logs.scrollTop = logs.scrollHeight;
}

function attachDropBehavior(zone, input, label) {
  const activeClasses = ["border-slate-700", "bg-slate-200"];

  ["dragenter", "dragover"].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.add(...activeClasses);
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove(...activeClasses);
    });
  });

  zone.addEventListener("drop", (event) => {
    const dt = event.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) {
      return;
    }

    const file = dt.files[0];
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Only .zip files are supported.");
      return;
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    label.textContent = file.name;
    setError("");
    updateUploadCompletionState();
  });

  input.addEventListener("change", () => {
    const file = input.files[0];
    label.textContent = file ? file.name : "Drop or click";
    updateUploadCompletionState();
  });
}

attachDropBehavior(oldZone, oldZipInput, oldZipLabel);
attachDropBehavior(newZone, newZipInput, newZipLabel);

function sourceMode() {
  const checked = document.querySelector('input[name="source"]:checked');
  return checked ? checked.value : "zip";
}

function updateUploadCompletionState() {
  const ready =
    sourceMode() === "git"
      ? Boolean(oldRef.value && newRef.value)
      : Boolean(oldZipInput.files[0] && newZipInput.files[0]);
  if (ready) {
    setPill(uploadState, "complete", "bg-emerald-100 text-emerald-800");
    if (sourceMode() === "zip") {
      uploadSection.open = false;
    }
  } else {
    setPill(uploadState, "pending", "bg-slate-200 text-slate-700");
  }
}

function setWorkflowForStart() {
  setPill(configState, "started", "bg-sky-100 text-sky-800");
  setPill(runState, "running", "bg-sky-100 text-sky-800");
  setPill(resultState, "pending", "bg-amber-100 text-amber-800");
  configSection.open = false;
  runSection.open = true;
}

function setWorkflowForDone(success) {
  runSection.open = false;
  resultSection.open = true;

  if (success) {
    setPill(configState, "done", "bg-emerald-100 text-emerald-800");
    setPill(runState, "complete", "bg-emerald-100 text-emerald-800");
    setPill(resultState, "ready", "bg-emerald-100 text-emerald-800");
  } else {
    setPill(runState, "failed", "bg-rose-100 text-rose-800");
    setPill(resultState, "blocked", "bg-rose-100 text-rose-800");
  }
}

async function startJob() {
  setError("");

  const useGit = sourceMode() === "git";
  const oldFile = oldZipInput.files[0];
  const newFile = newZipInput.files[0];

  if (useGit) {
    if (!oldRef.value || !newRef.value) {
      setError(repoError.textContent || "Please choose both old and new git refs.");
      return;
    }
  } else if (!oldFile || !newFile) {
    setError("Please choose both old and new ZIP files.");
    return;
  }

  logs.textContent = "";
  setDisabledActionLinks();

  const formData = new FormData();
  if (useGit) {
    formData.append("repoPath", repoSelect.value);
    formData.append("oldRef", oldRef.value);
    formData.append("newRef", newRef.value);
  } else {
    formData.append("oldZip", oldFile);
    formData.append("newZip", newFile);
  }
  formData.append("main", mainFile.value.trim());
  formData.append("mainOld", mainOldFile.value.trim());
  formData.append("mainNew", mainNewFile.value.trim());
  formData.append("compileMode", compileMode.value);
  formData.append("latexEngine", latexEngine.value);
  formData.append("outputMode", outputMode.value);
  formData.append("outDir", outDir.value.trim() || "out");
  formData.append("workDir", workDir.value.trim() || "work");
  formData.append("dockerImage", dockerImage.value.trim());
  formData.append("keepLog", keepLog.checked ? "true" : "false");
  formData.append("latexdiffArgs", latexdiffArgs.value || "");

  runBtn.disabled = true;
  runBtn.classList.add("opacity-60", "cursor-not-allowed");
  setStatus("starting", "bg-amber-100 text-amber-800");
  setWorkflowForStart();

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Failed to create job.");
    }

    currentJobId = payload.id;
    streamLogs(currentJobId);
  } catch (error) {
    setError(error.message || String(error));
    setStatus("error", "bg-rose-100 text-rose-800");
    setWorkflowForDone(false);
    runBtn.disabled = false;
    runBtn.classList.remove("opacity-60", "cursor-not-allowed");
  }
}

function streamLogs(jobId) {
  if (currentSource) {
    currentSource.close();
  }

  const source = new EventSource(`/api/jobs/${jobId}/logs`);
  currentSource = source;

  source.addEventListener("log", (event) => {
    const payload = JSON.parse(event.data);
    appendLog(payload.chunk || "");
  });

  source.addEventListener("status", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.status === "queued") {
      setStatus("queued", "bg-slate-200 text-slate-800");
      setPill(runState, "queued", "bg-slate-200 text-slate-700");
      return;
    }

    if (payload.status === "running") {
      setStatus("running", "bg-sky-100 text-sky-800");
      setPill(runState, "running", "bg-sky-100 text-sky-800");
      return;
    }

    runBtn.disabled = false;
    runBtn.classList.remove("opacity-60", "cursor-not-allowed");

    if (payload.status === "succeeded") {
      setStatus("succeeded", "bg-emerald-100 text-emerald-800");
      enableActionLinks(jobId);
      setWorkflowForDone(true);
      source.close();
      return;
    }

    if (payload.status === "failed") {
      setStatus("failed", "bg-rose-100 text-rose-800");
      setError(payload.error || "The job failed.");
      setWorkflowForDone(false);
      source.close();
    }
  });

  source.onerror = () => {
    setError("Connection lost while streaming logs. You can retry with the same files.");
    runBtn.disabled = false;
    runBtn.classList.remove("opacity-60", "cursor-not-allowed");
    setWorkflowForDone(false);
    source.close();
  };
}

function addGroup(select, label, options) {
  if (options.length === 0) {
    return;
  }
  const group = document.createElement("optgroup");
  group.label = label;
  for (const { value, text } of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    group.appendChild(option);
  }
  select.appendChild(group);
}

function fillRefSelect(select, repo) {
  select.textContent = "";
  addGroup(select, "Tags", repo.tags.map((t) => ({ value: t, text: t })));
  addGroup(select, "Branches", repo.branches.map((b) => ({ value: b, text: b })));
  addGroup(
    select,
    "Commits",
    repo.commits.map((c) => ({
      value: c.hash,
      text: `${c.short} ${c.subject} (${c.date.slice(0, 10)})${c.refs.length ? ` [${c.refs.join(", ")}]` : ""}`,
    })),
  );
}

async function loadRefs() {
  const response = await fetch(`/api/repo/refs?path=${encodeURIComponent(repoSelect.value)}`);
  const refs = await response.json();
  if (!response.ok) {
    throw new Error(refs.error || "Failed to read the repository.");
  }
  fillRefSelect(oldRef, refs);
  fillRefSelect(newRef, refs);
  // Default to comparing the previous commit against the latest one.
  if (refs.commits.length > 1) {
    newRef.value = refs.commits[0].hash;
    oldRef.value = refs.commits[1].hash;
  }
  updateUploadCompletionState();
}

function showSourcePanel() {
  const git = sourceMode() === "git";
  zipPanel.classList.toggle("hidden", git);
  gitPanel.classList.toggle("hidden", !git || Boolean(repoError.textContent));
  repoSelectWrap.classList.toggle("hidden", !git || repoSelect.options.length < 2);
  repoError.classList.toggle("hidden", !git || !repoError.textContent);
  updateUploadCompletionState();
}

async function loadRepo() {
  try {
    const response = await fetch("/api/repo");
    const repo = await response.json();
    if (!response.ok || !repo.present) {
      return;
    }

    sourceToggle.classList.remove("hidden");
    sourceToggle.classList.add("flex");
    document.querySelectorAll('input[name="source"]').forEach((radio) => {
      radio.addEventListener("change", showSourcePanel);
    });

    if (repo.error) {
      repoError.textContent = repo.error;
      return;
    }

    for (const entry of repo.repos) {
      const option = document.createElement("option");
      option.value = entry.path;
      option.textContent = entry.label;
      repoSelect.appendChild(option);
    }
    repoSelect.addEventListener("change", () => {
      loadRefs().catch((error) => setError(error.message || String(error)));
    });
    await loadRefs();
  } catch (error) {
    setError(error.message || String(error));
  }
}

runBtn.addEventListener("click", startJob);
loadRepo();
setStatus("idle", "bg-slate-200 text-slate-700");
setPill(uploadState, "pending", "bg-slate-200 text-slate-700");
setPill(configState, "ready", "bg-slate-200 text-slate-700");
setPill(runState, "waiting", "bg-slate-200 text-slate-700");
setPill(resultState, "pending", "bg-slate-200 text-slate-700");
setDisabledActionLinks();
