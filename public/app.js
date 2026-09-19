/* global SubEngine */
(function () {
  'use strict';

  const {
    MIN_DURATION_MS, MIN_GAP_MS,
    msToTimecode, parseSrt, formatSrt, normalize, applyDrag, applyMove, stretchRange, validate,
  } = SubEngine;

  const MIN_PPS = 10;    // 像素/秒，缩放范围
  const MAX_PPS = 2000;
  const UNDO_LIMIT = 100;

  const state = {
    cues: [],          // [{start, end, text}]
    pxPerSec: 120,
    undoStack: [],     // 每次拖动/变速前的 [{start,end},...] 快照
    selected: -1,
    drag: null,        // {index, edge: 'start'|'end'|'move', moved, grabOffset, el, snapshot}
    stretch: null,     // 区间变速预览：{original, affected:[i0,i1], ratio}
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
  const stretchPanel = $('#stretch-panel');
  const stretchIn = $('#stretch-in');
  const stretchOut = $('#stretch-out');
  const stretchTarget = $('#stretch-target');
  const stretchMsg = $('#stretch-msg');
  const btnSetIn = $('#btn-set-in');
  const btnSetOut = $('#btn-set-out');
  const markIn = $('#mark-in');
  const markOut = $('#mark-out');
  const markTarget = $('#mark-target');
  const stretchRegion = $('#stretch-region');

  let blockEls = [];   // 与 state.cues 对应的块元素池
  let rowEls = [];     // 列表行元素池
  let rulerWidth = 0;  // 已渲染刻度的宽度，避免拖动中重复渲染
  let rafPending = false;
  let armTarget = null; // 'in' | 'out'：等待在时间轴上单击设入点/出点

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
    const st = state.stretch;
    for (let i = Math.max(0, from); i < state.cues.length; i++) {
      const c = state.cues[i];
      const el = blockEls[i];
      el.style.left = (c.start / 1000 * pps) + 'px';
      el.style.width = ((c.end - c.start) / 1000 * pps) + 'px';
      el.classList.toggle('stretch-affected',
        !!(st && i >= st.affected[0] && i <= st.affected[1]));
      el.querySelector('.block-time').textContent =
        msToTimecode(c.start) + ' → ' + msToTimecode(c.end);
      const textEl = el.querySelector('.block-text');
      if (textEl.textContent !== c.text) textEl.textContent = c.text;
    }
  }

  function updateRows(from) {
    const st = state.stretch;
    for (let i = Math.max(0, from); i < state.cues.length; i++) {
      const c = state.cues[i];
      const tr = rowEls[i];
      tr.classList.toggle('stretch-affected',
        !!(st && i >= st.affected[0] && i <= st.affected[1]));
      const td = tr.children;
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
    btn.disabled = state.undoStack.length === 0 || !!state.stretch;
    btn.textContent = state.undoStack.length ? '撤销 (' + state.undoStack.length + ')' : '撤销';
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
      updateStretchMarkers();
      return;
    }
    ensureBlocks();
    ensureRows();
    content.style.width = contentWidthPx() + 'px';
    renderRuler();
    renderDynamic(0);
    markSelected();
    updateStretchMarkers();
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
    if (state.stretch) return; // 预览期间禁止拖动，先确认或取消
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
    if (state.stretch) return; // 预览期间请先「确认应用」或「取消预览」
    const snap = state.undoStack.pop();
    if (!snap) return;
    state.cues.forEach((c, i) => { c.start = snap[i].start; c.end = snap[i].end; });
    updateUndoButton();
    renderAll();
  }
  $('#btn-undo').addEventListener('click', undo);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.stretch) cancelStretch(false);   // Esc 取消预览
      else if (armTarget) setArm(null);          // Esc 取消「点击设点」
      return;
    }
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
    state.stretch = null; // 新文件，丢弃未确认的预览
    updateUndoButton();
    updateStretchUI();
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
    if (!state.cues.length || state.stretch) return; // 预览期间禁止导出
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

  /* ---------------- 区间变速 ---------------- */

  /** 解析时间输入：支持 HH:MM:SS,mmm / MM:SS.mmm / 纯秒数；非法返回 null */
  function parseTimeInput(str) {
    const s = String(str).trim();
    if (!s) return null;
    if (s.indexOf(':') === -1) {
      const sec = Number(s);
      return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null;
    }
    const parts = s.split(':');
    if (parts.length === 2) {
      const m = Number(parts[0]);
      const sec = Number(parts[1].replace(',', '.'));
      if (!Number.isFinite(m) || !Number.isFinite(sec) || m < 0 || sec < 0 || sec >= 60) return null;
      return Math.round((m * 60 + sec) * 1000);
    }
    return SubEngine.timecodeToMs(s);
  }

  /** 在面板消息区显示结果；冲突条目渲染为可点击的「定位」链接 */
  function showStretchMsg(text, conflicts, ok) {
    stretchMsg.textContent = text || '';
    stretchMsg.classList.toggle('warn', !ok);
    (conflicts || []).forEach((c) => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = '定位第 ' + (c.index + 1) + ' 条';
      a.title = c.message || '';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        selectCue(c.index);
        scrollBlockIntoView(c.index);
      });
      stretchMsg.appendChild(a);
    });
  }

  function setArm(which) {
    armTarget = which;
    btnSetIn.classList.toggle('armed', which === 'in');
    btnSetOut.classList.toggle('armed', which === 'out');
    scroller.classList.toggle('arming', !!which);
  }

  /** 刷新入点/出点/新出点标记线与区间高亮（预览期间隐藏） */
  function updateStretchMarkers() {
    const pps = state.pxPerSec;
    const inMs = parseTimeInput(stretchIn.value);
    const outMs = parseTimeInput(stretchOut.value);
    const targetMs = parseTimeInput(stretchTarget.value);
    const active = !stretchPanel.hidden && !state.stretch && state.cues.length > 0;
    const showMark = (el, ms) => {
      if (active && ms != null) {
        el.hidden = false;
        el.style.left = (ms / 1000 * pps) + 'px';
      } else {
        el.hidden = true;
      }
    };
    showMark(markIn, inMs);
    showMark(markOut, outMs);
    showMark(markTarget, inMs != null && targetMs != null ? inMs + targetMs : null);
    if (active && inMs != null && outMs != null && outMs > inMs) {
      stretchRegion.hidden = false;
      stretchRegion.style.left = (inMs / 1000 * pps) + 'px';
      stretchRegion.style.width = ((outMs - inMs) / 1000 * pps) + 'px';
    } else {
      stretchRegion.hidden = true;
    }
  }

  function updateStretchUI() {
    const previewing = !!state.stretch;
    $('#btn-stretch-apply').disabled = !previewing;
    $('#btn-stretch-cancel').disabled = !previewing;
    $('#btn-export').disabled = previewing || !state.cues.length;
    btnSetIn.disabled = previewing;
    btnSetOut.disabled = previewing;
    $('#btn-read-selected').disabled = previewing;
    if (previewing) setArm(null);
    document.body.classList.toggle('previewing', previewing);
    updateUndoButton();
    updateStretchMarkers();
  }

  function readStretchInputs() {
    const inMs = parseTimeInput(stretchIn.value);
    const outMs = parseTimeInput(stretchOut.value);
    const targetMs = parseTimeInput(stretchTarget.value);
    if (inMs == null) { showStretchMsg('⚠ 入点无效：支持时间码（如 00:00:05,000）或秒数', [], false); return null; }
    if (outMs == null) { showStretchMsg('⚠ 出点无效：支持时间码（如 00:00:10,000）或秒数', [], false); return null; }
    if (targetMs == null) { showStretchMsg('⚠ 目标时长无效：支持秒数（如 8）或时间码', [], false); return null; }
    return { inMs, outMs, targetMs };
  }

  function previewStretch() {
    if (!state.cues.length) { showStretchMsg('⚠ 请先导入字幕', [], false); return; }
    const p = readStretchInputs();
    if (!p) return;
    // 预览期间再次点击「预览」时，始终基于原始时间轴重新计算
    const base = state.stretch ? state.stretch.original : state.cues;
    const res = SubEngine.stretchRange(base, p.inMs, p.outMs, p.targetMs);
    if (!res.ok) { showStretchMsg('⚠ ' + res.message, res.conflicts, false); return; }
    state.stretch = { original: base, affected: res.affected, ratio: res.ratio };
    state.cues = res.cues;
    renderAll();
    const a = res.affected[0], b = res.affected[1];
    let msg = '预览中：第 ' + (a + 1) + '–' + (b + 1) + ' 条（共 ' + (b - a + 1) +
      ' 条）按 ×' + res.ratio.toFixed(3) + ' 映射';
    if (res.cues[b].end !== p.inMs + p.targetMs) {
      msg += '；受最短时长/间隔约束，区间实际终于 ' + msToTimecode(res.cues[b].end);
    }
    showStretchMsg(msg + '，请「确认应用」或「取消预览」（Esc）。', [], true);
    scrollBlockIntoView(a);
    updateStretchUI();
  }

  function applyStretch() {
    const st = state.stretch;
    if (!st) return;
    // 与拖动共用撤销栈：一条记录回退整次变速
    state.undoStack.push(st.original.map((c) => ({ start: c.start, end: c.end })));
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    state.stretch = null;
    showStretchMsg('✓ 已应用区间变速，可用「撤销」（Ctrl+Z）回退。', [], true);
    renderAll();
    updateStretchUI();
  }

  function cancelStretch(silent) {
    const st = state.stretch;
    if (!st) return;
    state.cues = st.original;
    state.stretch = null;
    renderAll();
    updateStretchUI();
    if (!silent) showStretchMsg('已取消预览，时间轴恢复原状。', [], true);
  }

  $('#btn-stretch').addEventListener('click', () => {
    stretchPanel.hidden = !stretchPanel.hidden;
    if (stretchPanel.hidden) cancelStretch(true); // 收起面板即退出预览
    updateStretchUI();
  });
  btnSetIn.addEventListener('click', () => setArm(armTarget === 'in' ? null : 'in'));
  btnSetOut.addEventListener('click', () => setArm(armTarget === 'out' ? null : 'out'));
  $('#btn-read-selected').addEventListener('click', () => {
    const c = state.cues[state.selected];
    if (!c) { showStretchMsg('⚠ 请先在时间轴或列表中选中一条字幕', [], false); return; }
    stretchIn.value = msToTimecode(c.start);
    stretchOut.value = msToTimecode(c.end);
    updateStretchMarkers();
  });
  $('#btn-stretch-preview').addEventListener('click', previewStretch);
  $('#btn-stretch-apply').addEventListener('click', applyStretch);
  $('#btn-stretch-cancel').addEventListener('click', () => cancelStretch(false));
  [stretchIn, stretchOut, stretchTarget].forEach((el) =>
    el.addEventListener('input', updateStretchMarkers));

  // 「点击设入点/出点」武装后，在时间轴上单击取时间（捕获阶段拦截，避免触发拖动）
  scroller.addEventListener('pointerdown', (e) => {
    if (!armTarget || state.stretch) return;
    const rect = content.getBoundingClientRect();
    const t = Math.max(0, Math.round((e.clientX - rect.left) / state.pxPerSec * 1000));
    (armTarget === 'in' ? stretchIn : stretchOut).value = msToTimecode(t);
    setArm(null);
    updateStretchMarkers();
    e.preventDefault();
    e.stopPropagation();
  }, true);

  /* ---------------- 示例 ---------------- */

  $('#btn-demo').addEventListener('click', () => {
    importText([
      '1', '00:00:00,000 --> 00:00:01,800', '欢迎来到字幕时间轴修整器', '',
      '2', '00:00:02,000 --> 00:00:04,200', '拖动左右边界调整起止，按住块主体可整块平移', '',
      '3', '00:00:04,500 --> 00:00:06,000', '右边界越过安全线时会递归推移后继块', '',
      '4', '00:00:06,200 --> 00:00:08,500', '向回拖动只释放空隙，不会拉回后继', '',
      '5', '00:00:08,800 --> 00:00:11,000', '每块至少 500ms，块间至少 100ms，起点不为负', '',
      '6', '00:00:11,300 --> 00:00:13,600', 'Ctrl+滚轮缩放时间轴，Ctrl+Z 撤销', '',
      '7', '00:00:13,900 --> 00:00:16,500', '完成后点击「导出 SRT」保存合法字幕文件', '',
      '8', '00:00:16,800 --> 00:00:19,200', '工具栏「区间变速」可按入点/出点/目标时长整体伸缩一段字幕', '',
    ].join('\n'), 'demo.srt');
  });

  window.addEventListener('resize', () => { if (state.cues.length) renderAll(); });

  zoomSlider.value = ppsToSlider(state.pxPerSec);
  zoomLabel.textContent = state.pxPerSec + ' px/s';
  renderAll();
})();
