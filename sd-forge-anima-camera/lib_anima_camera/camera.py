# SPDX-FileCopyrightText: 2026 灰暗x
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
Anima camera-control prompt engine, ported for Stable Diffusion Forge Neo.

Original author: 灰暗x (bilibili: https://space.bilibili.com/26779709)
Original project: ComfyUI-bsk_UI (AGPL-3.0-or-later), via the standalone
repackage "Anima-Camera-Control" (node ``bsk_CameraControlNode``).

This module is a faithful port of ``node/camera_control_node.py`` with the
ComfyUI node wrapper (INPUT_TYPES / execute) removed. The prompt-generation
math is intentionally unmodified so ComfyUI workflows and this Forge Neo
extension produce identical camera tags for identical inputs:

1. Azimuth (pos_x) is decomposed via az = pos_x * pi into 4 direction
   components, normalized by their sum, sharing the budget
   ``azimuth.weight`` x polar gate (gate -> 0 as |pos_y| -> 1, i.e. looking
   straight up/down kills front/back/left/right). Components below
   ``azimuth.deadzone_ratio`` are dropped.
2. Elevation (pos_y) is a 1-D mutually exclusive axis: exactly one of
   bird / high / eye / low / worm is emitted. ``eye`` is a "center"档
   peaking at y=0 (``eye_peak``) and fading to 1.0 at y=0.2; the extreme
  档 scale with |y|.
3. Distance (pos_z) is a 1-D mutually exclusive档 (ecu / cu / medium /
   full / wide); the in-档 weight ramps linearly with z across the档 range.
4. Tilt (roll) beyond ``tilt.deadzone`` emits ``dutch_tag``.
5. Extra tags (lens / dof / movement / composition / style) are
   enable-switched free text.
6. ``no_weight`` mode emits plain tags with no ``(tag:weight)`` syntax,
   for models that do not support prompt weights.

This module has no third-party dependencies (stdlib only: math/json/copy)
so it can be unit-tested outside Forge.
"""

import copy
import json
import math

# ============ Default config (must stay in sync with the ComfyUI node) ============
DEFAULT_CONFIG = {
    "weight_min": 0.1,
    "weight_max": 10.0,
    "no_weight": False,
    "no_weight_threshold": 0.5,
    "azimuth": {
        "enabled": True,
        "weight": 10.0,
        "deadzone_ratio": 0.2,
        "directions": {
            "front": {"tag": "from front", "enabled": True},
            "back": {"tag": "from behind", "enabled": True},
            "left": {"tag": "from right", "enabled": True},
            "right": {"tag": "from left", "enabled": True},
        },
    },
    "elevation": {
        "enabled": True,
        "extra": 10.0,
        "eye_peak": 3.0,
        "categories": {
            "bird": {"tag": "directly above, from above, aerial view,", "enabled": True},
            "high": {"tag": "high angle, from above", "enabled": True},
            "eye": {"tag": "eye-level", "enabled": True},
            "low": {"tag": "low angle, from below,", "enabled": True},
            "worm": {"tag": "directly below", "enabled": True},
        },
    },
    "distance": {
        "enabled": True,
        "extra": 0.0,
        "categories": {
            "ecu": {"tag": "extreme close-up", "enabled": True},
            "cu": {"tag": "close-up", "enabled": True},
            "medium": {"tag": "medium shot", "enabled": True},
            "full": {"tag": "full body", "enabled": True},
            "wide": {"tag": "wide shot", "enabled": True},
        },
    },
    "tilt": {
        "enabled": True,
        "deadzone": 0.15,
        "extra": 0.0,
        "dutch_tag": "dutch angle",
    },
    "extra_master": 1.0,
    "wheel_step": 0.0003,
    "drag_step": 0.004,
    "extras": {
        "lens": {"enabled": False, "value": "85mm lens"},
        "dof": {"enabled": False, "value": "shallow depth of field", "weight": 1.3},
        "movement": {"enabled": False, "value": "handheld camera"},
        "composition": {"enabled": False, "value": "rule of thirds"},
        "style": {"enabled": False, "value": "cinematic"},
    },
}

# Legacy schema marker keys (kept for migration of old ComfyUI configs).
LEGACY_KEYS = {"two_tier", "axes", "negative"}

# Distance档 z ranges: in-档 weight ramps 0% -> 100% of the extra weight
# from range start to range end. Crossing into the next档 restarts at 0%.
DIST_RANGES = {
    "ecu": (0.7, 1.0),
    "cu": (0.2, 0.7),
    "medium": (-0.2, 0.2),
    "full": (-0.7, -0.2),
    "wide": (-1.0, -0.7),
}

# medium/full/wide: farther (smaller z) = stronger, so the in-档 fraction is
# computed in reverse; ecu/cu are stronger when nearer (larger z).
DIST_FAR_STRONGER = {"medium", "full", "wide"}

# eye is the only "center"档: it owns y=0 and above up to this bound.
ELEV_EYE_MAX = 0.2

AZ_POLE = 0.9  # |pos_y| at which the azimuth gate fully closes


def default_config():
    """Return a deep copy of the default camera config."""
    return copy.deepcopy(DEFAULT_CONFIG)



# ---------- formatting helpers ----------
def _fmt_weight(w):
    return f"{round(float(w), 2):.2f}"


def _split_tags(tag):
    return [t.strip() for t in str(tag).split(",") if t.strip()]


def _emit_weighted(tag, w):
    return [f"({t}:{_fmt_weight(w)})" for t in _split_tags(tag)]


def _emit_plain(tag):
    return _split_tags(tag)


# ---------- config loading / migration ----------
def _merge_defaults(cfg, base):
    for k, v in base.items():
        if k not in cfg:
            cfg[k] = v
        elif isinstance(v, dict) and isinstance(cfg[k], dict):
            _merge_defaults(cfg[k], v)
    return cfg


def _has_legacy_keys(obj):
    if not isinstance(obj, dict):
        return False
    for k, v in obj.items():
        if k in LEGACY_KEYS:
            return True
        if isinstance(v, dict) and _has_legacy_keys(v):
            return True
    return False


def _strip_legacy_keys(obj):
    if not isinstance(obj, dict):
        return
    for k in list(obj.keys()):
        if k in LEGACY_KEYS:
            del obj[k]
        elif isinstance(obj[k], dict):
            _strip_legacy_keys(obj[k])


def load_config(raw):
    """Parse a config JSON string / dict / None into a complete config dict.

    Accepts the ``config`` string saved by the ComfyUI camera node verbatim,
    so workflows can be migrated by copy-paste.
    """
    if raw is None:
        return default_config()
    if isinstance(raw, dict):
        cfg = copy.deepcopy(raw)
    else:
        if isinstance(raw, str) and not raw.strip():
            return default_config()
        try:
            cfg = json.loads(raw)
        except Exception:
            return default_config()
        if not isinstance(cfg, dict):
            return default_config()
    if _has_legacy_keys(cfg):
        cfg["weight_min"] = DEFAULT_CONFIG["weight_min"]
        cfg["weight_max"] = DEFAULT_CONFIG["weight_max"]
        _strip_legacy_keys(cfg)
    _merge_defaults(cfg, default_config())
    return cfg


# ---------- axis helpers ----------
def elevation_key(y):
    y = float(y)
    if y > 0.7:
        return "bird"
    if y > ELEV_EYE_MAX:
        return "high"
    if y >= 0:
        return "eye"
    if y >= -0.7:
        return "low"
    return "worm"


def _elevation_weight(cfg, y, ek):
    elev_cfg = cfg.get("elevation") or {}
    if ek == "eye":
        peak = float(elev_cfg.get("eye_peak", 3.0))
        t = max(0.0, min(1.0, float(y) / ELEV_EYE_MAX))
        return peak + (1.0 - peak) * t
    extra_master = float(cfg.get("extra_master", 1.0))
    elev_extra = float(elev_cfg.get("extra", 0.0))
    k = 1.0 + extra_master * elev_extra
    if k <= 0:
        return 0.0
    return abs(float(y)) * k


def distance_key(z):
    z = float(z)
    if z > 0.7:
        return "ecu"
    if z > 0.2:
        return "cu"
    if z >= -0.2:
        return "medium"
    if z >= -0.7:
        return "full"
    return "wide"


def _azimuth_ratios(pos_x):
    az = float(pos_x) * math.pi
    front = max(0.0, math.cos(az))
    back = max(0.0, -math.cos(az))
    right = max(0.0, math.sin(az))
    left = max(0.0, -math.sin(az))
    s = front + back + left + right
    if s > 0:
        front /= s
        back /= s
        left /= s
        right /= s
    return (("front", front), ("back", back), ("left", left), ("right", right))


def _azimuth_gate(pos_y):
    return max(0.0, min(1.0, (1.0 - abs(float(pos_y))) / (1.0 - AZ_POLE)))


def _distance_parts(cfg, z):
    key = distance_key(float(z))
    cat = (cfg["distance"].get("categories") or {}).get(key)
    if not cat or not cat.get("tag") or not cat.get("enabled", True):
        return []
    extra_master = float(cfg.get("extra_master", 1.0))
    extra = float(cfg["distance"].get("extra", 0.0))
    wmin = float(cfg.get("weight_min", 0.1))
    wmax = float(cfg.get("weight_max", 10.0))
    start, end = DIST_RANGES[key]
    if key in DIST_FAR_STRONGER:
        frac = max(0.0, min(1.0, (end - float(z)) / (end - start)))
    else:
        frac = max(0.0, min(1.0, (float(z) - start) / (end - start)))
    w = 1.0 + frac * extra_master * extra
    w = min(wmax, max(wmin, w))
    return _emit_weighted(cat["tag"], w)



def _weighted_tilt(cfg):
    tilt = cfg.get("tilt", {})
    if not tilt.get("enabled", True):
        return []
    extra_master = float(cfg.get("extra_master", 1.0))
    extra = float(tilt.get("extra", 0.0))
    wmax = float(cfg.get("weight_max", 10.0))
    w = 1.0 + extra_master * extra
    w = min(wmax, max(0.1, w))
    return _emit_weighted(tilt.get("dutch_tag", ""), w)



# ---------- main entry points ----------
def compute_camera_prompt(pos_x, pos_y, pos_z, roll, cfg=None):
    """Compute the camera prompt fragment for the given camera position.

    ComfyUI-exact: same weights and behaviour as the reference
    ``CameraControlNode`` (``(tag:10.00)`` scale included). ``cfg`` may be
    a config dict, a JSON string (ComfyUI ``config`` wire), or None for
    defaults.
    """
    cfg = load_config(cfg) if not isinstance(cfg, dict) or cfg is None else _merge_defaults(
        copy.deepcopy(cfg), default_config()
    )
    if cfg.get("no_weight"):
        return _compute_prompt_no_weight(
            float(pos_x), float(pos_y), float(pos_z), float(roll), cfg
        )
    parts = []

    wmin = float(cfg.get("weight_min", 0.1))
    wmax = float(cfg.get("weight_max", 5.0))
    dz = float(cfg.get("azimuth", {}).get("deadzone_ratio", 0.2))

    # ---------- Azimuth ----------
    if cfg.get("azimuth", {}).get("enabled", True):
        az_gate = _azimuth_gate(pos_y)
        az_budget = float(cfg["azimuth"]["weight"]) * az_gate
        for name, ratio in _azimuth_ratios(pos_x):
            dir_cfg = cfg["azimuth"]["directions"].get(name, {})
            if not dir_cfg.get("enabled", True):
                continue
            w = ratio * az_budget
            if ratio <= 0 or w < dz:
                continue
            w = min(wmax, max(wmin, w))
            parts.extend(_emit_weighted(dir_cfg.get("tag", ""), w))


    # ---------- Elevation (mutually exclusive single档) ----------
    if cfg.get("elevation", {}).get("enabled", True):
        elev_key = elevation_key(float(pos_y))
        elev_cat = (cfg["elevation"].get("categories") or {}).get(elev_key)
        if elev_cat and elev_cat.get("tag") and elev_cat.get("enabled", True):
            ew = _elevation_weight(cfg, float(pos_y), elev_key)
            if ew > 0:
                ew = min(wmax, max(wmin, ew))
                parts.extend(_emit_weighted(elev_cat["tag"], ew))


    # ---------- Distance ----------
    if cfg.get("distance", {}).get("enabled", True):
        parts.extend(_distance_parts(cfg, float(pos_z)))

    # ---------- Tilt ----------
    if cfg.get("tilt", {}).get("enabled", True):
        if abs(float(roll)) >= float(cfg["tilt"]["deadzone"]):
            parts.extend(_weighted_tilt(cfg))

    # ---------- Extras ----------
    extras = cfg.get("extras", {})
    for key in ("lens", "dof", "movement", "composition", "style"):
        e = extras.get(key)
        if not e or not e.get("enabled"):
            continue
        val = (e.get("value") or "").strip()
        if not val:
            continue
        if key == "dof":
            w = e.get("weight", 1.3)
            parts.append(f"({val}:{_fmt_weight(w)})")
        else:
            parts.append(val)

    result = ", ".join(parts)
    if result:
        result += ","
    return result


def _compute_prompt_no_weight(pos_x, pos_y, pos_z, roll, cfg):
    parts = []
    thr = float(cfg.get("no_weight_threshold", 0.5))
    az = cfg.get("azimuth", {})
    if az.get("enabled", True):
        dirs = _azimuth_ratios(pos_x)
        az_gate = _azimuth_gate(pos_y)
        if az_gate > 0:
            dom = None
            dom_r = -1.0
            for name, ratio in dirs:
                d = az.get("directions", {}).get(name, {})
                if not d.get("enabled", True):
                    continue
                if ratio > dom_r:
                    dom_r = ratio
                    dom = name
            if dom is not None and dom_r > 0:
                parts.extend(_emit_plain(az["directions"][dom].get("tag", "")))
            for name, ratio in dirs:
                if name == dom:
                    continue
                d = az.get("directions", {}).get(name, {})
                if not d.get("enabled", True):
                    continue
                if ratio >= thr:
                    parts.extend(_emit_plain(d.get("tag", "")))
    if cfg.get("elevation", {}).get("enabled", True):
        ek = elevation_key(float(pos_y))
        if ek != "eye":
            ecat = (cfg["elevation"].get("categories") or {}).get(ek)
            if ecat and ecat.get("tag") and ecat.get("enabled", True):
                parts.extend(_emit_plain(ecat["tag"]))
    if cfg.get("distance", {}).get("enabled", True):
        dk = distance_key(float(pos_z))
        if dk != "medium":
            dcat = (cfg["distance"].get("categories") or {}).get(dk)
            if dcat and dcat.get("tag") and dcat.get("enabled", True):
                parts.extend(_emit_plain(dcat["tag"]))
    if cfg.get("tilt", {}).get("enabled", True) and abs(float(roll)) >= float(
        cfg["tilt"]["deadzone"]
    ):
        parts.extend(_emit_plain(cfg["tilt"].get("dutch_tag", "")))
    extras = cfg.get("extras", {})
    for key in ("lens", "dof", "movement", "composition", "style"):
        e = extras.get(key)
        if not e or not e.get("enabled"):
            continue
        val = (e.get("value") or "").strip()
        if val:
            parts.append(val)
    result = ", ".join(parts)
    return result + "," if result else ""


def describe_state(pos_x, pos_y, pos_z, roll, cfg=None):
    """One-line human-readable summary of the camera state (for UI preview)."""
    cfg = load_config(cfg) if not isinstance(cfg, dict) or cfg is None else cfg
    try:
        ratios = _azimuth_ratios(pos_x)
        dom = max(ratios, key=lambda kv: kv[1])
        dom_tag = (
            ((cfg.get("azimuth", {}).get("directions", {}).get(dom[0], {})) or {}).get(
                "tag", dom[0]
            )
        )
        ek = elevation_key(pos_y)
        dk = distance_key(pos_z)
        tilted = abs(float(roll)) >= float(cfg.get("tilt", {}).get("deadzone", 0.15))
        bits = [
            f"azimuth: {dom_tag} {dom[1] * 100:.0f}% (gate {_azimuth_gate(pos_y):.2f})",
            f"elevation: {ek}",
            f"distance: {dk}",
            f"tilt: {'dutch' if tilted else 'level'}",
        ]
        return " | ".join(bits)
    except Exception as exc:  # never break the UI over a preview line
        return f"(state unavailable: {exc})"
