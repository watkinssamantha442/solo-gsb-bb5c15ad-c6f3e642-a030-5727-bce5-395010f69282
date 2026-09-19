/* global SubEngine */
(function () {
  'use strict';

  const {
    MIN_DURATION_MS, MIN_GAP_MS,
    msToTimecode, parseSrt, formatSrt, normalize, applyDrag, applyMove, validate,
  } = SubEngine;

  const MIN_PPS = 10;    // 像素/秒，缩放范围
  const MAX_PPS = 2000;
  const UNDO_LIMIT = 100;

  const state = {
    cues: [],          // [{start, end, text}]
    pxPerSec: 120,
    undoStack: [],     // 每次拖动前的 [{start,end},...] 快照
    selected: -1,
    drag: null,        // {index, edge: 'start'|'end'|'move', moved, grabOffset, el, snapshot}
    fileName: 'edited.srt',
  };

  const $ = (sel) => document.querySelector(sel);
  const scroller = $('#timeline-scroll');
  const content = $('#timeline-content');
  const rulerEl = $('#ruler');
  const trackEl = $('#track');
  const listBody = $('#cue-list-body');
  const statusEl = $('#status');
  const emptyHint = $('#empty-hint');
  const fileInput = $('#file-input');
  const zoomSlider = $('#zoom-slider');
  const zoomLabel = $('#zoom-label');

  let blockEls = [];   // 与 state.cues 对应的块元素池
  let rowEls = [];     // 列表行元素池
  let rulerWidth = 0;  // 已渲染刻度的宽度，避免拖动中重复渲染
  let rafPending = false;

  /* ---------------- 渲染 ---------------- */

  function contentWidthPx() {
    const endMs = state.cues.length ? state.cues[state.cues.length - 1].end : 0;
    const w = (endMs + 5000) / 1000 * state.pxPerSec; // 末尾留白 5s
    return Math.max(w, scroller.clientWidth);
  }

  function ensureBlocks() {
    while (blockEls.length < state.cues.length) {
      const i = blockEls.length;
      const el = document.createElement('div');
      el.className = 'block';
      el.dataset.i = i;
      el.title = '按住块主体横向拖动可整块平移（时长不变）';
      el.innerHTML =
        '<div class="handle handle-l" title="拖动调整起点"></div>' +
        '<div class="block-body"><div class="block-time"></div><div class="block-text"></div></div>' +
        '<div class="handle handle-r" title="拖动调整终点"></div>';
      trackEl.appendChild(el);
      blockEls.push(el);
    }
    while (blockEls.length > state.cues.length) trackEl.removeChild(blockEls.pop());
  }

  function ensureRows() {
    while (rowEls.length < state.cues.length) {
      const tr = document.createElement('tr');
      for (let k = 0; k < 5; k++) tr.appendChild(document.createElement('td'));
      tr.addEventListener('click', () => {
        selectCue(rowEls.indexOf(tr));
        scrollBlockIntoView(rowEls.indexOf(tr));
      });
      listBody.appendChild(tr);
      rowEls.push(tr);
    }
    while (rowEls.length > state.cues.length) listBody.removeChild(rowEls.pop());
  }

  function updateBlocks(from) {
    const pps = state.pxPerSec;
    for (let i = Math.max(0, from); i < state.cues.length; i++) {
      const c = state.cues[i];
      const el = blockEls[i];
      el.style.left = (c.start / 1000 * pps) + 'px';
      el.style.width = ((c.end - c.start) / 1000 * pps) + 'px';
      el.querySelector('.block-time').textContent =
        msToTimecode(c.start) + ' → ' + msToTimecode(c.end);
      const textEl = el.querySelector('.block-text');
      if (textEl.textContent !== c.text) textEl.textContent = c.text;
    }
  }

  function updateRows(from) {
    for (let i = Math.max(0, from); i < state.cues.length; i++) {
      const c = state.cues[i];
      const td = rowEls[i].children;
      td[0].textContent = i + 1;
      td[1].textContent = msToTimecode(c.start);
      td[2].textContent = msToTimecode(c.end);
      td[3].textContent = ((c.end - c.start) / 1000).toFixed(3) + 's';
      if (td[4].textContent !== c.text) td[4].textContent = c.text;
    }
  }

  function renderRuler() {
    rulerEl.textContent = '';
    const pps = state.pxPerSec;
    const width = contentWidthPx();
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find(s => s * pps >= 90) || 3600;
    const frag = document.createDocumentFragment();
    for (let t = 0; t * pps <= width; t += step) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = (t * pps) + 'px';
      const label = document.createElement('span');
      label.textContent = step < 1
        ? msToTimecode(t * 1000).slice(3)          // mm:ss,mmm
        : msToTimecode(t * 1000).replace(/^00:/, ''); // 不足一小时时省略小时
      tick.appendChild(label);
      frag.appendChild(tick);
    }
    rulerEl.appendChild(frag);
    rulerWidth = width;
  }

  function updateStatus() {
    const n = state.cues.length;
    if (!n) {
      statusEl.textContent = '就绪 — 请导入 SRT 文件，或点击「载入示例」';
      return;
    }
    const problems = validate(state.cues);
    statusEl.textContent = problems.length
      ? '⚠ ' + problems[0]
      : '共 ' + n + ' 条 · 结束于 ' + msToTimecode(state.cues[n - 1].end) +
        ' · 缩放 ' + state.pxPerSec + ' px/s · ✓ 约束满足（每块 ≥' + MIN_DURATION_MS +
        'ms，间隔 ≥' + MIN_GAP_MS + 'ms，起点 ≥0）';
    statusEl.classList.toggle('warn', problems.length > 0);
  }

  function updateUndoButton() {
    const btn = $('#btn-undo');
    btn.disabled = state.undoStack.length === 0;
    btn.textContent = state.undoStack.length ? '撤销拖动 (' + state.undoStack.length + ')' : '撤销拖动';
  }

  function renderDynamic(from) {
    if (!state.cues.length) return;
    const w = contentWidthPx() + 'px';
    if (content.style.width !== w) content.style.width = w;
    if (parseFloat(w) > rulerWidth) renderRuler(); // 内容变长时补刻度
    updateBlocks(from);
    updateRows(from);
    updateStatus();
  }

  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderDynamic(state.drag ? state.drag.index : 0);
    });
  }

  function renderAll() {
    emptyHint.style.display = state.cues.length ? 'none' : '';
    if (!state.cues.length) {
      trackEl.textContent = ''; blockEls = [];
      listBody.textContent = ''; rowEls = [];
      rulerEl.textContent = ''; rulerWidth = 0;
      updateStatus();
      return;
    }
    ensureBlocks();
    ensureRows();
    content.style.width = contentWidthPx() + 'px';
    renderRuler();
    renderDynamic(0);
    markSelected();
  }

  /* ---------------- 选择 ---------------- */

  function markSelected() {
    blockEls.forEach((el, i) => el.classList.toggle('selected', i === state.selected));
    rowEls.forEach((el, i) => el.classList.toggle('selected', i === state.selected));
  }

  function selectCue(i) {
    state.selected = i;
    markSelected();
    if (rowEls[i]) rowEls[i].scrollIntoView({ block: 'nearest' });
  }

  function scrollBlockIntoView(i) {
    if (!state.cues[i]) return;
    const x = state.cues[i].start / 1000 * state.pxPerSec;
    scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 3);
  }

  /* ---------------- 拖动 ---------------- */

  trackEl.addEventListener('pointerdown', (e) => {
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;
    const index = Number(blockEl.dataset.i);
    selectCue(index);
    const handle = e.target.closest('.handle');
    // 手柄拖动边界；按住块主体则整块平移（时长不变）
    const edge = handle ? (handle.classList.contains('handle-l') ? 'start' : 'end') : 'move';
    e.preventDefault();
    const rect = content.getBoundingClientRect();
    const t = (e.clientX - rect.left) / state.pxPerSec * 1000;
    state.drag = {
      index,
      edge,
      moved: false,
      grabOffset: edge === 'move' ? t - state.cues[index].start : 0, // 抓取点偏移，避免跳动
      el: blockEl,
      snapshot: state.cues.map(c => ({ start: c.start, end: c.end })),
    };
    if (edge === 'move') blockEl.classList.add('moving');
    blockEl.setPointerCapture(e.pointerId);
  });

  trackEl.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    const rect = content.getBoundingClientRect();
    const t = (e.clientX - rect.left) / state.pxPerSec * 1000;
    if (state.drag.edge === 'move') {
      applyMove(state.cues, state.drag.index, t - state.drag.grabOffset);
    } else {
      applyDrag(state.cues, state.drag.index, state.drag.edge, t);
    }
    state.drag.moved = true;
    // 拖到视口边缘时自动横向滚动
    const sr = scroller.getBoundingClientRect();
    if (e.clientX > sr.right - 40) scroller.scrollLeft += 24;
    else if (e.clientX < sr.left + 40) scroller.scrollLeft -= 24;
    requestRender();
  });

  function finishDrag() {
    if (!state.drag) return;
    if (state.drag.el) state.drag.el.classList.remove('moving');
    if (state.drag.moved) {
      // 一次手势（含中途的推移与回拖）只产生一条撤销记录
      state.undoStack.push(state.drag.snapshot);
      if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
      updateUndoButton();
    }
    state.drag = null;
    renderDynamic(0);
  }
  trackEl.addEventListener('pointerup', finishDrag);
  trackEl.addEventListener('pointercancel', finishDrag);

  /* ---------------- 撤销 ---------------- */

  function undo() {
    const snap = state.undoStack.pop();
    if (!snap) return;
    state.cues.forEach((c, i) => { c.start = snap[i].start; c.end = snap[i].end; });
    updateUndoButton();
    renderAll();
  }
  $('#btn-undo').addEventListener('click', undo);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' &&
        !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
      e.preventDefault();
      undo();
    }
  });

  /* ---------------- 缩放 ---------------- */

  const sliderToPps = (v) => Math.round(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100));
  const ppsToSlider = (p) => Math.round(100 * Math.log(p / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS));

  function setPps(pps, anchorClientX) {
    const rect = scroller.getBoundingClientRect();
    const anchorX = anchorClientX != null ? anchorClientX - rect.left : scroller.clientWidth / 2;
    const timeAtAnchor = (scroller.scrollLeft + anchorX) / state.pxPerSec;
    state.pxPerSec = Math.min(MAX_PPS, Math.max(MIN_PPS, Math.round(pps)));
    zoomSlider.value = ppsToSlider(state.pxPerSec);
    zoomLabel.textContent = state.pxPerSec + ' px/s';
    renderAll();
    scroller.scrollLeft = timeAtAnchor * state.pxPerSec - anchorX;
  }

  $('#btn-zoom-in').addEventListener('click', () => setPps(state.pxPerSec * 1.25));
  $('#btn-zoom-out').addEventListener('click', () => setPps(state.pxPerSec / 1.25));
  $('#btn-zoom-fit').addEventListener('click', fitZoom);
  zoomSlider.addEventListener('input', () => setPps(sliderToPps(Number(zoomSlider.value))));
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setPps(state.pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX);
  }, { passive: false });

  function fitZoom() {
    if (!state.cues.length) return;
    const totalSec = (state.cues[state.cues.length - 1].end + 2000) / 1000;
    setPps((scroller.clientWidth - 20) / totalSec);
    scroller.scrollLeft = 0;
  }

  /* ---------------- 导入 / 导出 ---------------- */

  function importText(text, name) {
    const cues = normalize(parseSrt(text));
    if (!cues.length) {
      statusEl.textContent = '⚠ 未能从「' + name + '」解析出任何字幕';
      statusEl.classList.add('warn');
      return;
    }
    state.cues = cues;
    state.fileName = name.replace(/\.[^.]*$/, '') + '.srt';
    state.undoStack = [];
    state.selected = -1;
    updateUndoButton();
    $('#btn-export').disabled = false;
    renderAll();
    fitZoom();
  }

  $('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result), f.name);
    reader.readAsText(f);
    fileInput.value = '';
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result), f.name);
    reader.readAsText(f);
  });

  $('#btn-export').addEventListener('click', () => {
    if (!state.cues.length) return;
    const problems = validate(state.cues);
    if (problems.length) {
      alert('时间轴不合法，无法导出：\n' + problems.join('\n'));
      return;
    }
    const blob = new Blob([formatSrt(state.cues)], { type: 'application/x-subrip;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------------- 示例 ---------------- */

  $('#btn-demo').addEventListener('click', () => {
    importText([
      '1', '00:00:00,000 --> 00:00:01,800', '欢迎来到字幕时间轴修整器', '',
      '2', '00:00:02,000 --> 00:00:04,200', '拖动左右边界调整起止，按住块主体可整块平移', '',
      '3', '00:00:04,500 --> 00:00:06,000', '右边界越过安全线时会递归推移后继块', '',
      '4', '00:00:06,200 --> 00:00:08,500', '向回拖动只释放空隙，不会拉回后继', '',
      '5', '00:00:08,800 --> 00:00:11,000', '每块至少 500ms，块间至少 100ms，起点不为负', '',
      '6', '00:00:11,300 --> 00:00:13,600', 'Ctrl+滚轮缩放时间轴，Ctrl+Z 撤销拖动', '',
      '7', '00:00:13,900 --> 00:00:16,500', '完成后点击「导出 SRT」保存合法字幕文件', '',
    ].join('\n'), 'demo.srt');
  });

  window.addEventListener('resize', () => { if (state.cues.length) renderAll(); });

  zoomSlider.value = ppsToSlider(state.pxPerSec);
  zoomLabel.textContent = state.pxPerSec + ' px/s';
  renderAll();
})();
