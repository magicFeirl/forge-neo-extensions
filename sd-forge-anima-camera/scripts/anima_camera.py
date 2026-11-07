"""Forge Neo extension: Anima Camera Control.

Appends ComfyUI-bsk_UI-compatible camera tags to the prompt and triggers the
Anima camera-control LoRA via an extra-network ``<lora:...>`` tag, so the
ComfyUI ``anima_camera_control`` / ``img2img_anima_camera_control`` workflows
can be reproduced in Forge Neo (txt2img + img2img) without ComfyUI.

Install: copy the parent folder (``sd-forge-anima-camera``) into
``<forge>/extensions/`` and restart Forge. Select it like any other
extension folder; no pip packages required.

Camera math lives in ``lib_anima_camera/camera.py`` (stdlib only) and is a
faithful port of ``bsk_CameraControlNode`` by 灰暗x (ComfyUI-bsk_UI,
AGPL-3.0-or-later). See ../README.md and ../LICENSE.
"""

from __future__ import annotations

import json
import os
import re
import struct

import gradio as gr

from modules import scripts

try:
    from modules.ui_components import InputAccordion
except Exception:  # very old WebUI without InputAccordion
    InputAccordion = None

try:
    from modules import paths as forge_paths
except Exception:
    forge_paths = None

from lib_anima_camera import camera as cam

EXT_TITLE = "Anima Camera Control"
LORA_BASENAME = "anima_npu_lora_bsk_co-00001160"
LORA_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".bin")

# ----------------------------------------------------------------------------
# ui() return order. process()/preview()/preset helpers all map positionally
# through this list, so there is exactly one source of truth for arg order.
# ----------------------------------------------------------------------------
UI_FIELDS = [
    "enabled",
    # LoRA
    "lora_name",
    "lora_custom",
    "lora_strength",
    # camera position
    "pos_x",
    "pos_y",
    "pos_z",
    "roll",
    # azimuth
    "az_enabled",
    "az_weight",
    "az_deadzone",
    # elevation
    "el_enabled",
    "el_extra",
    "eye_peak",
    # distance
    "di_enabled",
    "di_extra",
    # tilt
    "ti_enabled",
    "ti_deadzone",
    "ti_extra",
    "dutch_tag",
    "extra_master",
    "weight_min",
    "weight_max",
    # no-weight mode
    "no_weight",
    "no_weight_threshold",
    # direction enables
    "dir_front_en",
    "dir_back_en",
    "dir_left_en",
    "dir_right_en",
    # elevation category enables
    "el_bird_en",
    "el_high_en",
    "el_eye_en",
    "el_low_en",
    "el_worm_en",
    # distance category enables
    "di_ecu_en",
    "di_cu_en",
    "di_medium_en",
    "di_full_en",
    "di_wide_en",
    # extras: enable + free text (+ dof weight)
    "ex_lens_en",
    "ex_lens_val",
    "ex_dof_en",
    "ex_dof_val",
    "dof_weight",
    "ex_move_en",
    "ex_move_val",
    "ex_comp_en",
    "ex_comp_val",
    "ex_style_en",
    "ex_style_val",
    # editable preview text (passed to process() so manual edits are honored;
    # never a live-preview input — its own edits must not re-trigger render).
    "preview_text",
]

# Components that affect the generated prompt fragment (live preview inputs).
# NOTE: preview_text is deliberately excluded — it is an *output* of the
# preview plus an *input* to process(), but typing in it must not
# re-render (which would wipe the edit being typed).
WATCHED = [f for f in UI_FIELDS if f not in ("enabled", "preview_text")]

# Preset buttons: (label, {field: value}) applied on top of current sliders.
PRESETS = [
    ("Front", {"pos_x": 0.0}),
    ("Behind", {"pos_x": 1.0}),
    ("Left", {"pos_x": -0.5}),
    ("Right", {"pos_x": 0.5}),
    ("High", {"pos_y": 0.5}),
    ("Bird", {"pos_y": 1.0}),
    ("Low", {"pos_y": -0.5}),
    ("Worm", {"pos_y": -1.0}),
    ("ECU", {"pos_z": 1.0}),
    ("Close-up", {"pos_z": 0.5}),
    ("Full", {"pos_z": -0.5}),
    ("Wide", {"pos_z": -1.0}),
    ("Dutch", {"roll": 0.5}),
    ("Reset", {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0}),
]


# ----------------------------------------------------------------------------
# LoRA discovery
# ----------------------------------------------------------------------------
def _lora_roots():
    roots = []
    if forge_paths is not None:
        try:
            models_path = forge_paths.models_path
        except Exception:
            models_path = None
        if models_path:
            for leaf in ("Lora", "lora"):
                candidate = os.path.join(models_path, leaf)
                if os.path.isdir(candidate):
                    roots.append(candidate)
    # Fallback: guess relative to this file (extensions/<name>/scripts/...)
    here = os.path.abspath(__file__)
    for _ in range(6):
        here = os.path.dirname(here)
        for leaf in ("models/Lora", "models/lora"):
            candidate = os.path.join(here, leaf)
            if os.path.isdir(candidate) and candidate not in roots:
                roots.append(candidate)
    return roots


