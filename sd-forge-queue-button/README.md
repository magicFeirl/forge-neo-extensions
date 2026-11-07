# Queue Button for Forge Neo

Adds a **Queue** button next to **Generate** on the txt2img and img2img tabs, like ComfyUI's queue, plus a **Results** panel that keeps every image the queue makes.

## Using it

- Click **Queue** to snapshot every current setting (prompt, sampler, size, hires, script/extension settings, init image, ...) and add it to the queue.
- Queued jobs run one after another, each with exactly the settings it was queued with, so you can keep editing the UI while earlier jobs are running.
- If nothing is running, a queued job starts immediately.
- The list under the buttons shows the running job and the waiting ones. Remove single jobs with ✕, or use **Clear**.
- **Interrupt** and **Skip** work as usual and only affect the running job. The queue then moves on to the next one.
- Shortcut: **Ctrl/Cmd + Shift + Enter** queues from the current tab.

### Results

Forge's normal gallery only shows the last job. The extension reads each finished job's images and collects them:

- A **Results** row appears under the queue list, with a count and a strip of the latest thumbnails.
- Click **Results** (or any thumbnail, or the "Queue finished" notice) to open a full-page viewer: all images grouped by job (newest first) with prompt, size and time.
- Click an image to enlarge it. ← / → step through all images, **Esc** goes back / closes. (Esc in the viewer never interrupts a running generation.)
- **Clear results** forgets the collected list. Image files on disk are not touched.
- Interrupted jobs keep the images they finished. Jobs that produced nothing add nothing.

## Install

Copy this folder into your Forge Neo `extensions` directory:

```
<forge-neo>/extensions/sd-forge-queue-button/
├── javascript/queue_button.js
├── style.css
└── README.md
```

Restart Forge Neo (or use **Settings → Reload UI**) and hard-refresh the browser (Ctrl+F5).
It is pure JavaScript and CSS, with no Python and no changes to Forge's own files.

## Good to know

- The queue and the collected results live in the browser page. Reloading the page empties them (your images are still in the output folder).
- The collected images are the ones Forge shows in its gallery, so a grid image appears too if Forge returns one.
- Up to 400 images are kept; the oldest jobs drop off first.
- The model, VAE and text-encoder selectors at the top of the UI are global settings, not part of a generation's inputs. They are not snapshotted: a job uses whatever is selected when it starts.
- A seed of `-1` stays random per job, so queueing the same settings five times gives five different images. A fixed seed repeats.
- Use one browser tab per generation tab to drive the queue.

## Layout

The Queue button is pinned to the right edge of the Generate row, and Interrupt/Skip are confined to the Generate button, using plain CSS (`--qb-w` in `style.css` sets the Queue button width). Nothing is measured in JavaScript, so it cannot go stale or overflow a narrow column.
