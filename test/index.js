/**
 * 测试目录汇总入口（兼容 shim）。
 *
 * 背景：本机 Node v24.14.0 在 `node --test test/` 时不会把目录参数当作「递归发现」，
 * 而是把 `test/` 当作模块入口解析（报 Cannot find module ...\test），
 * 与 docs/CONTRACT.md §7.6 约定的命令不兼容。
 *
 * 本文件让目录入口可被解析为模块：导入两个测试文件，使契约命令
 *   node --test test/
 * 可以直接跑全部测试。使用显式 glob `node --test test/*.test.js` 时
 * 本文件不会被匹配，因此不会重复执行。
 */
import './config.test.js';
import './server.test.js';
