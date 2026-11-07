/* Anima Camera Control - 3D orbit canvas for Forge Neo.
 *
 * A port of the ComfyUI BSK_CameraControl node's orbit viewport
 * (ComfyUI-bsk_UI by 灰暗x, AGPL-3.0-or-later): a perspective-projected
 * 3D scene showing the camera orbiting the subject. You SEE the camera
 * move instead of interpreting abstract sliders:
 *   left-drag ......... orbit (grab and rotate the world; X wraps around)
 *   right-drag ........ distance (drag left = closer, right = farther)
 *   wheel ............. distance (Forge addition)
 *   shift+wheel ....... roll (dutch angle)
 *   arrows / [ ] / , .  nudge X-Y / distance / roll (shift = coarse)
 *   double-click ...... reset view (Forge addition)
 *
 * The pad only drives the existing Gradio X/Y/Z/Roll sliders (by id,
 * scoped per accordion for txt2img+img2img), so the Python preview and
 * generation logic are untouched.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
(function () {
  "use strict";

  var ACC_ID = "anima_cam_accordion";
  var SLIDER_IDS = {
    x: "anima_cam_pos_x",
    y: "anima_cam_pos_y",
    z: "anima_cam_pos_z",
    r: "anima_cam_roll",
  };
  var SLIDER_LABELS = {
    x: "Left / Right (X)",
    y: "Up / Down (Y)",
    z: "Forward / Back (Z)",
    r: "Roll (dutch angle)",
  };

  // Canvas space (same as the ComfyUI node).
  var A = 560, R = 500;
  var CTR_X = 280, CTR_Y = 250, SCALE = 380, FOCAL = 4;
  var SUBJ_Y = 0.7;          // subject height above ground
  var V_OFF = 380 * -0.275;  // vertical centering offset (as in ComfyUI)
  var DRAG_STEP = 0.004;     // right-drag distance rate (Comfy default)
  var ROLL_DEG = 45;         // roll slider 1.0 == 45 degrees, as in ComfyUI

  var HINT_IDLE = "drag: orbit · right-drag / wheel: distance · shift+wheel: roll · dblclick: reset";

  function clamp(v, lo, hi) {
    v = parseFloat(v);
    if (isNaN(v)) v = 0;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function quant(v) {
    return Math.round(clamp(v, -1, 1) * 100) / 100;
  }

  function wrapX(v) {
    return (((v + 1) % 2) + 2) % 2 - 1;
  }

  function gradioRoot() {
    try {
      if (typeof gradioApp === "function") return gradioApp();
    } catch (e) { /* fall through */ }
    return document;
  }

  // ---- slider binding (scoped per accordion) ---------------------------
  function findSlider(root, key) {
    var scoped = root.querySelector("#" + SLIDER_IDS[key] + " input[type=range]");
    if (scoped) return scoped;
    var label = SLIDER_LABELS[key];
    var inputs = root.querySelectorAll('input[type="range"]');
    for (var i = 0; i < inputs.length; i++) {
      var container = inputs[i].parentElement;
      for (var depth = 0; depth < 5 && container && container !== root; depth++) {
        var text = ((container.innerText || "").split("\n"))[0] || "";
        if (text.indexOf(label) !== -1) return inputs[i];
        container = container.parentElement;
      }
    }
    return null;
  }

  function setSlider(input, v) {
    if (!input) return;
    v = quant(v);
    if (parseFloat(input.value) === v) return;
    input.value = v;
    try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
  }

  // ---- 3D math (ported from the ComfyUI node) ---------------------------
  // Perspective projection: 3D point -> screen + depth. Null when behind camera.
  function project(x, y, z) {
    var depth = FOCAL - z;
    if (depth < 0.1) return null;
    return {
      sx: CTR_X + (x / depth) * SCALE,
      sy: CTR_Y - ((y - 1.8) / depth) * SCALE + V_OFF,
      depth: depth,
    };
  }

  // Camera world position from slider state.
  function camPose(s) {
    var az = s.x * Math.PI;
    var el = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (s.y * Math.PI) / 2));
    var rad = 1.7 - 0.75 * s.z;
    return {
      x: rad * Math.cos(el) * Math.sin(az),
      y: SUBJ_Y + rad * Math.sin(el),
      z: rad * Math.cos(el) * Math.cos(az),
      R: rad, az: az, el: el,
    };
  }

  function readState(pad) {
    pad.resolve();
    function num(input) {
      return input ? clamp(input.value, -1, 1) : 0;
    }
    return {
      x: num(pad.inputs.x),
      y: num(pad.inputs.y),
      z: num(pad.inputs.z),
      r: num(pad.inputs.r),
    };
  }

  function azLabel(x) {
    var deg = 180 * x;
    if (Math.abs(x) > 0.85) return "BEHIND · 180°";
    if (x < -0.05) return "LEFT " + Math.abs(deg).toFixed(0) + "°";
    if (x > 0.05) return "RIGHT " + deg.toFixed(0) + "°";
    return "FRONT · 0°";
  }

  // ---- drawing ----------------------------------------------------------
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Orbit ring: great circle through the camera's azimuth/elevation planes.
  function drawOrbitRing(ctx, pose, mode, highlight) {
    // mode 0 = equatorial, 1 = vertical plane at camera azimuth, 2 = elevation circle
    var N = 50, started = false, i, a, px, py, pz, pt, front;
    ctx.beginPath();
    for (i = 0; i <= N; i++) {
      if (mode === 0) {
        a = (i / N) * Math.PI * 2;
        px = pose.R * Math.cos(a); py = SUBJ_Y; pz = pose.R * Math.sin(a);
        front = pz > 0;
      } else if (mode === 1) {
        a = -Math.PI / 2 + (i / N) * Math.PI;
        px = pose.R * Math.cos(a) * Math.sin(pose.az);
        py = SUBJ_Y + pose.R * Math.sin(a);
        pz = pose.R * Math.cos(a) * Math.cos(pose.az);
        front = pz > 0;
      } else {
        a = (i / N) * Math.PI * 2;
        px = pose.R * Math.cos(pose.el) * Math.cos(a);
        py = SUBJ_Y + pose.R * Math.sin(pose.el);
        pz = pose.R * Math.cos(pose.el) * Math.sin(a);
        front = pz > 0;
      }
      pt = project(px, py, pz);
      // draw front half solid-ish, back half only when highlighted (dragging)
      if (pt && ((front && !highlight) || (front && highlight) || (!front && highlight))) {
        if (!front && !highlight) { started = false; ctx.moveTo(0, 0); continue; }
        if (started) ctx.lineTo(pt.sx, pt.sy);
        else { ctx.moveTo(pt.sx, pt.sy); started = true; }
      } else { started = false; if (pt) ctx.moveTo(0, 0); }
    }
    var colors = [
      highlight ? "rgba(77,208,225,0.7)" : "rgba(77,208,225,0.4)",
      highlight ? "rgba(255,138,76,0.7)" : "rgba(255,138,76,0.45)",
      highlight ? "rgba(77,208,225,0.7)" : "rgba(77,208,225,0.4)",
    ];
    ctx.strokeStyle = colors[mode];
    ctx.lineWidth = 2.5;
    ctx.setLineDash(mode === 0 ? [5, 7] : [5, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Glowing marker dot with optional label (F / B / L / R).
  function drawMarker(ctx, x, y, z, color, label) {
    var pt = project(x, y, z);
    if (!pt) return;
    var r = clamp((2.5 / pt.depth) * 9, 3.5, 16);
    var g = ctx.createRadialGradient(
      pt.sx - 0.35 * r, pt.sy - 0.35 * r, 0.2 * r, pt.sx, pt.sy, r
    );
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.4, color);
    g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(pt.sx, pt.sy, r, 0, 2 * Math.PI);
    ctx.fill();
    if (label) {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "700 " + Math.max(14, r + 6) + "px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, pt.sx, pt.sy - r - 9);
    }
  }

  // Subject axes at the center: up / down / left / right + facing arrow.
  function drawSubjectAxes(ctx) {
    var c = project(0, SUBJ_Y, 0);
    if (!c) return;
    var t = 0.55;
    var up = project(0, 1.25, 0), down = project(0, SUBJ_Y - t, 0);
    var right = project(t, SUBJ_Y, 0), left = project(-t, SUBJ_Y, 0);
    var back = project(0, SUBJ_Y, t), face = project(0, SUBJ_Y, -t);
    function line(pt, color, w) {
      if (!pt) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = w || 1.5;
      ctx.beginPath();
      ctx.moveTo(c.sx, c.sy);
      ctx.lineTo(pt.sx, pt.sy);
      ctx.stroke();
    }
    line(up, "rgba(120,220,255,0.95)", 1.6);
    line(down, "rgba(120,220,255,0.45)", 1.2);
    line(right, "rgba(190,190,210,0.8)", 1.2);
    line(left, "rgba(190,190,210,0.8)", 1.2);
    line(back, "rgba(190,190,210,0.8)", 1.2);
    line(face, "#ffd166", 2.4);
    if (face) {
      // arrowhead at the facing tip
      var ang = Math.atan2(face.sy - c.sy, face.sx - c.sx);
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(face.sx, face.sy);
      ctx.lineTo(face.sx - 7 * Math.cos(ang - Math.PI / 7), face.sy - 7 * Math.sin(ang - Math.PI / 7));
      ctx.moveTo(face.sx, face.sy);
      ctx.lineTo(face.sx + 7 * Math.cos(ang + Math.PI / 7), face.sy - 7 * Math.sin(ang + Math.PI / 7));
      ctx.stroke();
    }
  }

  // The camera: orange body + lens, rotated to face the subject (+ roll).
  function drawCamera(ctx, pose, s, hovering) {
    var tip = project(pose.x, pose.y, pose.z);
    if (!tip) return;
    var c = project(0, SUBJ_Y, 0);
    if (c) {
      ctx.strokeStyle = "rgba(255,209,102,0.7)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.moveTo(tip.sx, tip.sy);
      ctx.lineTo(c.sx, c.sy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffd166";
      ctx.beginPath();
      ctx.arc(c.sx, c.sy, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
    var inner = project(0.9 * pose.x, 0.9 * pose.y + 0.001, 0.9 * pose.z);
    if (!inner) return;
    var faceAng = Math.atan2(tip.sy - inner.sy, tip.sx - inner.sx);
    var distScale = clamp(1.4 - 0.45 * s.z, 0.5, 2);
    var sizeScale = clamp(2.5 / tip.depth, 0.5, 2);
    var rr = Math.max(8, 14 * distScale * sizeScale);
    // glow halo
    var haloR = 2.5 * rr;
    var halo = ctx.createRadialGradient(tip.sx, tip.sy, 0, tip.sx, tip.sy, haloR);
    halo.addColorStop(0, "rgba(255,138,76,0.55)");
    halo.addColorStop(0.4, "rgba(255,138,76,0.18)");
    halo.addColorStop(1, "rgba(255,138,76,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(tip.sx - haloR, tip.sy - haloR, 2 * haloR, 2 * haloR);
    if (hovering) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tip.sx, tip.sy, 1.7 * rr, 0, 2 * Math.PI);
      ctx.stroke();
    }
    // body, rotated toward subject + roll tilt
    ctx.save();
    ctx.translate(tip.sx, tip.sy);
    ctx.rotate(faceAng + (s.r * Math.PI) / 4);
    var bw = 1.8 * rr, bh = 1.2 * rr;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    roundRectPath(ctx, -bw / 2 + 1, -bh / 2 + 2, bw, bh, 3);
    ctx.fill();
    var body = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
    body.addColorStop(0, "#ffa66a");
    body.addColorStop(1, "#e06a30");
    ctx.fillStyle = body;
    roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, 3);
    ctx.fill();
    // lens
    ctx.fillStyle = "#0b0e13";
    ctx.beginPath();
    ctx.arc(0.4 * rr, 0, 0.42 * rr, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.arc(0.35 * rr, -0.1 * rr, 0.12 * rr, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  function drawLabels(ctx, s, pose) {
    var t = pose.R;
    // word labels glued to world directions (pushed outward on screen)
    function word(x, y, z, text, color, size) {
      var pt = project(x, y, z);
      if (!pt) return;
      var dx = pt.sx - CTR_X, dy = pt.sy - CTR_Y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      ctx.fillStyle = color || "rgba(255,255,255,0.78)";
      ctx.font = "700 " + (size || 13) + "px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, pt.sx + (dx / len) * 30, pt.sy + (dy / len) * 30);
    }
    word(0, SUBJ_Y, t, "FRONT");
    word(0, SUBJ_Y, -t, "BACK");
    word(t, SUBJ_Y, 0, "LEFT");
    word(-t, SUBJ_Y, 0, "RIGHT");
    word(0, 1.25, 0, "ABOVE", "rgba(120,220,255,0.85)");
    word(0, SUBJ_Y - 1.05, 0, "BELOW", "rgba(120,220,255,0.6)", 11);

    // STRAIGHT-ON badge at the default view (front + eye-level)
    if (Math.abs(s.x) <= 0.05 && Math.abs(s.y) <= 0.2) {
      var c = project(0, SUBJ_Y, 0);
      if (c) {
        ctx.font = "700 13px monospace";
        var label = "STRAIGHT-ON";
        var w = ctx.measureText(label).width + 20;
        ctx.fillStyle = "rgba(255,138,76,0.9)";
        roundRectPath(ctx, c.sx - w / 2, c.sy + 26, w, 22, 6);
        ctx.fill();
        ctx.fillStyle = "#0b0e13";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, c.sx, c.sy + 37);
      }
    }

    // bottom status line in plain words
    var azW = Math.abs(s.x) > 0.85 ? "BEHIND"
      : Math.abs(s.x) < 0.05 ? "FRONT" : s.x > 0 ? "RIGHT SIDE" : "LEFT SIDE";
    var elW = s.y > 0.7 ? "ABOVE" : s.y > 0.2 ? "HIGH" : s.y >= 0 ? "EYE-LEVEL"
      : s.y >= -0.7 ? "LOW" : "BELOW";
    var parts = [azW, elW, distWord(s.z)];
    if (Math.abs(s.r) >= 0.15) parts.push("DUTCH");
    ctx.font = "700 14px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,209,102,0.92)";
    ctx.fillText(parts.join(" · "), A / 2, R - 12);
  }

  function distWord(z) {
    if (z > 0.7) return "EXTREME CLOSE-UP";
    if (z > 0.2) return "CLOSE-UP";
    if (z >= -0.2) return "MEDIUM";
    if (z >= -0.7) return "FULL BODY";
    return "WIDE";
  }

  function draw(pad) {
    var ctx = pad.ctx;
    var dpr = window.devicePixelRatio || 1;
    if (pad.canvas.width !== Math.round(A * dpr)) {
      pad.canvas.width = Math.round(A * dpr);
      pad.canvas.height = Math.round(R * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var s = readState(pad);
    var pose = camPose(s);

    // background
    ctx.clearRect(0, 0, A, R);
    var bg = ctx.createLinearGradient(0, 0, 0, R);
    bg.addColorStop(0, "rgba(0,0,0,0.62)");
    bg.addColorStop(1, "rgba(0,0,0,0.62)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, A, R);
    var glow = ctx.createRadialGradient(280, 225, 10, 280, 225, 230);
    glow.addColorStop(0, "rgba(77,208,225,0.05)");
    glow.addColorStop(1, "rgba(77,208,225,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, A, R);

    var active = pad.orbiting || pad.distDrag;

    // back-half rings, camera (if behind), subject, axes, markers, front rings, camera (if front)
    drawOrbitRing(ctx, pose, 0, active);
    drawOrbitRing(ctx, pose, 1, active);
    drawOrbitRing(ctx, pose, 2, active);
    if (pose.z < 0) drawCamera(ctx, pose, s, active);

    // subject: ground shadow + body
    (function () {
      var c = project(0, SUBJ_Y, 0);
      if (!c) return;
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.ellipse(c.sx, c.sy + 40, 20, 6, 0, 0, 2 * Math.PI);
      ctx.fill();
      var g2 = ctx.createRadialGradient(c.sx - 5, c.sy - 6, 3, c.sx, c.sy, 16);
      g2.addColorStop(0, "#9af0fa");
      g2.addColorStop(1, "#2f8a93");
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(c.sx, c.sy, 16, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
    })();
    drawSubjectAxes(ctx);

    // F / B / L / R markers + elevation ring markers
    (function () {
      var t = pose.R;
      var cn = Math.cos(pose.el), sn = Math.sin(pose.el);
      drawMarker(ctx, 0, SUBJ_Y, t, "rgba(77,208,225,1)", "F");
      drawMarker(ctx, 0, SUBJ_Y, -t, "rgba(77,208,225,1)", "B");
      drawMarker(ctx, t, SUBJ_Y, 0, "rgba(77,208,225,1)", "L");
      drawMarker(ctx, -t, SUBJ_Y, 0, "rgba(77,208,225,1)", "R");
      var o = t * cn, yy = SUBJ_Y + t * sn;
      if (o > 0.05) {
        var soft = "rgba(150,230,255,1)";
        drawMarker(ctx, 0, yy, o, soft, "");
        drawMarker(ctx, 0, yy, -o, soft, "");
        drawMarker(ctx, o, yy, 0, soft, "");
        drawMarker(ctx, -o, yy, 0, soft, "");
      }
    })();

    if (pose.z >= 0) drawCamera(ctx, pose, s, active);

    drawLabels(ctx, s, pose);

    // header: hint left, azimuth + roll right
    ctx.textBaseline = "top";
    ctx.font = "15px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(pad.hint, 10, 8, 340);
    ctx.textAlign = "right";
    ctx.fillStyle = "#ff8a4c";
    ctx.font = "15px monospace";
    ctx.fillText(azLabel(s.x), A - 10, 8);
    ctx.fillStyle = "#c792ea";
    ctx.fillText("ROLL: " + (ROLL_DEG * s.r).toFixed(0) + "°", A - 10, 28);

    // crosshair tooltip while orbiting
    if (pad.orbiting) {
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.moveTo(pad.mouse.x, 0);
      ctx.lineTo(pad.mouse.x, R);
      ctx.moveTo(0, pad.mouse.y);
      ctx.lineTo(A, pad.mouse.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.beginPath();
      ctx.arc(pad.mouse.x, pad.mouse.y, 3.5, 0, 2 * Math.PI);
      ctx.fill();
      var tag = "X:" + s.x.toFixed(2) + "  Y:" + s.y.toFixed(2);
      ctx.font = "600 10.5px monospace";
      var tw = ctx.measureText(tag).width;
      var bx = pad.mouse.x + 14, by = pad.mouse.y - 22;
      if (bx + tw + 12 > A) bx = pad.mouse.x - tw - 20;
      if (by < 0) by = pad.mouse.y + 14;
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      roundRectPath(ctx, bx, by, tw + 12, 18, 4);
      ctx.fill();
      ctx.fillStyle = "#ff8a4c";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(tag, bx + 6, by + 9);
    }
  }

  // on-demand redraw (coalesced rAF, as in the ComfyUI node)
  function requestDraw(pad) {
    pad.dirty = true;
    if (pad.raf) return;
    pad.raf = requestAnimationFrame(function () {
      pad.raf = null;
      if (!pad.canvas.isConnected) return;
      if (pad.dirty) {
        pad.dirty = false;
        try { draw(pad); } catch (e) { /* one bad frame */ }
      }
    });
  }

  // ---- attachment -------------------------------------------------------
  var pads = [];

  function attach(root) {
    if (root.dataset.animaCamPad === "1") return true;
    var inputs = {
      x: findSlider(root, "x"),
      y: findSlider(root, "y"),
      z: findSlider(root, "z"),
      r: findSlider(root, "r"),
    };
    if (!inputs.x || !inputs.y || !inputs.z || !inputs.r) return false;

    var wrap = document.createElement("div");
    wrap.className = "anima-cam-pad-wrap";
    wrap.style.cssText = "max-width:560px;margin:6px 0 10px 0;user-select:none;";
    var canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;max-width:560px;height:auto;" +
      "aspect-ratio:560/500;border:1px solid #2a2f3a;border-radius:10px;" +
      "cursor:crosshair;touch-action:none;user-select:none;";
    canvas.title = "drag: orbit · right-drag / wheel: distance · shift+wheel: roll";
    canvas.tabIndex = 0; // allow arrow-key nudging
    wrap.appendChild(canvas);

    var anchor = root.querySelector("#" + SLIDER_IDS.x);
    var row = anchor ? anchor.closest(".gradio-row") : null;
    if (row && row.parentElement) row.parentElement.insertBefore(wrap, row);
    else root.insertBefore(wrap, root.firstChild);

    var pad = {
      root: root, canvas: canvas, ctx: canvas.getContext("2d"),
      inputs: inputs, raf: null, dirty: false, frame: 0,
      orbiting: false, distDrag: null,
      mouse: { x: CTR_X, y: CTR_Y },
      grab: null, hint: HINT_IDLE,
    };
    pad.resolve = function () {
      pad.frame++;
      if (pad.frame % 60 === 0 || !pad.inputs.x || !pad.inputs.x.isConnected) {
        pad.inputs = {
          x: findSlider(root, "x"),
          y: findSlider(root, "y"),
          z: findSlider(root, "z"),
          r: findSlider(root, "r"),
        };
      }
    };

    function toCanvas(ev) {
      var rect = canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left) * (A / rect.width),
        y: (ev.clientY - rect.top) * (R / rect.height),
      };
    }
    function cur() { return readState(pad); }

    // --- pointer ---
    canvas.addEventListener("contextmenu", function (ev) {
      ev.preventDefault(); ev.stopPropagation();
    });
    canvas.addEventListener("pointerdown", function (ev) {
      ev.stopPropagation();
      pad.resolve();
      try { canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      var p = toCanvas(ev);
      pad.mouse = p;
      if (ev.button === 2 || ev.button === 1) {
        // right/middle-drag: distance (Comfy semantics: left = closer)
        var s0 = cur();
        pad.distDrag = { startX: ev.clientX, startZ: s0.z };
        pad.hint = "Adjusting distance · drag left for closer, right for farther";
        canvas.style.cursor = "ew-resize";
      } else {
        // left-drag: relative orbit (Comfy "grab and rotate" mode, X wraps)
        var s1 = cur();
        pad.grab = { ox: s1.x, oy: s1.y, mx: p.x, my: p.y };
        pad.orbiting = true;
        pad.hint = "Relative drag · grab and rotate the world";
        canvas.style.cursor = "none";
      }
      requestDraw(pad);
      ev.preventDefault();
    });
    canvas.addEventListener("pointermove", function (ev) {
      var p = toCanvas(ev);
      pad.mouse = p;
      if (pad.distDrag) {
        var rect = canvas.getBoundingClientRect();
        var cssDx = ev.clientX - pad.distDrag.startX;
        var dxCanvas = cssDx * (A / rect.width);
        setSlider(pad.inputs.z, pad.distDrag.startZ - dxCanvas * DRAG_STEP);
        requestDraw(pad);
        ev.preventDefault();
        return;
      }
      if (!pad.orbiting || !pad.grab) return;
      var nx = pad.grab.ox + (p.x - pad.grab.mx) / 280;
      var ny = pad.grab.oy - (p.y - pad.grab.my) / 250;
      setSlider(pad.inputs.x, wrapX(nx));
      setSlider(pad.inputs.y, clamp(ny, -1, 1));
      requestDraw(pad);
      ev.preventDefault();
    });
    function endPointer(ev) {
      if (pad.orbiting || pad.distDrag) {
        pad.orbiting = false;
        pad.distDrag = null;
        pad.grab = null;
        pad.hint = HINT_IDLE;
        canvas.style.cursor = "crosshair";
        requestDraw(pad);
      }
      try { canvas.releasePointerCapture && canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("dblclick", function (ev) {
      setSlider(pad.inputs.x, 0);
      setSlider(pad.inputs.y, 0);
      setSlider(pad.inputs.z, 0);
      setSlider(pad.inputs.r, 0);
      requestDraw(pad);
      ev.preventDefault();
    });

    // --- wheel: plain = distance (Forge addition), shift = roll (Comfy) ---
    canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var delta = ev.deltaY;
      if (ev.deltaMode === 1) delta *= 16;
      else if (ev.deltaMode === 2) delta *= 100;
      var s = cur();
      if (ev.shiftKey) setSlider(pad.inputs.r, s.r - 0.002 * delta);
      else setSlider(pad.inputs.z, s.z - 0.0008 * delta);
      requestDraw(pad);
    }, { passive: false });

    // --- keyboard: arrows X/Y, [ ] distance, , . roll (shift = coarse) ---
    canvas.addEventListener("keydown", function (ev) {
      var t = ev.target;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      var step = ev.shiftKey ? 0.1 : 0.02;
      var s = cur(), handled = true;
      switch (ev.key) {
        case "ArrowLeft": setSlider(pad.inputs.x, wrapX(s.x - step)); break;
        case "ArrowRight": setSlider(pad.inputs.x, wrapX(s.x + step)); break;
        case "ArrowUp": setSlider(pad.inputs.y, s.y + step); break;
        case "ArrowDown": setSlider(pad.inputs.y, s.y - step); break;
        case "[": setSlider(pad.inputs.z, s.z - step); break;
        case "]": setSlider(pad.inputs.z, s.z + step); break;
        case ",": setSlider(pad.inputs.r, s.r - step); break;
        case ".": setSlider(pad.inputs.r, s.r + step); break;
        default: handled = false;
      }
      if (handled) { ev.preventDefault(); requestDraw(pad); }
    });

    // redraw when sliders change elsewhere (presets, manual edits)
    ["x", "y", "z", "r"].forEach(function (k) {
      var inp = inputs[k];
      if (inp) inp.addEventListener("input", function () { requestDraw(pad); });
    });

    root.dataset.animaCamPad = "1";
    pads.push(pad);
    requestDraw(pad);
    return true;
  }

  function scan() {
    var roots = gradioRoot().querySelectorAll("#" + ACC_ID);
    for (var i = 0; i < roots.length; i++) {
      try { attach(roots[i]); } catch (e) { /* retry next scan */ }
    }
    // safety redraw so external changes always surface
    for (var j = 0; j < pads.length; j++) requestDraw(pads[j]);
  }

  var scanTimer = null;
  function observe() {
    scan();
    if (scanTimer) return;
    scanTimer = setInterval(scan, 1500);
    if (document.body) {
      new MutationObserver(function () { scan(); })
        .observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { observe(); });
  } else {
    observe();
  }
})();
