# texdiff

Track changes in LaTeX projects, based on two zip exports of your project. Works on Overleaf projects, or any LaTeX project that can be exported as a zip file.

## Retrieving zip files
In an Overleaf project, go to the top right of the navigation bar → History. Download the two versions you want to compare as ZIP files.

## Quick start (recommended): Docker mode

Docker mode avoids installing TeX dependencies on your host machine.

### Build image

```bash
docker build -t texdiff:local .
```

### Run image

```bash
mkdir -p ./out

docker run --rm \
	-v "./my_paper_v13.zip:/in/old.zip:ro" \
	-v "./my_paper_v14.zip:/in/new.zip:ro" \
	-v "./out:/out" \
	texdiff:local \
	--main my_main_file.tex
```

Container defaults are optimized for this workflow:

- `--compile-mode local`
- `--output-mode minimal`
- `--work-dir /tmp/texdiff`
- `--out-dir /out` (when `/out` exists)

Result:

- `out/diff.pdf`

Optional:

- Add `--keep-log` to also export `out/diff.log`.
- Use `--output-mode debug` to export full artifacts (`out/diff/`).

### Alternative input mount

If you prefer mounting a directory instead of two files:

```bash
mkdir -p ./input_zips ./out
cp "MDRuijzendaal_CH4_H2 (Version 6274).zip" ./input_zips/old.zip
cp "MDRuijzendaal_CH4_H2 (Version 6679).zip" ./input_zips/new.zip

docker run --rm \
	-v "$PWD/input_zips:/in:ro" \
	-v "$PWD/out:/out" \
	texdiff:local \
	--main my_main_file.tex
```

## Web UI (single Docker container)

This mode runs a simple browser UI in one container. The UI provides:

- Two drag-and-drop ZIP zones (also clickable file pickers)
- Options form covering all script flags (`--main`, `--main-old`, `--main-new`, `--latexdiff-arg`, `--latex-engine`, `--out-dir`, `--work-dir`, `--compile-mode`, `--output-mode`, `--keep-log`, `--docker-image`)
- Live log output while `texdiff.sh` runs
- PDF preview and PDF download when the job finishes

### Build web image

```bash
docker build -f Dockerfile.web -t texdiff-web:local .
```

### Run web image

```bash
docker run --rm \
	-p 8080:8080 \
	-v texdiff_web_data:/data \
	texdiff-web:local
```

Open `http://localhost:8080`.

### Launching the web server

Quick start, from the repository root:

```bash
# 1. Build the image (once, and again after code changes; the first build is large because of TeX Live)
docker build -f Dockerfile.web -t texdiff-web:local .

# 2. Start the server and open http://localhost:8080
docker run --rm -p 8080:8080 -v texdiff_web_data:/data texdiff-web:local
```

Common variations:

```bash
# Use a different host port (here 3000 -> http://localhost:3000)
docker run --rm -p 3000:8080 -v texdiff_web_data:/data texdiff-web:local

# Run in the background and keep it running across restarts
docker run -d --name texdiff-web --restart unless-stopped \
	-p 8080:8080 -v texdiff_web_data:/data texdiff-web:local

# Follow the server logs / stop and remove it
docker logs -f texdiff-web
docker stop texdiff-web && docker rm texdiff-web

# Raise limits via environment variables
docker run --rm -p 8080:8080 -v texdiff_web_data:/data \
	-e MAX_UPLOAD_MB=500 -e MAX_CONCURRENT_JOBS=2 texdiff-web:local
```

The server prints `texdiff-web listening on http://0.0.0.0:8080` when it is ready. Only one job runs at a time by default; further submissions get a "Server is busy" message until it finishes (see `MAX_CONCURRENT_JOBS`).

