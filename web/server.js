const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn, execFile } = require("child_process");
const { randomUUID } = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || 8080);
const DATA_ROOT = process.env.DATA_ROOT || "/data";
const TEXDIFF_BIN = process.env.TEXDIFF_BIN || "/usr/local/bin/texdiff";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const MAX_LISTED_COMMITS = Number(process.env.MAX_LISTED_COMMITS || 500);
const VALID_LATEX_ENGINES = new Set(["auto", "pdflatex", "xelatex", "lualatex"]);
const VALID_OUTPUT_MODES = new Set(["minimal", "debug"]);
const VALID_COMPILE_MODES = new Set(["auto", "local", "docker"]);

const jobs = new Map();
let runningJobs = 0;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function sendSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function appendJobLog(job, chunk) {
  const text = chunk.toString();
  job.logs.push(text);

  for (const client of job.sseClients) {
    sendSseEvent(client, "log", { chunk: text });
  }
}

function setJobStatus(job, status, extra = {}) {
  job.status = status;
  Object.assign(job, extra);
  const payload = {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    error: job.error,
    pdfReady: Boolean(job.pdfPath),
  };

  for (const client of job.sseClients) {
    sendSseEvent(client, "status", payload);
  }
}

function toJobSummary(job) {
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    error: job.error,
    pdfReady: Boolean(job.pdfPath),
  };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function parseBool(value) {
  return String(value).toLowerCase() === "true";
}

function parseEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function parseText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function resolveSafeJobPath(jobRoot, userPath, fallback) {
  const raw = parseText(userPath, fallback) || fallback;
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));

  if (!normalized || normalized === ".") {
    return path.join(jobRoot, fallback);
  }

  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Only relative out/work directories inside the job workspace are allowed.");
  }

  return path.join(jobRoot, normalized);
}

// The repository is expected to be mounted here (see README).
const REPO_ROOT = "/repo";

// How to address the root repository. Set by detectRepo().
let rootGitArgs = ["-C", REPO_ROOT];

