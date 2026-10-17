/* Khmer OCR Studio – front-end (no build step) */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const STATUS = {
  new: "New", detected: "Check boxes", boxes_ok: "Boxes OK", recognized: "Check text", done: "Done",
};
const LOW_CONF = 0.8, MID_CONF = 0.92;

const S = {
  projects: [], project: null, images: [], filter: "all",
  cur: null, lines: [], mode: "boxes", tool: "select",
  selId: null, hoverId: null,
  img: null, view: { scale: 1, ox: 0, oy: 0 },
  undo: [], redo: [],
  dirty: false, saving: false, saveTimer: null,
  jobs: {}, settings: null, lowOnly: false,
};

// ======================================================================= API
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
const P = () => `/api/projects/${S.project.id}`;

// ======================================================================= toast / modal
function toast(msg, kind = "", ms = 3200) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function openModal(html, onMount) {
  $("#modal").innerHTML = html;
  $("#modalBg").hidden = false;
  onMount?.($("#modal"));
  setTimeout(() => $("#modal [autofocus]")?.focus(), 20);
}
function closeModal() {
  $("#modalBg").hidden = true; $("#modal").innerHTML = "";
  const f = S.onModalClose; S.onModalClose = null; if (f) f();
}
$("#modalBg").addEventListener("mousedown", (e) => { if (e.target.id === "modalBg") closeModal(); });

function confirmBox(title, text, okLabel = "Delete", danger = true) {
  return new Promise((res) => {
    openModal(`
      <header><h3>${esc(title)}</h3><p>${text}</p></header>
      <footer><button class="btn" data-x>Cancel</button>
      <button class="btn ${danger ? "danger" : "primary"}" data-ok autofocus>${esc(okLabel)}</button></footer>`,
      (m) => {
        $("[data-x]", m).onclick = () => { closeModal(); res(false); };
        $("[data-ok]", m).onclick = () => { closeModal(); res(true); };
      });
  });
}
function promptBox(title, value = "", okLabel = "Save") {
  return new Promise((res) => {
    openModal(`
      <header><h3>${esc(title)}</h3></header>
      <div class="body"><div class="field"><input type="text" id="pv" value="${esc(value)}" autofocus></div></div>
      <footer><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button></footer>`,
      (m) => {
        const ok = () => { const v = $("#pv").value.trim(); closeModal(); res(v || null); };
        $("[data-x]", m).onclick = () => { closeModal(); res(null); };
        $("[data-ok]", m).onclick = ok;
        $("#pv").addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
        setTimeout(() => $("#pv").select(), 30);
      });
  });
}

// ======================================================================= projects
async function loadProjects() {
  S.projects = await api("GET", "/api/projects");
  if (!S.projects.length) {
    const p = await api("POST", "/api/projects", { name: "My first project" });
    S.projects = [p];
  }
  const last = localStorageGet("kiri.project");
  const pick = S.projects.find((p) => p.id === last) || S.projects[0];
  await openProject(pick.id);
}

async function openProject(pid) {
  await flushSave();
  const p = await api("GET", `/api/projects/${pid}`);
  S.project = p;
  S.images = p.images;
  S.cur = null; S.lines = []; S.img = null;
  localStorageSet("kiri.project", pid);
  $("#projectName").textContent = p.name;
  renderCounts(); renderQueue(); renderStage(); renderLines();
  for (const j of p.jobs || []) trackJob(j);
  const first = S.images.find((i) => i.status !== "done") || S.images[0];
  if (first) openImage(first.id);
}

async function refreshProject({ keepLines = true } = {}) {
  if (!S.project) return;
  const p = await api("GET", P());
  S.project = p;
  S.images = p.images;
  if (S.cur) {
    const fresh = S.images.find((i) => i.id === S.cur.id);
    if (fresh) {
      S.cur = fresh;
      if (!keepLines && !S.dirty && JSON.stringify(fresh.lines || []) !== JSON.stringify(S.lines)) {
        const hadText = S.lines.some((l) => l.text != null);
        S.lines = structuredClone(fresh.lines || []);
        S.undo = []; S.redo = [];
        // recognition just finished for the open image -> jump to text review
        if (!hadText && S.lines.some((l) => l.text != null)) S.mode = "text";
        renderStage(); renderLines(); draw();
      }
    }
  }
  renderCounts(); renderQueue(); renderMeta();
}

function renderProjectMenu() {
  const m = $("#projectMenu");
  m.innerHTML = S.projects.map((p) => `
      <div class="item ${p.id === S.project?.id ? "on" : ""}" data-pid="${p.id}">
        <span>${esc(p.name)}</span><span class="muted small">${p.n_images} img</span>
      </div>`).join("") + `
      <hr>
      <div class="item" data-act="new">＋ New project</div>
      <div class="item" data-act="rename">Rename current…</div>
      <div class="item" data-act="delete" style="color:var(--danger)">Delete current…</div>`;
}
$("#projectBtn").onclick = async (e) => {
  e.stopPropagation();
  const m = $("#projectMenu");
  if (!m.hidden) { m.hidden = true; return; }
  S.projects = await api("GET", "/api/projects");
  renderProjectMenu();
  m.hidden = false;
};
document.addEventListener("click", (e) => { if (!e.target.closest(".project-picker")) $("#projectMenu").hidden = true; });
$("#projectMenu").onclick = async (e) => {
  const it = e.target.closest(".item"); if (!it) return;
  $("#projectMenu").hidden = true;
  if (it.dataset.pid) return openProject(it.dataset.pid);
  const act = it.dataset.act;
  if (act === "new") {
    const name = await promptBox("New project", "", "Create");
    if (!name) return;
    const p = await api("POST", "/api/projects", { name });
    S.projects.unshift(p);
    openProject(p.id);
  } else if (act === "rename") {
    const name = await promptBox("Rename project", S.project.name);
    if (!name) return;
    await api("PATCH", P(), { name });
    S.project.name = name; $("#projectName").textContent = name;
  } else if (act === "delete") {
    if (!(await confirmBox("Delete project?", `“${esc(S.project.name)}” and all ${S.images.length} images and annotations will be removed permanently.`))) return;
    await api("DELETE", P());
    S.project = null;
    await loadProjects();
  }
};

// ======================================================================= counts / queue
function renderCounts() {
  const c = S.project?.counts || {};
  for (const k of Object.keys(STATUS)) {
    const b = $(`[data-count="${k}"]`); if (b) b.textContent = c[k] || 0;
  }
  $$("#pipeline .stage").forEach((b) => b.classList.toggle("on", S.filter === b.dataset.filter));
  const any = S.images.length > 0;
  $("#detectAllBtn").disabled = !any;
  $("#recAllBtn").disabled = !any;
}

function filtered() {
  const f = S.filter;
  if (f === "all") return S.images;
  if (f === "todo") return S.images.filter((i) => i.status === "detected" || i.status === "recognized");
  return S.images.filter((i) => i.status === f);
}

function busyIds() {
  const ids = new Set();
  for (const j of Object.values(S.jobs)) if (j.current) ids.add(j.current);
  return ids;
}

