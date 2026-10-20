#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./texdiff.sh [OLD_PROJECT.zip NEW_PROJECT.zip] [options]

Options:
  --main FILE.tex         Main TeX file for both projects (optional)
  --main-old FILE.tex     Main TeX file for old project (optional)
  --main-new FILE.tex     Main TeX file for new project (optional)
  --latexdiff-arg ARG     Extra argument passed to latexdiff (repeatable)
  --latex-engine ENGINE   latexmk engine: auto|pdflatex|xelatex|lualatex (default: auto)
  --out-dir DIR           Output directory (default: ./out, or /out in container)
  --work-dir DIR          Working directory (default: ./work, or /tmp/texdiff in container)
  --compile-mode MODE     Compilation backend: auto|local|docker (default: auto, resolved to local in container)
  --output-mode MODE      Output mode: minimal|debug (default: minimal)
  --keep-log              Keep diff.log in minimal output mode
  --docker-image IMAGE    Docker image for latexmk (default: texlive/texlive:latest-full)
  --help                  Show this help

When ZIP arguments are omitted, defaults are auto-detected in this order:
  1) /in/old.zip and /in/new.zip (container use)
  2) ./old.zip and ./new.zip

Outputs:
  Minimal mode: OUT_DIR/diff.pdf (+ OUT_DIR/diff.log if --keep-log)
  Debug mode:   OUT_DIR/diff/ (all build artifacts)
EOF
}

has_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

require_cmd() {
  local cmd="$1"
  if ! has_cmd "$cmd"; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

abs_path() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    printf '%s\n' "$p"
  else
    printf '%s/%s\n' "$PWD" "$p"
  fi
}

