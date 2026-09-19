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
    validate,
  };
});