function renderQueue() {
  renderFilmstrip();
  const list = $("#queueList");
  const imgs = filtered();
  const busy = busyIds();
  $$("#filters button").forEach((b) => b.classList.toggle("on", b.dataset.filter === S.filter));
  if (!S.images.length) {
    list.innerHTML = `<div class="queue-empty">No images yet.<br>Upload or drag &amp; drop images anywhere.</div>`;
  } else if (!imgs.length) {
    list.innerHTML = `<div class="queue-empty">Nothing in “${esc(STATUS[S.filter] || S.filter)}”.</div>`;
  } else {
    list.innerHTML = imgs.map((i) => `
      <div class="qitem ${i.id === S.cur?.id ? "on" : ""} ${busy.has(i.id) ? "busy" : ""}" data-iid="${i.id}" title="${esc(i.filename)}">
        <img loading="lazy" src="${P()}/images/${i.id}/thumb" alt="">
        <div style="min-width:0">
          <div class="name">${esc(i.filename)}</div>
          <div class="meta"><span class="dot s-${i.status}"></span>${STATUS[i.status]}
            ${i.lines ? `· ${i.lines.length} lines` : ""}</div>
        </div>
        <button class="del" data-del="${i.id}" title="Remove image"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join("");
    list.querySelector(".qitem.on")?.scrollIntoView({ block: "nearest" });
  }
  const done = S.images.filter((i) => i.status === "done").length;
  $("#queueFoot").textContent = S.images.length ? `${done} / ${S.images.length} images done` : "";
  $("#imgCount").textContent = S.images.length ? `(${S.images.length})` : "";
}
$("#queueList").onclick = async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    const img = S.images.find((i) => i.id === del.dataset.del);
    if (!(await confirmBox("Remove image?", `“${esc(img.filename)}” and its annotations will be removed.`, "Remove"))) return;
    await api("DELETE", `${P()}/images/${img.id}`);
    if (S.cur?.id === img.id) { S.cur = null; S.lines = []; S.img = null; S.dirty = false; }
    await refreshProject();
    if (!S.cur && S.images.length) openImage(S.images[0].id); else { renderStage(); renderLines(); }
    return;
  }
  const it = e.target.closest(".qitem");
  if (it) openImage(it.dataset.iid);
};
$("#filters").onclick = (e) => { const b = e.target.closest("button"); if (b) { S.filter = b.dataset.filter; renderQueue(); renderCounts(); } };
$("#pipeline").onclick = (e) => {
  const b = e.target.closest(".stage"); if (!b) return;
  S.filter = S.filter === b.dataset.filter ? "all" : b.dataset.filter;
  renderQueue(); renderCounts();
};

// ======================================================================= upload
async function doUpload(files, { detect = false } = {}) {
  if (!files.length || !S.project) return;
  const BATCH = 8;
  const job = { id: "upload", kind: "upload", total: files.length, done: 0, status: "running" };
  S.jobs.upload = job; renderJobs();
  let added = 0, failed = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const fd = new FormData();
    files.slice(i, i + BATCH).forEach((f) => fd.append("files", f, f.name));
    try {
      const r = await fetch(`${P()}/images`, { method: "POST", body: fd });
      const j = await r.json();
      added += j.added?.length || 0; failed += j.failed?.length || 0;
    } catch { failed += Math.min(BATCH, files.length - i); }
    job.done = Math.min(files.length, i + BATCH); renderJobs();
  }
  delete S.jobs.upload; renderJobs();
  await refreshProject();
  toast(`Uploaded ${added} image(s)${failed ? `, ${failed} failed` : ""}`, failed ? "error" : "ok");
  if (!S.cur && S.images.length) openImage(S.images[0].id);
  if (added && detect) { startJob("detect", null, false, "new"); return; }
  if (added && S.settings && S.images.some((i) => i.status === "new")) {
    const b = $("#banner");
    b.innerHTML = `<span>${added} new image(s) ready.</span><button class="btn small primary" id="bannerDetect">Detect all now</button><button class="btn tiny ghost" id="bannerX">✕</button>`;
    b.hidden = false;
    $("#bannerDetect").onclick = () => { b.hidden = true; startJob("detect", null, false, "new"); };
    $("#bannerX").onclick = () => (b.hidden = true);
  }
}
$("#fileInput").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
document.addEventListener("change", (e) => { if (e.target.classList.contains("fileInput2")) { uploadFiles(e.target.files); e.target.value = ""; } });

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("#dropOverlay").hidden = false; } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true;
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

// ======================================================================= jobs
async function startJob(kind, image_ids = null, overwrite = false, scope = null) {
  await flushSave();
  try {
    const j = await api("POST", `${P()}/jobs`, { kind, image_ids, overwrite, scope });
    if (!j.total) { toast(kind === "detect" ? "Nothing to detect" : "Nothing to recognize — approve some boxes first"); return; }
    trackJob(j);
  } catch (e) { toast(e.message, "error"); }
}

function trackJob(j) {
  S.jobs[j.id] = j; renderJobs();
  let lastDone = j.done;
  const tick = async () => {
    let cur;
    try { cur = await api("GET", `/api/jobs/${j.id}`); } catch { delete S.jobs[j.id]; renderJobs(); return; }
    S.jobs[j.id] = cur; renderJobs();
    const finished = ["done", "error", "cancelled"].includes(cur.status);
    if (cur.done !== lastDone || finished) {
      lastDone = cur.done;
      const affectsCur = S.cur && !S.dirty;
      await refreshProject({ keepLines: !affectsCur });
      if (affectsCur) renderStage();
    }
    if (finished) {
      delete S.jobs[j.id]; renderJobs(); renderQueue();
      const what = cur.kind === "detect" ? "Detection" : "Recognition";
      if (cur.status === "done" && cur.errors.length) toast(`${what}: ${cur.errors.length} of ${cur.total} image(s) failed — ${esc(cur.errors[0].error)}`, "error", 9000);
      else if (cur.status === "done") toast(`${what} finished on ${cur.done} image(s)`, "ok");
      else if (cur.status === "error") toast(`${what} failed: ${esc(cur.message)}`, "error", 6000);
      else toast(`${what} cancelled`);
      return;
    }
    setTimeout(tick, 700);
  };
  setTimeout(tick, 400);
}

function renderJobs() {
  const jobs = Object.values(S.jobs);
  const bar = $("#jobbar");
  if (!jobs.length) { bar.hidden = true; renderQueue(); return; }
  const j = jobs[0];
  const label = { detect: "Detecting text lines", recognize: "Recognizing text", upload: "Uploading" }[j.kind] || j.kind;
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  bar.hidden = false;
  $("#jobFill").style.width = pct + "%";
  $("#jobText").textContent = `${label} · ${j.done} / ${j.total}${j.message ? " · " + j.message : ""}${jobs.length > 1 ? `  (+${jobs.length - 1} queued)` : ""}`;
  $("#jobCancel").hidden = j.kind === "upload";
  $("#jobCancel").onclick = () => api("POST", `/api/jobs/${j.id}/cancel`);
  $$(".qitem").forEach((el) => el.classList.toggle("busy", busyIds().has(el.dataset.iid)));
}

// ---- batch dialogs: show exactly what will be processed and let the user choose
function choiceModal({ title, sub, options, okLabel, extra = "", onOk }) {
  const firstOk = options.findIndex((o) => o.n > 0);
  openModal(`<header><h3>${title}</h3><p>${sub}</p></header>
    <div class="body"><div class="choices">
      ${options.map((o, i) => `
        <label class="choice ${o.n ? "" : "disabled"}">
          <input type="radio" name="scope" value="${o.value}" ${i === firstOk ? "checked" : ""} ${o.n ? "" : "disabled"}>
          <div style="flex:1"><div class="t">${o.title}<span class="n">${o.n} image${o.n === 1 ? "" : "s"}</span></div>
          <div class="d">${o.desc}</div></div>
        </label>`).join("")}
    </div>${extra}</div>
    <footer><button class="btn" data-x>Cancel</button>
      <button class="btn primary" data-ok ${firstOk < 0 ? "disabled" : ""}>${okLabel}</button></footer>`,
    (m) => {
      $("[data-x]", m).onclick = closeModal;
      $("[data-ok]", m).onclick = () => {
        const v = $("input[name=scope]:checked", m)?.value;
        if (!v) return;
        closeModal(); onOk(v, m);
      };
    });
}

$("#detectAllBtn").onclick = () => {
  const imgs = S.images;
  const nNew = imgs.filter((i) => i.lines == null).length;
  const nUnapproved = imgs.filter((i) => !i.det_verified).length;
  choiceModal({
    title: "Detect text lines",
    sub: "Runs the DB line detector from mrrtmob/kiri-ocr. You will check the boxes afterwards.",
    okLabel: "Start detection",
    options: [
      { value: "new", n: nNew, title: "New images only", desc: "Images that have no boxes yet. Nothing you edited is touched." },
      { value: "unapproved", n: nUnapproved, title: "All images not approved yet", desc: "Re-detects new images and images whose boxes you haven't approved (replaces their boxes)." },
      { value: "all", n: imgs.length, title: "Every image (start over)", desc: "Replaces ALL boxes and text, including approved ones." },
    ],
    onOk: async (scope) => {
      if (scope === "all" && !(await confirmBox("Replace everything?", "All boxes and recognized/approved text on every image will be replaced.", "Replace all"))) return;
      startJob("detect", null, false, scope);
    },
  });
};

$("#recAllBtn").onclick = () => {
  const imgs = S.images;
  const pending = (i) => (i.lines || []).some((l) => l.text == null);
  const nApproved = imgs.filter((i) => i.det_verified && !i.text_verified && pending(i)).length;
  const nBoxes = imgs.filter((i) => (i.lines || []).length && !i.text_verified && pending(i)).length;
  const nUnchecked = imgs.filter((i) => (i.lines || []).length && !i.det_verified).length;
  const noBoxes = imgs.filter((i) => i.lines == null).length;
  choiceModal({
    title: "Recognize text",
    sub: "Crops every line box and reads it with the kiri-ocr recognizer. Only lines without text are processed.",
    okLabel: "Start recognition",
    options: [
      { value: "approved", n: nApproved, title: "Images with approved boxes", desc: "Recommended: the boxes were checked, so the crops are right." },
      { value: "with_boxes", n: nBoxes, title: "All images that have boxes", desc: `Also includes ${nUnchecked} image(s) whose boxes are not checked yet. You can still fix boxes later and re-recognize single lines.` },
    ],
    extra: (noBoxes ? `<div class="callout warn">${noBoxes} image(s) have no boxes yet — run <b>Detect all</b> first for them.</div>` : "")
      + (!nBoxes && !noBoxes ? `<div class="callout ok">Every line already has text. Use <b>Recognize this</b> on an image to re-read it.</div>` : ""),
    onOk: (scope) => startJob("recognize", null, false, scope),
  });
};
$("#detectOneBtn").onclick = async () => {
  if (!S.cur) return;
  if (S.lines.length && !(await confirmBox("Re-run detection?", "This replaces all boxes (and text) on this image.", "Replace boxes", false))) return;
  S.dirty = false;
  startJob("detect", [S.cur.id], true);
};
$("#recOneBtn").onclick = async () => {
  if (!S.cur || !S.lines.length) return;
  await flushSave();
  const hasText = S.lines.some((l) => l.text != null);
  if (hasText && !(await confirmBox("Re-recognize all lines?", "Text you typed on this image will be replaced by the model output.", "Recognize", false))) return;
  if (!S.cur.det_verified) await saveNow({ det_verified: true });
  S.dirty = false;
  startJob("recognize", [S.cur.id], true);
};

// ======================================================================= open image / navigation
async function openImage(iid) {
  if (S.cur?.id === iid) return;
  await flushSave();
  const img = S.images.find((i) => i.id === iid);
  if (!img) return;
  S.cur = img;
  S.lines = structuredClone(img.lines || []);
  S.selId = null; S.hoverId = null; S.undo = []; S.redo = [];
  S.mode = S.lines.some((l) => l.text != null) ? "text" : "boxes";
  $("#banner").hidden = true;
  const el = new Image();
  el.onload = () => { if (S.cur?.id === iid) { S.img = el; fit(); draw(); } };
  el.src = `${P()}/images/${iid}/file`;
  S.img = null;
  renderQueue(); renderStage(); renderLines(); renderFilmstrip(); draw();
}

function navigate(delta) {
  const list = filtered().length ? filtered() : S.images;
  if (!list.length) return;
  const cur = list.findIndex((i) => i.id === S.cur?.id);
  const idx = cur < 0 ? 0 : clamp(cur + delta, 0, list.length - 1);
  if (idx === cur) { // already at the first / last image
    bump(delta);
    toast(delta > 0 ? "This is the last image" : "This is the first image", "", 1400);
    return;
  }
  openImage(list[idx].id);
}

function bump(dir) {
  canvas.animate([{ transform: "none" }, { transform: `translateX(${-dir * 24}px)` }, { transform: "none" }], { duration: 260, easing: "ease-out" });
}
function nextNeeding(statuses) {
  const n = S.images.length;
  const start = S.images.findIndex((i) => i.id === S.cur?.id);
  for (let k = 1; k <= n; k++) {
    const img = S.images[(start + k) % n];
    if (statuses.includes(img.status) && img.id !== S.cur?.id) return img;
  }
  return null;
}

$("#prevBtn").onclick = () => navigate(-1);
$("#nextBtn").onclick = () => navigate(1);

async function approve() {
  if (!S.cur) return;
  if (S.mode === "boxes") {
    if (S.cur.lines == null && !S.lines.length) return toast("Run detection or draw boxes first");
    await saveNow({ det_verified: true });
    toast(`✓ Boxes approved (${S.lines.length} lines)`, "ok", 1600);
    if (S.settings?.auto_recognize && S.lines.some((l) => l.text == null)) startJob("recognize", [S.cur.id]);
    const nxt = nextNeeding(["detected"]) || nextNeeding(["new"]);
    if (nxt) openImage(nxt.id);
    else { toast("All boxes reviewed 🎉 — run <b>Recognize all</b> next", "ok", 4000); renderStage(); }
  } else {
    if (S.lines.some((l) => l.text == null && !l.ignore)) return toast("Some lines have no text yet — recognize them or mark them ignored", "error");
    await saveNow({ text_verified: true, det_verified: true });
    toast("✓ Text approved", "ok", 1600);
    const nxt = nextNeeding(["recognized"]);
    if (nxt) openImage(nxt.id);
    else { toast("All text reviewed 🎉 — you can export the dataset", "ok", 4000); renderStage(); }
  }
}
$("#approveBtn").onclick = approve;

// ======================================================================= saving
function markDirty() {
  S.dirty = true;
  setSaveState("Unsaved…");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => saveNow(), 700);
}
function setSaveState(t, cls = "") { const el = $("#saveState"); el.textContent = t; el.className = "save-state " + cls; }

async function saveNow(extra = {}) {
  clearTimeout(S.saveTimer);
  if (!S.cur) return;
  const iid = S.cur.id;
  const body = { ...extra };
  if (S.dirty || Object.keys(extra).length) body.lines = S.lines;
  if (!Object.keys(body).length) return;
  S.saving = true; setSaveState("Saving…", "saving");
  S.dirty = false;
  try {
    const r = await api("PUT", `${P()}/images/${iid}`, body);
    const i = S.images.findIndex((x) => x.id === iid);
    if (i >= 0) S.images[i] = r;
    if (S.cur?.id === iid) S.cur = r;
    setSaveState("All changes saved");
    // keep counts fresh without a full reload
    const counts = {};
    S.images.forEach((im) => (counts[im.status] = (counts[im.status] || 0) + 1));
    S.project.counts = counts;
    renderCounts(); renderQueue(); renderMeta();
  } catch (e) {
    S.dirty = true; setSaveState("Save failed", "saving");
    toast("Save failed: " + esc(e.message), "error");
  } finally { S.saving = false; }
}
async function flushSave() { if (S.dirty) await saveNow(); }
window.addEventListener("beforeunload", (e) => { if (S.dirty) { saveNow(); e.preventDefault(); } });

// ======================================================================= undo
function pushUndo() {
  S.undo.push(JSON.stringify(S.lines));
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
}
function undo() { if (!S.undo.length) return; S.redo.push(JSON.stringify(S.lines)); S.lines = JSON.parse(S.undo.pop()); afterEdit(); }
function redo() { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.lines)); S.lines = JSON.parse(S.redo.pop()); afterEdit(); }
function afterEdit() { markDirty(); renderLines(); draw(); }
$("#undoBtn").onclick = undo;
$("#redoBtn").onclick = redo;

// ======================================================================= stage render
function renderStage() {
  const has = !!S.cur;
  $("#emptyState").hidden = has;
  $("#zoomDock").hidden = !has;
  $("#navHint").hidden = !has;
  $("#layout").classList.toggle("text-mode", S.mode === "text");
  if (window.layoutReady) applyLayout();
  $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  $$("#toolSeg button").forEach((b) => b.classList.toggle("on", b.dataset.tool === S.tool));
  $("#canvasWrap").classList.toggle("tool-draw", S.tool === "draw");
  $("#approveLbl").textContent = S.mode === "boxes" ? "Approve boxes & next" : "Approve text & next";
  ["#approveBtn", "#prevBtn", "#nextBtn", "#detectOneBtn", "#recOneBtn", "#undoBtn", "#redoBtn", "#delBtn", "#zoomIn", "#zoomOut", "#zoomFit"]
    .forEach((s) => ($(s).disabled = !has));
  if (has && S.cur.lines == null && !S.lines.length && !Object.keys(S.jobs).length) {
    const b = $("#banner");
    b.innerHTML = `<span>No boxes yet on this image.</span>
      <button class="btn small primary" id="bDet">Detect this image</button>
      <button class="btn small" id="bDraw">Draw manually (B)</button>`;
    b.hidden = false;
    $("#bDet").onclick = () => { b.hidden = true; startJob("detect", [S.cur.id], true); };
    $("#bDraw").onclick = () => { b.hidden = true; setTool("draw"); };
  } else if (has && $("#banner").innerHTML.includes("No boxes yet")) {
    $("#banner").hidden = true;
  }
  renderMeta();
  setTimeout(resizeCanvas, 0);
}
function renderMeta() {
  const m = $("#imgMeta");
  if (!S.cur) { m.innerHTML = ""; return; }
  const list = filtered().length ? filtered() : S.images;
  const idx = list.findIndex((i) => i.id === S.cur.id);
  m.innerHTML = `<span class="fname" title="${esc(S.cur.filename)}">${esc(S.cur.filename)}</span>
    <span class="pill st-${S.cur.status}"><span class="dot s-${S.cur.status}"></span>${STATUS[S.cur.status]}</span>
    <span class="muted small">${idx + 1} / ${list.length} · ${S.cur.width}×${S.cur.height}</span>`;
}

function setMode(m) {
  if (S.mode === m) return;
  S.mode = m;
  renderStage(); renderLines(); draw();
}
function setTool(t) { S.tool = t; renderStage(); }
$("#modeSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.mode); };
$("#toolSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) setTool(b.dataset.tool); };

// ======================================================================= lines panel
const flagged = (l) => !l.ignore && l.text != null && (l.alt != null || (l.conf ?? 1) < LOW_CONF);
function confClass(c) { return c == null ? "" : c < LOW_CONF ? "low" : c < MID_CONF ? "mid" : ""; }
function cropUrl(l, h = 0) {
  const [x1, y1, x2, y2] = l.box.map((v) => Math.round(v));
  return `${P()}/images/${S.cur.id}/crop?x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}${h ? `&h=${h}` : ""}`;
}

function renderLines() {
  const list = $("#linesList");
  const panel = $("#linesPanel");
  panel.classList.toggle("compact", S.mode === "boxes");
  if (!S.cur) { list.innerHTML = ""; $("#linesTitle").textContent = "Lines"; $("#linesSub").textContent = ""; return; }
  const n = S.lines.length;
  const textMode = S.mode === "text";
  $("#linesTitle").textContent = textMode ? "Text review" : "Detected lines";
  const low = S.lines.filter(flagged).length;
  const missing = S.lines.filter((l) => l.text == null).length;
  $("#linesSub").textContent = textMode
    ? `${n} lines · ${low} to check${missing ? ` · ${missing} not recognized` : ""}`
    : `${n} boxes · click a box to select, drag to adjust`;
  $("#lowOnly").closest("label").style.visibility = textMode ? "visible" : "hidden";

  if (!n) {
    list.innerHTML = `<div class="lines-empty">${S.cur.lines == null ? "Run detection or draw boxes with <kbd>B</kbd>." : "No lines. Draw boxes with <kbd>B</kbd>."}</div>`;
    return;
  }
  let shown = S.lines.map((l, i) => [l, i]);
  if (textMode && S.lowOnly) shown = shown.filter(([l]) => l.text == null || flagged(l));
  if (textMode && missing === n) {
    list.innerHTML = `<div class="lines-empty">Text not recognized yet.<br><br>
      <button class="btn primary" id="recHere">Recognize this image</button></div>`;
    $("#recHere").onclick = () => $("#recOneBtn").click();
    return;
  }
  list.innerHTML = shown.map(([l, i]) => {
    const on = l.id === S.selId ? "on" : "";
    const ign = l.ignore ? "ignored" : "";
    if (!textMode) {
      return `<div class="lcard ${on} ${ign}" data-lid="${l.id}">
        <div class="row"><span class="idx">${i + 1}</span>
          ${l.det_conf != null ? `<span class="conf ${confClass(l.det_conf)}" title="Detection confidence">${Math.round(l.det_conf * 100)}%</span>` : `<span class="conf" title="Drawn manually">manual</span>`}
          <div class="acts"><button class="danger" data-act="del" title="Delete box (Del)"><svg viewBox="0 0 24 24"><path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>
        </div>
        <img class="crop" loading="lazy" src="${cropUrl(l, 80)}" alt="">
      </div>`;
    }
    return `<div class="lcard ${on} ${ign}" data-lid="${l.id}">
      <div class="row"><span class="idx">${i + 1}</span>
        ${l.conf != null ? `<span class="conf ${confClass(l.conf)}" title="Recognition confidence (CTC)">${Math.round(l.conf * 100)}%</span>` : ""}
        ${l.alt != null ? `<span class="conf mid" title="The two decoders disagree on this line — please check">check</span>` : ""}
        ${l.ignore ? `<span class="pill">ignored</span>` : ""}
        <div class="acts">
          <button data-act="rerec" title="Re-recognize this line (after adjusting its box)"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>
          <button data-act="ignore" class="${l.ignore ? "active" : ""}" title="Ignore: exclude this line from the recognition dataset (unreadable / not text)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></button>
          <button class="danger" data-act="del" title="Delete line"><svg viewBox="0 0 24 24"><path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        </div>
      </div>
      <img class="crop" loading="lazy" src="${cropUrl(l, 96)}" alt="">
      <input class="text ${l.text ? "" : "empty"}" lang="km" dir="auto" spellcheck="false" value="${esc(l.text ?? "")}" placeholder="${l.text == null ? "Not recognized yet" : "Type the text shown above…"}">
      ${l.alt != null && l.alt !== l.text ? `<button class="alt" data-act="alt" title="The fast CTC decoder read this line differently. Click to use its reading.">
        <span class="muted">Other reading:</span> <span class="alt-text">${esc(l.alt)}</span> <b>Use</b></button>` : ""}
    </div>`;
  }).join("");
}

const linesList = $("#linesList");
linesList.addEventListener("click", async (e) => {
  const card = e.target.closest(".lcard"); if (!card) return;
  const lid = card.dataset.lid;
  const line = S.lines.find((l) => l.id === lid);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "del") { pushUndo(); S.lines = S.lines.filter((l) => l.id !== lid); if (S.selId === lid) S.selId = null; afterEdit(); return; }
  if (act === "alt") { pushUndo(); [line.text, line.alt] = [line.alt, line.text]; afterEdit(); return; }
  if (act === "ignore") { pushUndo(); line.ignore = !line.ignore; afterEdit(); return; }
  if (act === "rerec") {
    const btn = e.target.closest("button"); btn.disabled = true;
    try {
      const r = await api("POST", `${P()}/images/${S.cur.id}/recognize-line`, { box: line.box });
      pushUndo(); Object.assign(line, r); afterEdit();
      toast("Line re-recognized", "ok", 1200);
    } catch (err) { toast(esc(err.message), "error"); btn.disabled = false; }
    return;
  }
  select(lid, { scrollList: false, focusCanvas: true });
});
linesList.addEventListener("focusin", (e) => {
  if (!e.target.matches("input.text")) return;
  const lid = e.target.closest(".lcard").dataset.lid;
  pushUndo();
  select(lid, { scrollList: false, focusCanvas: true });
});
linesList.addEventListener("input", (e) => {
  if (!e.target.matches("input.text")) return;
  const lid = e.target.closest(".lcard").dataset.lid;
  const line = S.lines.find((l) => l.id === lid);
  line.text = e.target.value;
  e.target.classList.toggle("empty", !e.target.value);
  markDirty();
});
linesList.addEventListener("keydown", (e) => {
  if (!e.target.matches("input.text")) return;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); approve(); return; }
  if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const inputs = $$("input.text", linesList);
    const i = inputs.indexOf(e.target) + (e.key === "ArrowUp" ? -1 : 1);
    if (inputs[i]) { inputs[i].focus(); inputs[i].select(); }
    else if (e.key === "Enter") $("#approveBtn").focus();
  }
  if (e.key === "Escape") e.target.blur();
});
linesList.addEventListener("mouseover", (e) => {
  const c = e.target.closest(".lcard"); const id = c?.dataset.lid || null;
  if (id !== S.hoverId) { S.hoverId = id; draw(); }
});
linesList.addEventListener("mouseleave", () => { S.hoverId = null; draw(); });
$("#lowOnly").onchange = (e) => { S.lowOnly = e.target.checked; renderLines(); };

function select(lid, { scrollList = true, focusCanvas = false, focusInput = false } = {}) {
  S.selId = lid;
  $$(".lcard", linesList).forEach((c) => c.classList.toggle("on", c.dataset.lid === lid));
  const card = lid && $(`.lcard[data-lid="${lid}"]`, linesList);
  if (card && scrollList) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (card && focusInput) { const inp = $("input.text", card); inp?.focus(); }
  if (focusCanvas && lid) ensureVisible(S.lines.find((l) => l.id === lid));
  draw();
}

// ======================================================================= canvas
const ZMIN = 0.05, ZMAX = 16, MARGIN = 40;
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const wrap = $("#canvasWrap");
let dpr = window.devicePixelRatio || 1;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  draw();
}
new ResizeObserver(() => { const keep = S.img && S.view._fitted; resizeCanvas(); if (keep) fit(); }).observe(wrap);

function fit() {
  if (!S.img) return;
  const r = wrap.getBoundingClientRect();
  const pad = MARGIN;
  const s = Math.min((r.width - pad * 2) / S.img.width, (r.height - pad * 2) / S.img.height);
  S.view = { scale: s, ox: (r.width - S.img.width * s) / 2, oy: (r.height - S.img.height * s) / 2, _fitted: true };
  draw();
}
function zoomAt(f, sx, sy) {
  const v = S.view;
  const ns = clamp(v.scale * f, ZMIN, ZMAX);
  const k = ns / v.scale;
  S.view = { scale: ns, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k, _fitted: false };
  draw();
}
function zoomTo(scale) { // zoom around the viewport centre
  if (!S.img) return;
  const r = wrap.getBoundingClientRect();
  zoomAt(clamp(scale, ZMIN, ZMAX) / S.view.scale, r.width / 2, r.height / 2);
}
function fitWidth() {
  if (!S.img) return;
  const r = wrap.getBoundingClientRect();
  const s = (r.width - 2 * MARGIN) / S.img.width;
  S.view = { scale: s, ox: MARGIN, oy: MARGIN, _fitted: false };
  draw();
}
// keep the page reachable: centre it when smaller than the viewport,
// otherwise don't let it scroll further than MARGIN past its edges
function clampView() {
  if (!S.img) return;
  const r = wrap.getBoundingClientRect(), v = S.view;
  const iw = S.img.width * v.scale, ih = S.img.height * v.scale;
  v.ox = iw + 2 * MARGIN <= r.width ? (r.width - iw) / 2 : clamp(v.ox, r.width - iw - MARGIN, MARGIN);
  v.oy = ih + 2 * MARGIN <= r.height ? (r.height - ih) / 2 : clamp(v.oy, r.height - ih - MARGIN, MARGIN);
}
function scrollBy(dx, dy) {
  S.view.ox -= dx; S.view.oy -= dy; S.view._fitted = false; draw();
}

// ---- scrollbars
function updateScrollbars() {
  const r = wrap.getBoundingClientRect();
  for (const [id, axis] of [["#sbarH", "x"], ["#sbarV", "y"]]) {
    const bar = $(id), thumb = bar.firstElementChild;
    if (!S.img) { bar.classList.add("off"); continue; }
    const view = axis === "x" ? r.width : r.height;
    const content = (axis === "x" ? S.img.width : S.img.height) * S.view.scale + 2 * MARGIN;
    if (content <= view + 1) { bar.classList.add("off"); continue; }
    bar.classList.remove("off");
    const track = axis === "x" ? bar.clientWidth : bar.clientHeight;
    const len = Math.max(30, (view / content) * track);
    const off = axis === "x" ? S.view.ox : S.view.oy;
    const pos = ((MARGIN - off) / (content - view)) * (track - len);
    if (axis === "x") { thumb.style.width = len + "px"; thumb.style.left = pos + "px"; }
    else { thumb.style.height = len + "px"; thumb.style.top = pos + "px"; }
  }
}
for (const [id, axis] of [["#sbarH", "x"], ["#sbarV", "y"]]) {
  const bar = $(id), thumb = bar.firstElementChild;
  const geo = () => {
    const r = wrap.getBoundingClientRect();
    const view = axis === "x" ? r.width : r.height;
    const content = (axis === "x" ? S.img.width : S.img.height) * S.view.scale + 2 * MARGIN;
    const track = axis === "x" ? bar.clientWidth : bar.clientHeight;
    const len = Math.max(30, (view / content) * track);
    return { view, content, track, len };
  };
  const setFromThumbPos = (pos) => {
    const g = geo();
    const off = MARGIN - (clamp(pos, 0, g.track - g.len) / (g.track - g.len)) * (g.content - g.view);
    if (axis === "x") S.view.ox = off; else S.view.oy = off;
    S.view._fitted = false; draw();
  };
  thumb.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const start = axis === "x" ? e.clientX : e.clientY;
    const pos0 = parseFloat(axis === "x" ? thumb.style.left : thumb.style.top) || 0;
    bar.classList.add("drag");
    const mv = (ev) => setFromThumbPos(pos0 + (axis === "x" ? ev.clientX : ev.clientY) - start);
    const up = () => { bar.classList.remove("drag"); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  });
  bar.addEventListener("mousedown", (e) => { // click on the track = jump there
    if (e.target !== bar) return;
    const b = bar.getBoundingClientRect();
    setFromThumbPos((axis === "x" ? e.clientX - b.left : e.clientY - b.top) - geo().len / 2);
  });
}

// ---- zoom dock
const LNMIN = Math.log(ZMIN), LNMAX = Math.log(ZMAX);
function updateZoomUI() {
  const pct = Math.round(S.view.scale * 100) + "%";
  $("#zoomPct").textContent = pct;
  if (document.activeElement !== $("#zoomSlider"))
    $("#zoomSlider").value = Math.round(((Math.log(S.view.scale) - LNMIN) / (LNMAX - LNMIN)) * 1000);
}
$("#zoomSlider").addEventListener("input", (e) => zoomTo(Math.exp(LNMIN + (e.target.value / 1000) * (LNMAX - LNMIN))));
$("#zoomPct").onclick = (e) => { e.stopPropagation(); $("#zoomMenu").hidden = !$("#zoomMenu").hidden; };
$("#zoomMenu").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const z = b.dataset.z;
  if (z === "fit") fit(); else if (z === "width") fitWidth(); else zoomTo(Number(z));
  $("#zoomMenu").hidden = true;
};
document.addEventListener("click", (e) => { if (!e.target.closest(".zoom-pct-wrap")) $("#zoomMenu").hidden = true; });
function hideNavHint() { $("#navHint").classList.add("gone"); localStorageSet("kiri.navhint", "1"); }
if (localStorageGet("kiri.navhint")) $("#navHint").classList.add("gone");
else setTimeout(hideNavHint, 9000);
function ensureVisible(line) {
  if (!line || !S.img) return;
  const r = wrap.getBoundingClientRect();
  const [x1, y1, x2, y2] = line.box;
  const v = S.view;
  let sx1 = x1 * v.scale + v.ox, sy1 = y1 * v.scale + v.oy, sx2 = x2 * v.scale + v.ox, sy2 = y2 * v.scale + v.oy;
  if (S.mode === "text" && (y2 - y1) * v.scale < 18) {
    // zoom so the line is readable on the page
    const target = clamp(Math.min((r.width - 60) / (x2 - x1), 40 / (y2 - y1)), v.scale, 8);
    S.view.scale = target; S.view._fitted = false;
    sx1 = x1 * target; sx2 = x2 * target; sy1 = y1 * target; sy2 = y2 * target;
    S.view.ox = r.width / 2 - (sx1 + sx2) / 2; S.view.oy = r.height / 2 - (sy1 + sy2) / 2;
    return draw();
  }
  const m = 40;
  if (sy1 < m || sy2 > r.height - m) S.view.oy += r.height / 2 - (sy1 + sy2) / 2;
  if (sx1 < m || sx2 > r.width - m) S.view.ox += r.width / 2 - (sx1 + sx2) / 2;
  draw();
}

const toScreen = (x, y) => [x * S.view.scale + S.view.ox, y * S.view.scale + S.view.oy];
const toImage = (x, y) => [(x - S.view.ox) / S.view.scale, (y - S.view.oy) / S.view.scale];

let drag = null; // {type:'pan'|'move'|'resize'|'draw', ...}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!S.cur || !S.img) updateScrollbars();
  if (!S.cur) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = S.view;
  if (!S.img) {
    ctx.fillStyle = "#9aa1ad"; ctx.font = "14px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Loading image…", canvas.width / dpr / 2, canvas.height / dpr / 2);
    return;
  }
  clampView();
  ctx.imageSmoothingQuality = "high";
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 18;
  ctx.drawImage(S.img, v.ox, v.oy, S.img.width * v.scale, S.img.height * v.scale);
  ctx.shadowBlur = 0;

  const textMode = S.mode === "text";
  const focusId = S.selId || S.hoverId;
  if (textMode && focusId) {
    // dim everything but the focused line
    const l = S.lines.find((x) => x.id === focusId);
    if (l) {
      const [a, b] = toScreen(l.box[0], l.box[1]); const [c, d] = toScreen(l.box[2], l.box[3]);
      ctx.save(); ctx.fillStyle = "rgba(15,17,22,.45)";
      ctx.beginPath(); ctx.rect(v.ox, v.oy, S.img.width * v.scale, S.img.height * v.scale);
      ctx.rect(a - 3, b - 3, c - a + 6, d - b + 6); ctx.fill("evenodd"); ctx.restore();
    }
  }

  ctx.font = "600 11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  S.lines.forEach((l, i) => {
    const [x1, y1] = toScreen(l.box[0], l.box[1]);
    const [x2, y2] = toScreen(l.box[2], l.box[3]);
    const w = x2 - x1, h = y2 - y1;
    const sel = l.id === S.selId, hov = l.id === S.hoverId;
    let col = "#6366f1";
    if (textMode) col = l.ignore ? "#98a2b3" : l.text == null ? "#f79009" : flagged(l) ? "#f04438" : "#12b76a";
    else if (l.det_conf != null && l.det_conf < 0.6) col = "#f79009";
    if (l.ignore) ctx.setLineDash([5, 4]);
    ctx.lineWidth = sel ? 2.5 : hov ? 2 : 1.5;
    ctx.strokeStyle = col;
    ctx.fillStyle = sel ? hexA(col, 0.18) : hov ? hexA(col, 0.12) : hexA(col, textMode ? 0.04 : 0.08);
    ctx.fillRect(x1, y1, w, h); ctx.strokeRect(x1, y1, w, h);
    ctx.setLineDash([]);
    // index tag
    if (v.scale > 0.15 || sel) {
      const tag = String(i + 1); const tw = ctx.measureText(tag).width + 8;
      ctx.fillStyle = col; ctx.fillRect(x1 - 1, y1 - 15, tw, 14);
      ctx.fillStyle = "#fff"; ctx.fillText(tag, x1 + 3, y1 - 13);
    }
    if (sel && !textMode) handles(l).forEach(([, hx, hy]) => {
      ctx.fillStyle = "#fff"; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8);
    });
  });

  if (drag?.type === "draw") {
    const [a, b] = toScreen(drag.x0, drag.y0); const [c, d] = toScreen(drag.x1, drag.y1);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = "#a5b4fc"; ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(99,102,241,.15)";
    ctx.fillRect(a, b, c - a, d - b); ctx.strokeRect(a, b, c - a, d - b); ctx.setLineDash([]);
  }
  updateZoomUI();
  updateScrollbars();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function handles(l) {
  const [x1, y1] = toScreen(l.box[0], l.box[1]); const [x2, y2] = toScreen(l.box[2], l.box[3]);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  return [["nw", x1, y1], ["n", mx, y1], ["ne", x2, y1], ["e", x2, my], ["se", x2, y2], ["s", mx, y2], ["sw", x1, y2], ["w", x1, my]];
}
const CURSOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

function hit(sx, sy) {
  const sel = S.lines.find((l) => l.id === S.selId);
  if (sel && S.mode === "boxes") for (const [h, hx, hy] of handles(sel)) if (Math.abs(sx - hx) <= 7 && Math.abs(sy - hy) <= 7) return { kind: "handle", line: sel, h };
  const [ix, iy] = toImage(sx, sy);
  let best = null, bestA = Infinity;
  for (const l of S.lines) {
    const [x1, y1, x2, y2] = l.box;
    const tol = 3 / S.view.scale;
    if (ix >= x1 - tol && ix <= x2 + tol && iy >= y1 - tol && iy <= y2 + tol) {
      const a = (x2 - x1) * (y2 - y1);
      if (a < bestA) { best = l; bestA = a; }
    }
  }
  return best ? { kind: "box", line: best } : null;
}

const spaceDown = { v: false };
canvas.addEventListener("mousedown", (e) => {
  if (!S.cur || !S.img) return;
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const [ix, iy] = toImage(sx, sy);
  if (e.button === 1 || e.button === 2 || spaceDown.v) {
    drag = { type: "pan", sx, sy, ox: S.view.ox, oy: S.view.oy }; e.preventDefault(); return;
  }
  if (S.tool === "draw" && S.mode === "boxes") {
    drag = { type: "draw", x0: ix, y0: iy, x1: ix, y1: iy }; return;
  }
  const h = hit(sx, sy);
  if (h?.kind === "handle") {
    pushUndo(); drag = { type: "resize", line: h.line, h: h.h, box0: [...h.line.box], ix, iy, moved: false }; return;
  }
  if (h?.kind === "box") {
    select(h.line.id, { focusInput: S.mode === "text" });
    if (S.mode === "boxes") { pushUndo(); drag = { type: "move", line: h.line, box0: [...h.line.box], ix, iy, moved: false }; }
    return;
  }
  select(null);
  drag = { type: "pan", sx, sy, ox: S.view.ox, oy: S.view.oy };
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (!drag) {
    if (e.target !== canvas || !S.cur) return;
    if (spaceDown.v) { canvas.style.cursor = "grab"; return; }
    if (S.tool === "draw" && S.mode === "boxes") { canvas.style.cursor = "crosshair"; return; }
    const h = hit(sx, sy);
    canvas.style.cursor = h?.kind === "handle" ? CURSOR[h.h] : h ? (S.mode === "boxes" ? "move" : "pointer") : "default";
    const id = h?.line?.id || null;
    if (id !== S.hoverId) { S.hoverId = id; draw(); }
    return;
  }
  const [ix, iy] = toImage(sx, sy);
  const W = S.img.width, H = S.img.height;
  if (drag.type === "pan") {
    canvas.style.cursor = "grabbing";
    S.view.ox = drag.ox + (sx - drag.sx); S.view.oy = drag.oy + (sy - drag.sy); S.view._fitted = false;
  } else if (drag.type === "draw") {
    drag.x1 = clamp(ix, 0, W); drag.y1 = clamp(iy, 0, H);
  } else if (drag.type === "move") {
    const [x1, y1, x2, y2] = drag.box0;
    const dx = clamp(ix - drag.ix, -x1, W - x2), dy = clamp(iy - drag.iy, -y1, H - y2);
    drag.line.box = [x1 + dx, y1 + dy, x2 + dx, y2 + dy]; drag.moved = true;
  } else if (drag.type === "resize") {
    let [x1, y1, x2, y2] = drag.box0;
    const dx = ix - drag.ix, dy = iy - drag.iy;
    if (drag.h.includes("w")) x1 = clamp(x1 + dx, 0, W);
    if (drag.h.includes("e")) x2 = clamp(x2 + dx, 0, W);
    if (drag.h.includes("n")) y1 = clamp(y1 + dy, 0, H);
    if (drag.h.includes("s")) y2 = clamp(y2 + dy, 0, H);
    drag.line.box = [x1, y1, x2, y2]; drag.moved = true;
  }
  draw();
});
window.addEventListener("mouseup", () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.type === "pan") { canvas.style.cursor = ""; return; }
  if (d.type === "draw") {
    const x1 = Math.min(d.x0, d.x1), x2 = Math.max(d.x0, d.x1), y1 = Math.min(d.y0, d.y1), y2 = Math.max(d.y0, d.y1);
    if (x2 - x1 >= 4 && y2 - y1 >= 4) {
      pushUndo();
      const l = { id: uid(), box: [x1, y1, x2, y2], det_conf: null, text: null, conf: null };
      S.lines.push(l); sortLines(); S.selId = l.id; afterEdit(); select(l.id);
    } else draw();
    return;
  }
  if (d.type === "move" || d.type === "resize") {
    if (!d.moved) { S.undo.pop(); return; }
    const [x1, y1, x2, y2] = d.line.box;
    d.line.box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    sortLines(); afterEdit();
  }
});
canvas.addEventListener("dblclick", (e) => {
  if (S.mode !== "text") return;
  const r = canvas.getBoundingClientRect();
  const h = hit(e.clientX - r.left, e.clientY - r.top);
  if (h?.line) select(h.line.id, { focusInput: true });
});
canvas.addEventListener("wheel", (e) => {
  if (!S.img) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? r.height : 1;
  if (e.ctrlKey || e.metaKey) {
    // Ctrl + wheel (and trackpad pinch) = zoom around the cursor
    const step = e.deltaMode === 0 && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0025;
    zoomAt(Math.exp(-e.deltaY * unit * step), e.clientX - r.left, e.clientY - r.top);
  } else if (e.shiftKey) {
    scrollBy((e.deltaY || e.deltaX) * unit, 0); // Shift + wheel = horizontal scroll
  } else {
    scrollBy(e.deltaX * unit, e.deltaY * unit); // wheel / trackpad = scroll
  }
  hideNavHint();
}, { passive: false });

function sortLines() {
  // reading order: top-to-bottom, then left-to-right for boxes on the same row
  S.lines.sort((a, b) => {
    const ha = a.box[3] - a.box[1], hb = b.box[3] - b.box[1];
    const ca = (a.box[1] + a.box[3]) / 2, cb = (b.box[1] + b.box[3]) / 2;
    if (Math.abs(ca - cb) < Math.min(ha, hb) * 0.5) return a.box[0] - b.box[0];
    return ca - cb;
  });
}

function deleteSelected() {
  if (!S.selId) return;
  const idx = S.lines.findIndex((l) => l.id === S.selId);
  if (idx < 0) return;
  pushUndo();
  S.lines.splice(idx, 1);
  S.selId = S.lines[Math.min(idx, S.lines.length - 1)]?.id || null;
  afterEdit();
}
$("#delBtn").onclick = deleteSelected;
$("#zoomIn").onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); };
$("#zoomOut").onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); };
$("#zoomFit").onclick = fit;

// ======================================================================= keyboard
window.addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea, select");
  if (!$("#modalBg").hidden) { if (e.key === "Escape") closeModal(); return; }
  if (e.key === " " && !typing) { spaceDown.v = true; e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    if (e.altKey) setPanelOpen("right", !L.rightOpen); else setPanelOpen("left", !L.leftOpen);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveNow(); return; }
  if ((e.ctrlKey || e.metaKey) && ["=", "+", "-", "0"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "0") fit(); else $(e.key === "-" ? "#zoomOut" : "#zoomIn").click();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); approve(); return; }
  if (typing) return;
  const sel = S.lines.find((l) => l.id === S.selId);
  switch (e.key) {
    case "Enter": e.preventDefault(); approve(); break;
    case "1": setMode("boxes"); break;
    case "2": setMode("text"); break;
    case "b": case "B": setMode("boxes"); setTool(S.tool === "draw" ? "select" : "draw"); break;
    case "v": case "V": setTool("select"); break;
    case "f": case "F": fit(); break;
    case "w": case "W": fitWidth(); break;
    case "0": zoomTo(1); break;
    case "r": case "R": $("#recOneBtn").click(); break;
    case "+": case "=": $("#zoomIn").click(); break;
    case "-": $("#zoomOut").click(); break;
    case "Delete": case "Backspace": e.preventDefault(); deleteSelected(); break;
    case "Escape": setTool("select"); select(null); break;
    case "PageUp": e.preventDefault(); navigate(-1); break;
    case "PageDown": e.preventDefault(); navigate(1); break;
    case "Tab": {
      if (!S.lines.length) break;
      e.preventDefault();
      const i = S.lines.findIndex((l) => l.id === S.selId);
      const n = S.lines[(i + (e.shiftKey ? -1 : 1) + S.lines.length) % S.lines.length];
      select(n.id, { focusCanvas: true, focusInput: S.mode === "text" });
      break;
    }
    case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown": {
      if (sel && S.mode === "boxes") {
        e.preventDefault();
        if (!e.repeat) pushUndo();
        const st = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -st : e.key === "ArrowRight" ? st : 0;
        const dy = e.key === "ArrowUp" ? -st : e.key === "ArrowDown" ? st : 0;
        if (e.altKey) { sel.box[2] += dx; sel.box[3] += dy; } // Alt+arrows: resize
        else sel.box = [sel.box[0] + dx, sel.box[1] + dy, sel.box[2] + dx, sel.box[3] + dy];
        markDirty(); draw();
        clearTimeout(S._nudgeT); S._nudgeT = setTimeout(renderLines, 400);
      } else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "ArrowRight") navigate(1);
      break;
    }
    case "?": showHelp(); break;
  }
});
window.addEventListener("keyup", (e) => { if (e.key === " ") { spaceDown.v = false; canvas.style.cursor = ""; } });

function showHelp() {
  const row = (k, d) => `<tr><td>${k}</td><td>${d}</td></tr>`;
  openModal(`<header><h3>Keyboard shortcuts</h3><p>Work through hundreds of pages without touching the mouse.</p></header>
    <div class="body"><table class="kbd-table">
      ${row("<kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>Enter</kbd>", "Approve current image &amp; jump to the next one to review")}
      ${row("<kbd>←</kbd> <kbd>→</kbd> · <kbd>PgUp</kbd> <kbd>PgDn</kbd>", "Previous / next image")}
      ${row("<kbd>Ctrl</kbd>+<kbd>B</kbd> · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd>", "Show / hide the Images panel · the Lines panel")}
      ${row("Drag a panel border (⟷)", "Resize the panel · double-click the border to reset")}
      ${row("Filmstrip", "Drag or scroll the thumbnail strip under the page; click a thumbnail to open it")}
      ${row("<kbd>1</kbd> / <kbd>2</kbd>", "Boxes mode / Text mode")}
      ${row("<kbd>B</kbd>", "Toggle draw-box tool")}
      ${row("<kbd>V</kbd> · <kbd>Esc</kbd>", "Select tool · deselect")}
      ${row("<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>", "Next / previous line")}
      ${row("<kbd>Del</kbd>", "Delete selected box")}
      ${row("Arrows (box selected)", "Nudge box 1px (<kbd>Shift</kbd> = 10px, <kbd>Alt</kbd> = resize)")}
      ${row("<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>", "Undo / redo")}
      ${row("Mouse wheel · <kbd>Shift</kbd>+wheel", "Scroll up/down · left/right")}
      ${row("<kbd>Ctrl</kbd>+wheel · <kbd>+</kbd> <kbd>-</kbd>", "Zoom in / out (at the cursor)")}
      ${row("Drag empty space · <kbd>Space</kbd>+drag · right-drag", "Pan")}
      ${row("<kbd>F</kbd> · <kbd>W</kbd> · <kbd>0</kbd>", "Fit page · fit width · 100%")}
      ${row("<kbd>R</kbd>", "Recognize all lines of this image")}
      ${row("In a text field: <kbd>Enter</kbd> / <kbd>↑</kbd> <kbd>↓</kbd>", "Move to next / previous line")}
    </table></div>
    <footer><button class="btn primary" onclick="closeModal()">Got it</button></footer>`);
}
$("#helpBtn").onclick = showHelp;

// ======================================================================= settings
async function loadSettings() { S.settings = await api("GET", "/api/settings"); }
$("#settingsBtn").onclick = async () => {
  await loadSettings();
  const s = S.settings;
  const num = (k, label, step, min, max, hint) => `
    <div class="field"><label>${label} <span class="muted mono small" id="v_${k}">${s[k]}</span></label>
      <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}">
      <span class="hint">${hint}</span></div>`;
  openModal(`<header><h3>Settings</h3><p>Model: <code>${esc(s.model_path)}</code> · device: <b>${s.resolved_device}</b>${s.cuda_available ? "" : " (no CUDA found)"}</p></header>
    <div class="body">
      <div class="grid2">
        <div class="field"><label>Recognition decoding</label>
          <select data-k="decode_method">
            ${["fast", "accurate", "beam"].map((m) => `<option ${s.decode_method === m ? "selected" : ""}>${m}</option>`).join("")}
          </select><span class="hint">fast = CTC · accurate = decoder · beam = best, slowest</span></div>
        <div class="field"><label>Device</label>
          <select data-k="device">${["auto", "cpu", "cuda"].map((m) => `<option ${s.device === m ? "selected" : ""}>${m}</option>`).join("")}</select>
          <span class="hint">auto uses the GPU when available</span></div>
      </div>
      ${num("det_db_thresh", "Pixel threshold", 0.05, 0.05, 0.9, "Lower finds fainter text (DB binarization threshold).")}
      ${num("det_db_box_thresh", "Box threshold", 0.05, 0.1, 0.95, "Lower keeps more low-confidence boxes.")}
      ${num("det_db_unclip_ratio", "Unclip ratio", 0.1, 1.0, 3.0, "Higher makes boxes larger (more margin around text).")}
      ${num("max_side_len", "Max image side", 32, 640, 2560, "Images are resized so the long side ≤ this before detection. Higher helps small text.")}
      ${num("crop_pad", "Line crop padding (px)", 1, 0, 20, "Extra margin around each box when cropping lines (recognition + exported dataset).")}
      <label class="switch"><input type="checkbox" data-k="auto_recognize" ${s.auto_recognize ? "checked" : ""}><span></span> Recognize automatically right after approving an image's boxes</label>
      <div class="field"><label>Custom detector ONNX (optional)</label>
        <input type="text" data-k="det_model_path" value="${esc(s.det_model_path)}" placeholder="empty = detector/DB/detector.onnx from the HF repo"></div>
      <div class="field"><label>Recognition model</label>
        <input type="text" data-k="model_path" value="${esc(s.model_path)}" placeholder="mrrtmob/kiri-ocr or path/to/model.safetensors">
        <span class="hint">Point to your fine-tuned <code>model.safetensors</code> later to close the loop.</span></div>
    </div>
    <footer><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></footer>`,
    (m) => {
      $$("input[type=range]", m).forEach((r) => r.oninput = () => ($(`#v_${r.dataset.k}`).textContent = r.value));
      $("[data-x]", m).onclick = closeModal;
      $("[data-ok]", m).onclick = async () => {
        const body = {};
        $$("[data-k]", m).forEach((el) => {
          body[el.dataset.k] = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
        });
        S.settings = await api("PUT", "/api/settings", body);
        closeModal(); toast("Settings saved", "ok", 1500);
      };
    });
};

