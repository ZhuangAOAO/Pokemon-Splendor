'use strict';
/* ==================== 手写神经网络（零依赖） ====================
 * 全连接 MLP：前向 + 反向传播 + Adam。供 ppo-mini-nn / ppo-big-nn 使用。
 *
 * 为什么手写而不上 PyTorch：游戏引擎在 JS 里，PyTorch 训练需要把整个
 * 规则引擎用 Python 重写（不是装个包的事）。手写版训练推理同语言、
 * 立刻能跑、零依赖，且是未来 PyTorch 版最好的对照基线。
 *
 * 结构约定：
 *   makeMLP(sizes, rng)         建网络（He 初始化 + Adam 缓冲）
 *   forward(net, x) → {out, saved}   标量输出；saved 供 backward 用
 *   backward(net, saved, gOut)       累加梯度进 net.dW/db（标量输出 → gOut 是数）
 *   zeroGrads(net) / adamStep(net, lr, t)
 *   serialize(net) → 纯数组（JSON 可直接存）
 */

function makeMLP(sizes, rng) {
  const W = [], b = [], dW = [], db = [], mW = [], vW = [], mb = [], vb = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const din = sizes[l], dout = sizes[l + 1];
    const scale = Math.sqrt(2 / din); // He 初始化（tanh 用 Xavier 亦可，2/din 保守）
    const wl = new Float64Array(din * dout), bl = new Float64Array(dout);
    for (let i = 0; i < wl.length; i++) wl[i] = (rng() * 2 - 1) * scale;
    W.push(wl); b.push(bl);
    dW.push(new Float64Array(din * dout)); db.push(new Float64Array(dout));
    mW.push(new Float64Array(din * dout)); vW.push(new Float64Array(din * dout));
    mb.push(new Float64Array(dout)); vb.push(new Float64Array(dout));
  }
  return { sizes, W, b, dW, db, mW, vW, mb, vb };
}

function forward(net, x) {
  const saved = { xs: [], pres: [] };
  let h = x;
  saved.xs.push(h);
  for (let l = 0; l < net.W.length; l++) {
    const din = net.sizes[l], dout = net.sizes[l + 1];
    const W = net.W[l], b = net.b[l];
    const pre = new Float64Array(dout);
    for (let j = 0; j < dout; j++) {
      let s = b[j];
      for (let i = 0; i < din; i++) s += W[i * dout + j] * h[i];
      pre[j] = s;
    }
    saved.pres.push(pre);
    h = l === net.W.length - 1 ? pre : Float64Array.from(pre, Math.tanh);
    saved.xs.push(h);
  }
  return { out: h[0], saved };
}

function backward(net, saved, gOut) {
  let gVec = Float64Array.of(gOut);
  for (let l = net.W.length - 1; l >= 0; l--) {
    const din = net.sizes[l], dout = net.sizes[l + 1];
    const pre = saved.pres[l], x = saved.xs[l];
    const W = net.W[l], dW = net.dW[l], db = net.db[l];
    const dPre = new Float64Array(dout);
    if (l < net.W.length - 1) {
      const act = saved.xs[l + 1]; // tanh' = 1 − a²
      for (let j = 0; j < dout; j++) dPre[j] = gVec[j] * (1 - act[j] * act[j]);
    } else {
      for (let j = 0; j < dout; j++) dPre[j] = gVec[j];
    }
    for (let j = 0; j < dout; j++) {
      db[j] += dPre[j];
      for (let i = 0; i < din; i++) dW[i * dout + j] += dPre[j] * x[i];
    }
    if (l > 0) {
      const gPrev = new Float64Array(din);
      for (let i = 0; i < din; i++) {
        let s = 0;
        for (let j = 0; j < dout; j++) s += W[i * dout + j] * dPre[j];
        gPrev[i] = s;
      }
      gVec = gPrev;
    }
  }
}

function zeroGrads(net) {
  for (let l = 0; l < net.W.length; l++) { net.dW[l].fill(0); net.db[l].fill(0); }
}

let adamT = 0; // 全局步数（两个网络共用也行——各自独立计数更干净，这里简化共用）
function adamStep(net, lr) {
  adamT++;
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const c1 = 1 - Math.pow(b1, adamT), c2 = 1 - Math.pow(b2, adamT);
  for (let l = 0; l < net.W.length; l++) {
    const W = net.W[l], b = net.b[l], dW = net.dW[l], db = net.db[l];
    const mW = net.mW[l], vW = net.vW[l], mb = net.mb[l], vb = net.vb[l];
    for (let i = 0; i < W.length; i++) {
      mW[i] = b1 * mW[i] + (1 - b1) * dW[i];
      vW[i] = b2 * vW[i] + (1 - b2) * dW[i] * dW[i];
      W[i] += lr * (mW[i] / c1) / (Math.sqrt(vW[i] / c2) + eps);
    }
    for (let j = 0; j < b.length; j++) {
      mb[j] = b1 * mb[j] + (1 - b1) * db[j];
      vb[j] = b2 * vb[j] + (1 - b2) * db[j] * db[j];
      b[j] += lr * (mb[j] / c1) / (Math.sqrt(vb[j] / c2) + eps);
    }
  }
}

function serialize(net) {
  return {
    sizes: net.sizes,
    W: net.W.map((a) => Array.from(a)),
    b: net.b.map((a) => Array.from(a)),
  };
}
function deserialize(data) {
  const net = makeMLP(data.sizes, Math.random); // 缓冲重新分配
  for (let l = 0; l < net.W.length; l++) {
    net.W[l].set(Float64Array.from(data.W[l]));
    net.b[l].set(Float64Array.from(data.b[l]));
  }
  return net;
}

module.exports = { makeMLP, forward, backward, zeroGrads, adamStep, serialize, deserialize };