find_main_tex() {
  local dir="$1"
  local preferred=""
  if [[ $# -ge 2 ]]; then
    preferred="$2"
  fi

  if [[ -n "$preferred" ]]; then
    if [[ -f "$dir/$preferred" ]]; then
      printf '%s\n' "$preferred"
      return 0
    fi
    echo "Provided main file not found: $dir/$preferred" >&2
    return 1
  fi

  if [[ -f "$dir/main.tex" ]]; then
    printf '%s\n' "main.tex"
    return 0
  fi

  # Candidate order: shallowest path first, then alphabetical.
  local candidates=()
  mapfile -t candidates < <(find "$dir" -type f -name '*.tex' -print \
    | awk -F/ '{ print NF "\t" $0 }' | sort -k1,1n -k2 | cut -f2-)

  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "No .tex files found in $dir" >&2
    return 1
  fi

  # Preference: main*.tex with \documentclass, any file with \documentclass,
  # any main*.tex, then simply the first .tex file.
  local main_named=()
  local main_class=()
  local any_class=()
  local f base
  for f in "${candidates[@]}"; do
    base="$(basename "$f")"
    base="${base,,}"
    local is_main="false"
    local has_class="false"
    if [[ "$base" =~ ^main.*\.tex$ ]]; then
      is_main="true"
      main_named+=("$f")
    fi
    if grep -q '\\documentclass' "$f"; then
      has_class="true"
      any_class+=("$f")
    fi
    if [[ "$is_main" == "true" && "$has_class" == "true" ]]; then
      main_class+=("$f")
    fi
  done

  local selected=""
  if [[ ${#main_class[@]} -gt 0 ]]; then
    selected="${main_class[0]}"
  elif [[ ${#any_class[@]} -gt 0 ]]; then
    selected="${any_class[0]}"
  elif [[ ${#main_named[@]} -gt 0 ]]; then
    selected="${main_named[0]}"
  else
    selected="${candidates[0]}"
  fi

  selected="${selected#"$dir"/}"
  printf '%s\n' "$selected"
}

main() {
  local old_zip=""
  local new_zip=""

  # Optional positional ZIP arguments.
  if [[ $# -gt 0 && "$1" != --* ]]; then
    old_zip="$1"
    shift
  fi
  if [[ $# -gt 0 && "$1" != --* ]]; then
    new_zip="$1"
    shift
  fi

  if [[ -n "$old_zip" && -z "$new_zip" ]]; then
    echo "When providing positional ZIP args, provide both OLD and NEW zip files." >&2
    usage
    exit 1
  fi

  local main_old=""
  local main_new=""
  local latexdiff_args=("--graphics-markup=new-only")
  local latex_engine="auto"
  local out_dir="out"
  local work_dir="work"
  local compile_mode="auto"
  local output_mode="minimal"
  local keep_log="false"
  local docker_image="texlive/texlive:latest-full"

  local set_out_dir="false"
  local set_work_dir="false"
  local set_compile_mode="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --main)
        main_old="$2"
        main_new="$2"
        shift 2
        ;;
      --main-old)
        main_old="$2"
        shift 2
        ;;
      --main-new)
        main_new="$2"
        shift 2
        ;;
      --latexdiff-arg)
        latexdiff_args+=("$2")
        shift 2
        ;;
      --latex-engine)
        latex_engine="$2"
        shift 2
        ;;
      --out-dir)
        out_dir="$2"
        set_out_dir="true"
        shift 2
        ;;
      --work-dir)
        work_dir="$2"
        set_work_dir="true"
        shift 2
        ;;
      --compile-mode)
        compile_mode="$2"
        set_compile_mode="true"
        shift 2
        ;;
      --output-mode)
        output_mode="$2"
        shift 2
        ;;
      --keep-log)
        keep_log="true"
        shift
        ;;
      --docker-image)
        docker_image="$2"
        shift 2
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  # Container-friendly defaults: if the caller did not explicitly set these,
  # make output and work paths match the common mount layout.
  if [[ -f /.dockerenv ]]; then
    if [[ "$set_out_dir" != "true" && -d "/out" ]]; then
      out_dir="/out"
    fi
    if [[ "$set_work_dir" != "true" ]]; then
      work_dir="/tmp/texdiff"
    fi
    if [[ "$set_compile_mode" != "true" ]]; then
      compile_mode="local"
    fi
  fi

  if [[ "$compile_mode" != "auto" && "$compile_mode" != "local" && "$compile_mode" != "docker" ]]; then
    echo "Invalid --compile-mode: $compile_mode (expected auto|local|docker)" >&2
    exit 1
  fi

  if [[ "$output_mode" != "minimal" && "$output_mode" != "debug" ]]; then
    echo "Invalid --output-mode: $output_mode (expected minimal|debug)" >&2
    exit 1
  fi

  if [[ "$latex_engine" != "auto" && "$latex_engine" != "pdflatex" && "$latex_engine" != "xelatex" && "$latex_engine" != "lualatex" ]]; then
    echo "Invalid --latex-engine: $latex_engine (expected auto|pdflatex|xelatex|lualatex)" >&2
    exit 1
  fi

  # If ZIP args were omitted, try container-first defaults then local defaults.
  if [[ -z "$old_zip" && -z "$new_zip" ]]; then
    if [[ -f "/in/old.zip" && -f "/in/new.zip" ]]; then
      old_zip="/in/old.zip"
      new_zip="/in/new.zip"
    elif [[ -f "old.zip" && -f "new.zip" ]]; then
      old_zip="old.zip"
      new_zip="new.zip"
    else
      echo "ZIP inputs not provided and default names were not found." >&2
      echo "Expected either /in/old.zip + /in/new.zip or ./old.zip + ./new.zip" >&2
      usage
      exit 1
    fi
  fi

  require_cmd unzip
  require_cmd latexdiff

  if [[ "$compile_mode" == "local" ]]; then
    require_cmd latexmk
  elif [[ "$compile_mode" == "docker" ]]; then
    require_cmd docker
  else
    # In auto mode, prefer local compilation inside containers to avoid Docker-in-Docker.
    if [[ -f /.dockerenv ]]; then
      require_cmd latexmk
      compile_mode="local"
    elif has_cmd docker; then
      compile_mode="docker"
    elif has_cmd latexmk; then
      compile_mode="local"
    else
      echo "auto compile mode requires either docker or latexmk" >&2
      exit 1
    fi
  fi

  old_zip="$(abs_path "$old_zip")"
  new_zip="$(abs_path "$new_zip")"
  out_dir="$(abs_path "$out_dir")"
  work_dir="$(abs_path "$work_dir")"

  mkdir -p "$out_dir" "$work_dir"

  local old_dir="$work_dir/old"
  local new_dir="$work_dir/new"
  rm -rf "$old_dir" "$new_dir"
  mkdir -p "$old_dir" "$new_dir"

  echo "Unzipping projects..."
  unzip -q "$old_zip" -d "$old_dir"
  unzip -q "$new_zip" -d "$new_dir"

  local old_main_rel
  local new_main_rel
  old_main_rel="$(find_main_tex "$old_dir" "$main_old")"
  new_main_rel="$(find_main_tex "$new_dir" "$main_new")"

  echo "Detected old main file: $old_main_rel"
  echo "Detected new main file: $new_main_rel"

  local diff_dir="$work_dir/diff"
  rm -rf "$diff_dir"
  mkdir -p "$diff_dir"

  echo "Preparing assets for compilation..."
  cp -R "$new_dir"/. "$diff_dir" 2>/dev/null || true
  cp -Rn "$old_dir"/. "$diff_dir" 2>/dev/null || true

  local diff_tex="$diff_dir/diff.tex"

  echo "Generating LaTeX diff..."
  latexdiff --flatten "${latexdiff_args[@]}" "$old_dir/$old_main_rel" "$new_dir/$new_main_rel" > "$diff_tex"

  echo "Compiling diff.tex to PDF..."
  local latexmk_engine="-pdf"
  if [[ "$latex_engine" == "pdflatex" ]]; then
    latexmk_engine="-pdf"
  elif [[ "$latex_engine" == "xelatex" ]]; then
    latexmk_engine="-xelatex"
  elif [[ "$latex_engine" == "lualatex" ]]; then
    latexmk_engine="-lualatex"
  elif grep -Eq '\\usepackage(\[[^]]*\])?\{unicode-math\}' "$diff_tex"; then
    # unicode-math requires XeLaTeX or LuaLaTeX.
    latexmk_engine="-xelatex"
  fi

  if [[ "$compile_mode" == "local" ]]; then
    (
      cd "$diff_dir"
      latexmk "$latexmk_engine" -f -interaction=nonstopmode -halt-on-error diff.tex
    )
  else
    docker run --rm \
      -v "$diff_dir:/data" \
      -w /data \
      "$docker_image" \
      latexmk "$latexmk_engine" -f -interaction=nonstopmode -halt-on-error diff.tex
  fi

  mkdir -p "$out_dir"
  local diff_pdf="$diff_dir/diff.pdf"
  local diff_log="$diff_dir/diff.log"
  if [[ ! -f "$diff_pdf" ]]; then
    echo "Compilation succeeded but diff.pdf was not found at $diff_pdf" >&2
    exit 1
  fi

  if [[ "$output_mode" == "debug" ]]; then
    local out_debug_dir="$out_dir/diff"
    rm -rf "$out_debug_dir"
    mkdir -p "$out_debug_dir"
    cp -R "$diff_dir"/. "$out_debug_dir"
    echo "Done. Outputs:"
    echo "  $out_debug_dir"
  else
    cp "$diff_pdf" "$out_dir/diff.pdf"
    if [[ "$keep_log" == "true" && -f "$diff_log" ]]; then
      cp "$diff_log" "$out_dir/diff.log"
    fi
    echo "Done. Outputs:"
    echo "  $out_dir/diff.pdf"
    if [[ "$keep_log" == "true" && -f "$diff_log" ]]; then
      echo "  $out_dir/diff.log"
    fi
  fi
}

main "$@"
