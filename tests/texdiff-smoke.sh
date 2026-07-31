#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_cmd zip
require_cmd unzip
require_cmd latexdiff
require_cmd latexmk
require_cmd pdflatex
require_cmd xelatex
require_cmd lualatex

fixture_root="$repo_root/tests/fixtures/import-media"
old_fixture="$fixture_root/old"
new_fixture="$fixture_root/new"

for project_dir in "$old_fixture" "$new_fixture"; do
  if [[ ! -f "$project_dir/main.tex" ]]; then
    echo "Missing fixture project: $project_dir" >&2
    exit 1
  fi
  if [[ ! -f "$project_dir/sections/media/intro-figure.pdf" ]]; then
    echo "Missing fixture media file: $project_dir/sections/media/intro-figure.pdf" >&2
    exit 1
  fi
  if [[ ! -f "$project_dir/sections/sub/media/methods-figure.pdf" ]]; then
    echo "Missing fixture media file: $project_dir/sections/sub/media/methods-figure.pdf" >&2
    exit 1
  fi
done

work_root="$(mktemp -d "${TMPDIR:-/tmp}/texdiff-smoke.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT

prepare_project() {
  local fixture_dir="$1"
  local project_dir="$2"

  cp -R "$fixture_dir" "$project_dir"
}

make_zip() {
  local project_dir="$1"
  local zip_path="$2"
  (cd "$project_dir" && zip -qr "$zip_path" .)
}

old_project="$work_root/old"
new_project="$work_root/new"
prepare_project "$old_fixture" "$old_project"
prepare_project "$new_fixture" "$new_project"

old_zip="$work_root/old.zip"
new_zip="$work_root/new.zip"
make_zip "$old_project" "$old_zip"
make_zip "$new_project" "$new_zip"

run_case() {
  local engine="$1"
  local out_dir="$work_root/out-$engine"
  local work_dir="$work_root/work-$engine"

  echo "Running smoke test with $engine..."
  "$repo_root/texdiff.sh" "$old_zip" "$new_zip" \
    --main main.tex \
    --latex-engine "$engine" \
    --compile-mode local \
    --output-mode minimal \
    --out-dir "$out_dir" \
    --work-dir "$work_dir"

  if [[ ! -f "$out_dir/diff.pdf" ]]; then
    echo "Expected output missing: $out_dir/diff.pdf" >&2
    exit 1
  fi
}

run_case pdflatex
run_case xelatex
run_case lualatex

echo "All smoke tests passed."