// ======================================================================= export
$("#exportBtn").onclick = async () => {
  await flushSave();
  await refreshProject();
  const imgs = S.images;
  const detReady = imgs.filter((i) => i.det_verified).length;
  const textReady = imgs.filter((i) => i.text_verified);
  const linesReady = textReady.reduce((a, i) => a + (i.lines || []).filter((l) => l.text && !l.ignore).length, 0);
  const unverified = imgs.filter((i) => i.det_verified && !i.text_verified && (i.lines || []).some((l) => l.text)).length;
  openModal(`<header><h3>Export training datasets</h3><p>Only human-approved data is exported. Train/val split is done per image, so lines from one page never leak across splits.</p></header>
    <div class="body">
      <div class="stat-grid">
        <div class="stat"><div class="v">${detReady}</div><div class="k">images with approved boxes</div></div>
        <div class="stat"><div class="v">${textReady.length}</div><div class="k">images with approved text</div></div>
        <div class="stat"><div class="v">${linesReady}</div><div class="k">text-line crops</div></div>
      </div>
      <div class="callout">
        <b>detection/</b> — YOLO format, 1 class <code>text</code> (<code>images/</code>, <code>labels/</code>, <code>data.yaml</code>) + PaddleOCR-DB label files.<br>
        <b>recognition/</b> — line crops + <code>labels.txt</code> (<code>file⇥text</code>), ready for <code>kiri-ocr train --train-labels …</code> (48×640).
      </div>
      ${!detReady ? `<div class="callout warn">No approved images yet. Approve boxes (<kbd>Enter</kbd>) on some images first.</div>` : ""}
      <div class="field"><label>Validation split <span class="mono muted small" id="vr">10%</span></label>
        <input type="range" id="valRatio" min="0" max="0.4" step="0.05" value="0.1"></div>
      <label class="switch"><input type="checkbox" id="incUnv"><span></span> Also include recognized text on images that are not text-approved (${unverified} image(s)) — not recommended</label>
      <div id="exportResult"></div>
    </div>
    <footer><button class="btn" data-x>Close</button><button class="btn primary" data-ok ${detReady ? "" : "disabled"}>Export</button></footer>`,
    (m) => {
      $("#valRatio").oninput = (e) => ($("#vr").textContent = Math.round(e.target.value * 100) + "%");
      $("[data-x]", m).onclick = closeModal;
      $("[data-ok]", m).onclick = async (e) => {
        e.target.disabled = true; e.target.innerHTML = `<span class="spinner"></span> Exporting…`;
        try {
          const r = await api("POST", `${P()}/export`, { val_ratio: Number($("#valRatio").value), include_unverified_text: $("#incUnv").checked });
          const s = r.stats;
          $("#exportResult").innerHTML = `<div class="callout ok">
            <b>Export complete.</b><br>
            Detection: ${s.det_images.train} train / ${s.det_images.val} val images (${s.det_boxes.train + s.det_boxes.val} boxes)<br>
            Recognition: ${s.rec_lines.train} train / ${s.rec_lines.val} val lines<br>
            Folder: <code>${esc(r.dir)}</code><br><br>
            <a class="btn small primary" href="/api/exports/${encodeURIComponent(r.zip)}" download>Download .zip</a>
          </div>`;
          e.target.textContent = "Export again"; e.target.disabled = false;
        } catch (err) { toast(esc(err.message), "error"); e.target.textContent = "Export"; e.target.disabled = false; }
      };
    });
};