def scan_loras():
    """Scan LoRA files; display names are subfolder-relative paths (no ext).

    NOTE (Forge Neo namespace): ``<lora:...>`` tags resolve by BARE BASENAME
    only (see extensions-builtin/sd_forge_lora/networks.py:
    ``name = basename(filename)``). The dropdown still shows the relative
    path so you can tell duplicates apart, but the injected tag always uses
    the basename. Returns {display: (basename, fullpath)}.
    """
    found = {}
    for root in _lora_roots():
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                if not filename.lower().endswith(LORA_EXTENSIONS):
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, root).replace("\\", "/")
                for ext in LORA_EXTENSIONS:
                    if rel.lower().endswith(ext):
                        rel = rel[: -len(ext)]
                        break
                basename = os.path.splitext(filename)[0]
                found.setdefault(rel, (basename, full))
    return dict(sorted(found.items(), key=lambda kv: kv[0].lower()))


def normalize_lora_name(raw):
    """Clean user input into a Forge ``<lora:>`` name: the bare basename.

    Accepts bare names, ``Anima/Utility/name`` relative paths, filenames with
    extensions, or absolute paths; strips directories, quotes and extensions.
    """
    name = (raw or "").strip().strip("\"'")
    if not name:
        return ""
    name = name.replace("\\", "/").rstrip("/")
    name = name.rsplit("/", 1)[-1]  # Neo namespace is basename-only
    for ext in LORA_EXTENSIONS:
        if name.lower().endswith(ext):
            name = name[: -len(ext)]
            break
    return name


def default_lora_name(choices):
    for choice in choices:
        if LORA_BASENAME in os.path.basename(choice):
            return choice
    return choices[0] if choices else ""


# ----------------------------------------------------------------------------
# LoRA identity: Neo registers every LoRA under its basename AND its
# safetensors `ss_output_name` alias (e.g. basename
# "anima_npu_lora_bsk_co-00001160" + alias "anima_npu_lora_bsk_co"). Both
# spellings load the same file, so a prompt containing EITHER form must
# suppress injecting the other — otherwise the LoRA applies twice.
# ----------------------------------------------------------------------------
_scan_cache = None
_alias_cache = {}


def cached_scan():
    global _scan_cache
    if _scan_cache is None:
        _scan_cache = scan_loras()
    return _scan_cache


def _read_ss_output_name(path):
    """Read `ss_output_name` from a safetensors header (no dependency)."""
    try:
        with open(path, "rb") as f:
            (size,) = struct.unpack("<Q", f.read(8))
            if size <= 0 or size > 100 * 1024 * 1024:
                return None
            header = json.loads(f.read(size).decode("utf-8", "ignore"))
        return ((header.get("__metadata__", {}) or {}).get("ss_output_name") or "").strip() or None
    except Exception:
        return None


def lora_identities(display_or_name):
    """All `<lora:NAME` id prefixes that resolve to the same file."""
    base = normalize_lora_name(display_or_name)
    ids = {f"<lora:{base}"} if base else set()
    if not base:
        return ids
    if base not in _alias_cache:
        alias = None
        try:
            for display, (_base, full) in cached_scan().items():
                if _base == base:
                    alias = _read_ss_output_name(full)
                    break
        except Exception:
            alias = None
        _alias_cache[base] = alias
    alias = _alias_cache.get(base)
    if alias and alias != base:
        ids.add(f"<lora:{alias}")
    return ids


