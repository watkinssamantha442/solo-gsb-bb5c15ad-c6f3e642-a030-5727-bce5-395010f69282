'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');

const cue = (start, end, text = 'x') => ({ start, end, text });

test('时间码互转', () => {
  assert.equal(E.msToTimecode(0), '00:00:00,000');
  assert.equal(E.msToTimecode(3723456), '01:02:03,456');
  assert.equal(E.timecodeToMs('01:02:03,456'), 3723456);
  assert.equal(E.timecodeToMs('00:00:01.500'), 1500); // 兼容句点
  assert.equal(E.timecodeToMs('bad'), null);
});

test('解析 SRT：序号可选、多行文本、CRLF、结束码后带设置', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n世界\r\n\r\n' +
              '00:00:03,000 --> 00:00:04,000 X1:abc\r\n第二块\r\n';
  const cues = E.parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1000, end: 2000, text: '你好\n世界' });
  assert.equal(cues[1].start, 3000);
  assert.equal(cues[1].text, '第二块');
});

test('解析 SRT：忽略 BOM', () => {
  const cues = E.parseSrt('﻿1\n00:00:00,000 --> 00:00:01,000\n带 BOM\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '带 BOM');
});

test('导出 SRT：序号重排、格式合法且可回读', () => {
  const cues = [cue(0, 1500, '甲'), cue(1600, 2100, '乙\n两行')];
  const out = E.formatSrt(cues);
  assert.equal(out, '1\n00:00:00,000 --> 00:00:01,500\n甲\n\n' +
                    '2\n00:00:01,600 --> 00:00:02,100\n乙\n两行\n');
  assert.deepEqual(E.parseSrt(out), cues);
});

test('normalize：修正负起点、短时长、重叠与乱序', () => {
  const cues = E.normalize([
    cue(2000, 2100, 'c'),   // 时长不足 500
    cue(-300, 400, 'a'),    // 负起点
    cue(450, 1200, 'b'),    // 与 a 间隔不足
  ]);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 700],     // a: 负起点整体平移归零，保持 700 时长
    [800, 1550],  // b: 保持 750 时长整体后移
    [2000, 2500], // c: 位置不变，补足最短时长
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('右边界越过安全线：超出量递归推移后继并保持时长', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000)];
  E.applyDrag(cues, 0, 'end', 1500);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 1500],
    [1600, 2200], // 整体 +900，时长 600 不变
    [2300, 2900], // 连锁 +900
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('连锁在空隙足够处停止', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(5000, 5600)];
  E.applyDrag(cues, 0, 'end', 1500);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 1500],
    [1600, 2200],
    [5000, 5600], // 空隙足够，不受影响
  ]);
});

test('向回拖动只释放空隙，不拉回后继', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000)];
  E.applyDrag(cues, 0, 'end', 1500); // 先推过去
  E.applyDrag(cues, 0, 'end', 800);  // 再拖回来
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 800],
    [1600, 2200], // 后继保持不动
    [2300, 2900],
  ]);
});

test('右边界不得小于最短时长', () => {
  const cues = [cue(1000, 3000)];
  E.applyDrag(cues, 0, 'end', 1100);
  assert.deepEqual([cues[0].start, cues[0].end], [1000, 1500]);
});

test('左边界：夹取于 0、前驱安全线与最短时长', () => {
  const cues = [cue(0, 600), cue(700, 3000)];
  E.applyDrag(cues, 1, 'start', -500);           // 越过 0 与前驱安全线
  assert.equal(cues[1].start, 700);              // prev.end + 100
  E.applyDrag(cues, 1, 'start', 2900);           // 越过 end - 500
  assert.equal(cues[1].start, 2500);
  E.applyDrag(cues, 0, 'start', -100);           // 首块不能为负
  assert.equal(cues[0].start, 0);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：时长不变，向左夹取于 0 与前驱安全线', () => {
  const cues = [cue(0, 600), cue(1000, 3000)];
  E.applyMove(cues, 1, 500);                     // 越过前驱安全线 700
  assert.deepEqual([cues[1].start, cues[1].end], [700, 2700]);  // 时长 2000 不变
  E.applyMove(cues, 0, -800);                    // 首块夹取到 0
  assert.deepEqual([cues[0].start, cues[0].end], [0, 600]);
  E.applyMove(cues, 1, 1200);                    // 正常平移
  assert.deepEqual([cues[1].start, cues[1].end], [1200, 3200]);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：向右越过后继安全线递归推移并保持各块时长', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000), cue(5000, 5800)];
  E.applyMove(cues, 0, 1000);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [1000, 1600], // 时长 600 不变
    [1700, 2300], // 被推移，时长 600 不变
    [2400, 3000], // 连锁推移
    [5000, 5800], // 空隙足够，不受影响
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：空隙足够时不影响后继', () => {
  const cues = [cue(0, 600), cue(2000, 2600)];
  E.applyMove(cues, 0, 800);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [[800, 1400], [2000, 2600]]);
});