// ======================================================================= touch: pan / pinch
// one finger: pan · two fingers: pinch-zoom
const touch = { mode: null };
const tDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
canvas.addEventListener("touchstart", (e) => {
  if (!S.img) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  if (e.touches.length === 2) {
    touch.mode = "pinch"; touch.d0 = tDist(e.touches); touch.s0 = S.view.scale;
    touch.cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
    touch.cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    touch.mode = "pan"; touch.x0 = t.clientX; touch.y0 = t.clientY; touch.ox = S.view.ox; touch.oy = S.view.oy;
  }
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  if (!touch.mode) return;
  e.preventDefault();
  if (touch.mode === "pinch" && e.touches.length === 2) {
    const target = clamp(touch.s0 * (tDist(e.touches) / touch.d0), ZMIN, ZMAX);
    zoomAt(target / S.view.scale, touch.cx, touch.cy);
  } else if (touch.mode === "pan" && e.touches.length === 1) {
    const t = e.touches[0];
    S.view.ox = touch.ox + (t.clientX - touch.x0); S.view.oy = touch.oy + (t.clientY - touch.y0); S.view._fitted = false;
    draw();
  }
}, { passive: false });
canvas.addEventListener("touchend", (e) => { if (!e.touches.length) touch.mode = null; });

// ======================================================================= filmstrip
function filmList() { return filtered().length ? filtered() : S.images; }
function renderFilmstrip() {
  const strip = $("#filmstrip");
  const show = S.images.length > 0 && localStorageGet("kiri.film") !== "0";
  strip.hidden = !show;
  $("#filmBtn").classList.toggle("on", show);
  if (!show) return;
  const list = filmList();
  const track = $("#filmTrack");
  const idx = list.findIndex((i) => i.id === S.cur?.id);
  $("#filmCount").textContent = idx >= 0 ? `${idx + 1} / ${list.length}` : `${list.length} images`;
  const key = list.map((i) => i.id + i.status).join() + "|" + S.cur?.id;
  if (track.dataset.key === key) return; // nothing changed
  track.dataset.key = key;
  track.innerHTML = list.map((i, n) => `
    <button class="film ${i.id === S.cur?.id ? "on" : ""}" data-iid="${i.id}" title="${esc(i.filename)} — ${STATUS[i.status]}">
      <img loading="lazy" draggable="false" src="${P()}/images/${i.id}/thumb" alt="">
      <span class="dot s-${i.status}"></span><span class="num">${n + 1}</span>
    </button>`).join("");
  const on = track.querySelector(".film.on");
  if (on) on.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}