# ----------------------------------------------------------------------------
# Config assembly (UI values -> camera engine config dict)
# ----------------------------------------------------------------------------
def build_config(v):
    """Build a camera-engine config dict from a ``dict(zip(UI_FIELDS, args))``."""
    d = cam.DEFAULT_CONFIG
    cfg = {
        "weight_min": float(v["weight_min"]),
        "weight_max": float(v["weight_max"]),
        "no_weight": bool(v["no_weight"]),
        "no_weight_threshold": float(v["no_weight_threshold"]),
        "azimuth": {
            "enabled": bool(v["az_enabled"]),
            "weight": float(v["az_weight"]),
            "deadzone_ratio": float(v["az_deadzone"]),
            "directions": {
                "front": {"tag": d["azimuth"]["directions"]["front"]["tag"],
                          "enabled": bool(v["dir_front_en"])},
                "back": {"tag": d["azimuth"]["directions"]["back"]["tag"],
                         "enabled": bool(v["dir_back_en"])},
                "left": {"tag": d["azimuth"]["directions"]["left"]["tag"],
                         "enabled": bool(v["dir_left_en"])},
                "right": {"tag": d["azimuth"]["directions"]["right"]["tag"],
                          "enabled": bool(v["dir_right_en"])},
            },
        },
        "elevation": {
            "enabled": bool(v["el_enabled"]),
            "extra": float(v["el_extra"]),
            "eye_peak": float(v["eye_peak"]),
            "categories": {
                key: {"tag": d["elevation"]["categories"][key]["tag"],
                      "enabled": bool(v[f"el_{key}_en"])}
                for key in ("bird", "high", "eye", "low", "worm")
            },
        },
        "distance": {
            "enabled": bool(v["di_enabled"]),
            "extra": float(v["di_extra"]),
            "categories": {
                key: {"tag": d["distance"]["categories"][key]["tag"],
                      "enabled": bool(v[f"di_{key}_en"])}
                for key in ("ecu", "cu", "medium", "full", "wide")
            },
        },
        "tilt": {
            "enabled": bool(v["ti_enabled"]),
            "deadzone": float(v["ti_deadzone"]),
            "extra": float(v["ti_extra"]),
            "dutch_tag": (v["dutch_tag"] or "").strip() or "dutch angle",
        },
        "extra_master": float(v["extra_master"]),
        "wheel_step": d["wheel_step"],
        "drag_step": d["drag_step"],
        "extras": {
            "lens": {"enabled": bool(v["ex_lens_en"]),
                     "value": (v["ex_lens_val"] or "").strip()},
            "dof": {"enabled": bool(v["ex_dof_en"]),
                    "value": (v["ex_dof_val"] or "").strip(),
                    "weight": float(v["dof_weight"])},
            "movement": {"enabled": bool(v["ex_move_en"]),
                         "value": (v["ex_move_val"] or "").strip()},
            "composition": {"enabled": bool(v["ex_comp_en"]),
                            "value": (v["ex_comp_val"] or "").strip()},
            "style": {"enabled": bool(v["ex_style_en"]),
                      "value": (v["ex_style_val"] or "").strip()},
        },
    }
    return cfg


def values_from_watched(vals):
    return dict(zip(WATCHED, vals))


def camera_fragment(values):
    """(camera_prompt_stripped, state_line) for preview / process."""
    cfg = build_config(values)
    raw = cam.compute_camera_prompt(
        float(values["pos_x"]),
        float(values["pos_y"]),
        float(values["pos_z"]),
        float(values["roll"]),
        cfg,
    )
    state = cam.describe_state(
        float(values["pos_x"]),
        float(values["pos_y"]),
        float(values["pos_z"]),
        float(values["roll"]),
        cfg,
    )
    return raw.strip().rstrip(","), state


def lora_tag_for(values):
    name = normalize_lora_name(
        (values.get("lora_custom") or "").strip() or (values.get("lora_name") or "")
    )
    try:
        strength = float(values.get("lora_strength", 0.8))
    except (TypeError, ValueError):
        strength = 0.8
    if not name or strength <= 0:
        return "", name, strength
    return f"<lora:{name}:{strength}>", name, strength


def render_preview(*vals):
    values = values_from_watched(vals)
    fragment, state = camera_fragment(values)
    tag, name, strength = lora_tag_for(values)
    lines = [f"state: {state}"]
    if fragment:
        lines.append(f"camera: {fragment},")
    else:
        lines.append("camera: (no tags at this position)")
    if tag:
        lines.append(f"lora: {tag}")
    elif name:
        lines.append("lora: (strength is 0, LoRA disabled)")
    else:
        lines.append("lora: (none selected — pick the camera LoRA)")
    return "\n".join(lines)


_LORA_TAG_RE = re.compile(r"<lora:[^>\n]+>")
_NO_TAGS_RE = re.compile(r"^\s*\(?no tags", re.IGNORECASE)


def parse_preview_override(preview_text, fallback_fragment="", fallback_tag=""):
    """Honor a manual edit of the preview box.

    Returns (fragment, tag, edited) where ``edited`` is True when the
    preview text supplied at least one labeled line (``camera:`` /
    ``lora:``) or non-empty raw text, i.e. process() should use these
    values instead of the freshly computed ones. An empty/blank preview
    falls back to the computed values with ``edited=False``.

    Accepted forms:
    - the standard 3-line preview (``state:`` / ``camera:`` / ``lora:``)
      as produced by render_preview — edit the ``camera:`` / ``lora:``
      lines in place;
    - raw tags with no labels (e.g. pasted ``(from front:1.40), ...``):
      the whole box is treated as the camera fragment, and any
      ``<lora:...>`` found inside is lifted out as the LoRA tag.
    """
    if preview_text is None:
        return fallback_fragment, fallback_tag, False
    text = str(preview_text)
    if not text.strip():
        return fallback_fragment, fallback_tag, False
    cam_line = None
    lora_line = None
    has_lora_label = False
    for line in text.splitlines():
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("camera:") and cam_line is None:
            cam_line = stripped[len("camera:"):].strip()
        elif low.startswith("lora:") and not has_lora_label:
            has_lora_label = True
            lora_line = stripped[len("lora:"):].strip()
    if cam_line is None and not has_lora_label:
        # raw paste: everything is the fragment except an embedded LoRA tag
        m = _LORA_TAG_RE.search(text)
        tag = m.group(0) if m else fallback_tag
        fragment = _LORA_TAG_RE.sub("", text).strip().rstrip(",").strip()
        if not fragment:
            return fallback_fragment, tag, False
        return fragment, tag, True
    if cam_line is not None:
        if _NO_TAGS_RE.match(cam_line):
            fragment = ""
        else:
            fragment = cam_line.rstrip(", ").strip()
    else:
        fragment = fallback_fragment
    if has_lora_label:
        m = _LORA_TAG_RE.search(lora_line or "")
        tag = m.group(0) if m else ""
    else:
        tag = fallback_tag
    return fragment, tag, True