function gitRaw(baseArgs, args) {
  return new Promise((resolve, reject) => {
    // The mounted repo (and, for submodules, its separate git dir) is usually
    // owned by a different uid, so mark everything safe. The mount is read-only.
    execFile(
      "git",
      ["-c", "safe.directory=*", ...baseArgs, ...args],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Returns an error message when /repo/.git is a file (submodule or linked
// worktree) whose target is not inside the mount, otherwise null.
function checkGitFilePointer() {
  const gitPath = path.join(REPO_ROOT, ".git");
  let stat;
  try {
    stat = fs.statSync(gitPath);
  } catch (_error) {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, "utf8"));
  if (!match) {
    return "The .git file in the mounted folder is not a valid gitdir pointer.";
  }

  const target = match[1].trim();
  const resolved = path.resolve(REPO_ROOT, target);
  if (isInside(REPO_ROOT, resolved) && fs.existsSync(resolved)) {
    return null;
  }

  const upLevels = target.split("/").filter((part) => part === "..").length;
  const kind = target.includes("/modules/") ? "submodule" : "linked worktree";
  const mountHint =
    upLevels > 0
      ? `the folder ${upLevels} level${upLevels === 1 ? "" : "s"} above the one you mounted`
      : "the folder that contains it";
  return (
    `The mounted folder is a git ${kind}: its .git file points to "${target}", which is outside the mounted folder. ` +
    `Mount ${mountHint} (the main repository) instead, e.g. -v /path/to/main-repo:/repo:ro. ` +
    (kind === "submodule" ? "The submodule will then be selectable in this page." : "")
  ).trim();
}

// Describes the mounted repository:
//   { present: false }                     nothing usable mounted (option hidden)
//   { present: true, error: "..." }        something mounted that cannot be used
//   { present: true, error: null }         ready
// Supports a working copy, a bare repository, or a bare git directory such as
// .git/modules/<name> of a submodule (the latter may carry a core.worktree that
// does not exist in the container, so it is overridden).
async function detectRepo() {
  const pointerError = checkGitFilePointer();
  if (pointerError) {
    return { present: true, error: pointerError };
  }

  const candidates = [
    ["-C", REPO_ROOT],
    [`--git-dir=${REPO_ROOT}`, `--work-tree=${os.tmpdir()}`],
  ];
  for (const baseArgs of candidates) {
    try {
      await gitRaw(baseArgs, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      rootGitArgs = baseArgs;
      return { present: true, error: null };
    } catch (_error) {
      // try the next layout
    }
  }

  try {
    const entries = fs.readdirSync(REPO_ROOT);
    if (entries.length > 0) {
      return {
        present: true,
        error: "The folder mounted at /repo is not a git repository (or it has no commits).",
      };
    }
  } catch (_error) {
    // not mounted
  }
  return { present: false, error: null };
}

// Initialized submodules (recursively) of the working copy, as paths relative
// to /repo. The root repository itself is represented by "".
async function listRepos() {
  const repos = [{ path: "", label: "Main repository" }];
  if (rootGitArgs[0] !== "-C") {
    return repos;
  }
  try {
    const out = await gitRaw(rootGitArgs, [
      "submodule",
      "foreach",
      "--quiet",
      "--recursive",
      'printf "%s\\n" "$displaypath"',
    ]);
    for (const sub of out.split("\n").filter(Boolean)) {
      repos.push({ path: sub, label: sub });
    }
  } catch (_error) {
    // No submodules, or none that are initialized.
  }
  return repos;
}

// Resolves a user-supplied repo path (from the list above) to git base args.
async function gitBaseFor(repoPath) {
  const status = await detectRepo();
  if (!status.present || status.error) {
    throw new Error(status.error || "No git repository is mounted at /repo.");
  }
  if (!repoPath) {
    return rootGitArgs;
  }
  const known = await listRepos();
  if (!known.some((repo) => repo.path === repoPath)) {
    throw new Error(`Unknown repository: ${repoPath}`);
  }
  return ["-C", path.join(REPO_ROOT, repoPath)];
}

async function resolveCommit(base, ref) {
  if (typeof ref !== "string" || !ref.trim() || ref.startsWith("-")) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  try {
    return (await gitRaw(base, ["rev-parse", "--verify", "--quiet", `${ref.trim()}^{commit}`])).trim();
  } catch (_error) {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

async function archiveCommit(base, sha, zipPath) {
  await gitRaw(base, ["archive", "--format=zip", `--output=${zipPath}`, sha]);
}

async function listRefs(base) {
  const SEP = "\x1f";
  const logOut = await gitRaw(base, [
    "log",
    "--all",
    `--max-count=${MAX_LISTED_COMMITS}`,
    `--format=%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%D${SEP}%s`,
  ]);

  const commits = logOut
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, short, author, date, decorations, subject] = line.split(SEP);
      return { hash, short, author, date, subject, refs: decorations ? decorations.split(", ") : [] };
    });

  const tagsOut = await gitRaw(base, ["tag", "--sort=-creatordate", "--format=%(refname:short)"]);
  const branchesOut = await gitRaw(base, ["branch", "--all", "--format=%(refname:short)"]);

  return {
    commits,
    tags: tagsOut.split("\n").filter(Boolean),
    branches: branchesOut.split("\n").filter(Boolean),
  };
}

async function runJob(job) {
  let outDir;
  let workDir;

  try {
    outDir = resolveSafeJobPath(job.rootDir, job.options.outDir, "out");
    workDir = resolveSafeJobPath(job.rootDir, job.options.workDir, "work");
  } catch (error) {
    setJobStatus(job, "failed", {
      endedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const args = [
    job.oldZipPath,
    job.newZipPath,
    "--out-dir",
    outDir,
    "--work-dir",
    workDir,
    "--compile-mode",
    job.options.compileMode,
    "--latex-engine",
    job.options.latexEngine,
    "--output-mode",
    job.options.outputMode,
  ];

  if (job.options.main) {
    args.push("--main", job.options.main);
  }

  if (job.options.mainOld) {
    args.push("--main-old", job.options.mainOld);
  }

  if (job.options.mainNew) {
    args.push("--main-new", job.options.mainNew);
  }

  if (job.options.keepLog) {
    args.push("--keep-log");
  }

  if (job.options.dockerImage) {
    args.push("--docker-image", job.options.dockerImage);
  }

  for (const diffArg of job.options.latexdiffArgs) {
    args.push("--latexdiff-arg", diffArg);
  }

  setJobStatus(job, "running", { startedAt: new Date().toISOString() });
  runningJobs += 1;

  try {
    await ensureDir(outDir);
    await ensureDir(workDir);

    const child = spawn(TEXDIFF_BIN, args, {
      cwd: job.rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    job.childPid = child.pid;

    child.stdout.on("data", (chunk) => appendJobLog(job, chunk));
    child.stderr.on("data", (chunk) => appendJobLog(job, chunk));

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    job.exitCode = exitCode;

    if (exitCode !== 0) {
      setJobStatus(job, "failed", {
        endedAt: new Date().toISOString(),
        error: `texdiff exited with code ${exitCode}`,
      });
      return;
    }

    const minimalPdf = path.join(outDir, "diff.pdf");
    const debugPdf = path.join(outDir, "diff", "diff.pdf");

    if (fs.existsSync(minimalPdf)) {
      job.pdfPath = minimalPdf;
    } else if (fs.existsSync(debugPdf)) {
      job.pdfPath = debugPdf;
    }

    if (!job.pdfPath) {
      setJobStatus(job, "failed", {
        endedAt: new Date().toISOString(),
        error: "Compilation finished but no diff.pdf was found.",
      });
      return;
    }

    setJobStatus(job, "succeeded", {
      endedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    setJobStatus(job, "failed", {
      endedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    runningJobs -= 1;
    job.childPid = null;
  }
}

function uploadMiddlewareForJob(jobInputDir) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, jobInputDir),
    filename: (_req, file, cb) => {
      const lower = file.fieldname.toLowerCase();
      if (lower === "oldzip") {
        cb(null, "old.zip");
      } else if (lower === "newzip") {
        cb(null, "new.zip");
      } else {
        cb(new Error("Unknown upload field."));
      }
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: MAX_UPLOAD_MB * 1024 * 1024,
      files: 2,
    },
    fileFilter: (_req, file, cb) => {
      if (!file.originalname.toLowerCase().endsWith(".zip")) {
        cb(new Error("Only .zip files are allowed."));
        return;
      }
      cb(null, true);
    },
  });
}

app.get("/api/repo", async (_req, res) => {
  const status = await detectRepo();
  if (!status.present) {
    res.json({ present: false, error: null, repos: [] });
    return;
  }
  res.json({
    present: true,
    error: status.error,
    repos: status.error ? [] : await listRepos(),
  });
});

app.get("/api/repo/refs", async (req, res) => {
  try {
    const base = await gitBaseFor(parseText(req.query.path));
    res.json(await listRefs(base));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/jobs", async (req, res) => {
  if (runningJobs >= MAX_CONCURRENT_JOBS) {
    res.status(429).json({ error: "Server is busy. Please try again shortly." });
    return;
  }

  const id = randomUUID();
  const rootDir = path.join(DATA_ROOT, "jobs", id);
  const inputDir = path.join(rootDir, "input");

  await ensureDir(inputDir);

  const upload = uploadMiddlewareForJob(inputDir).fields([
    { name: "oldZip", maxCount: 1 },
    { name: "newZip", maxCount: 1 },
  ]);

  upload(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    const files = req.files || {};
    let oldZipPath = files.oldZip && files.oldZip[0] && files.oldZip[0].path;
    let newZipPath = files.newZip && files.newZip[0] && files.newZip[0].path;

    const oldRef = parseText(req.body.oldRef);
    const newRef = parseText(req.body.newRef);

    if (oldRef || newRef) {
      if (!oldRef || !newRef) {
        res.status(400).json({ error: "Please provide both oldRef and newRef." });
        return;
      }
      try {
        const base = await gitBaseFor(parseText(req.body.repoPath));
        const [oldSha, newSha] = await Promise.all([resolveCommit(base, oldRef), resolveCommit(base, newRef)]);
        oldZipPath = path.join(inputDir, "old.zip");
        newZipPath = path.join(inputDir, "new.zip");
        await archiveCommit(base, oldSha, oldZipPath);
        await archiveCommit(base, newSha, newZipPath);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    if (!oldZipPath || !newZipPath) {
      res.status(400).json({ error: "Please provide both ZIP files or both git refs." });
      return;
    }

    const latexEngine = parseEnum(req.body.latexEngine, VALID_LATEX_ENGINES, "auto");
    const outputMode = parseEnum(req.body.outputMode, VALID_OUTPUT_MODES, "minimal");
    const compileMode = parseEnum(req.body.compileMode, VALID_COMPILE_MODES, "local");

    const keepLog = parseBool(req.body.keepLog);

    const main = parseText(req.body.main);
    const mainOld = parseText(req.body.mainOld);
    const mainNew = parseText(req.body.mainNew);
    const outDir = parseText(req.body.outDir, "out") || "out";
    const workDir = parseText(req.body.workDir, "work") || "work";
    const dockerImage = parseText(req.body.dockerImage);
    const latexdiffArgsRaw = parseText(req.body.latexdiffArgs);
    const latexdiffArgs = latexdiffArgsRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const job = {
      id,
      rootDir,
      oldZipPath,
      newZipPath,
      status: "queued",
      startedAt: null,
      endedAt: null,
      exitCode: null,
      error: null,
      pdfPath: null,
      childPid: null,
      logs: [],
      sseClients: new Set(),
      options: {
        main,
        mainOld,
        mainNew,
        outDir,
        workDir,
        dockerImage,
        latexEngine,
        compileMode,
        outputMode,
        keepLog,
        latexdiffArgs,
      },
    };

    jobs.set(id, job);
    runJob(job);

    res.status(201).json(toJobSummary(job));
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json(toJobSummary(job));
});

app.get("/api/jobs/:id/logs", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sendSseEvent(res, "status", toJobSummary(job));
  if (job.logs.length > 0) {
    sendSseEvent(res, "log", { chunk: job.logs.join("") });
  }

  job.sseClients.add(res);

  req.on("close", () => {
    job.sseClients.delete(res);
  });
});

app.get("/api/jobs/:id/pdf", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.pdfPath || !fs.existsSync(job.pdfPath)) {
    res.status(404).json({ error: "PDF not available." });
    return;
  }

  if (req.query.download === "1") {
    res.download(job.pdfPath, `texdiff-${job.id}.pdf`);
  } else {
    res.sendFile(job.pdfPath);
  }
});

app.listen(PORT, async () => {
  await ensureDir(path.join(DATA_ROOT, "jobs"));
  console.log(`texdiff-web listening on http://0.0.0.0:${PORT}`);
});