(function filmstripInput() {
  const track = $("#filmTrack");
  // drag to scroll the strip; a click without dragging opens the image
  let down = null;
  track.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, sl: track.scrollLeft, moved: false, id: e.pointerId };
  });
  track.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > 5 && !down.moved) { down.moved = true; track.setPointerCapture(down.id); track.classList.add("dragging"); }
    if (down.moved) track.scrollLeft = down.sl - dx;
  });
  track.addEventListener("pointerup", (e) => {
    if (!down) return;
    const wasMoved = down.moved; down = null;
    track.classList.remove("dragging");
    if (wasMoved) return;
    const b = e.target.closest(".film");
    if (!b || b.dataset.iid === S.cur?.id) return;
    openImage(b.dataset.iid);
  });
  track.addEventListener("pointercancel", () => { down = null; track.classList.remove("dragging"); });
  track.addEventListener("wheel", (e) => { // vertical wheel scrolls the strip sideways
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { track.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  $("#filmLeft").onclick = () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: "smooth" });
  $("#filmRight").onclick = () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: "smooth" });
  $("#filmBtn").onclick = () => {
    localStorageSet("kiri.film", localStorageGet("kiri.film") === "0" ? "1" : "0");
    track.dataset.key = "";
    renderFilmstrip();
  };
})();