def _lora_name_from_tag(tag):
    """Extract the LoRA name from a ``<lora:NAME[:...]>`` tag."""
    m = re.match(r"\s*<\s*lora\s*:\s*([^:>]+)", tag or "", re.IGNORECASE)
    return normalize_lora_name(m.group(1)) if m else ""


def _split_fragment(fragment):
    """Split a camera fragment into chunks, ignoring commas inside (tag:w)."""
    parts, depth, buf = [], 0, ""
    for ch in fragment:
        if ch == "," and depth == 0:
            parts.append(buf)
            buf = ""
        else:
            buf += ch
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(0, depth - 1)
    parts.append(buf)
    return [p.strip() for p in parts if p.strip().strip(",").strip()]


_WEIGHTED_CHUNK_RE = re.compile(r"\(([^():]+):([^()]*)\)")


def _exclusive_members():
    """Chunk tag texts that are mutually exclusive per axis.

    Elevation and distance emit exactly ONE category (like the ComfyUI
    node), so a fresh chunk retires stale chunks of sibling categories.
    Azimuth co-emits and extras are free text: never touched.
    """
    members = {"elevation": set(), "distance": set()}
    for axis in members:
        for _key, cat in cam.DEFAULT_CONFIG[axis]["categories"].items():
            for part in str(cat.get("tag", "")).split(","):
                part = part.strip()
                if part:
                    members[axis].add(part)
    return members


_EXCLUSIVE = _exclusive_members()


def _family_of(tag_text):
    for axis, tags in _EXCLUSIVE.items():
        if tag_text in tags:
            return axis
    return None


def apply_suffix(prompt, fragment, tag, extra_lora_ids=()):
    """Merge the camera fragment + LoRA trigger into the prompt, Comfy-clean.

    Mirrors ComfyUI's bsk_StringMergeWithSwitch (strip, join with ", "):
    the base prompt keeps the user's own formatting; only joints are
    normalized (no doubled commas/spaces).

    Per-chunk reconciliation (so re-runs and pasted infotext never stack):
    - exact chunk already present -> nothing;
    - same tag with a STALE weight, e.g. pasted `(wide shot:1.00)` while the
      sliders now say `(wide shot:1.90)` -> replaced in place (sliders stay
      live, no duplicates);
    - plain (unweighted) extras present -> skipped.
    LoRA guard is identity-aware: any known spelling (basename or
    `ss_output_name` alias) suppresses injecting another copy, so the LoRA
    can never apply twice.
    """
    prompt = prompt or ""
    fresh = []
    for chunk in _split_fragment(fragment or ""):
        m = _WEIGHTED_CHUNK_RE.fullmatch(chunk)
        if not m:
            if chunk and chunk not in prompt:
                fresh.append(chunk)
            continue
        tag_text = m.group(1).strip()
        if not tag_text:
            continue
        if chunk in prompt:
            continue
        stale = re.compile(r"\(" + re.escape(tag_text) + r":[^\n()]*\)")
        if stale.search(prompt):
            prompt = stale.sub(chunk, prompt)
        else:
            # mutually exclusive axis (elevation/distance): a fresh category
            # retires stale sibling categories, e.g. pasted (wide shot:*)
            # while the sliders now say medium.
            fam = _family_of(tag_text)
            if fam:
                for sibling in _EXCLUSIVE[fam]:
                    if sibling != tag_text:
                        prompt = re.sub(
                            r"\(" + re.escape(sibling) + r":[^\n()]*\)",
                            "",
                            prompt,
                        )
                prompt = re.sub(r"[ \t]*,[ \t]*,[ \t]*", ", ", prompt)
                prompt = prompt.strip().rstrip(", ")
            fresh.append(chunk)

    if tag and tag not in prompt:
        # "<lora:NAME:0.8>" -> "<lora:NAME" (same LoRA, any weight)
        own_id = ":".join(tag.split(":")[:2])
        known = set(extra_lora_ids) | {own_id}
        if not any(k and k in prompt for k in known):
            fresh.append(tag)

    if not fresh:
        return prompt
    base = prompt.strip().rstrip(", ")
    if not base:
        return ", ".join(fresh)
    return f"{base}, " + ", ".join(fresh)


