# Anima Camera Control for Forge Neo

A [sd-webui-forge-classic](https://github.com/Haoming02/sd-webui-forge-classic)
(Neo) extension that ports the ComfyUI **BSK_Camera Control** node
(`bsk_CameraControlNode`) to Forge's txt2img / img2img UI.

It appends camera tags — `from front`, `high angle, from above`,
`close-up`, `dutch angle`, ... with `(tag:weight)` strengths — to your prompt
and triggers the Anima camera-control LoRA through an extra-network
`<lora:...>` tag. Same math, same tags, same defaults as the ComfyUI node,
so the bundled ComfyUI workflows
(`anima_camera_control.json` / `img2img_anima_camera_control.json`) translate
1:1: **base prompt + camera prompt, LoRA at 0.8, 30 steps, CFG 4.5**.

## Credit / license

- Original camera logic: **灰暗x**, **ComfyUI-bsk_UI**
  (bilibili: https://space.bilibili.com/26779709), via the standalone
  repackage `Anima-Camera-Control`.
- Tutorial videos: https://www.bilibili.com/video/BV11SNq6wEvP ·
  https://www.bilibili.com/video/BV1dCN16MEqL
- License: **GNU AGPL v3** (see `LICENSE`) — this port keeps the same license,
  and the prompt-generation math is unmodified.

## Requirements

- Forge Neo (`sd-webui-forge-classic` by Haoming02). Should also load on
  classic WebUI/Forge with `InputAccordion` support; on older UIs it falls
  back to a plain accordion + enable checkbox.
- An Anima checkpoint that already generates normally in your Forge install.
- The camera-control LoRA (see below).

## Install

1. Copy the `sd-forge-anima-camera` folder into:
   ```
   <forge>/extensions/sd-forge-anima-camera/
   ```
   so that `scripts/anima_camera.py` ends up at
   `extensions/sd-forge-anima-camera/scripts/anima_camera.py`.
2. Place the camera LoRA anywhere under your LoRA folder — subfolders are
   fine and encouraged, e.g.:
   ```
   models/Lora/Anima/Utility/anima_npu_lora_bsk_co-00001160.safetensors
   ```
   The extension scans `models/Lora` recursively and pre-selects a file whose
   name contains `anima_npu_lora_bsk_co-00001160`. Keep your organized folders.
3. Restart Forge.

> **Neo namespace note (important):** Forge Neo resolves `<lora:...>` tags by
> **bare filename only** — `Anima/Utility/anima_npu_lora_bsk_co-00001160`
> will *not* load (`Failed to load LoRA`), while
> `anima_npu_lora_bsk_co-00001160` loads fully (280 UNet + 256 CLIP keys,
> verified live). The extension therefore always injects the basename; the
> dropdown shows the subfolder path purely for disambiguation. Consequence:
> if two files in different subfolders share a basename, Neo itself cannot
> tell them apart — rename one.

## Use

1. Pick your Anima checkpoint (base v1, 3.8B v2 bundle, etc. — the extension
   is checkpoint-agnostic: it only edits prompt text plus a `<lora>` tag).
2. Expand **Anima Camera Control**, tick the enable box (top of the panel).
3. Confirm the **Camera LoRA** dropdown shows
   `Anima/Utility/anima_npu_lora_bsk_co-00001160` (path shown for clarity;
   the injected tag uses the bare basename, per the note above). Hit 🔄 if
   you just added the file. If the dropdown misses it, paste the filename
   into **LoRA override**.
4. Move the **X / Y / Z / Roll** sliders (or use a preset button). The
   **preview box** shows the exact tags that will be appended — and it is
   editable: tweak the `camera:` / `lora:` lines (or paste raw tags) and
   whatever is in the box at Generate time is what gets appended.
   Moving a slider re-renders the box (overwriting your edit), and
   **↺ Reset all to fresh-session defaults** restores every control plus
   the preview to how a fresh session looks.
5. Generate. The final prompt is `your prompt, <camera tags>,
   <lora:anima_npu_lora_bsk_co-00001160:0.8>`.

ComfyUI equivalents for reference:

| ComfyUI | Forge extension |
|---|---|
| `pos_x / pos_y / pos_z / roll` | X / Y / Z / Roll sliders (−1…1) |
| `LoraLoader` 0.8 / 0.8 | LoRA dropdown + strength `0.8` (single Forge strength ≈ both) |
| base prompt + camera merge | automatic suffix on every prompt in the batch |
| KSampler 30 steps, CFG 4.5 | your normal sampler settings |

### Notes

- **Prompt weights match ComfyUI exactly.** The extension emits the same
  Comfy-scale weights as the reference `CameraControlNode` (up to
  `(tag:10.00)`). Use `No-weight mode` if your setup dislikes
  `(tag:weight)` syntax.
- The negative prompt is left untouched (same as the ComfyUI workflows).
- Prompt editing is idempotent: re-runs, Hires. fix second passes and XYZ
  plot combinations won't stack duplicate tags.
- Generation parameters record `Anima Camera`, `Anima Camera XYZR` and
  `Anima Camera LoRA`, so PNG infotext keeps your camera settings.
- `no-weight mode` emits plain tags for setups that dislike `(tag:weight)`.
- API / XYZ plot: the script is `AlwaysVisible`; pass its parameters through
  `alwayson_scripts` like any other script.

### The camera canvas

The accordion embeds the ComfyUI node's **3D orbit viewport** (ported
1:1 — same perspective projection, same gestures):

- **Left-drag** grabs and orbits the camera around the subject (X wraps
  past ±1, like turning all the way around)
- **Right-drag** changes distance (left = closer, right = farther)
- **Wheel** = distance, **Shift+wheel** = roll, **arrows / `[` `]` /
  `,` `.`** nudge everything (Shift = coarse), **double-click** resets
- Header shows live `LEFT/RIGHT n°` and `ROLL: n°`; the orange camera icon
  tilts with roll, the dashed line is its sight-line to the subject
- World-direction words are drawn on the scene itself — FRONT, BACK, LEFT,
  RIGHT, ABOVE, BELOW — plus a STRAIGHT-ON badge at the default view and a
  bottom status line (`BEHIND · LOW · FULL BODY`)
- Tip: clean side views live at the 3/9-o'clock positions — use the Left /
  Right preset buttons (exactly ±0.5). Near ±1 the from-behind component
  dominates by design (same as the ComfyUI node), so both extremes read as
  "behind"

Dragging the canvas writes straight into the X/Y/Z/Roll sliders, so the
preview box and presets stay in sync.

## Known limitations

- Per-direction custom tag *text* is fixed to the ComfyUI defaults (enable
  switches are exposed). If you translated the tags in ComfyUI, tell me and
  I'll add text fields in v2.

## Troubleshooting framing ("wide doesn't go wide")

Framing is a tug-of-war, and the camera tag is only one side of the rope:

- The camera LoRA was trained on 63 images covering **azimuth only**
  (3 behind + 30 left + 30 right — see the LoRA's `ss_dataset_dirs`
  metadata). It has no learned "wide/far" direction; distance and elevation
  tags are served by the **base model**. Verified live: `(wide shot:1.00)`
  vs `(wide shot:1.90)` framed identically.
- The usual anchor keeping shots close is a **character/detail LoRA**:
  seed-locked tests showed `training_3902573` even at 0.3 holding a medium
  shot while removing it pulled back further. But that alone is not enough
  either — both levers are needed together (same seed 2632675446):
  training LoRA present + `wide 1.00` → medium; present + `wide 1.90` →
  medium; removed + `wide 1.00` → medium; removed + `wide 1.90` → true
  head-to-feet wide. So: drop detail LoRAs to 0 **and** raise **Distance
  extra** to ~10 (watch the preview: `wide 1.00 → 1.90`). For far full-body
  shots, also restore the face afterwards (e.g. ADetailer), trading some
  character fidelity.
- `blank background` leaves the model nothing to be far *in* — give it an
  environment (beach, street, room). Portrait aspects also bias toward
  medium framing; landscape helps far shots.
- Push the tag side with the **Distance extra** slider (verified live in
  the preview: `wide 1.00 → 1.90`), and strengthen wording with explicit
  `full body, showing feet, far away` in your own prompt text.
- With a standard setup (detail LoRAs on, extras at default), the Wide
  preset lands around **cowboy/medium** framing — that is the expected
  operating point, not a bug (ComfyUI behaves identically). True
  head-to-feet wide needs the recipe above.
- **Never add the camera LoRA a second time yourself.** The extension
  injects it automatically; adding it via the Lora tab too (Forge inserts
  the *alias* spelling `anima_npu_lora_bsk_co`, the extension the *basename*
  spelling) applies it twice and collapses framing back to close-up with a
  harsher look — verified live. The extension now detects the alias form
  and refuses to stack, and it reconciles pasted/stale camera tags
  per-tag instead of duplicating them (restart Forge to pick this up).

## Updates

Snapshot of the node logic as of ComfyUI-bsk_UI build 26090502. For the
latest full plugin, check the pinned link under the author's bilibili videos.