test('整块平移：一次手势内先右推再左回拖，后继不自动回拉', () => {
  const cues = [cue(0, 600), cue(700, 1300), cue(1400, 2000)];
  E.applyMove(cues, 0, 1000); // 先向右推开后继
  E.applyMove(cues, 0, 200);  // 再向左回拖
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [200, 800],
    [1700, 2300], // 后继保持被推开后的位置
    [2400, 3000],
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('整块平移：中间块向右推动两侧后继，向左仍受前驱约束', () => {
  const cues = [cue(0, 600), cue(1000, 1600), cue(1700, 2300)];
  E.applyMove(cues, 1, 1500); // 越过 cue2 安全线
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 600],
    [1500, 2100],
    [2200, 2800], // 被推移，时长 600 不变
  ]);
  E.applyMove(cues, 1, 100);  // 回拖，夹取于前驱安全线 700；后继不回拉
  assert.deepEqual(cues.map(c => [c.start, c.end]), [
    [0, 600],
    [700, 1300],
    [2200, 2800],
  ]);
  assert.deepEqual(E.validate(cues), []);
});

test('validate 能发现全部三类违规', () => {
  const problems = E.validate([cue(-1, 200), cue(250, 400)]);
  // 负起点 + 第一块时长不足 + 第二块时长不足 + 间隔不足
  assert.equal(problems.length, 4);
});

/* ---------------- 区间变速 ---------------- */

test('区间变速：区间内字幕按锚点线性映射，区间外不动', () => {
  const cues = [
    cue(0, 1000, 'a'),
    cue(2000, 3000, 'b'),
    cue(3200, 3800, 'c'),
    cue(5000, 6000, 'd'),
  ];
  const before = JSON.parse(JSON.stringify(cues));
  // 区间 [2000, 4000] → 目标 3000ms，k = 1.5
  const res = E.stretchRange(cues, 2000, 4000, 3000);
  assert.ok(res.ok);
  assert.equal(res.ratio, 1.5);
  assert.deepEqual(res.affected, [1, 2]);
  assert.deepEqual(res.cues.map(c => [c.start, c.end]), [
    [0, 1000],      // 区间外：不动
    [2000, 3500],   // 2000 + 1000*1.5
    [3800, 4700],   // 2000 + 1200*1.5 → 2000 + 1800*1.5
    [5000, 6000],   // 区间外：不动
  ]);
  assert.deepEqual(res.cues.map(c => c.text), ['a', 'b', 'c', 'd']); // 文本保持
  assert.deepEqual(cues, before);                                     // 入参不被修改
  assert.deepEqual(E.validate(res.cues), []);
});

test('区间变速：压缩后自动补足最短时长并级联右移', () => {
  const cues = [cue(0, 600, 'a'), cue(700, 1300, 'b'), cue(1400, 2000, 'c'), cue(2100, 2600, 'd')];
  // 区间 [700, 2100] → 目标 700ms，k = 0.5；b 压缩到 300ms 需补足，c 被级联右移
  const res = E.stretchRange(cues, 700, 2100, 700);
  assert.ok(res.ok);
  assert.deepEqual(res.cues.map(c => [c.start, c.end]), [
    [0, 600],
    [700, 1200],    // 映射为 [700,1000]，补足最短时长 500
    [1300, 1800],   // 映射为 [1050,1350]，间隔不足整体右移 250，再补足最短时长
    [2100, 2600],   // 区间外：不动
  ]);
  assert.deepEqual(E.validate(res.cues), []);
});

test('区间变速：跨越边界的块只映射落在区间内的一端', () => {
  const cues = [cue(0, 1500, 'a'), cue(1600, 2200, 'b')];
  // 区间 [1000, 2000] → 目标 500ms，k = 0.5
  // a 跨越入点：起点 0 不动，终点映射为 1250；b 跨越出点：终点 2200 不动
  const res = E.stretchRange(cues, 1000, 2000, 500);
  assert.ok(res.ok);
  assert.deepEqual(res.affected, [0, 1]);
  assert.deepEqual(res.cues.map(c => [c.start, c.end]), [
    [0, 1250],
    [1350, 2250],   // 起点映射为 1300，与 a 间隔不足被整体右移 50（终点随之移动）
  ]);
  assert.deepEqual(E.validate(res.cues), []);
});

