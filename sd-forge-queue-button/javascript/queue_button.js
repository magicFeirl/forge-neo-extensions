/*
 * Queue Button for Stable Diffusion WebUI Forge Neo
 *
 * Adds a "Queue" button next to "Generate" on the txt2img and img2img tabs.
 *   - Queue takes a snapshot of every current setting and adds it to a queue.
 *     Jobs run one after another, each with the settings it was queued with.
 *   - Every finished job's images are collected in a Results panel (open it with the
 *     "Results" button under the Queue list), so nothing is lost when the next job
 *     replaces the normal gallery.
 *
 * How it works (no changes to Forge's own files):
 *   - Forge's Generate button runs a JS pre-hook (`submit` / `submit_img2img`) that
 *     receives every input value right before the request is sent.
 *   - Queue: we click Generate with a "capture" flag set. The wrapped hook stores the
 *     values and throws, which makes Gradio drop that call, so nothing is generated.
 *   - Run: when the tab is idle, we click Generate with a "replay" flag set. The real
 *     hook runs (progress bar, Interrupt/Skip buttons, task id), then we swap its
 *     values for the stored snapshot.
 *   - Results: when a job ends, we wait for the gallery to show the new images and
 *     record their URLs, before the next job starts.
 */
(function () {
    "use strict";

    const TABS = {
        txt2img: { submitFn: "submit" },
        img2img: { submitFn: "submit_img2img" },
    };

    const MAX_QUEUE = 100;
    const MAX_RESULT_IMAGES = 400; // oldest results are dropped beyond this
    const STRIP_THUMBS = 7; // thumbnails shown under the queue list
    const TICK_MS = 120; // how often the scheduler looks for work
    const SETTLE_MS = 150; // pause between a finished job and the next start
    const CAPTURE_TIMEOUT_MS = 2000;
    const REPLAY_TIMEOUT_MS = 4000;
    const COLLECT_STABLE_MS = 350; // gallery must stay unchanged this long before we read it
    const COLLECT_TIMEOUT_MS = 8000; // give up waiting for images (error, interrupt with no output)
    const MAX_ATTEMPTS = 3;

    const state = {};

    for (const tab of Object.keys(TABS)) {
        state[tab] = {
            jobs: [], // waiting jobs: { id, args, info, attempts }
            serial: 0,
            capturing: false,
            captureTimer: null,
            replay: null, // job whose Generate click is in flight
            replayDeadline: 0,
            current: null, // job from this queue that is running now
            collect: null, // { job, baseSig, baseLog, lastSnapshot, changedAt, startedAt } while we wait for its images
            wasBusy: false,
            lastFinished: 0,
            results: [], // groups, oldest first: { job, label, size, images: [url], time }
            unseen: 0,
            runJobs: 0, // jobs finished since the queue was last idle
            runImages: 0,
            button: null,
            badge: null,
            panel: null,
            count: null,
            clear: null,
            list: null,
            resultsBar: null,
            resultsOpen: null,
            resultsCount: null,
            strip: null,
        };
    }

    // A capture aborts Gradio's call by throwing; keep that out of the console.
    window.addEventListener("unhandledrejection", (event) => {
        if (event.reason && event.reason.__queueCapture) event.preventDefault();
    });

    function $(id) {
        return gradioApp().getElementById(id);
    }

    function clone(value) {
        try {
            return structuredClone(value);
        } catch (e) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function toast(message, onClick) {
        const el = document.createElement("div");
        el.className = "qb-toast";
        el.textContent = message;
        if (onClick) {
            el.classList.add("qb-toast-click");
            el.addEventListener("click", () => {
                onClick();
                el.remove();
            });
        }
        document.body.appendChild(el);
        setTimeout(() => el.classList.add("qb-toast-out"), onClick ? 6000 : 2400);
        setTimeout(() => el.remove(), onClick ? 6500 : 2900);
    }

    /** True while this tab is generating (same signal Forge's own shortcuts use). */
    function isBusy(tab) {
        return ["interrupt", "skip", "interrupting"].some((suffix) => {
            const el = $(`${tab}_${suffix}`);
            return !!el && el.style.display === "block";
        });
    }

    /** Short description for the lists. Display only, never sent anywhere. */
    function describe(tab) {
        const info = { prompt: "", size: "" };
        try {
            const textarea = gradioApp().querySelector(`#${tab}_prompt textarea`);
            info.prompt = textarea ? textarea.value.trim() : "";
            const w = gradioApp().querySelector(`#${tab}_width input[type=number]`);
            const h = gradioApp().querySelector(`#${tab}_height input[type=number]`);
            if (w && h && w.value && h.value) info.size = `${w.value}×${h.value}`;
        } catch (e) {
            // the label is cosmetic; never let it block queueing
        }
        return info;
    }

    /* ----------------------------------------------------------------- *
     *  Reading the gallery
     * ----------------------------------------------------------------- */

    /** URLs of the images currently shown in the tab's output gallery. */
    function galleryImages(tab) {
        const gallery = $(`${tab}_gallery`);
        if (!gallery) return [];

        const usable = (img) => {
            const src = img.src || "";
            return src && !src.startsWith("data:") && !src.startsWith("blob:") && !img.closest(".livePreview");
        };

        let imgs = [...gallery.querySelectorAll("button.thumbnail-item img")].filter(usable);
        if (imgs.length === 0) imgs = [...gallery.querySelectorAll("img")].filter(usable); // single image, no thumbnails

        const seen = new Set();
        const urls = [];
        for (const img of imgs) {
            if (!seen.has(img.src)) {
                seen.add(img.src);
                urls.push(img.src);
            }
        }
        return urls;
    }

    /**
     * Forge rewrites the "html_log" panel (time taken, or an error) every time a job
     * ends, even when no image was produced. Gallery selection never touches it, so it
     * is a reliable "this job's result has arrived" signal.
     */
    function logSignature(tab) {
        const log = $(`html_log_${tab}`);
        return log ? log.innerHTML : "";
    }

    /* ----------------------------------------------------------------- *
     *  Hooking Forge's submit functions
     * ----------------------------------------------------------------- */

    function wrapSubmit(tab) {
        const name = TABS[tab].submitFn;
        const original = window[name];
        if (typeof original !== "function") return false;
        if (original.__queueWrapped) return true;

        const wrapped = function () {
            const st = state[tab];

            if (st.capturing) {
                st.capturing = false;
                clearTimeout(st.captureTimer);
                captureJob(tab, arguments);

                // Throwing makes Gradio drop this call: nothing reaches the server.
                const abort = new Error("[Queue] settings captured");
                abort.__queueCapture = true;
                throw abort;
            }

            const res = original.apply(this, arguments);

            if (st.replay) {
                const job = st.replay;
                st.replay = null;
                st.current = job;
                st.wasBusy = true;
                job.baseSig = galleryImages(tab).join("|"); // what the gallery and log show before this job's result lands
                job.baseLog = logSignature(tab);

                // Use the stored values. Keep the fresh task id from the real hook
                // (res[0]) so the progress bar tracks this run.
                const count = Math.min(job.args.length, res.length);
                const args = clone(job.args).slice(0, count);
                args[0] = res[0];
                render(tab);
                return args;
            }

            return res;
        };

        wrapped.__queueWrapped = true;
        window[name] = wrapped;
        return true;
    }

    function captureJob(tab, rawArgs) {
        const st = state[tab];
        const args = clone(
            typeof window.create_submit_args === "function"
                ? window.create_submit_args(rawArgs)
                : Array.from(rawArgs),
        );

        st.jobs.push({ id: ++st.serial, args, info: describe(tab), attempts: 0, baseSig: "", baseLog: "" });
        render(tab);
        setTimeout(tick, 30);
    }

    /* ----------------------------------------------------------------- *
     *  Queue actions
     * ----------------------------------------------------------------- */

    function enqueue(tab) {
        const st = state[tab];

        if (st.replay) {
            // a queued job is just being started; try again in a moment
            setTimeout(() => enqueue(tab), 60);
            return;
        }
        if (st.capturing) return;

        if (st.jobs.length >= MAX_QUEUE) {
            toast(`The queue is full (${MAX_QUEUE} jobs).`);
            return;
        }

        const generate = $(`${tab}_generate`);
        if (!generate) {
            toast("Couldn't find the Generate button.");
            return;
        }

        st.capturing = true;
        st.captureTimer = setTimeout(() => {
            if (!st.capturing) return;
            st.capturing = false;
            toast("Couldn't read the current settings. Please try again.");
        }, CAPTURE_TIMEOUT_MS);

        generate.click();
    }

    function removeJob(tab, id) {
        const st = state[tab];
        st.jobs = st.jobs.filter((job) => job.id !== id);
        render(tab);
    }

    function clearJobs(tab) {
        state[tab].jobs = [];
        render(tab);
    }

    function startNext(tab) {
        const st = state[tab];
        const generate = $(`${tab}_generate`);
        if (!generate) return;

        st.replay = st.jobs.shift();
        st.replayDeadline = Date.now() + REPLAY_TIMEOUT_MS;
        render(tab);
        generate.click();
    }

    function failReplay(tab) {
        const st = state[tab];
        const job = st.replay;
        st.replay = null;
        if (!job) return;

        job.attempts += 1;
        if (job.attempts < MAX_ATTEMPTS) {
            st.jobs.unshift(job);
        } else {
            toast(`Queued job #${job.id} could not be started and was removed.`);
        }
        render(tab);
    }

    /* ----------------------------------------------------------------- *
     *  Collecting results
     * ----------------------------------------------------------------- */

    function beginCollect(tab) {
        const st = state[tab];
        const job = st.current;
        st.current = null;
        const now = Date.now();
        st.collect = { job, baseSig: job.baseSig, baseLog: job.baseLog, lastSnapshot: "", changedAt: now, startedAt: now };
        render(tab);
    }

    function stepCollect(tab, busy) {
        const st = state[tab];
        const c = st.collect;
        const now = Date.now();

        const urls = galleryImages(tab);
        const sig = urls.join("|");
        const log = logSignature(tab);

        const snapshot = `${sig}\u0000${log}`;
        if (snapshot !== c.lastSnapshot) {
            c.lastSnapshot = snapshot;
            c.changedAt = now;
        }

        // The result has landed once the gallery or the log panel differs from before the job.
        const landed = sig !== c.baseSig || log !== c.baseLog;
        const fresh = sig !== c.baseSig ? urls : []; // an unchanged or emptied gallery means no new images

        if (landed && now - c.changedAt >= COLLECT_STABLE_MS) return finishCollect(tab, fresh);
        if (busy) return finishCollect(tab, fresh); // another run started; stop waiting
        if (now - c.startedAt > COLLECT_TIMEOUT_MS) return finishCollect(tab, fresh);
    }

    function finishCollect(tab, urls) {
        const st = state[tab];
        const job = st.collect.job;
        st.collect = null;
        st.lastFinished = Date.now();
        st.runJobs += 1;

        if (urls.length) {
            addResults(tab, job, urls);
            st.runImages += urls.length;
        }
        render(tab);
    }

    function addResults(tab, job, urls) {
        const st = state[tab];
        st.results.push({ job, images: urls, time: new Date() });
        st.unseen += urls.length;

        let total = st.results.reduce((n, g) => n + g.images.length, 0);
        while (total > MAX_RESULT_IMAGES && st.results.length > 1) {
            total -= st.results.shift().images.length;
        }
        if (overlay.root && !overlay.root.hidden && overlay.tab === tab) renderOverlay();
    }

    function resultCount(tab) {
        return state[tab].results.reduce((n, g) => n + g.images.length, 0);
    }

    function clearResults(tab) {
        const st = state[tab];
        st.results = [];
        st.unseen = 0;
        render(tab);
        if (overlay.root && !overlay.root.hidden && overlay.tab === tab) closeOverlay();
    }

    function maybeAnnounceFinish(tab) {
        const st = state[tab];
        if (st.runJobs === 0) return;
        if (st.jobs.length || st.replay || st.collect || st.capturing || st.current) return;

        const jobs = st.runJobs;
        const images = st.runImages;
        st.runJobs = 0;
        st.runImages = 0;

        const viewing = overlay.root && !overlay.root.hidden && overlay.tab === tab; // it already updates live
        if (jobs >= 2 && images > 0 && !viewing) {
            toast(`Queue finished: ${images} image${images === 1 ? "" : "s"}. Click to view all.`, () => openOverlay(tab));
        }
    }

    function tick() {
        for (const tab of Object.keys(TABS)) {
            const st = state[tab];
            if (!st.button) continue;

            const busy = isBusy(tab);
            if (st.wasBusy && !busy && st.current) beginCollect(tab);
            if (st.wasBusy && !busy) st.lastFinished = Date.now();
            st.wasBusy = busy;

            // hold the queue until the finished job's images have been read
            if (st.collect) {
                stepCollect(tab, busy);
                continue;
            }

            if (st.replay) {
                if (Date.now() > st.replayDeadline) failReplay(tab);
                continue;
            }

            if (st.capturing || busy) continue;

            if (st.jobs.length === 0) {
                maybeAnnounceFinish(tab);
                continue;
            }

            if (Date.now() - st.lastFinished < SETTLE_MS) continue;

            startNext(tab);
        }
    }

    /* ----------------------------------------------------------------- *
     *  UI: queue button and list
     * ----------------------------------------------------------------- */

    function makeItem(job, label, removable, tab) {
        const li = document.createElement("li");
        li.className = "qb-item";

        const tag = document.createElement("span");
        tag.className = "qb-tag";
        tag.textContent = label;

        const text = document.createElement("span");
        text.className = "qb-text";
        text.textContent = job.info.prompt || "(empty prompt)";
        text.title = job.info.prompt;

        li.append(tag, text);

        if (job.info.size) {
            const meta = document.createElement("span");
            meta.className = "qb-meta";
            meta.textContent = job.info.size;
            li.append(meta);
        }

        if (removable) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "qb-remove";
            remove.title = "Remove from the queue";
            remove.textContent = "✕";
            remove.addEventListener("click", () => removeJob(tab, job.id));
            li.append(remove);
        }

        return li;
    }

    function render(tab) {
        const st = state[tab];
        if (!st.button) return;

        const waiting = st.jobs.length;
        const running = st.current || st.replay || (st.collect && st.collect.job);
        const total = resultCount(tab);

        st.badge.textContent = String(waiting);
        st.badge.hidden = waiting === 0;

        st.panel.hidden = waiting === 0 && !running && total === 0;
        st.count.textContent = waiting === 1 ? "1 waiting" : `${waiting} waiting`;
        st.clear.hidden = waiting === 0;

        const items = [];
        if (running) {
            const item = makeItem(running, st.collect ? "Saving" : "Running", false, tab);
            item.classList.add("qb-running");
            items.push(item);
        }
        st.jobs.forEach((job, index) => items.push(makeItem(job, `#${index + 1}`, true, tab)));
        st.list.replaceChildren(...items);

        // results bar
        st.resultsBar.hidden = total === 0;
        st.resultsCount.textContent = String(total);
        st.resultsOpen.classList.toggle("qb-new", st.unseen > 0);

        const thumbs = [];
        const flat = flatResults(tab);
        flat.slice(0, STRIP_THUMBS).forEach((entry) => {
            const img = document.createElement("img");
            img.src = entry.url;
            img.loading = "lazy";
            img.alt = "";
            img.title = entry.group.job.info.prompt;
            img.addEventListener("click", () => openOverlay(tab, entry.url));
            thumbs.push(img);
        });
        st.strip.replaceChildren(...thumbs);
    }

    /** Every result image, newest job first, in generation order inside a job. */
    function flatResults(tab) {
        const out = [];
        const groups = state[tab].results;
        for (let g = groups.length - 1; g >= 0; g--) {
            groups[g].images.forEach((url, index) => out.push({ url, group: groups[g], index }));
        }
        return out;
    }

    function buildUi(tab) {
        const st = state[tab];

        const button = document.createElement("button");
        button.type = "button";
        button.id = `${tab}_queue`; // must not end in "_generate": Forge's shortcuts match on that
        button.className = "qb-button";
        button.title = "Add the current settings to the queue (Ctrl+Shift+Enter). Jobs run one after another.";

        const label = document.createElement("span");
        label.textContent = "Queue";
        const badge = document.createElement("span");
        badge.className = "qb-badge";
        badge.hidden = true;
        button.append(label, badge);
        button.addEventListener("click", () => enqueue(tab));

        const panel = document.createElement("div");
        panel.id = `${tab}_queue_panel`;
        panel.className = "qb-panel";
        panel.hidden = true;

        const head = document.createElement("div");
        head.className = "qb-head";
        const title = document.createElement("span");
        title.textContent = "Queue";
        const count = document.createElement("span");
        count.className = "qb-count";
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "qb-clear";
        clear.textContent = "Clear";
        clear.title = "Remove all waiting jobs (the running job is not stopped)";
        clear.addEventListener("click", () => clearJobs(tab));
        head.append(title, count, clear);

        const list = document.createElement("ol");
        list.className = "qb-list";

        const resultsBar = document.createElement("div");
        resultsBar.className = "qb-results";
        resultsBar.hidden = true;

        const resultsHead = document.createElement("div");
        resultsHead.className = "qb-results-head";
        const resultsOpen = document.createElement("button");
        resultsOpen.type = "button";
        resultsOpen.className = "qb-results-open";
        resultsOpen.title = "Show every image made by the queue in one place";
        const resultsLabel = document.createElement("span");
        resultsLabel.textContent = "Results";
        const resultsCount = document.createElement("span");
        resultsCount.className = "qb-results-count";
        resultsOpen.append(resultsLabel, resultsCount);
        resultsOpen.addEventListener("click", () => openOverlay(tab));
        const resultsClear = document.createElement("button");
        resultsClear.type = "button";
        resultsClear.className = "qb-clear";
        resultsClear.textContent = "Clear";
        resultsClear.title = "Forget the collected results (files on disk are not touched)";
        resultsClear.addEventListener("click", () => clearResults(tab));
        resultsHead.append(resultsOpen, resultsClear);

        const strip = document.createElement("div");
        strip.className = "qb-strip";
        resultsBar.append(resultsHead, strip);

        panel.append(head, list, resultsBar);

        Object.assign(st, { button, badge, panel, count, clear, list, resultsBar, resultsOpen, resultsCount, strip });
    }

    function attach(tab) {
        const st = state[tab];
        const box = $(`${tab}_generate_box`);
        const generate = $(`${tab}_generate`);
        if (!box || !generate) return false;

        if (!st.button) buildUi(tab);

        if (!st.button.isConnected) generate.insertAdjacentElement("afterend", st.button);
        if (!st.panel.isConnected) box.insertAdjacentElement("afterend", st.panel);

        // Layout lives entirely in style.css (see ".has-queue"): the Queue button is
        // pinned to the right edge of the row and Generate fills the rest.
        box.classList.add("has-queue");

        render(tab);
        return true;
    }

    /* ----------------------------------------------------------------- *
     *  UI: results viewer
     * ----------------------------------------------------------------- */

    const overlay = { root: null, tab: null, view: null, viewIndex: -1, flat: [] };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function buildOverlay() {
        const root = el("div", "qb-overlay");
        root.hidden = true;

        const head = el("div", "qb-ov-head");
        overlay.title = el("strong", "qb-ov-title");
        overlay.sub = el("span", "qb-ov-sub");
        const clear = el("button", "qb-ov-btn", "Clear results");
        clear.type = "button";
        clear.addEventListener("click", () => clearResults(overlay.tab));
        const close = el("button", "qb-ov-btn qb-ov-close", "✕");
        close.type = "button";
        close.title = "Close (Esc)";
        close.addEventListener("click", closeOverlay);
        head.append(overlay.title, overlay.sub, clear, close);

        overlay.body = el("div", "qb-ov-body");

        const view = el("div", "qb-view");
        view.hidden = true;
        overlay.viewImg = el("img", "qb-view-img");
        overlay.viewCap = el("div", "qb-view-cap");
        const prev = el("button", "qb-nav qb-prev", "‹");
        prev.type = "button";
        prev.addEventListener("click", () => stepView(1));
        const next = el("button", "qb-nav qb-next", "›");
        next.type = "button";
        next.addEventListener("click", () => stepView(-1));
        const viewClose = el("button", "qb-ov-btn qb-view-close", "✕");
        viewClose.type = "button";
        viewClose.title = "Back to the grid (Esc)";
        viewClose.addEventListener("click", closeView);
        overlay.viewOpen = el("a", "qb-view-open", "Open image in a new tab");
        overlay.viewOpen.target = "_blank";
        overlay.viewOpen.rel = "noopener";
        view.append(overlay.viewImg, prev, next, viewClose, overlay.viewCap, overlay.viewOpen);
        view.addEventListener("click", (event) => {
            if (event.target === view) closeView();
        });

        root.append(head, overlay.body, view);
        overlay.view = view;
        overlay.root = root;
        document.body.appendChild(root);
    }

    function openOverlay(tab, focusUrl) {
        if (!overlay.root) buildOverlay();
        overlay.tab = tab;
        state[tab].unseen = 0;
        document.querySelectorAll(".qb-toast-click").forEach((node) => node.remove());
        render(tab);
        renderOverlay();
        overlay.root.hidden = false;
        document.body.classList.add("qb-noscroll");

        if (focusUrl) {
            const index = overlay.flat.findIndex((entry) => entry.url === focusUrl);
            if (index >= 0) showView(index);
        }
    }

    function closeOverlay() {
        if (!overlay.root) return;
        closeView();
        overlay.root.hidden = true;
        document.body.classList.remove("qb-noscroll");
    }

    function renderOverlay() {
        const tab = overlay.tab;
        const st = state[tab];
        overlay.flat = flatResults(tab);

        overlay.title.textContent = `Queue results: ${tab}`;
        overlay.sub.textContent = `${overlay.flat.length} image${overlay.flat.length === 1 ? "" : "s"} from ${st.results.length} job${st.results.length === 1 ? "" : "s"}`;

        const sections = [];
        let position = 0;
        for (let g = st.results.length - 1; g >= 0; g--) {
            const group = st.results[g];
            const section = el("section", "qb-group");

            const info = group.job.info;
            const header = el("div", "qb-group-head");
            header.append(
                el("span", "qb-group-title", `Job ${group.job.id}`),
                el("span", "qb-group-meta", [info.size, `${group.images.length} image${group.images.length === 1 ? "" : "s"}`, group.time.toLocaleTimeString()].filter(Boolean).join(" · ")),
            );
            const prompt = el("div", "qb-group-prompt", info.prompt || "(empty prompt)");
            prompt.title = info.prompt;

            const grid = el("div", "qb-grid");
            group.images.forEach((url) => {
                const index = position++;
                const cell = el("button", "qb-cell");
                cell.type = "button";
                const img = el("img");
                img.src = url;
                img.loading = "lazy";
                img.decoding = "async";
                img.alt = "";
                cell.append(img);
                cell.addEventListener("click", () => showView(index));
                grid.append(cell);
            });

            section.append(header, prompt, grid);
            sections.push(section);
        }

        if (sections.length === 0) sections.push(el("div", "qb-empty", "No results yet."));
        overlay.body.replaceChildren(...sections);

        if (!overlay.view.hidden) {
            if (overlay.viewIndex >= overlay.flat.length) closeView();
            else showView(overlay.viewIndex);
        }
    }

    function showView(index) {
        const entry = overlay.flat[index];
        if (!entry) return;
        overlay.viewIndex = index;
        overlay.viewImg.src = entry.url;
        overlay.viewOpen.href = entry.url;

        const info = entry.group.job.info;
        const n = entry.group.images.length;
        overlay.viewCap.textContent = [`Job ${entry.group.job.id}`, n > 1 ? `image ${entry.index + 1}/${n}` : "", info.size, info.prompt].filter(Boolean).join(" · ");
        overlay.view.hidden = false;
    }

    function stepView(delta) {
        if (overlay.view.hidden || overlay.flat.length === 0) return;
        const next = overlay.viewIndex + delta;
        if (next >= 0 && next < overlay.flat.length) showView(next);
    }

    function closeView() {
        if (!overlay.view) return;
        overlay.view.hidden = true;
        overlay.viewIndex = -1;
        overlay.viewImg.removeAttribute("src");
    }

    // While the viewer is open it owns Esc and the arrow keys (Forge's own Esc
    // handler would otherwise interrupt the running generation).
    window.addEventListener(
        "keydown",
        (event) => {
            if (!overlay.root || overlay.root.hidden) return;

            const keys = { Escape: () => (overlay.view.hidden ? closeOverlay() : closeView()), ArrowLeft: () => stepView(-1), ArrowRight: () => stepView(1) };
            const action = keys[event.key];
            if (!action) return;

            event.preventDefault();
            event.stopPropagation();
            action();
        },
        true,
    );

    /* ----------------------------------------------------------------- *
     *  Keyboard shortcut: Ctrl/Cmd + Shift + Enter
     * ----------------------------------------------------------------- */

    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Enter" || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return;

            const content = typeof get_uiCurrentTabContent === "function" ? get_uiCurrentTabContent() : null;
            const tab = content && content.id === "tab_txt2img" ? "txt2img" : content && content.id === "tab_img2img" ? "img2img" : null;
            if (!tab || !state[tab].button) return;

            // Forge's own Ctrl+Enter handler would also fire here; this replaces it.
            event.preventDefault();
            event.stopPropagation();

            // give a debounced prompt edit a moment to reach Gradio first
            setTimeout(() => enqueue(tab), 60);
        },
        true,
    );

    /* ----------------------------------------------------------------- *
     *  Startup
     * ----------------------------------------------------------------- */

    function setup(attempt) {
        let ready = true;
        for (const tab of Object.keys(TABS)) {
            if (!(wrapSubmit(tab) && attach(tab))) ready = false;
        }
        if (!ready && attempt < 40) setTimeout(() => setup(attempt + 1), 500);
    }

    onUiLoaded(function () {
        setup(0);
        setInterval(tick, TICK_MS);
    });

    // If Gradio ever re-renders the area around the buttons, put ours back.
    onAfterUiUpdate(function () {
        for (const tab of Object.keys(TABS)) {
            const st = state[tab];
            if (st.button && (!st.button.isConnected || !st.panel.isConnected)) attach(tab);
        }
    });
})();
