/*
 * 字幕时间轴约束引擎（浏览器 / Node 共用）
 *
 * 不变式（任何时刻都必须成立）：
 *   1. 每条字幕时长 >= MIN_DURATION_MS（500ms）
 *   2. 相邻字幕间隔 >= MIN_GAP_MS（100ms）
 *   3. 起点 >= 0
 *
 * 拖动规则：
 *   - 拖动右边界越过“后继安全线”（next.start - MIN_GAP）时，
 *     超出量递归推移所有受影响的后继块，且保持各块时长不变；
 *   - 向回拖动只释放空隙，不自动拉回后继块；
 *   - 拖动左边界时不推移前驱块，仅在 0 / 前驱安全线 / 最短时长处夹取；
 *   - 按住块主体整块平移时保持时长不变：向左在 0 / 前驱安全线处夹取，
 *     向右越过后继安全线时同样递归推移后继块；同一次手势内先推后回拖，
 *     已被推开的后继不自动回拉。
 *
 * 区间变速：
 *   - 以入点/出点为锚点，把 [inMs, outMs] 区间线性映射到目标时长；
 *   - 区间内及跨越边界的字幕参与映射：跨越边界的块只映射落在区间内的
 *     那一端，区间外一端保持不动；完全在区间外的字幕一律不改写；
 *   - 映射后自动补足最短时长、拉开 100ms 间隔（仅在受影响集合内右移/延长）；
 *   - 若修正需要改动区间外字幕，或映射导致起终点倒置，则不静默改写，
 *     返回带下标与时间码的可定位冲突信息。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MIN_DURATION_MS = 500;
  const MIN_GAP_MS = 100;

  function pad(n, w) { return String(n).padStart(w, '0'); }

  /** 毫秒 -> SRT 时间码 HH:MM:SS,mmm */
  function msToTimecode(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(r, 3);
  }

  /** SRT 时间码 -> 毫秒；非法返回 null。兼容逗号/句点分隔。 */
  function timecodeToMs(tc) {
    const m = String(tc).trim().match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
    if (!m) return null;
    return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4].padEnd(3, '0'));
  }

  /** 解析 SRT 文本 -> [{start, end, text}]（未做约束修正） */
  function parseSrt(text) {
    const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    for (const raw of src.split(/\n[ \t]*\n/)) {
      const lines = raw.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');
      if (!lines.length) continue;
      let i = /^\d+$/.test(lines[0].trim()) ? 1 : 0; // 序号行可有可无
      const tcLine = lines[i];
      if (!tcLine || tcLine.indexOf('-->') === -1) continue;
      const parts = tcLine.split('-->');
      const start = timecodeToMs(parts[0]);
      // 结束时间码后可能跟坐标等设置，只取第一个 token
      const end = timecodeToMs((parts[1] || '').trim().split(/\s+/)[0]);
      if (start == null || end == null) continue;
      cues.push({ start, end, text: lines.slice(i + 1).join('\n') });
    }
    return cues;
  }

  /** 序列化为合法 SRT（序号重排、逗号分隔） */
  function formatSrt(cues) {
    return cues.map((c, i) =>
      (i + 1) + '\n' + msToTimecode(c.start) + ' --> ' + msToTimecode(c.end) + '\n' + c.text
    ).join('\n\n') + '\n';
  }

  /**
   * 导入时规整：排序、负起点归零、补足最短时长、
   * 间隔不足时把后继块整体后移（保持时长），保证初始状态合法。
   */
  function normalize(cues) {
    cues.sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let minStart = 0;
    for (const c of cues) {
      if (c.start < minStart) {
        const shift = minStart - c.start; // 整体平移，时长不变
        c.start += shift;
        c.end += shift;
      }
      if (c.end < c.start + MIN_DURATION_MS) c.end = c.start + MIN_DURATION_MS;
      minStart = c.end + MIN_GAP_MS;
    }
    return cues;
  }

  /** 从 index 起向后检查：间隔不足的后继块整体后移（保持时长），空隙足够即停止 */
  function pushSuccessors(cues, index) {
    let prev = cues[index];
    for (let k = index + 1; k < cues.length; k++) {
      const cur = cues[k];
      const minStart = prev.end + MIN_GAP_MS;
      if (cur.start >= minStart) break; // 空隙足够，连锁停止
      cur.end += minStart - cur.start;  // 整体平移，时长不变
      cur.start = minStart;
      prev = cur;
    }
  }

  /**
   * 应用一次边界拖动（拖动过程中可反复调用）。
   * @param cues  字幕数组（就地修改）
   * @param index 被拖动的块下标
   * @param edge  'start' | 'end'
   * @param t     期望的边界时间（ms）
   */
  function applyDrag(cues, index, edge, t) {
    const cue = cues[index];
    if (!cue) return cues;
    t = Math.round(t);

    if (edge === 'end') {
      // 最短时长夹取；向回拖动只释放空隙
      cue.end = Math.max(t, cue.start + MIN_DURATION_MS);
      // 越过后继安全线：超出量递归推移后继块，保持各块时长
      pushSuccessors(cues, index);
    } else if (edge === 'start') {
      let s = Math.min(t, cue.end - MIN_DURATION_MS); // 最短时长
      if (s < 0) s = 0;                                // 起点不为负
      if (index > 0) {
        const limit = cues[index - 1].end + MIN_GAP_MS; // 前驱安全线
        if (s < limit) s = limit;
      }
      cue.start = s;
    }
    return cues;
  }

  /**
   * 应用一次整块平移（按住块主体横向拖动，拖动过程中可反复调用）。
   * 时长保持不变；向左在 0 / 前驱安全线处夹取；
   * 向右越过后继安全线时递归推移后继块；回拖只释放空隙，不拉回后继。
   * @param cues  字幕数组（就地修改）
   * @param index 被平移的块下标
   * @param t     期望的起点时间（ms）
   */
  function applyMove(cues, index, t) {
    const cue = cues[index];
    if (!cue) return cues;
    const dur = cue.end - cue.start;
    let s = Math.round(t);
    if (s < 0) s = 0;                                 // 起点不为负
    if (index > 0) {
      const limit = cues[index - 1].end + MIN_GAP_MS; // 前驱安全线
      if (s < limit) s = limit;
    }
    cue.start = s;
    cue.end = s + dur;                                // 整体平移，时长不变
    pushSuccessors(cues, index);
    return cues;
  }

  /**
   * 区间变速（纯函数，不修改入参）。
   * 把与 [inMs, outMs] 相交（含跨越边界）的字幕按锚点做线性时间映射：
   *   t <= inMs        → t（区间外不动）
   *   inMs < t < outMs → inMs + (t - inMs) * k，k = targetMs / (outMs - inMs)
   *   t >= outMs       → t（区间外不动；但终点坐标 t == outMs 仍跟随锚点，
   *                      即恰好结束在出点的块，其终点映射到新区间末端）
   * 即入点、出点为锚点，区间整体压缩/拉伸到 targetMs；跨越边界的块只映射
   * 落在区间内的那一端，区间外一端保持不动。文本与相对顺序保持不变。
   *
   * 映射后自动修正最短时长与 100ms 间隔，但只允许改动受影响集合
   * （右移/延长）；若修正需要波及区间外字幕，或跨越出点的块映射后
   * 起点越过其终点，则不静默改写，返回带下标与时间码的冲突信息。
   *
   * @param cues     字幕数组（不会被修改）
   * @param inMs     入点（ms，>= 0）
   * @param outMs    出点（ms，> inMs）
   * @param targetMs 目标时长（ms，> 0）
   * @returns ok=true  → { ok, cues: 新数组, affected: [i0, i1], ratio, conflicts: [] }
   *          ok=false → { ok, message, conflicts: [{index, message}], cues: null }
   */
  function stretchRange(cues, inMs, outMs, targetMs) {
    inMs = Math.round(Number(inMs));
    outMs = Math.round(Number(outMs));
    targetMs = Math.round(Number(targetMs));
    const bad = (message, conflicts) => ({
      ok: false, message, conflicts: conflicts || [], cues: null, affected: null, ratio: 0,
    });
    if (!Number.isFinite(inMs) || inMs < 0) return bad('入点必须是不小于 0 的时间');
    if (!Number.isFinite(outMs) || outMs <= inMs) return bad('出点必须大于入点');
    if (!Number.isFinite(targetMs) || targetMs <= 0) return bad('目标时长必须大于 0');

    // 受影响集合：与 [inMs, outMs] 相交的所有块（含跨越边界者），下标连续
    let i0 = -1, i1 = -1;
    cues.forEach((c, i) => {
      if (c.start < outMs && c.end > inMs) { if (i0 < 0) i0 = i; i1 = i; }
    });
    if (i0 < 0) return bad('入点/出点区间内没有任何字幕');

    const k = targetMs / (outMs - inMs);
    // 边界归属：起点坐标 t >= outMs 视为区间外（恰从出点开始的后继块不受影响）；
    // 终点坐标 t > outMs 才视为区间外——出点本身是锚点，恰好结束在出点的块，
    // 其终点跟随锚点移动到新区间末端。
    const mapStart = (t) => (t <= inMs ? t : t >= outMs ? t : inMs + (t - inMs) * k);
    const mapEnd = (t) => (t <= inMs ? t : t > outMs ? t : inMs + (t - inMs) * k);

    // 复制后再映射，绝不就地修改入参；文本原样保留
    const out = cues.map(c => ({ start: c.start, end: c.end, text: c.text }));
    for (let i = i0; i <= i1; i++) {
      const s = Math.round(mapStart(out[i].start));
      const e = Math.round(mapEnd(out[i].end));
      if (e - s < 1 && cues[i].end > outMs) {
        // 只会发生在跨越出点的块上：区间外终点不动，映射后起点越过终点
        // （区间内的块映射后必然 s <= e，时长不足由下方修正补足）
        return bad(
          '第 ' + (i + 1) + ' 条（' + msToTimecode(cues[i].start) + ' → ' +
          msToTimecode(cues[i].end) + '）跨越出点，映射后起点将越过终点；' +
          '请先缩短该条，或调整区间/目标时长',
          [{ index: i, message: '第 ' + (i + 1) + ' 条映射后起终点倒置' }]
        );
      }
      out[i].start = s;
      out[i].end = e;
    }

    // 自动修正：最短时长 + 100ms 间隔，仅在受影响集合内右移/延长
    let minStart = i0 > 0 ? out[i0 - 1].end + MIN_GAP_MS : 0; // 区间外前驱不可动
    for (let i = i0; i <= i1; i++) {
      const c = out[i];
      if (c.start < minStart) {           // 间隔不足：整体右移，时长不变
        const shift = minStart - c.start;
        c.start += shift;
        c.end += shift;
      }
      if (c.end < c.start + MIN_DURATION_MS) c.end = c.start + MIN_DURATION_MS;
      minStart = c.end + MIN_GAP_MS;
    }

    // 右缘：修正不得波及区间外字幕，否则报可定位冲突而不是静默改写
    if (i1 < out.length - 1 && out[i1].end + MIN_GAP_MS > out[i1 + 1].start) {
      return bad(
        '应用约束后第 ' + (i1 + 1) + ' 条将结束于 ' + msToTimecode(out[i1].end) +
        '，与区间外第 ' + (i1 + 2) + ' 条（始 ' + msToTimecode(out[i1 + 1].start) +
        '）间隔不足 100ms；请缩短目标时长，或先调整区间外字幕',
        [
          { index: i1, message: '第 ' + (i1 + 1) + ' 条修正后越过后继安全线' },
          { index: i1 + 1, message: '第 ' + (i1 + 2) + ' 条在区间外，不会被改写' },
        ]
      );
    }

    return { ok: true, message: '', conflicts: [], cues: out, affected: [i0, i1], ratio: k };
  }

  /** 校验当前状态是否满足全部约束，返回问题列表（空数组 = 合法） */
  function validate(cues) {
    const problems = [];
    cues.forEach((c, i) => {
      if (c.start < 0) problems.push('第 ' + (i + 1) + ' 条起点为负');
      if (c.end - c.start < MIN_DURATION_MS) problems.push('第 ' + (i + 1) + ' 条时长不足 500ms');
      if (i > 0 && c.start - cues[i - 1].end < MIN_GAP_MS) {
        problems.push('第 ' + (i + 1) + ' 条与前一条间隔不足 100ms');
      }
    });
    return problems;
  }

  return {
    MIN_DURATION_MS,
    MIN_GAP_MS,
    msToTimecode,
    timecodeToMs,
    parseSrt,
    formatSrt,
    normalize,
    applyDrag,
    applyMove,
    stretchRange,
    validate,
  };
});