// ======================================================================= upload preview
function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|bmp|tiff?|webp)$/i.test(f.name));
  if (!files.length) return toast("No image files found", "error");
  if (!S.project) return;
  const items = files.map((f) => ({ file: f, url: URL.createObjectURL(f), keep: true }));
  let cur = 0;
  const kept = () => items.filter((it) => it.keep);
  const fmt = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");

  openModal(`
    <header class="up-head">
      <div><h3>Upload images</h3><p id="upSub"></p></div>
      <button class="btn icon ghost" data-x title="Cancel (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="up-stage">
      <button class="up-nav prev" id="upPrev" title="Previous (←)"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div class="up-view" id="upView"><img id="upImg" alt="" draggable="false"></div>
      <button class="up-nav next" id="upNext" title="Next (→)"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
      <div class="up-caption"><span id="upName"></span><span id="upIdx" class="mono"></span></div>
      <button class="btn small up-remove" id="upToggle"></button>
    </div>
    <div class="up-strip" id="upStrip">
      ${items.map((it, i) => `<button class="up-thumb" data-i="${i}" title="${esc(it.file.name)}">
        <img loading="lazy" src="${it.url}" alt="" draggable="false"><span class="x" data-rm="${i}" title="Remove / keep">✕</span></button>`).join("")}
    </div>
    <footer class="up-foot">
      <label class="switch"><input type="checkbox" id="upDetect" ${localStorageGet("kiri.upDetect") === "1" ? "checked" : ""}><span></span> Run text detection right after upload</label>
      <div class="grow"></div>
      <button class="btn" data-x>Cancel</button>
      <button class="btn primary" id="upGo"></button>
    </footer>`,
    (m) => {
      $("#modal").classList.add("wide");
      const show = (i, dir = 0) => {
        cur = clamp(i, 0, items.length - 1);
        const it = items[cur];
        const img = $("#upImg");
        img.src = it.url;
        $("#upName").textContent = `${it.file.name} · ${fmt(it.file.size)}`;
        $("#upIdx").textContent = `${cur + 1} / ${items.length}`;
        $("#upView").classList.toggle("removed", !it.keep);
        $("#upToggle").textContent = it.keep ? "Remove this image" : "Keep this image";
        $("#upPrev").disabled = cur === 0;
        $("#upNext").disabled = cur === items.length - 1;
        $$(".up-thumb", m).forEach((t, k) => {
          t.classList.toggle("on", k === cur);
          t.classList.toggle("removed", !items[k].keep);
        });
        $(`.up-thumb[data-i="${cur}"]`, m)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
        const n = kept().length;
        $("#upSub").textContent = `${items.length} selected · ${n} will be uploaded — use ‹ › or ← → to check them`;
        $("#upGo").textContent = n ? `Upload ${n} image${n === 1 ? "" : "s"}` : "Nothing to upload";
        $("#upGo").disabled = !n;
      };
      const go = (d) => { if (cur + d >= 0 && cur + d < items.length) show(cur + d, d); };
      const toggle = (i) => { items[i].keep = !items[i].keep; show(cur); };
      $("#upPrev").onclick = () => go(-1);
      $("#upNext").onclick = () => go(1);
      $("#upToggle").onclick = () => toggle(cur);
      $("#upStrip").onclick = (e) => {
        const rm = e.target.closest("[data-rm]");
        if (rm) { e.stopPropagation(); toggle(+rm.dataset.rm); return; }
        const t = e.target.closest(".up-thumb");
        if (t) show(+t.dataset.i, +t.dataset.i > cur ? 1 : -1);
      };
      $("#upStrip").addEventListener("wheel", (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $("#upStrip").scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });

      const keys = (e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); toggle(cur); }
        else if (e.key === "Enter" && kept().length) { e.preventDefault(); e.stopPropagation(); $("#upGo").click(); }
      };
      window.addEventListener("keydown", keys, true);
      // runs on Cancel, Esc, backdrop click or Upload
      S.onModalClose = () => {
        window.removeEventListener("keydown", keys, true);
        $("#modal").classList.remove("wide");
        items.forEach((it) => URL.revokeObjectURL(it.url));
      };
      $$("[data-x]", m).forEach((b) => (b.onclick = closeModal));
      $("#upGo").onclick = () => {
        const sel = kept().map((it) => it.file);
        const detect = $("#upDetect").checked;
        localStorageSet("kiri.upDetect", detect ? "1" : "0");
        closeModal();
        doUpload(sel, { detect });
      };
      show(0);
    });
}