class AnimaCameraScript(scripts.Script):
    sorting_priority = 260209302

    def title(self):
        return EXT_TITLE

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    # -- UI ---------------------------------------------------------------
    def ui(self, is_img2img):
        lora_choices = list(scan_loras().keys())
        lora_default = default_lora_name(lora_choices)

        accordion = (
            InputAccordion(False, label=EXT_TITLE, elem_id="anima_cam_accordion")
            if InputAccordion is not None
            else gr.Accordion(EXT_TITLE, open=False, elem_id="anima_cam_accordion")
        )
        with accordion as enabled:
            if InputAccordion is None:
                enabled = gr.Checkbox(
                    False, label="Enable Anima Camera Control"
                )
            gr.Markdown(
                "Appends camera tags (front / high angle / close-up / ...) to the "
                "prompt and triggers the Anima camera-control LoRA. "
                "Mirrors the ComfyUI `BSK_Camera Control` node."
            )
            with gr.Row():
                lora_name = gr.Dropdown(
                    label="Camera LoRA",
                    choices=lora_choices or ["(no LoRA files found — rescan or type below)"],
                    value=lora_default if lora_default else None,
                    info="Neo resolves <lora:> tags by bare filename; subfolders shown for clarity only.",
                )
                refresh = gr.Button("🔄", min_width=48)
            lora_custom = gr.Textbox(
                label="LoRA override (optional)",
                placeholder="Only if the dropdown misses your file — overrides the dropdown.",
                lines=1,
            )
            lora_strength = gr.Slider(
                label="LoRA strength",
                minimum=0.0,
                maximum=2.0,
                step=0.05,
                value=0.8,
                info="ComfyUI workflow uses 0.8 (model) / 0.8 (clip).",
            )

            with gr.Row():
                pos_x = gr.Slider(-1.0, 1.0, step=0.01, value=0.0,
                                  label="Left / Right (X)",
                                  elem_id="anima_cam_pos_x")
                pos_y = gr.Slider(-1.0, 1.0, step=0.01, value=0.0,
                                  label="Up / Down (Y)",
                                  elem_id="anima_cam_pos_y")
            with gr.Row():
                pos_z = gr.Slider(-1.0, 1.0, step=0.01, value=0.0,
                                  label="Forward / Back (Z)",
                                  elem_id="anima_cam_pos_z")
                roll = gr.Slider(-1.0, 1.0, step=0.01, value=0.0,
                                 label="Roll (dutch angle)",
                                 elem_id="anima_cam_roll")

            with gr.Row():
                preset_btns = [
                    gr.Button(label, size="sm") for label, _ in PRESETS
                ]

            _ex = cam.DEFAULT_CONFIG["extras"]
            _initial_watched = {
                "lora_name": lora_default or (lora_choices[0] if lora_choices else ""),
                "lora_custom": "",
                "lora_strength": 0.8,
                "pos_x": 0.0,
                "pos_y": 0.0,
                "pos_z": 0.0,
                "roll": 0.0,
                "az_enabled": True,
                "az_weight": 10.0,
                "az_deadzone": 0.2,
                "el_enabled": True,
                "el_extra": 10.0,
                "eye_peak": 3.0,
                "di_enabled": True,
                "di_extra": 0.0,
                "ti_enabled": True,
                "ti_deadzone": 0.15,
                "ti_extra": 0.0,
                "dutch_tag": "dutch angle",
                "extra_master": 1.0,
                "weight_min": 0.1,
                "weight_max": 10.0,
                "no_weight": False,
                "no_weight_threshold": 0.5,
                "dir_front_en": True,
                "dir_back_en": True,
                "dir_left_en": True,
                "dir_right_en": True,
                "el_bird_en": True,
                "el_high_en": True,
                "el_eye_en": True,
                "el_low_en": True,
                "el_worm_en": True,
                "di_ecu_en": True,
                "di_cu_en": True,
                "di_medium_en": True,
                "di_full_en": True,
                "di_wide_en": True,
                "ex_lens_en": False,
                "ex_lens_val": _ex["lens"]["value"],
                "ex_dof_en": False,
                "ex_dof_val": _ex["dof"]["value"],
                "dof_weight": 1.3,
                "ex_move_en": False,
                "ex_move_val": _ex["movement"]["value"],
                "ex_comp_en": False,
                "ex_comp_val": _ex["composition"]["value"],
                "ex_style_en": False,
                "ex_style_val": _ex["style"]["value"],
            }
            try:
                _initial_preview = render_preview(
                    *[_initial_watched[f] for f in WATCHED]
                )
            except Exception:
                _initial_preview = ""

            preview = gr.Textbox(
                label="Camera prompt preview (editable)",
                lines=4,
                interactive=True,
                value=_initial_preview,
                info="Live from the sliders — but your edit wins: whatever is "
                     "in this box at Generate time is what gets appended.",
                elem_id="anima_cam_preview",
            )
            with gr.Row():
                reset_all_btn = gr.Button(
                    "↺ Reset all to fresh-session defaults",
                    size="sm",
                    elem_id="anima_cam_reset_all",
                )

            with gr.Accordion("Azimuth / Elevation / Distance / Tilt", open=False):
                with gr.Row():
                    az_enabled = gr.Checkbox(True, label="Azimuth (front/back/left/right)")
                    az_weight = gr.Slider(0.1, 20.0, step=0.1, value=10.0,
                                          label="Azimuth weight")
                    az_deadzone = gr.Slider(0.0, 0.9, step=0.01, value=0.2,
                                            label="Azimuth deadzone")
                with gr.Row():
                    el_enabled = gr.Checkbox(True, label="Elevation (high/low/...)")
                    el_extra = gr.Slider(0.0, 20.0, step=0.1, value=10.0,
                                         label="Elevation extra")
                    eye_peak = gr.Slider(1.0, 10.0, step=0.1, value=3.0,
                                         label="Eye-level peak")
                with gr.Row():
                    di_enabled = gr.Checkbox(True, label="Distance (close-up/wide/...)")
                    di_extra = gr.Slider(0.0, 20.0, step=0.1, value=0.0,
                                         label="Distance extra")
                with gr.Row():
                    ti_enabled = gr.Checkbox(True, label="Tilt (dutch angle)")
                    ti_deadzone = gr.Slider(0.0, 1.0, step=0.01, value=0.15,
                                            label="Tilt deadzone")
                    ti_extra = gr.Slider(0.0, 20.0, step=0.1, value=0.0,
                                         label="Tilt extra")
                dutch_tag = gr.Textbox("dutch angle", label="Dutch tag", lines=1)
                with gr.Row():
                    extra_master = gr.Slider(0.0, 2.0, step=0.05, value=1.0,
                                             label="Extra master")
                    weight_min = gr.Slider(0.01, 2.0, step=0.01, value=0.1,
                                           label="Weight min")
                    weight_max = gr.Slider(1.0, 20.0, step=0.1, value=10.0,
                                           label="Weight max")
                with gr.Row():
                    no_weight = gr.Checkbox(False, label="No-weight mode (plain tags)")
                    no_weight_threshold = gr.Slider(
                        0.0, 1.0, step=0.05, value=0.5,
                        label="No-weight 2nd-direction threshold")


            with gr.Accordion("Direction / category switches", open=False):
                with gr.Row():
                    dir_front_en = gr.Checkbox(True, label="front")
                    dir_back_en = gr.Checkbox(True, label="behind")
                    dir_left_en = gr.Checkbox(True, label="left")
                    dir_right_en = gr.Checkbox(True, label="right")
                with gr.Row():
                    el_bird_en = gr.Checkbox(True, label="bird (directly above)")
                    el_high_en = gr.Checkbox(True, label="high angle")
                    el_eye_en = gr.Checkbox(True, label="eye-level")
                    el_low_en = gr.Checkbox(True, label="low angle")
                    el_worm_en = gr.Checkbox(True, label="worm (directly below)")
                with gr.Row():
                    di_ecu_en = gr.Checkbox(True, label="extreme close-up")
                    di_cu_en = gr.Checkbox(True, label="close-up")
                    di_medium_en = gr.Checkbox(True, label="medium shot")
                    di_full_en = gr.Checkbox(True, label="full body")
                    di_wide_en = gr.Checkbox(True, label="wide shot")

            with gr.Accordion("Lens / depth / movement / composition / style", open=False):
                d = cam.DEFAULT_CONFIG["extras"]
                with gr.Row():
                    ex_lens_en = gr.Checkbox(False, label="Lens")
                    ex_lens_val = gr.Textbox(d["lens"]["value"], label="Lens", lines=1)
                with gr.Row():
                    ex_dof_en = gr.Checkbox(False, label="Depth of field")
                    ex_dof_val = gr.Textbox(d["dof"]["value"], label="DoF", lines=1)
                    dof_weight = gr.Slider(0.1, 5.0, step=0.05, value=1.3,
                                           label="DoF weight")
                with gr.Row():
                    ex_move_en = gr.Checkbox(False, label="Movement")
                    ex_move_val = gr.Textbox(d["movement"]["value"],
                                             label="Movement", lines=1)
                with gr.Row():
                    ex_comp_en = gr.Checkbox(False, label="Composition")
                    ex_comp_val = gr.Textbox(d["composition"]["value"],
                                             label="Composition", lines=1)
                with gr.Row():
                    ex_style_en = gr.Checkbox(False, label="Style")
                    ex_style_val = gr.Textbox(d["style"]["value"],
                                              label="Style", lines=1)

        ordered = {name: comp for name, comp in [
            ("enabled", enabled),
            ("lora_name", lora_name),
            ("lora_custom", lora_custom),
            ("lora_strength", lora_strength),
            ("pos_x", pos_x),
            ("pos_y", pos_y),
            ("pos_z", pos_z),
            ("roll", roll),
            ("az_enabled", az_enabled),
            ("az_weight", az_weight),
            ("az_deadzone", az_deadzone),
            ("el_enabled", el_enabled),
            ("el_extra", el_extra),
            ("eye_peak", eye_peak),
            ("di_enabled", di_enabled),
            ("di_extra", di_extra),
            ("ti_enabled", ti_enabled),
            ("ti_deadzone", ti_deadzone),
            ("ti_extra", ti_extra),
            ("dutch_tag", dutch_tag),
            ("extra_master", extra_master),
            ("weight_min", weight_min),
            ("weight_max", weight_max),
            ("no_weight", no_weight),
            ("no_weight_threshold", no_weight_threshold),
            ("dir_front_en", dir_front_en),
            ("dir_back_en", dir_back_en),
            ("dir_left_en", dir_left_en),
            ("dir_right_en", dir_right_en),
            ("el_bird_en", el_bird_en),
            ("el_high_en", el_high_en),
            ("el_eye_en", el_eye_en),
            ("el_low_en", el_low_en),
            ("el_worm_en", el_worm_en),
            ("di_ecu_en", di_ecu_en),
            ("di_cu_en", di_cu_en),
            ("di_medium_en", di_medium_en),
            ("di_full_en", di_full_en),
            ("di_wide_en", di_wide_en),
            ("ex_lens_en", ex_lens_en),
            ("ex_lens_val", ex_lens_val),
            ("ex_dof_en", ex_dof_en),
            ("ex_dof_val", ex_dof_val),
            ("dof_weight", dof_weight),
            ("ex_move_en", ex_move_en),
            ("ex_move_val", ex_move_val),
            ("ex_comp_en", ex_comp_en),
            ("ex_comp_val", ex_comp_val),
            ("ex_style_en", ex_style_en),
            ("ex_style_val", ex_style_val),
            ("preview_text", preview),
        ]}
        assert list(ordered) == UI_FIELDS, (
            f"UI return order drifted: {[k for k in ordered if k not in UI_FIELDS]}"
        )

        watched_inputs = [ordered[name] for name in WATCHED]

        # live preview on any relevant change
        for comp in watched_inputs:
            try:
                comp.change(fn=render_preview, inputs=watched_inputs,
                            outputs=[preview], show_progress=False, queue=False)
            except TypeError:  # older gradio without queue/show_progress kwargs
                comp.change(fn=render_preview, inputs=watched_inputs,
                            outputs=[preview])

        # LoRA rescan
        def _rescan():
            choices = list(scan_loras().keys())
            return gr.update(
                choices=choices or ["(no LoRA files found — rescan or type below)"],
                value=default_lora_name(choices) or gr.update(),
            )

        refresh.click(fn=_rescan, outputs=[lora_name],
                      show_progress=False, queue=False)

        # presets: keep other watched values, override positions, refresh preview
        pos_idx = [WATCHED.index(n) for n in ("pos_x", "pos_y", "pos_z", "roll")]

        for (label, overrides), btn in zip(PRESETS, preset_btns):
            def _preset(*vals, _overrides=overrides):
                values = values_from_watched(vals)
                for key, val in _overrides.items():
                    values[key] = val
                fragment, state = camera_fragment(values)
                tag, _name, _strength = lora_tag_for(values)
                lines = [f"state: {state}"]
                lines.append(
                    f"camera: {fragment}," if fragment
                    else "camera: (no tags at this position)")
                lines.append(f"lora: {tag}" if tag else "lora: (none selected)")
                return (
                    values["pos_x"], values["pos_y"],
                    values["pos_z"], values["roll"],
                    "\n".join(lines),
                )

            btn.click(fn=_preset, inputs=watched_inputs,
                      outputs=[pos_x, pos_y, pos_z, roll, preview],
                      show_progress=False, queue=False)

        # -- full reset: every value back to how a fresh session looks ------
        # Captured here (not recomputed in the handler) so Reset restores
        # the exact defaults this session started with, including the
        # LoRA detected at load and the fresh preview text.
        _d = cam.DEFAULT_CONFIG["extras"]
        fresh_defaults = {
            "enabled": False,
            "lora_name": lora_default or (lora_choices[0] if lora_choices else ""),
            "lora_custom": "",
            "lora_strength": 0.8,
            "pos_x": 0.0,
            "pos_y": 0.0,
            "pos_z": 0.0,
            "roll": 0.0,
            "az_enabled": True,
            "az_weight": 10.0,
            "az_deadzone": 0.2,
            "el_enabled": True,
            "el_extra": 10.0,
            "eye_peak": 3.0,
            "di_enabled": True,
            "di_extra": 0.0,
            "ti_enabled": True,
            "ti_deadzone": 0.15,
            "ti_extra": 0.0,
            "dutch_tag": "dutch angle",
            "extra_master": 1.0,
            "weight_min": 0.1,
            "weight_max": 10.0,
            "no_weight": False,
            "no_weight_threshold": 0.5,
            "dir_front_en": True,
            "dir_back_en": True,
            "dir_left_en": True,
            "dir_right_en": True,
            "el_bird_en": True,
            "el_high_en": True,
            "el_eye_en": True,
            "el_low_en": True,
            "el_worm_en": True,
            "di_ecu_en": True,
            "di_cu_en": True,
            "di_medium_en": True,
            "di_full_en": True,
            "di_wide_en": True,
            "ex_lens_en": False,
            "ex_lens_val": _d["lens"]["value"],
            "ex_dof_en": False,
            "ex_dof_val": _d["dof"]["value"],
            "dof_weight": 1.3,
            "ex_move_en": False,
            "ex_move_val": _d["movement"]["value"],
            "ex_comp_en": False,
            "ex_comp_val": _d["composition"]["value"],
            "ex_style_en": False,
            "ex_style_val": _d["style"]["value"],
        }
        fresh_defaults["preview_text"] = render_preview(
            *[fresh_defaults[f] for f in WATCHED]
        )

        def _reset_all():
            return [fresh_defaults[f] for f in UI_FIELDS]

        try:
            reset_all_btn.click(fn=_reset_all, inputs=[],
                                outputs=[ordered[name] for name in UI_FIELDS],
                                show_progress=False, queue=False)
        except TypeError:  # older gradio without queue/show_progress kwargs
            reset_all_btn.click(fn=_reset_all, inputs=[],
                                outputs=[ordered[name] for name in UI_FIELDS])

        return [ordered[name] for name in UI_FIELDS]

    # -- generation -------------------------------------------------------
    def process(self, p, *args):
        if len(args) != len(UI_FIELDS):
            # Tolerate arg vectors built before preview_text existed
            # (e.g. older XYZ-plot configs): missing preview just means
            # "no manual edit".
            if len(args) != len(UI_FIELDS) - 1 or "preview_text" not in UI_FIELDS:
                print(f"[{EXT_TITLE}] arg mismatch "
                      f"({len(args)} != {len(UI_FIELDS)}); skipping.")
                return
            args = tuple(args) + ("",)
        values = dict(zip(UI_FIELDS, args))
        if not values.get("enabled"):
            return

        fragment, state = camera_fragment(values)
        tag, lora_name, strength = lora_tag_for(values)

        # Manual edit wins: whatever is in the preview box at Generate
        # time is what gets appended (sliders stay untouched, so moving a
        # slider afterwards simply re-renders and overwrites the box).
        manual_edit = False
        preview_raw = values.get("preview_text", "")
        if isinstance(preview_raw, str) and preview_raw.strip():
            fragment, tag, manual_edit = parse_preview_override(
                preview_raw, fragment, tag
            )
            if manual_edit:
                lora_name = _lora_name_from_tag(tag) or lora_name
                try:
                    m = re.match(r"\s*<\s*lora\s*:[^:>]+:\s*([^>]+)",
                                 tag or "")
                    if m:
                        strength = float(m.group(1).strip())
                except (TypeError, ValueError):
                    pass

        if not fragment and not tag:
            return

        identities = lora_identities(
            (values.get("lora_custom") or "").strip() or (values.get("lora_name") or "")
        )
        if manual_edit and tag:
            # the edited box may spell a LoRA the dropdown doesn't know
            # (alias / custom file) — its identity must also suppress
            # injecting a second copy.
            identities |= lora_identities(_lora_name_from_tag(tag))
        prompts = getattr(p, "all_prompts", None) or [getattr(p, "prompt", "")]
        p.all_prompts = [
            apply_suffix(pr or "", fragment, tag, identities) for pr in prompts
        ]
        if getattr(p, "prompt", None) is not None and p.all_prompts:
            p.prompt = p.all_prompts[0]

        try:
            p.extra_generation_params.update({
                "Anima Camera": (fragment + ",") if fragment else "(off)",
                "Anima Camera XYZR": (
                    f"{float(values['pos_x']):.2f}, "
                    f"{float(values['pos_y']):.2f}, "
                    f"{float(values['pos_z']):.2f}, "
                    f"{float(values['roll']):.2f} ({state})"
                ),
                "Anima Camera LoRA": f"{lora_name}:{strength}" if lora_name else "(none)",
                "Anima Camera source": "manual preview edit" if manual_edit else "sliders",
            })
        except Exception:
            pass
