# texdiff

Automate LaTeX project comparison from two Overleaf ZIP files and produce a compiled, highlighted diff PDF.

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