// ======================================================================= resizable + collapsible panels
// Images panel (left) and Lines panel (right): drag the sash to resize, double-click it to reset,
// drag it almost closed to collapse, or use the toggle icons / Ctrl+B / Ctrl+Alt+B.
const PANEL = {
  left: { key: "kiri.lw", def: 264, min: 200, max: 560 },
  rightBoxes: { key: "kiri.rwb", def: 380, min: 300, max: 900 },
  rightText: { key: "kiri.rwt", def: () => Math.round(window.innerWidth * 0.4), min: 340, max: 1100 },
};
const L = {
  left: +localStorageGet(PANEL.left.key) || PANEL.left.def,
  rightBoxes: +localStorageGet(PANEL.rightBoxes.key) || PANEL.rightBoxes.def,
  rightText: +localStorageGet(PANEL.rightText.key) || PANEL.rightText.def(),
  leftOpen: localStorageGet("kiri.lopen") !== "0",
  rightOpen: localStorageGet("kiri.ropen") !== "0",
};
const rightKey = () => (S.mode === "text" ? "rightText" : "rightBoxes");
function maxFor(k) { // always leave at least 420px for the image
  const other = k === "left" ? (L.rightOpen ? L[rightKey()] : 0) : (L.leftOpen ? L.left : 0);
  return Math.max(PANEL[k].min, Math.min(PANEL[k].max, window.innerWidth - other - 420));
}
function applyLayout() {
  const lay = $("#layout");
  const lw = L.leftOpen ? clamp(L.left, PANEL.left.min, maxFor("left")) : 0;
  const rk = rightKey();
  const rw = L.rightOpen ? clamp(L[rk], PANEL[rk].min, maxFor(rk)) : 0;
  lay.style.gridTemplateColumns = `${lw}px minmax(0, 1fr) ${rw}px`;
  lay.classList.toggle("left-collapsed", !L.leftOpen);
  lay.classList.toggle("right-collapsed", !L.rightOpen);
  $("#toggleLeft").classList.toggle("on", L.leftOpen);
  $("#toggleRight").classList.toggle("on", L.rightOpen);
}
function setPanelOpen(side, open) {
  L[side + "Open"] = open;
  localStorageSet(side === "left" ? "kiri.lopen" : "kiri.ropen", open ? "1" : "0");
  applyLayout();
}
$("#toggleLeft").onclick = () => setPanelOpen("left", !L.leftOpen);
$("#toggleRight").onclick = () => setPanelOpen("right", !L.rightOpen);
$("#collapseLeft").onclick = () => setPanelOpen("left", false);
window.addEventListener("resize", applyLayout);