Without Docker (development), install the Node dependencies and start the server directly. This requires Node 20+ and the [local mode](#local-mode-host-installed-dependencies) tools on your `PATH`:

```bash
cd web
npm install
PORT=8080 DATA_ROOT=./data TEXDIFF_BIN="$(cd .. && pwd)/texdiff.sh" npm start
```

### Compare two commits or tags from a git repository

Mount a folder containing a git repository at `/repo` (read-only is fine). The UI then shows a "Git repository" source option with dropdowns listing tags, branches and commits; the two selected revisions are exported with `git archive` and compared exactly like two ZIP files.

```bash
docker run --rm \
	-p 8080:8080 \
	-v texdiff_web_data:/data \
	-v /path/to/my/latex-repo:/repo:ro \
	texdiff-web:local
```

**Git submodules:** if the mounted repository has initialized submodules, a "Repository" dropdown lets you choose between the main repository and each submodule. Mount the *main* repository, not the submodule folder: a submodule's `.git` is a small file pointing into the main repository's `.git/modules/` folder, which is not visible when only the submodule folder is mounted. If you do mount just a submodule (or a linked worktree), the "Git repository" option still appears, with an error explaining which folder to mount instead.

What each part means:

| Part | Side | Meaning |
| --- | --- | --- |
| `-p 8080:8080` | `HOST_PORT:CONTAINER_PORT` | Left: the port you open in your browser (`http://localhost:8080`). Right: the port the server listens on inside the container (`PORT`, default `8080`). |
| `-v texdiff_web_data:/data` | `VOLUME_OR_HOST_PATH:CONTAINER_PATH` | Left: a named Docker volume (or a host folder) that persists job files. Right: `/data` inside the container, where uploads and results are stored under `/data/jobs/<job-id>/` (`DATA_ROOT`). |
| `-v /path/to/my/latex-repo:/repo:ro` | `HOST_PATH:CONTAINER_PATH:MODE` | Left: **replace with the folder on your machine** that contains the git repository (the one with the `.git` directory). Right: `/repo`, where the server looks for it (this path is fixed). `:ro` mounts it read-only; texdiff never writes to it. Omit this line to use ZIP uploads only. |
| `texdiff-web:local` | | The image name and tag built with `docker build ... -t texdiff-web:local`. |

Notes:

- Job artifacts are stored under `/data/jobs/<job-id>/` inside the container.
- Only the generated PDF is downloadable from the UI.
- Runtime defaults can be overridden with env vars:
  - `PORT` (default: `8080`)
  - `DATA_ROOT` (default: `/data`)
  - `MAX_UPLOAD_MB` (default: `200`)
  - `MAX_CONCURRENT_JOBS` (default: `1`)
  - `MAX_LISTED_COMMITS` (default: `500`)

## Local mode (host-installed dependencies)

Use local mode only if you want to run without Docker and have required tools installed.

### Requirements

- `unzip`
- `texdirflatten`
- `latexpand`
- `latexdiff`
- `latexmk`

### Basic usage

```bash
./texdiff.sh "OLD_PROJECT.zip" "NEW_PROJECT.zip"
```

If ZIP files are named `old.zip` and `new.zip`, positional arguments can be omitted:

```bash
./texdiff.sh
```

Example:

```bash
./texdiff.sh "MDRuijzendaal_CH4_H2 (Version 6274).zip" "MDRuijzendaal_CH4_H2 (Version 6679).zip" --main my_main_file.tex --compile-mode local
```

## Optional arguments

General:

- `--main FILE.tex` (sets both old and new main files)
- `--main-old FILE.tex`
- `--main-new FILE.tex`
- `--out-dir DIR` (default: `out`)
- `--work-dir DIR` (default: `work`)
- `--compile-mode MODE` (`auto|local|docker`, default: `auto`)
- `--docker-image IMAGE` (default: `texlive/texlive:latest-full`)
- `--latex-engine ENGINE` (`auto|pdflatex|xelatex|lualatex`)

Output and debugging:

- `--output-mode MODE` (`minimal|debug`, default: `minimal`)
- `--keep-log` (also write `diff.log` in `minimal` mode)
- `--latexdiff-arg ARG` (repeatable; pass through to `latexdiff`)

### Main file detection

If no `--main` / `--main-old` / `--main-new` is given, the main `.tex` file of each project is chosen automatically, in this order:

1. `main.tex` in the project root
2. a file named `main*.tex` (e.g. `main_paper.tex`, case-insensitive) that contains `\documentclass`
3. any file that contains `\documentclass`
4. any `main*.tex` file
5. the first `.tex` file

Within each step, files closer to the project root win, then alphabetical order. The chosen files are printed (`Detected old main file: ...`). If a project has several candidates (e.g. `main_els.tex` and `main_psst.tex`), pass `--main` explicitly.

### Project `.latexmkrc`

The new project is copied, including dotfiles, into the build folder and `latexmk` runs there, so a `.latexmkrc` in your project **is** applied when compiling the diff (for example bibliography tooling, shell-escape or extra `latexmk` hooks). Keep in mind:

- The diff is always built as `diff.tex`, and `texdiff` expects `diff.pdf` next to it. Settings that move output elsewhere (`$out_dir`, `$aux_dir`, ...) can make the build fail or hide the PDF; guard them, e.g. with `if ($^O eq 'darwin') { ... }` so they only apply to your own machine, not the Linux container.
- The engine is always passed on the `latexmk` command line (`-pdf` by default, `-xelatex` when `unicode-math` is detected, or whatever `--latex-engine` says), which overrides an engine set in `.latexmkrc` (e.g. `$pdf_mode`). Use `--latex-engine` to choose the engine.
- When the same file exists in both projects, the new project's `.latexmkrc` is used.

## Common `latexdiff` debug/tuning arguments

Pass each argument with `--latexdiff-arg`.

Examples:

```bash
./texdiff.sh old.zip new.zip \
	--main my_main_file.tex \
	--latexdiff-arg="--exclude-safecmd=ce" \
	--latexdiff-arg="--exclude-safecmd=citep" \
	--latexdiff-arg="--exclude-safecmd=citet" \
	--latexdiff-arg="--allow-spaces" \
	--latexdiff-arg="--math-markup=whole" \
	--latexdiff-arg="--flatten" \
	--output-mode debug
```

Frequently useful options:

- `--exclude-safecmd=ce` (common with chemistry macros)
- `--exclude-safecmd=citep`
- `--exclude-safecmd=citet`
- `--allow-spaces`
- `--math-markup=whole` (reduce noisy token-level math diffs)
- `--flatten` (if you want `latexdiff` itself to flatten)
- `--graphics-markup=new-only` (already included by default in this script)

## Smoke tests

Run the bundled smoke tests:

```bash
bash tests/texdiff-smoke.sh
```

The smoke test fixture uses `\import`, `\subimport`, and figures inside imported directories, and runs `texdiff.sh` with `pdflatex`, `xelatex`, and `lualatex`.