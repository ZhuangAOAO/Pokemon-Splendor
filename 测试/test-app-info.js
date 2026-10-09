'use strict';

// 发布身份冒烟：/health 与 POST /api appInfo 必须报告同一批代码。
const BASE = 'http://localhost:3000';
const pkg = require('../package.json');

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

(async () => {
  const healthRes = await fetch(BASE + '/health', { cache: 'no-store' });
  check(healthRes.ok, '/health HTTP 状态异常：' + healthRes.status);
  const health = await healthRes.json();

  const apiRes = await fetch(BASE + '/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'appInfo' }),
  });
  check(apiRes.ok, '/api HTTP 状态异常：' + apiRes.status);
  const api = await apiRes.json();

  check(health.ok && api.ok, '发布身份接口没有返回 ok');
  check(health.version === pkg.version, `运行版本 ${health.version} 与 package.json ${pkg.version} 不一致`);
  check(health.build === api.build, '/health 与 /api 的 build 不一致');
  check(/^[0-9a-f]{10}$/.test(health.build), 'build 指纹格式不正确：' + health.build);
  check(!Number.isNaN(Date.parse(health.startedAt)), 'startedAt 不是有效时间：' + health.startedAt);

  console.log(`PASS  v${health.version} · ${health.build}`);
})().catch((err) => {
  console.error('FAIL  ' + err.message);
  process.exit(1);
});