function makeSash(el, side) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    document.body.classList.add("resizing");
    const lay = $("#layout").getBoundingClientRect();
    const k = side === "left" ? "left" : rightKey();
    const move = (ev) => {
      const w = side === "left" ? ev.clientX - lay.left : lay.right - ev.clientX;
      if (w < PANEL[k].min - 80) { // dragged nearly closed -> snap shut (VS Code behaviour)
        if (L[side + "Open"]) setPanelOpen(side, false);
        return;
      }
      if (!L[side + "Open"]) setPanelOpen(side, true);
      L[k] = clamp(Math.round(w), PANEL[k].min, maxFor(k));
      applyLayout();
    };
    const up = () => {
      el.classList.remove("active");
      document.body.classList.remove("resizing");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      localStorageSet(PANEL[k].key, String(L[k]));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  el.addEventListener("dblclick", () => { // reset to the default width
    const k = side === "left" ? "left" : rightKey();
    const d = PANEL[k].def;
    L[k] = typeof d === "function" ? d() : d;
    localStorageSet(PANEL[k].key, String(L[k]));
    applyLayout();
  });
}
makeSash($("#sashLeft"), "left");
makeSash($("#sashRight"), "right");
$("#collapseRight").onclick = () => setPanelOpen("right", false);
applyLayout();
window.layoutReady = true;

// ======================================================================= utils / boot
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

(async function boot() {
  try {
    await loadSettings();
    await loadProjects();
  } catch (e) {
    toast("Cannot reach the server: " + esc(e.message), "error", 8000);
  }
  renderStage();
})();