test('区间变速：完全覆盖区间的块两端都在区间外，保持不动', () => {
  const cues = [cue(0, 5000, 'a')];
  const res = E.stretchRange(cues, 1000, 2000, 3000);
  assert.ok(res.ok);
  assert.deepEqual(res.affected, [0, 0]);
  assert.deepEqual([res.cues[0].start, res.cues[0].end], [0, 5000]);
});

test('区间变速：与区间外后继冲突时不静默改写，返回可定位冲突', () => {
  const cues = [cue(0, 600, 'a'), cue(700, 1300, 'b'), cue(1400, 2000, 'c')];
  const before = JSON.parse(JSON.stringify(cues));
  // b 扩张到 [700, 2700]，撞上区间外的 c
  const res = E.stretchRange(cues, 700, 1300, 2000);
  assert.equal(res.ok, false);
  assert.equal(res.cues, null);
  assert.ok(res.message.includes('第 2 条'));
  assert.ok(res.message.includes('第 3 条'));
  assert.deepEqual(res.conflicts.map(c => c.index), [1, 2]); // 可定位：双方下标
  assert.deepEqual(cues, before); // 冲突时原数组分毫不动
});

test('区间变速：跨越出点的块映射后起终点倒置 → 可定位冲突', () => {
  const cues = [cue(0, 1000, 'a'), cue(1100, 1600, 'b'), cue(1700, 2500, 'c')];
  const before = JSON.parse(JSON.stringify(cues));
  // 区间 [1200, 2000] → 目标 5000ms，k = 6.25；c 起点映射为 4325 > 其终点 2500
  const res = E.stretchRange(cues, 1200, 2000, 5000);
  assert.equal(res.ok, false);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].index, 2);
  assert.ok(res.message.includes('第 3 条'));
  assert.deepEqual(cues, before);
});

test('区间变速：左缘与区间外前驱间隔不足时自动右移受影响块', () => {
  const cues = [cue(0, 960, 'a'), cue(1100, 2000, 'b')];
  // 区间 [1000, 2000] → 目标 500ms，k = 0.5；b 起点映射为 1050，与 a 间隔 90 < 100
  const res = E.stretchRange(cues, 1000, 2000, 500);
  assert.ok(res.ok);
  assert.deepEqual(res.cues.map(c => [c.start, c.end]), [
    [0, 960],       // 区间外前驱：不动
    [1060, 1560],   // 整体右移 10 拉开间隔，再补足最短时长 500
  ]);
  assert.deepEqual(E.validate(res.cues), []);
});

test('区间变速：保持文本与相对顺序', () => {
  const cues = [
    cue(1000, 1600, '甲'), cue(1700, 2300, '乙'), cue(2400, 3000, '丙'), cue(4000, 5000, '丁'),
  ];
  const res = E.stretchRange(cues, 1000, 3100, 1050); // k = 0.5
  assert.ok(res.ok);
  assert.deepEqual(res.cues.map(c => c.text), ['甲', '乙', '丙', '丁']);
  for (let i = 1; i < res.cues.length; i++) {
    assert.ok(res.cues[i].start >= res.cues[i - 1].end + E.MIN_GAP_MS);
  }
  assert.deepEqual(E.validate(res.cues), []);
});

test('区间变速：非法参数与空区间', () => {
  const cues = [cue(0, 1000, 'a')];
  assert.equal(E.stretchRange(cues, -1, 1000, 500).ok, false);   // 入点为负
  assert.equal(E.stretchRange(cues, 1000, 1000, 500).ok, false); // 出点不大于入点
  assert.equal(E.stretchRange(cues, 0, 1000, 0).ok, false);      // 目标时长非正
  assert.equal(E.stretchRange(cues, 2000, 3000, 500).ok, false); // 区间内无字幕
  assert.equal(E.stretchRange([], 0, 1000, 500).ok, false);      // 空时间轴
});

test('区间变速：极小压缩比下区间内块由最短时长修正兜底，不误报倒置', () => {
  const cues = [cue(0, 1000, 'a')];
  // 1 小时区间压到 1 秒：a 完全在区间内部，映射后时长不足 1ms，应补足 500ms 而不是报冲突
  const res = E.stretchRange(cues, 0, 3600000, 1000);
  assert.ok(res.ok);
  assert.deepEqual([res.cues[0].start, res.cues[0].end], [0, 500]);
  assert.deepEqual(E.validate(res.cues), []);
});
